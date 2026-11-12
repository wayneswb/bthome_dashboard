#!/usr/bin/env python3
"""家庭温湿度看板后端。

扫描 BTHome v2（未加密）蓝牙广播，解析温度/湿度写入 SQLite，并通过 HTTP
同时提供静态页面和 /api/readings 接口。

预览（不需要蓝牙）:
    python3 server.py --demo

正式运行（需要 bleak）:
    uv run --with bleak server.py
    # 或 pip3 install --user bleak && python3 server.py
"""

import argparse
import asyncio
import functools
import hashlib
import json
import math
import random
import sqlite3
import struct
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DEFAULT_CONFIG = ROOT / "config.json"
DEFAULT_DB = ROOT / "data" / "bthome.sqlite3"
DEFAULT_DEMO_DB = ROOT / "data" / "demo.sqlite3"
BUCKET_SECONDS = 300
RETENTION_SECONDS = 7 * 24 * 3600

PALETTE = ["#f59e0b", "#a78bfa", "#34d399", "#f472b6", "#38bdf8", "#fb7185"]

# BTHome v2 object id -> payload size in bytes（只列看板需要的常见对象）
OBJECT_SIZES = {
    0x00: 1,  # packet id
    0x01: 1,  # battery
    0x02: 2,  # temperature, 0.01 °C
    0x03: 2,  # humidity, 0.01 %
    0x04: 3,  # pressure
    0x05: 3,  # illuminance
    0x08: 2,  # dew point
    0x0C: 2,  # voltage
    0x0D: 2,  # pm2.5
    0x0E: 2,  # pm10
    0x12: 2,  # co2
    0x13: 2,  # tvoc
    0x14: 2,  # moisture
    0x2E: 1,  # humidity, 1 %
    0x2F: 1,  # moisture, 1 %
    0x45: 2,  # temperature, 0.1 °C
    0x46: 1,  # uv index
    0x50: 4,  # timestamp
    0x60: 1,  # channel
    0xF0: 2,  # device type id
    0xF1: 4,  # firmware version
}

_seen_devices = set()
_unmatched_devices = set()


def log(message):
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


# ---------------------------------------------------------------------------
# BTHome v2
# ---------------------------------------------------------------------------


def decode_bthome(payload):
    """返回 (temperature, humidity)；无法解析或加密的数据返回 None。"""
    if not payload or len(payload) < 2:
        return None

    info = payload[0]
    if info & 0x01:  # 加密广播
        return None
    if ((info >> 5) & 0x07) != 2:  # 不是 BTHome v2
        return None

    temperature = None
    humidity = None
    index = 1

    while index < len(payload):
        object_id = payload[index]
        index += 1

        try:
            if object_id == 0x02:
                if index + 2 > len(payload):
                    break
                temperature = struct.unpack_from("<h", payload, index)[0] / 100.0
                index += 2
            elif object_id == 0x45:
                if index + 2 > len(payload):
                    break
                temperature = struct.unpack_from("<h", payload, index)[0] / 10.0
                index += 2
            elif object_id == 0x03:
                if index + 2 > len(payload):
                    break
                humidity = struct.unpack_from("<H", payload, index)[0] / 100.0
                index += 2
            elif object_id == 0x2E:
                if index + 1 > len(payload):
                    break
                humidity = float(payload[index])
                index += 1
            else:
                size = OBJECT_SIZES.get(object_id)
                if size is None:
                    break
                if index + size > len(payload):
                    break
                index += size
        except struct.error:
            break

    if temperature is not None and not (-60.0 <= temperature <= 120.0):
        temperature = None
    if humidity is not None and not (0.0 <= humidity <= 100.0):
        humidity = None

    if temperature is None and humidity is None:
        return None
    return temperature, humidity


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def load_config(path):
    config = {"history_hours": 24, "auto_add_unknown": True, "sensors": []}

    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            log(f"读取配置失败：{path}（{exc}），使用自动发现模式")
        else:
            if isinstance(raw, dict):
                for key in ("history_hours", "auto_add_unknown", "sensors"):
                    if key in raw:
                        config[key] = raw[key]
            log(f"已加载配置：{path}")
    else:
        log("未找到 config.json，使用自动发现模式")

    try:
        config["history_hours"] = max(
            1.0, min(float(config.get("history_hours") or 24), 168.0)
        )
    except (TypeError, ValueError):
        config["history_hours"] = 24.0

    config["auto_add_unknown"] = bool(config.get("auto_add_unknown", True))
    sensors = config.get("sensors")
    config["sensors"] = sensors if isinstance(sensors, list) else []
    return config


