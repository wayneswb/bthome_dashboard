(() => {
  "use strict";

  const API_URL = "./api/readings";
  const REFRESH_MS = 60_000;
  const LIVE_WINDOW_MS = 15 * 60_000;
  const TEMP_COLOR = "#fbbf24";
  const HUM_COLOR = "#38bdf8";

  const el = {
    grid: document.getElementById("grid"),
    badge: document.getElementById("badge"),
    badgeText: document.querySelector("#badge .badge-text"),
    updated: document.getElementById("updated"),
    refresh: document.getElementById("refresh"),
    template: document.getElementById("sensor-card"),
  };

  const params = new URLSearchParams(location.search);

  const state = {
    payload: null,
    mode: "loading",
    fromApi: false,
    error: null,
    loading: false,
    lastLoadedAt: null,
    demoForced: params.has("demo") || location.protocol === "file:",
  };

  let chartSeq = 0;

  /* ------------------------------------------------------------------ */
  /* Data loading                                                       */
  /* ------------------------------------------------------------------ */

  async function fetchPayload() {
    const res = await fetch(API_URL, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.sensors)) {
      throw new Error("接口返回格式不正确");
    }
    return data;
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    el.refresh.disabled = true;
    el.refresh.classList.add("is-spinning");

    try {
      if (state.demoForced) throw new Error("演示模式");
      const raw = await fetchPayload();
      state.payload = normalize(raw, raw.demo ? "demo" : "live");
      state.mode = raw.demo ? "demo" : "live";
      state.fromApi = true;
      state.error = null;
    } catch (err) {
      if (state.fromApi && state.payload) {
        // 已经显示过真实数据时，刷新失败就保留旧数据，只提示连接中断。
        state.mode = "error";
        state.error = err instanceof Error ? err.message : String(err);
      } else {
        state.payload = normalize(makeDemoPayload(), "demo");
        state.mode = "demo";
        state.fromApi = false;
        state.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      state.loading = false;
      state.lastLoadedAt = Date.now();
      el.refresh.disabled = false;
      el.refresh.classList.remove("is-spinning");
      render();
    }
  }

  function normalize(payload, mode) {
    const hours = clamp(Number(payload.history_hours) || 24, 1, 168);
    const serverTime = Number.isFinite(Number(payload.server_time))
      ? Number(payload.server_time) * 1000
      : Date.now();

    const sensors = (payload.sensors || []).map((sensor, index) => {
      const readings = (Array.isArray(sensor.readings) ? sensor.readings : [])
        .map((r) => ({
          t: Number(r.t) * 1000,
          temperature: toNum(r.temperature),
          humidity: toNum(r.humidity),
        }))
        .filter((r) => Number.isFinite(r.t))
        .sort((a, b) => a.t - b.t);

      const current = sensor.current
        ? {
            t: Number(sensor.current.t) * 1000,
            temperature: toNum(sensor.current.temperature),
            humidity: toNum(sensor.current.humidity),
          }
        : null;

      const lastSeen = toNum(sensor.last_seen);

      return {
        id: String(sensor.id ?? index),
        name: String(sensor.name || "未命名"),
        color: safeColor(sensor.color),
        deviceName: String(sensor.device_name || ""),
        lastSeen: lastSeen == null ? null : lastSeen * 1000,
        readings,
        current,
      };
    });

    return { hours, serverTime, demo: mode === "demo", sensors };
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                          */
  /* ------------------------------------------------------------------ */

  const BADGE_TEXT = {
    loading: "连接中…",
    live: "实时数据",
    demo: "演示数据",
    error: "连接中断",
  };

  function render() {
    updateHeader();
    const payload = state.payload;
    if (!payload) return;

    if (payload.sensors.length === 0) {
      el.grid.replaceChildren(renderEmpty());
      return;
    }

    const frag = document.createDocumentFragment();
    for (const sensor of payload.sensors) {
      frag.appendChild(renderCard(sensor, payload));
    }
    el.grid.replaceChildren(frag);
  }

  function updateHeader() {
    el.badge.className = `badge badge--${state.mode}`;
    el.badgeText.textContent = BADGE_TEXT[state.mode] || "—";
    el.badge.title = state.error && state.mode !== "live" ? state.error : "";
    el.updated.textContent = state.lastLoadedAt
      ? `更新于 ${clock(state.lastLoadedAt)}`
      : "—";
  }

  function renderEmpty() {
    const node = document.createElement("div");
    node.className = "empty";
    node.innerHTML =
      '<span class="empty-icon" aria-hidden="true">📡</span>' +
      '<h2 class="empty-title">还没有收到传感器数据</h2>' +
      '<p class="empty-text">确认传感器在附近并正在广播 BTHome v2，' +
      "然后检查 <code>config.json</code> 里的 <code>match</code> 是否与设备广播名一致。" +
      "也可以先用 <code>python3 server.py --demo</code> 预览看板。</p>";
    return node;
  }

  function renderCard(sensor, payload) {
    const node = el.template.content.firstElementChild.cloneNode(true);
    node.style.setProperty("--accent", sensor.color);

    node.querySelector(".room-name").textContent = sensor.name;
    node.querySelector(".device-name").textContent =
      sensor.deviceName || "BTHome 传感器";

    const readings = sensor.readings;
    const lastTemp = lastValue(readings, "temperature");
    const lastHum = lastValue(readings, "humidity");
    const currentTemp = sensor.current?.temperature ?? lastTemp;
    const currentHum = sensor.current?.humidity ?? lastHum;

    node.querySelector(".temp-value").textContent = formatTemp(currentTemp);
    node.querySelector(".hum-value").textContent = formatHum(currentHum);

    const tempValues = readings
      .map((r) => r.temperature)
      .filter((v) => v != null);
    const humValues = readings.map((r) => r.humidity).filter((v) => v != null);

    node.querySelector(".temp-range").textContent = rangeText(
      tempValues,
      (v) => `${v.toFixed(1)}°`
    );
    node.querySelector(".hum-range").textContent = rangeText(
      humValues,
      (v) => `${Math.round(v)}%`
    );

    const online =
      payload.demo ||
      (sensor.lastSeen != null &&
        Date.now() - sensor.lastSeen < LIVE_WINDOW_MS);
    const pill = node.querySelector(".live-pill");
    pill.classList.toggle("is-online", online);
    pill.querySelector(".live-label").textContent = online ? "在线" : "离线";

    node.querySelector(".chart-title").textContent = `最近 ${formatHours(
      payload.hours
    )} 小时`;
    const axisStart = node.querySelector(".axis-start");
    const axisMid = node.querySelector(".axis-mid");
    axisStart.textContent = `${formatHours(payload.hours)} 小时前`;
    axisMid.textContent = `${formatHours(payload.hours / 2)} 小时前`;

    node.querySelector(".card-foot").textContent = sensor.lastSeen
      ? `最后收到数据：${relativeTime(sensor.lastSeen)}`
      : "还没有收到数据";

    const plot = node.querySelector(".chart-plot");
    plot.setAttribute(
      "aria-label",
      `${sensor.name}：温度 ${formatTemp(currentTemp)} 摄氏度，湿度 ${formatHum(
        currentHum
      )}%，最近 ${formatHours(payload.hours)} 小时趋势`
    );

    drawChart(plot, sensor, payload);
    return node;
  }

  /* ------------------------------------------------------------------ */
  /* Chart                                                              */
  /* ------------------------------------------------------------------ */

  function drawChart(plot, sensor, payload) {
    const svg = plot.querySelector(".chart-svg");
    const crosshair = plot.querySelector(".chart-crosshair");
    const tooltip = plot.querySelector(".chart-tooltip");
    const emptyNote = plot.querySelector(".chart-empty");

    const end = payload.serverTime;
    const start = end - payload.hours * 3600_000;
    const readings = sensor.readings;

    const temps = readings.filter((r) => r.temperature != null);
    const hums = readings.filter((r) => r.humidity != null);

    const tempDomain = domainFor(
      temps.map((r) => r.temperature),
      0.5
    );
    const humDomain = domainFor(
      hums.map((r) => r.humidity),
      2
    );

    const topTemp = 46;
    const bottomTemp = 118;
    const topHum = 134;
    const bottomHum = 206;
    const seq = ++chartSeq;

    let markup = "<defs>";
    markup += gradientDef("tg", seq, TEMP_COLOR);
    markup += gradientDef("hg", seq, HUM_COLOR);
    markup += "</defs>";

    markup += baseline(0, topTemp, bottomTemp);
    markup += baseline(0, topHum, bottomHum);

    if (tempDomain && temps.length > 1) {
      const path = seriesPath(
        temps,
        "temperature",
        topTemp,
        bottomTemp,
        tempDomain,
        start,
        end
      );
      markup += `<path d="${path.area}" fill="url(#tg${seq})"></path>`;
      markup += `<path class="chart-line" d="${path.line}" stroke="${TEMP_COLOR}"></path>`;
      markup += lastDot(path.last, TEMP_COLOR);
    } else if (tempDomain && temps.length === 1) {
      const dot = pointFor(temps[0], "temperature", topTemp, bottomTemp, tempDomain, start, end);
      markup += `<circle class="chart-dot" cx="${dot.x}" cy="${dot.y}" r="3" fill="${TEMP_COLOR}"></circle>`;
    }

    if (humDomain && hums.length > 1) {
      const path = seriesPath(
        hums,
        "humidity",
        topHum,
        bottomHum,
        humDomain,
        start,
        end
      );
      markup += `<path d="${path.area}" fill="url(#hg${seq})"></path>`;
      markup += `<path class="chart-line" d="${path.line}" stroke="${HUM_COLOR}"></path>`;
      markup += lastDot(path.last, HUM_COLOR);
    } else if (humDomain && hums.length === 1) {
      const dot = pointFor(hums[0], "humidity", topHum, bottomHum, humDomain, start, end);
      markup += `<circle class="chart-dot" cx="${dot.x}" cy="${dot.y}" r="3" fill="${HUM_COLOR}"></circle>`;
    }

    svg.innerHTML = markup;

    emptyNote.hidden = readings.length > 0;
    if (readings.length === 0) {
      crosshair.hidden = true;
      tooltip.hidden = true;
      return;
    }

    bindHover(plot, sensor, payload, start, end, crosshair, tooltip);
  }

  function gradientDef(prefix, seq, color) {
    return (
      `<linearGradient id="${prefix}${seq}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0%" stop-color="${color}" stop-opacity="0.3"></stop>` +
      `<stop offset="100%" stop-color="${color}" stop-opacity="0"></stop>` +
      `</linearGradient>`
    );
  }

  function baseline(x1, top, bottom) {
    return `<line class="chart-baseline" x1="${x1}" y1="${bottom}" x2="1000" y2="${bottom}"></line>`;
  }

  function seriesPath(readings, key, yTop, yBottom, domain, start, end) {
    const points = readings.map((r) =>
      pointFor(r, key, yTop, yBottom, domain, start, end)
    );
    const line = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(" ");
    const first = points[0];
    const last = points[points.length - 1];
    const area = `${line} L${last.x.toFixed(1)} ${yBottom} L${first.x.toFixed(
      1
    )} ${yBottom} Z`;
    return { line, area, last };
  }

  function lastDot(last, color) {
    return `<circle class="chart-dot" cx="${last.x}" cy="${last.y}" r="2.6" fill="${color}"></circle>`;
  }

  function pointFor(reading, key, yTop, yBottom, domain, start, end) {
    const [lo, hi] = domain;
    const x = clamp(((reading.t - start) / (end - start)) * 1000, 0, 1000);
    const ratio = clamp((reading[key] - lo) / (hi - lo), 0, 1);
    const y = yBottom - ratio * (yBottom - yTop);
    return { x, y };
  }

  function domainFor(values, minPad) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const value of values) {
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    const span = hi - lo;
    const pad = span > 0.05 ? span * 0.18 : minPad;
    return [lo - pad, hi + pad];
  }

  function bindHover(plot, sensor, payload, start, end, crosshair, tooltip) {
    const readings = sensor.readings;
    const ttTime = tooltip.querySelector(".tt-time");
    const ttTemp = tooltip.querySelector(".tt-temp");
    const ttHum = tooltip.querySelector(".tt-hum");
    let fraction = 0.999;

    function show(nextFraction) {
      fraction = clamp(nextFraction, 0, 1);
      const target = start + fraction * (end - start);
      const reading = readings[nearestIndex(readings, target)];
      const xPct = clamp(
        ((reading.t - start) / (end - start)) * 100,
        0,
        100
      );

      crosshair.hidden = false;
      tooltip.hidden = false;
      crosshair.style.left = `${xPct}%`;
      tooltip.style.left = `${clamp(xPct, 6, 94)}%`;
      tooltip.classList.toggle("flip-left", xPct > 78);

      ttTime.textContent = shortDateTime(reading.t);
      ttTemp.textContent =
        reading.temperature == null
          ? "温度 —"
          : `${reading.temperature.toFixed(1)} °C`;
      ttHum.textContent =
        reading.humidity == null
          ? "湿度 —"
          : `${reading.humidity.toFixed(1)} %`;
    }

    function hide() {
      crosshair.hidden = true;
      tooltip.hidden = true;
    }

    plot.addEventListener("pointermove", (event) => {
      const rect = plot.getBoundingClientRect();
      if (!rect.width) return;
      show((event.clientX - rect.left) / rect.width);
    });

    plot.addEventListener("pointerdown", (event) => {
      const rect = plot.getBoundingClientRect();
      if (!rect.width) return;
      show((event.clientX - rect.left) / rect.width);
    });

    plot.addEventListener("pointerleave", hide);
    plot.addEventListener("pointercancel", hide);

    plot.addEventListener("focus", () => show(fraction));
    plot.addEventListener("blur", hide);

    plot.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 0.1 : 0.02;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        show(fraction - step);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        show(fraction + step);
      } else if (event.key === "Home") {
        event.preventDefault();
        show(0);
      } else if (event.key === "End") {
        event.preventDefault();
        show(1);
      } else if (event.key === "Escape") {
        hide();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Demo data                                                          */
  /* ------------------------------------------------------------------ */

  const DEMO_SENSORS = [
    {
      id: "demo-living",
      name: "客厅",
      device: "ATC_DEMO_01",
      color: "#f59e0b",
      baseT: 22.8,
      ampT: 1.6,
      baseH: 46,
      ampH: 6,
      phase: 0.2,
    },
    {
      id: "demo-bedroom",
      name: "卧室",
      device: "ATC_DEMO_02",
      color: "#a78bfa",
      baseT: 21.4,
      ampT: 1.1,
      baseH: 51,
      ampH: 4,
      phase: -0.4,
    },
    {
      id: "demo-study",
      name: "书房",
      device: "ATC_DEMO_03",
      color: "#34d399",
      baseT: 23.6,
      ampT: 2.0,
      baseH: 43,
      ampH: 7,
      phase: 0.6,
    },
  ];

  function makeDemoPayload() {
    const now = Math.floor(Date.now() / 1000);
    const hours = 24;
    const start = now - hours * 3600;
    const step = 300;

    const sensors = DEMO_SENSORS.map((spec, index) => {
      const random = mulberry32(0x9e3779b9 + index * 7919);
      let driftT = 0;
      let driftH = 0;
      const readings = [];

      for (let t = start; t <= now; t += step) {
        const date = new Date(t * 1000);
        const hour = date.getHours() + date.getMinutes() / 60;
        const phase = Math.sin(((hour - 9) / 24) * Math.PI * 2 + spec.phase);

        driftT = driftT * 0.96 + (random() - 0.5) * 0.16;
        driftH = driftH * 0.95 + (random() - 0.5) * 0.9;

        const temperature =
          spec.baseT + spec.ampT * phase + driftT + (random() - 0.5) * 0.08;
        const humidity = clamp(
          spec.baseH - spec.ampH * phase + driftH + (random() - 0.5) * 0.6,
          22,
          92
        );

        readings.push({
          t,
          temperature: round(temperature, 2),
          humidity: round(humidity, 1),
        });
      }

      return {
        id: spec.id,
        name: spec.name,
        color: spec.color,
        device_name: spec.device,
        last_seen: now,
        current: readings[readings.length - 1],
        readings,
      };
    });

    return {
      server_time: now,
      history_hours: hours,
      demo: true,
      sensors,
    };
  }

  function mulberry32(seed) {
    return function random() {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */

  function nearestIndex(readings, t) {
    let lo = 0;
    let hi = readings.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (readings[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    if (
      lo > 0 &&
      Math.abs(readings[lo - 1].t - t) < Math.abs(readings[lo].t - t)
    ) {
      return lo - 1;
    }
    return lo;
  }

  function lastValue(readings, key) {
    for (let i = readings.length - 1; i >= 0; i -= 1) {
      if (readings[i][key] != null) return readings[i][key];
    }
    return null;
  }

  function rangeText(values, formatter) {
    if (!values.length) return "—";
    let min = values[0];
    let max = values[0];
    for (const value of values) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return `最低 ${formatter(min)} · 最高 ${formatter(max)}`;
  }

  function formatTemp(value) {
    return value == null ? "--" : value.toFixed(1);
  }

  function formatHum(value) {
    return value == null ? "--" : String(Math.round(value));
  }

  function formatHours(hours) {
    return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  }

  function toNum(value) {
    if (value == null || value === "") return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function safeColor(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
      ? value
      : TEMP_COLOR;
  }

  function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function clock(ms) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function shortDateTime(ms) {
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(
      d.getMinutes()
    )}`;
  }

  function relativeTime(ms) {
    const diff = Date.now() - ms;
    if (diff < 60_000) return "刚刚";
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
    return `${Math.floor(diff / 86400_000)} 天前`;
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                               */
  /* ------------------------------------------------------------------ */

  el.refresh.addEventListener("click", () => load());

  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      state.lastLoadedAt &&
      Date.now() - state.lastLoadedAt > REFRESH_MS
    ) {
      load();
    }
  });

  setInterval(load, REFRESH_MS);
  load();
})();
