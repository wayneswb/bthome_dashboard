# 家里的温湿度

一个单页温湿度看板：按房间显示当前温度/湿度，以及最近 24 小时的双折线趋势图。数据来自
ATC MiThermometer (V2) 刷第三方固件后广播的 **BTHome v2（未加密）** 报文。

## 特点

- 每个房间一张卡片：当前温度/湿度、24 小时最低/最高、温度与湿度趋势图
- 鼠标悬停（或键盘 `←` `→`）查看任意时间点的读数，触摸屏可点按
- 响应式布局：手机 1 列、平板 2 列、桌面 3 列
- 前端零依赖（原生 JS + SVG + CSS Grid），不需要 Node.js 或构建步骤
- 后端零第三方依赖也能预览；正式扫描蓝牙只需 `bleak`
- 历史数据存 SQLite，接口按 5 分钟降采样，页面每 60 秒刷新

## 快速开始

### 1. 启动服务

```sh
python3 server.py
```

打开 <http://127.0.0.1:8000>。


传感器只要在电脑附近广播 BTHome v2，就会自动出现。默认房间名是设备广播名
（例如 `ATC_a1b2c3`），重启后名称和历史都会保留。

### 3. 给房间起名

```sh
cp config.example.json config.json
```

编辑 `config.json`，把 `match` 改成设备的广播名（或地址），并设置房间名和主题色：

```json
{
  "history_hours": 24,
  "auto_add_unknown": true,
  "sensors": [
    { "name": "客厅", "color": "#f59e0b", "match": ["ATC_a1b2c3"] },
    { "name": "卧室", "color": "#a78bfa", "match": ["ATC_d4e5f6"] },
    { "name": "书房", "color": "#34d399", "match": ["ATC_789abc"] }
  ]
}
```

设备广播名可以这样找：

- 直接看 `server.py` 的启动日志（会打印「收到 BTHome 广播：…」）
- 或运行已安装的 `bthome-logger`
- `match` 支持精确匹配、前缀/后缀匹配；macOS 暴露的是 CoreBluetooth UUID 而不是 MAC，
  所以优先用广播名匹配

修改配置后重启服务即可；历史数据按设备地址保存，改名字不会丢数据。

## 前端独立运行

`public/` 目录可以单独托管在任何静态服务器上（Nginx、GitHub Pages 等）。页面会请求
同源的 `./api/readings`


## API

`GET /api/readings`（时间均为 Unix 秒）：

```json
{
  "server_time": 1763020800.123,
  "history_hours": 24,
  "demo": false,
  "sensors": [
    {
      "id": "AA:BB:CC:DD:EE:FF",
      "name": "客厅",
      "color": "#f59e0b",
      "device_name": "ATC_a1b2c3",
      "last_seen": 1763020798.4,
      "current": { "t": 1763020798.4, "temperature": 22.7, "humidity": 45.8 },
      "readings": [
        { "t": 1762934400, "temperature": 21.9, "humidity": 48.2 }
      ]
    }
  ]
}
```

- `readings`：最近 `history_hours` 小时，按 5 分钟桶做平均
- `current`：最新一条原始读数，用于卡片上的大数字
- `last_seen`：最后一次收到广播的时间，用于在线/离线判断（15 分钟阈值）

如果已有别的方式采集数据（Home Assistant、ESPHome 等），也可以只部署 `public/`，
让同源路径 `/api/readings` 返回上面的格式。

## 目录结构

```
.
├── public/               # 前端（可直接静态托管）
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── server.py             # BLE 扫描 + SQLite + HTTP 服务
├── requirements.txt      # bleak
├── config.example.json   # 房间/颜色配置示例
└── data/                 # SQLite 数据库（自动生成，已 gitignore）
```

## 说明

- **BTHome v2 解析**：监听 0xFCD2 服务数据；校验版本位，跳过加密报文；支持
  温度对象 `0x02`（0.01 °C）和 `0x45`（0.1 °C）、湿度对象 `0x03`（0.01 %）和 `0x2E`（1 %）
- **采样**：ATC 每秒/每几秒广播一次，后端对「数值没变化」的报文最多每 5 分钟落一个点；
  数据库保留 7 天原始数据，接口再按 5 分钟聚合
- **安全**：默认只监听 `127.0.0.1`。如需手机访问可加 `--host 0.0.0.0`，但页面没有鉴权，
  请只在可信局域网内使用

## 可以继续加的功能

- 悬停时联动三张卡片的时间轴
- 1 小时 / 6 小时 / 24 小时 / 7 天切换
- 温度过高/过低、湿度异常提醒
- PWA 离线缓存、推送到手机
- MQTT 或 Home Assistant 集成