def sensor_patterns(sensor_config):
    raw = sensor_config.get("match")
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    return [str(item).strip().upper() for item in raw if str(item).strip()]


def resolve_config_sensor(config, device_name, address):
    upper_name = (device_name or "").upper()
    upper_address = (address or "").upper()

    for order, sensor_config in enumerate(config["sensors"]):
        if not isinstance(sensor_config, dict):
            continue
        for pattern in sensor_patterns(sensor_config):
            if pattern == upper_name or pattern == upper_address:
                return sensor_config, order
            if upper_name and (
                upper_name.startswith(pattern) or upper_name.endswith(pattern)
            ):
                return sensor_config, order
            if upper_address and upper_address.endswith(pattern):
                return sensor_config, order
    return None, None


def default_color(address):
    digest = hashlib.sha1((address or "unknown").encode("utf-8")).hexdigest()
    return PALETTE[int(digest, 16) % len(PALETTE)]


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


class Store:
    def __init__(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._last_reading = {}
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS sensors (
                    address TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    color TEXT NOT NULL,
                    device_name TEXT,
                    sort_order INTEGER NOT NULL DEFAULT 1000,
                    last_seen REAL
                );

                CREATE TABLE IF NOT EXISTS readings (
                    address TEXT NOT NULL,
                    ts REAL NOT NULL,
                    temperature REAL,
                    humidity REAL
                );

                CREATE INDEX IF NOT EXISTS idx_readings_address_ts
                    ON readings (address, ts);
                """
            )
            self._conn.commit()

    def close(self):
        with self._lock:
            self._conn.close()

    def get_sensor(self, address):
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM sensors WHERE address = ?", (address,)
            ).fetchone()
        return dict(row) if row else None

    def sensor_count(self):
        with self._lock:
            row = self._conn.execute("SELECT COUNT(*) AS n FROM sensors").fetchone()
        return int(row["n"])

    def auto_count(self):
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM sensors WHERE sort_order >= 1000"
            ).fetchone()
        return int(row["n"])

    def upsert_sensor(self, address, name, color, device_name, sort_order, now):
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO sensors
                    (address, name, color, device_name, sort_order, last_seen)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(address) DO UPDATE SET
                    name = excluded.name,
                    color = excluded.color,
                    device_name = COALESCE(excluded.device_name, sensors.device_name),
                    sort_order = excluded.sort_order,
                    last_seen = MAX(
                        COALESCE(sensors.last_seen, 0),
                        COALESCE(excluded.last_seen, 0)
                    )
                """,
                (address, name, color, device_name, sort_order, now),
            )
            self._conn.commit()

    def insert_reading(self, address, ts, temperature, humidity):
        with self._lock:
            self._conn.execute(
                "INSERT INTO readings (address, ts, temperature, humidity)"
                " VALUES (?, ?, ?, ?)",
                (address, ts, temperature, humidity),
            )
            self._conn.commit()

    def add_reading(self, address, ts, temperature, humidity):
        previous = self._last_reading.get(address)
        if previous is not None:
            prev_t, prev_h, prev_ts = previous
            same = _same(prev_t, temperature) and _same(prev_h, humidity)
            # 数值没变化时最多每 5 分钟落一个点，避免图表出现大段空白。
            if same and ts - prev_ts < 300:
                return False
        self.insert_reading(address, ts, temperature, humidity)
        self._last_reading[address] = (temperature, humidity, ts)
        return True

    def latest(self, address):
        with self._lock:
            row = self._conn.execute(
                "SELECT ts, temperature, humidity FROM readings"
                " WHERE address = ? ORDER BY ts DESC LIMIT 1",
                (address,),
            ).fetchone()
        return dict(row) if row else None

    def readings_since(self, address, since):
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT CAST(ts / ? AS INTEGER) * ? AS bucket,
                       AVG(temperature) AS temperature,
                       AVG(humidity) AS humidity
                FROM readings
                WHERE address = ? AND ts >= ?
                GROUP BY bucket
                ORDER BY bucket
                """,
                (BUCKET_SECONDS, BUCKET_SECONDS, address, since),
            ).fetchall()
        return [
            {
                "t": int(row["bucket"]),
                "temperature": _round(row["temperature"], 2),
                "humidity": _round(row["humidity"], 2),
            }
            for row in rows
        ]

    def sensors(self):
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM sensors ORDER BY sort_order, name"
            ).fetchall()
        return [dict(row) for row in rows]

    def prune(self, before):
        with self._lock:
            self._conn.execute("DELETE FROM readings WHERE ts < ?", (before,))
            self._conn.commit()


def _round(value, digits=2):
    return None if value is None else round(float(value), digits)


def _same(a, b):
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) < 1e-9


# ---------------------------------------------------------------------------
# Ingest
# ---------------------------------------------------------------------------


def record_packet(store, config, address, device_name, temperature, humidity):
    now = time.time()
    sensor_config, order = resolve_config_sensor(config, device_name, address)
    existing = store.get_sensor(address)

    if sensor_config is not None:
        name = str(sensor_config.get("name") or device_name or address)
        color = str(sensor_config.get("color") or default_color(address))
        sort_order = int(order)
    elif existing is not None:
        name = existing["name"]
        color = existing["color"]
        sort_order = int(existing["sort_order"])
    elif config["auto_add_unknown"]:
        label = (device_name or "").strip()
        name = label or f"传感器 {store.auto_count() + 1}"
        color = default_color(address)
        sort_order = 1000 + store.auto_count()
        log(f"发现新设备：{name}（{address}）— 可在 config.json 中设置房间名")
    else:
        if address not in _unmatched_devices:
            _unmatched_devices.add(address)
            log(f"未匹配到配置的设备：{device_name or '?'}（{address}）")
        return

    store.upsert_sensor(address, name, color, device_name, sort_order, now)
    store.add_reading(address, now, temperature, humidity)


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


def build_payload(store, config, demo=False):
    now = time.time()
    hours = float(config["history_hours"])
    since = now - hours * 3600
    sensors = []

    for sensor in store.sensors():
        readings = store.readings_since(sensor["address"], since)
        latest = store.latest(sensor["address"])
        last_seen = sensor["last_seen"]
        if latest is not None:
            last_seen = max(last_seen or 0, latest["ts"])

        current = None
        if latest is not None:
            current = {
                "t": round(float(latest["ts"]), 1),
                "temperature": _round(latest["temperature"]),
                "humidity": _round(latest["humidity"]),
            }

        sensors.append(
            {
                "id": sensor["address"],
                "name": sensor["name"],
                "color": sensor["color"],
                "device_name": sensor["device_name"] or "",
                "last_seen": round(float(last_seen), 1) if last_seen else None,
                "current": current,
                "readings": readings,
            }
        )

    return {
        "server_time": round(now, 3),
        "history_hours": hours,
        "demo": demo,
        "sensors": sensors,
    }


class DashboardHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    store = None
    config = None
    demo = False

    def do_GET(self):
        route = urlsplit(self.path).path

        if route == "/api/readings":
            self._send_json(build_payload(self.store, self.config, self.demo))
            return

        if route == "/api/health":
            self._send_json(
                {
                    "ok": True,
                    "sensors": self.store.sensor_count(),
                    "time": round(time.time(), 3),
                }
            )
            return

        super().do_GET()

    def _send_json(self, payload):
        body = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if not urlsplit(self.path).path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            return
        super().log_message(fmt, *args)


# ---------------------------------------------------------------------------
# BLE scanning
# ---------------------------------------------------------------------------


def scan_ble(store, config):
    try:
        from bleak import BleakScanner
    except ImportError:
        log("未安装 bleak，无法扫描蓝牙。")
        log("请运行：uv run --with bleak server.py")
        return

    def on_detection(device, advertisement):
        service_data = getattr(advertisement, "service_data", None) or {}
        for uuid, data in service_data.items():
            key = str(uuid).lower().split('-')[0]
            if not key.endswith("fcd2"):
                continue

            decoded = decode_bthome(bytes(data))
            if decoded is None:
                continue

            temperature, humidity = decoded
            name = (
                getattr(advertisement, "local_name", None)
                or getattr(device, "name", None)
                or ""
            ).strip()

            address = getattr(device, "address", None) or name or "unknown"

            if address not in _seen_devices:
                _seen_devices.add(address)
                log(
                    f"收到 BTHome 广播：{name or '?'}（{address}）"
                    f"温度={temperature} 湿度={humidity}"
                )

            record_packet(
                store, config, address, name, temperature, humidity
            )

    async def run():
        while True:
            try:
                async with BleakScanner(detection_callback=on_detection):
                    log("BLE 扫描已启动（Ctrl+C 停止）")
                    await asyncio.sleep(3600)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # 蓝牙被关闭 / 权限不足等
                hint = ""
                if isinstance(exc, FileNotFoundError):
                    hint = "（检查是否挂载了主机的 /run/dbus/system_bus_socket）"
                log(f"BLE 扫描失败：{exc}{hint}；5 秒后重试")
                await asyncio.sleep(5)

    asyncio.run(run())


# ---------------------------------------------------------------------------
# Demo data
# ---------------------------------------------------------------------------


DEMO_SPECS = [
    ("demo:living-room", "客厅", "#f59e0b", "ATC_DEMO_01", 22.8, 1.6, 46, 6),
    ("demo:bedroom", "卧室", "#a78bfa", "ATC_DEMO_02", 21.4, 1.1, 51, 4),
    ("demo:study", "书房", "#34d399", "ATC_DEMO_03", 23.6, 2.0, 43, 7),
]


def seed_demo(store):
    if store.sensor_count() > 0:
        return

    now = time.time()
    start = now - 24 * 3600

    for order, spec in enumerate(DEMO_SPECS):
        address, name, color, device, base_t, amp_t, base_h, amp_h = spec
        store.upsert_sensor(address, name, color, device, order, now)
        random_source = random.Random(42 + order)
        drift_t = 0.0
        drift_h = 0.0

        for step in range(289):
            ts = start + step * 300
            local = time.localtime(ts)
            hour = local.tm_hour + local.tm_min / 60.0
            phase = math.sin(((hour - 9) / 24.0) * 2 * math.pi + order * 0.4)

            drift_t = drift_t * 0.96 + (random_source.random() - 0.5) * 0.16
            drift_h = drift_h * 0.95 + (random_source.random() - 0.5) * 0.9

            temperature = (
                base_t
                + amp_t * phase
                + drift_t
                + (random_source.random() - 0.5) * 0.08
            )
            humidity = min(
                92.0,
                max(
                    22.0,
                    base_h
                    - amp_h * phase
                    + drift_h
                    + (random_source.random() - 0.5) * 0.6,
                ),
            )
            store.insert_reading(
                address, ts, round(temperature, 2), round(humidity, 2)
            )

    log("已生成 24 小时演示数据")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def parse_args():
    parser = argparse.ArgumentParser(description="BTHome v2 家庭温湿度看板")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址")
    parser.add_argument("--port", type=int, default=8000, help="监听端口")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG), help="配置文件路径")
    parser.add_argument("--db", default=None, help="SQLite 数据库路径")
    parser.add_argument(
        "--demo",
        action="store_true",
        help="使用演示数据（不扫描蓝牙，默认写入 data/demo.sqlite3）",
    )
    parser.add_argument(
        "--no-ble",
        action="store_true",
        help="只提供静态页面和 API，不扫描蓝牙",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    config = load_config(Path(args.config))

    if args.db:
        db_path = Path(args.db)
    elif args.demo:
        db_path = DEFAULT_DEMO_DB
        # 每次演示都重新生成 24 小时数据，避免看到上次运行留下的旧数据。
        for suffix in ("", "-wal", "-shm"):
            stale = Path(str(DEFAULT_DEMO_DB) + suffix)
            if stale.exists():
                stale.unlink()
    else:
        db_path = DEFAULT_DB

    if not PUBLIC_DIR.exists():
        raise SystemExit(f"找不到静态目录：{PUBLIC_DIR}")

    store = Store(db_path)
    store.prune(time.time() - RETENTION_SECONDS)
    if args.demo:
        seed_demo(store)

    DashboardHandler.store = store
    DashboardHandler.config = config
    DashboardHandler.demo = args.demo

    handler = functools.partial(DashboardHandler, directory=str(PUBLIC_DIR))
    try:
        server = ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as exc:
        store.close()
        raise SystemExit(f"无法监听 {args.host}:{args.port}：{exc}")
    display_host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    log(f"看板地址：http://{display_host}:{args.port}")

    if args.demo or args.no_ble:
        if args.demo:
            log("运行在演示模式，不扫描蓝牙")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            log("正在退出…")
        finally:
            server.server_close()
            store.close()
        return

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        # scan_ble 只在无法扫描（如未安装 bleak）时返回；此时继续提供页面。
        scan_ble(store, config)
        log("BLE 扫描未运行；页面和 API 仍然可用，按 Ctrl+C 退出")
        thread.join()
    except KeyboardInterrupt:
        log("正在退出…")
    finally:
        server.shutdown()
        server.server_close()
        store.close()


if __name__ == "__main__":
    main()
