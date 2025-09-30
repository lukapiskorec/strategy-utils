/* Strategy Utils - On-chain price analysis for NFTStrategy™ tokens via GeckoTerminal
   Flow:
    1) Load token (with top pools) for {network}:{tokenAddress}
    2) Pick the most liquid pool
    3) Fetch OHLCV for timeframe/aggregate (USD; token side honored)
    4) Optionally aggregate 1m -> 10m client-side
    Docs:
        - Root & rate limit: https://api.geckoterminal.com/api/v2 (≈30 req/min)
        - Token (+top pools): /networks/{network}/tokens/{address}?include=top_pools
        - OHLCV: /networks/{network}/pools/{pool}/ohlcv/{timeframe}?aggregate=...
*/

const API_ROOT = "https://api.geckoterminal.com/api/v2";

const STEP_MAP = {
    "1m": { tf: "minute", agg: 1, sec: 60, client10m: false },
    "5m": { tf: "minute", agg: 5, sec: 300, client10m: false },
    "10m": { tf: "minute", agg: 1, sec: 600, client10m: true }, // build from 1m
    "15m": { tf: "minute", agg: 15, sec: 900, client10m: false },
    "1h": { tf: "hour", agg: 1, sec: 3600, client10m: false },
    "4h": { tf: "hour", agg: 4, sec: 14400, client10m: false },
    "12h": { tf: "hour", agg: 12, sec: 43200, client10m: false },
    "1d": { tf: "day", agg: 1, sec: 86400, client10m: false },
};

// Fixed network
const FIXED_NETWORK = "eth";

// Predefined Strategy -> contract mapping (Ethereum)
const STRATEGIES = {
    PunkStrategy: "0xc50673EDb3A7b94E8CAD8a7d4E0cD68864E33eDF",
    BirbStrategy: "0x6bcba7cd81a5f12c10ca1bf9b36761cc382658e8",
    DickStrategy: "0x8680acfacb3fed5408764343fc7e8358e8c85a4c",
    ApeStrategy: "0x9ebf91b8d6ff68aa05545301a3d0984eaee54a03",
    PudgyStrategy: "0xb3d6e9e142a785ea8a4f0050fee73bcc3438c5c5",
    MeebitStrategy: "0xc9b2c00f31b210fcea1242d91307a5b1e3b2be68",
    SquiggleStrategy: "0x742fd09cbbeb1ec4e3d6404dfc959a324deb50e6",
    ToadzStrategy: "0x92cedfdbce6e87b595e4a529afa2905480368af4",
};

const els = {
    form: document.getElementById("controls"),
    strategy: document.getElementById("strategy"),
    step: document.getElementById("step"),
    rows: document.getElementById("rows"),
    start: document.getElementById("start"),
    load: document.getElementById("load"),
    stop: document.getElementById("stop"),
    status: document.getElementById("status"),
    tbody: document.getElementById("tbody"),
    ti: {
        wrap: document.getElementById("token-info"),
        name: document.getElementById("ti-name"),
        symbol: document.getElementById("ti-symbol"),
        launch: document.getElementById("ti-launch"),
        age: document.getElementById("ti-age"),
        liq: document.getElementById("ti-liq"),
        vol24: document.getElementById("ti-vol24"),
        mcap: document.getElementById("ti-mcap"),
        contract: document.getElementById("ti-contract"),
        copyContract: document.getElementById("copy-contract"),
        scanLink: document.getElementById("scan-link"),
    },
    table: document.getElementById("prices"),
    colPicker: document.querySelector(".columns-picker"),
    startAtLaunch: document.getElementById("start-at-launch"),
};

// Chart elements
els.chart = document.getElementById("chart");
els.chartTooltip = document.getElementById("chart-tooltip");
els.chartLegend = document.getElementById("chart-legend");
els.chartControls = document.querySelector(".chart-controls");

// Series definitions for the chart
const CHART_SERIES_DEF = {
    open: { label: "Open", color: "#7aa2ff", fmt: (v) => fmt(v) },
    high: { label: "High", color: "#33ff99", fmt: (v) => fmt(v) },
    low: { label: "Low", color: "#ff9f43", fmt: (v) => fmt(v) },
    close: { label: "Close", color: "#00f0ff", fmt: (v) => fmt(v) },
    volume: { label: "Volume", color: "#ffd166", fmt: (v) => fmt(v) },
    mcap: { label: "Market Cap", color: "#ff00ff", fmt: (v) => fmtUSD(v) },
    fee: { label: "Trading fee", color: "#39ff14", fmt: (v) => fmtPercent(v) },
    breakeven: { label: "Breakeven x", color: "#ff4d4d", fmt: (v) => fmtMultiple(v) },
    breakeven_mc: { label: "Breakeven MC", color: "#b967ff", fmt: (v) => fmtUSD(v) },
};

// How much vertical breathing room around data (top & bottom), e.g. 8%
const CHART_Y_PAD_FRAC = 0.08;

// ---- Global app state ----
const state = {
    network: null,
    contract: null,
    tokenAttrs: null,
    chosenPool: null,
    mcapSupply: null,
    launchTs: null,
    hiddenCols: new Set(),

    // chart state lives here from the start
    chart: {
        rows: [],
        seriesKeys: ["close", "mcap"], // defaults (match your checked boxes)
        series: {},                   // populated by buildChartData
    }
};

let aborter = null;

function createTimeGrid(startUnix, endUnix, stepSec) {
    const out = [];
    for (let t = startUnix; t <= endUnix + 1e-9; t += stepSec) out.push(t | 0);
    return out;
}

function renderStrategyCheckboxes(keys) {
    const wrap = document.getElementById("chart-strategy-controls");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (!keys.length) { wrap.hidden = true; return; }
    wrap.hidden = false;

    const title = document.createElement("span");
    title.textContent = "Tokens:";
    wrap.appendChild(title);

    keys.forEach(k => {
        const id = `cs-${k}`;
        const label = document.createElement("label");
        label.setAttribute("for", id);
        label.innerHTML = `<input type="checkbox" id="${id}" data-strat="${k}" checked> ${k}`;
        wrap.appendChild(label);
    });
    // Event delegation (persistent). No { once:true }.
    wrap.onchange = () => rebuildChartFromControls();
}

function getCheckedStrategyKeys() {
    const wrap = document.getElementById("chart-strategy-controls");
    if (!wrap) return Object.keys(state.datasets || {});
    const keys = [];
    wrap.querySelectorAll('input[type="checkbox"][data-strat]').forEach(cb => {
        if (cb.checked) keys.push(cb.getAttribute("data-strat"));
    });
    return keys;
}

function renderInfoBarFromDataset(ds) {
    const t = ds.tokenAttrs || {};
    const mcap = t.market_cap_usd ?? null;
    const fdv = t.fdv_usd ?? null;
    const mcapText = mcap != null ? fmtUSD(mcap) : (fdv != null ? `${fmtUSD(fdv)} (FDV)` : "—");

    els.ti.name.textContent = t.name || "—";
    els.ti.symbol.textContent = t.symbol || "—";
    els.ti.launch.textContent = ds.launchTs ? new Date(ds.launchTs * 1000).toLocaleString() : "—";
    els.ti.age.textContent = humanAge(ds.launchTs);
    els.ti.liq.textContent = fmtUSD(t.total_reserve_in_usd ?? ds?.chosenPool?.reserveUSD ?? null);
    els.ti.vol24.textContent = fmtUSD(t.volume_usd?.h24 ?? null);
    els.ti.mcap.textContent = mcapText;

    // contract + actions
    const addr = ds.address || null;
    const short = shortAddr(addr);
    els.ti.contract.textContent = short;
    els.ti.contract.title = addr || "—";
    const hasAddr = !!addr;
    els.ti.copyContract.hidden = !hasAddr;
    els.ti.copyContract.disabled = !hasAddr;
    els.ti.scanLink.href = hasAddr ? `https://etherscan.io/token/${addr}` : "#";
    els.ti.scanLink.hidden = !hasAddr;

    els.ti.wrap.hidden = false;
}

function buildTableTabs(keys) {
    const tabsEl = document.getElementById("table-tabs");
    if (!tabsEl) return;
    tabsEl.innerHTML = "";
    keys.forEach(k => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "tab" + (k === state.activeTableKey ? " active" : "");
        b.textContent = k;
        b.dataset.key = k;
        b.addEventListener("click", () => switchTableTab(k));
        tabsEl.appendChild(b);
    });
    tabsEl.hidden = !keys.length;
}

function switchTableTab(key) {
    state.activeTableKey = key;
    const ds = state.datasets[key];
    if (!ds) return;

    // IMPORTANT: set supply/launch BEFORE rendering table so MCAP shows
    state.mcapSupply = ds.supply ?? null;
    state.launchTs = ds.launchTs ?? null;

    // info bar + table for the selected dataset
    renderInfoBarFromDataset(ds);
    renderRows(ds.rows || []);

    // Rebuild chart on the same global time grid (no trimming)
    const metricKeys = getCheckedSeriesKeys();
    const stratKeys = getCheckedStrategyKeys();
    buildChartDataMulti(metricKeys, stratKeys);
    drawChart();

    // update tab look
    const tabsEl = document.getElementById("table-tabs");
    if (tabsEl) {
        tabsEl.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.key === key));
    }
}

async function loadOneToken({ network, nameKey, address, step, maxRows, startUnix, endUnix, signal }) {
    // 1) token + pools
    const tokenJson = await fetchTokenWithTopPools(network, address, signal);
    const chosen = pickMostLiquidPool(tokenJson, address);
    if (!chosen?.poolAddress) {
        return { key: nameKey, error: "No pool" };
    }

    // 2) launch + supply
    const tAttrs = tokenJson?.data?.attributes || {};
    const pools = (tokenJson?.included || []).filter(x => x.type === "pool");
    const tsList = pools
        .map(p => Date.parse(p.attributes?.pool_created_at || "") / 1000)
        .filter(x => Number.isFinite(x));
    const launchTs = tsList.length ? Math.min(...tsList) : (chosen?.createdAtISO ? Math.floor(Date.parse(chosen.createdAtISO) / 1000) : null);

    // reference price from attrs or from later candle
    // we'll fallback after OHLCV if needed
    let refPrice = numOrNull(tAttrs.price_usd);

    // 3) candles
    const needByRange = Math.ceil((endUnix - startUnix) / (step.client10m ? 60 : step.sec));
    const rawLimit = Math.min(1000,
        (step.client10m ? Math.max(maxRows * 10, needByRange) + 10
            : Math.max(maxRows, needByRange) + 5));

    const raw = await fetchOHLCV({
        network,
        poolAddress: chosen.poolAddress,
        timeframe: step.tf,
        aggregate: step.client10m ? 1 : step.agg,
        limit: rawLimit,
        beforeTs: endUnix,
        side: chosen.side,
        includeEmpty: true,
        signal
    });

    const asc = raw.slice().sort((a, b) => a.ts - b.ts);
    const series = step.client10m ? aggregateTo10m(asc) : asc;
    const rows = series.filter(k => k.ts >= startUnix && k.ts <= endUnix).slice(0, maxRows);

    if (!refPrice && rows.length) refPrice = rows[rows.length - 1].c ?? null;

    const supply = deriveSupplyForMcap(tAttrs || {}, refPrice);

    return {
        key: nameKey,
        address,
        tokenAttrs: tAttrs,
        chosenPool: chosen,
        launchTs,
        supply,
        rows
    };
}

function buildChartDataMulti(seriesKeys, stratKeys) {
    const dsMap = state.datasets || {};
    const grid = state.chart.timeGrid || [];           // canonical timestamps
    const N = grid.length;

    const combined = {};       // "<strategy>:<series>" -> array of length N
    const combinedKeys = [];

    const dashBook = [[], [6, 3], [3, 3], [8, 3, 2, 3], [2, 4], [1, 2]];
    state.chart.strokeStyles = {}; // reset style map

    stratKeys.forEach((sk, si) => {
        const ds = dsMap[sk];
        if (!ds) return;
        const supply = ds.supply;
        const launchTs = ds.launchTs;

        // map dataset rows by timestamp for O(1) lookup
        const byTs = new Map((ds.rows || []).map(r => [r.ts, r]));

        for (const ser of seriesKeys) {
            const key = `${sk}:${ser}`;
            combinedKeys.push(key);
            const arr = new Array(N);

            for (let i = 0; i < N; i++) {
                const ts = grid[i];
                const r = byTs.get(ts);
                let val = null;
                if (r) {
                    switch (ser) {
                        case "open": val = r.o; break;
                        case "high": val = r.h; break;
                        case "low": val = r.l; break;
                        case "close": val = r.c; break;
                        case "volume": val = r.v; break;
                        case "mcap": val = (supply != null && r?.c != null) ? r.c * supply : null; break;
                        case "fee": val = Number.isFinite(launchTs) ? computeTradingFeePercentFor(launchTs, ts) : 10; break;
                        case "breakeven": {
                            if (Number.isFinite(launchTs)) {
                                const feePct = computeTradingFeePercentFor(launchTs, ts);
                                val = breakevenMultipleFromFee(feePct);
                            }
                        } break;
                        case "breakeven_mc": {
                            if (Number.isFinite(launchTs) && supply != null && r?.c != null) {
                                const feePct = computeTradingFeePercentFor(launchTs, ts);
                                const mult = breakevenMultipleFromFee(feePct);
                                val = (mult != null) ? mult * (r.c * supply) : null;
                            }
                        } break;
                    }
                }
                arr[i] = (val == null || !isFinite(val)) ? null : val;
            }

            combined[key] = arr;
            const cfg = CHART_SERIES_DEF[ser];
            state.chart.strokeStyles[key] = { color: (cfg?.color || "#fff"), dash: dashBook[si % dashBook.length] };
        }
    });

    // Commit: x-axis uses the global grid; overlay uses combined arrays
    state.chart.rows = grid.map(ts => ({ ts }));
    state.chart.seriesCombined = combined;
    state.chart.combinedKeys = combinedKeys;
    // IMPORTANT: keep state.chart.seriesKeys = the metric list (unchanged)
}


function getCheckedSeriesKeys() {
    if (!els.chartControls) return [];
    const keys = [];
    els.chartControls.querySelectorAll('input[type="checkbox"][data-ser]').forEach(cb => {
        if (cb.checked) keys.push(cb.getAttribute("data-ser"));
    });
    return keys;
}

function rebuildChartFromControls() {
    const metricKeys = getCheckedSeriesKeys();               // e.g., ["close","mcap"]
    const isAllMode = !!(state.datasets && Object.keys(state.datasets).length);

    if (isAllMode) {
        const stratKeys = getCheckedStrategyKeys();            // selected strategies
        // If nothing selected, show nothing (axes still draw).
        state.chart.seriesKeys = metricKeys.slice();           // store chosen metrics (used by builder)
        buildChartDataMulti(metricKeys, stratKeys);            // (re)build combined series
    } else {
        // single token
        state.chart.seriesKeys = metricKeys.slice();
        const rows = (state.datasets && state.activeTableKey && state.datasets[state.activeTableKey])
            ? (state.datasets[state.activeTableKey].rows || [])
            : (state.chart.rows || []);
        buildChartData(rows);                                  // your existing single-token builder
    }

    drawChart();                                             // always redraw
}

function wireChartControlHandlers() {
    // Metric series checkboxes
    if (els.chartControls) {
        els.chartControls.onchange = () => rebuildChartFromControls();
    }
    // Strategy toggles (the container is static; its content is replaced)
    const stratWrap = document.getElementById("chart-strategy-controls");
    if (stratWrap) {
        stratWrap.onchange = () => rebuildChartFromControls();
    }
    // Redraw on resize
    window.addEventListener("resize", () => drawChart());
}

function computeTradingFeePercentFor(launchTs, tsSec) {
    if (!Number.isFinite(launchTs)) return 10;
    const delta = tsSec - launchTs;
    if (delta < 0) return 95;
    const minutes = Math.floor(delta / 60);
    const fee = 95 - minutes;
    return Math.max(10, fee);
}

function buildChartData(rows) {
    const keys = state.chart.seriesKeys;
    const series = {};
    // Precompute derived columns per row (same logic as renderRows)
    const supply = state.mcapSupply;
    const rowCalc = rows.map(r => {
        const mcap = (supply != null && r?.c != null) ? r.c * supply : null;
        const feePct = computeTradingFeePercent(r.ts);
        const bMultiple = breakevenMultipleFromFee(feePct);
        const bMC = (bMultiple != null && mcap != null) ? (bMultiple * mcap) : null;
        return { ...r, mcap, feePct, bMultiple, bMC };
    });

    keys.forEach(k => {
        switch (k) {
            case "open": series[k] = rowCalc.map(r => r.o ?? null); break;
            case "high": series[k] = rowCalc.map(r => r.h ?? null); break;
            case "low": series[k] = rowCalc.map(r => r.l ?? null); break;
            case "close": series[k] = rowCalc.map(r => r.c ?? null); break;
            case "volume": series[k] = rowCalc.map(r => r.v ?? null); break;
            case "mcap": series[k] = rowCalc.map(r => r.mcap ?? null); break;
            case "fee": series[k] = rowCalc.map(r => r.feePct ?? null); break;
            case "breakeven": series[k] = rowCalc.map(r => r.bMultiple ?? null); break;
            case "breakeven_mc": series[k] = rowCalc.map(r => r.bMC ?? null); break;
        }
    });

    state.chart.rows = rows;
    state.chart.series = series;
}

function niceTicks(min, max, target = 6) {
    if (!isFinite(min) || !isFinite(max) || min === max) {
        const v = isFinite(min) ? min : (isFinite(max) ? max : 0);
        return [v - 1, v, v + 1];
    }
    const span = max - min;
    const step = Math.pow(10, Math.floor(Math.log10(span / target)));
    const err = (span / target) / step;
    const mult = err >= 7.5 ? 10 : err >= 3 ? 5 : err >= 1.5 ? 2 : 1;
    const niceStep = mult * step;
    const niceMin = Math.floor(min / niceStep) * niceStep;
    const niceMax = Math.ceil(max / niceStep) * niceStep;
    const ticks = [];
    for (let v = niceMin; v <= niceMax + 1e-12; v += niceStep) ticks.push(v);
    return ticks;
}



function drawChart() {
    const canvas = els.chart;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    // Hi-DPI
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // legend reset
    if (els.chartLegend) els.chartLegend.innerHTML = "";

    const rows = state.chart.rows || [];
    const n = rows.length;

    // detect ALL-mode (overlay) by presence of datasets and combined keys
    const isAllMode = !!(state.datasets && Object.keys(state.datasets || {}).length) && Array.isArray(state.chart.combinedKeys);
    const keys = isAllMode ? (state.chart.combinedKeys || []) : (state.chart.seriesKeys || []);
    const series = isAllMode ? (state.chart.seriesCombined || {}) : (state.chart.series || {});

    if (!n || !keys.length) {
        drawEmpty(ctx, cssW, cssH);
        // still draw a left axis line so it's not "empty"
        const pad = { top: 12, right: 56, bottom: 22, left: 8 };
        ctx.strokeStyle = "rgba(255,255,255,.1)";
        ctx.beginPath(); ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, cssH - pad.bottom); ctx.stroke();
        // bind hover to a harmless noop scale
        return bindChartHover(pad.left, pad.top, cssW - pad.left - pad.right, cssH - pad.top - pad.bottom,
            i => 0, v => 0, 0, 1);
    }

    // min/max across visible series
    let min = +Infinity, max = -Infinity;
    keys.forEach(k => {
        (series[k] || []).forEach(v => {
            if (v == null || !isFinite(v)) return;
            if (v < min) min = v; if (v > max) max = v;
        });
    });
    if (!isFinite(min) || !isFinite(max)) { drawEmpty(ctx, cssW, cssH); return; }
    if (min === max) { min -= 1; max += 1; }

    // vertical padding
    const span = max - min;
    const padAmt = Math.max(span * CHART_Y_PAD_FRAC, 1e-6);
    const minP = min - padAmt;
    const maxP = max + padAmt;

    // layout
    const pad = { top: 12, right: 56, bottom: 22, left: 8 };
    const x0 = pad.left, y0 = pad.top;
    const PW = cssW - pad.left - pad.right;
    const PH = cssH - pad.top - pad.bottom;

    // scales
    const xAt = i => x0 + (n <= 1 ? 0 : (PW * (i / (n - 1))));
    const yAt = v => y0 + PH - ((v - minP) / (maxP - minP)) * PH;

    // grid + right axis
    ctx.font = "12px " + getComputedStyle(document.body).getPropertyValue("--mono");
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "rgba(255,255,255,.1)";
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--text") || "#fff";
    const ticks = niceTicks(minP, maxP, 6);
    const axisKeys = isAllMode ? keys.map(k => k.includes(":") ? k.split(":").pop() : k) : keys;
    ticks.forEach(t => {
        const y = yAt(t);
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + PW, y); ctx.stroke();
        const label = formatForAxis(t, axisKeys);
        ctx.fillText(label, x0 + PW + 44, y);
    });

    // x labels
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    const s0 = new Date(rows[0].ts * 1000).toLocaleString();
    const s1 = new Date(rows[n - 1].ts * 1000).toLocaleString();
    ctx.fillText(s0, x0, y0 + PH + 4);
    const w = ctx.measureText(s1).width;
    ctx.fillText(s1, x0 + PW - w, y0 + PH + 4);

    // line style helper
    const getStyle = (key) => {
        if (!isAllMode) {
            const plain = key.includes(":") ? key.split(":").pop() : key;
            const cfg = CHART_SERIES_DEF[plain] || {};
            return { color: cfg.color || "#fff", dash: [] };
        }
        return (state.chart.strokeStyles && state.chart.strokeStyles[key]) || { color: "#fff", dash: [] };
    };

    // lines
    keys.forEach(k => {
        const data = series[k] || [];
        const { color, dash } = getStyle(k);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash(dash);
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
            const v = data[i];
            if (v == null || !isFinite(v)) { started = false; continue; }
            const x = xAt(i), y = yAt(v);
            if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
    });
    ctx.setLineDash([]);

    // legends
    renderLegend(getCheckedSeriesKeys()); // metric legend
    // strategy dash legend (only in ALL mode)
    if (isAllMode && els.chartLegend) {
        const stratKeys = getCheckedStrategyKeys();
        if (stratKeys.length) {
            const dashBook = [[], [6, 3], [3, 3], [8, 3, 2, 3], [2, 4], [1, 2]];
            const stratLegend = document.createElement("div");
            stratLegend.style.marginTop = "6px";
            stratLegend.style.display = "flex";
            stratLegend.style.flexWrap = "wrap";
            stratLegend.style.gap = "8px";
            stratLegend.style.alignItems = "center";
            stratLegend.style.fontSize = "11px";
            stratLegend.style.color = getComputedStyle(document.body).getPropertyValue("--muted") || "#ccc";
            stratKeys.forEach((sk, si) => {
                const sw = document.createElement("span");
                sw.style.color = "#ff1ad9";
                sw.innerHTML = `<span class="dash" style="border-top-style:${(dashBook[si % dashBook.length].length ? 'dashed' : 'solid')}"></span>${sk}`;
                stratLegend.appendChild(sw);
            });
            els.chartLegend.appendChild(stratLegend);
        }
    }

    // hover (uses padded range)
    bindChartHover(x0, y0, PW, PH, xAt, yAt, minP, maxP);
}

function drawEmpty(ctx, W, H) {
    ctx.fillStyle = "rgba(255,255,255,.3)";
    ctx.font = "12px " + getComputedStyle(document.body).getPropertyValue("--mono");
    ctx.fillText("No data to plot.", 8, 8);
}

function renderLegend(keys) {
    if (!els.chartLegend) return;
    els.chartLegend.innerHTML = "";
    keys.forEach(k => {
        const cfg = CHART_SERIES_DEF[k];
        const item = document.createElement("span");
        item.innerHTML = `<span class="swatch" style="background:${cfg.color}"></span>${cfg.label}`;
        els.chartLegend.appendChild(item);
    });
}

function formatForAxis(v, keys) {
    // If any USD series is selected, prefer compact USD axis labels; else plain numbers
    const hasUSD = keys.some(k => k === "mcap" || k === "breakeven_mc");
    if (hasUSD) {
        if (Math.abs(v) >= 100000) return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(v);
        return Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v);
    }
    // mixed units → generic formatting
    if (Math.abs(v) >= 100000) return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(v);
    return Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v);
}

function bindChartHover(x0, y0, PW, PH, xAt, yAt, min, max) {
    const canvas = els.chart, tip = els.chartTooltip;
    if (!canvas || !tip) return;

    const rows = state.chart.rows || [];
    const isAllMode = !!(state.datasets && Object.keys(state.datasets || {}).length) && Array.isArray(state.chart.combinedKeys);
    const keysDraw = isAllMode ? (state.chart.combinedKeys || []) : (state.chart.seriesKeys || []);
    const series = isAllMode ? (state.chart.seriesCombined || {}) : (state.chart.series || {});

    // style resolver
    function getSeriesStyle(key) {
        if (isAllMode) {
            const style = (state.chart.strokeStyles || {})[key];
            if (style && style.color) return style;
            const seriesId = key.includes(":") ? key.split(":").pop() : key;
            const cfg = CHART_SERIES_DEF[seriesId] || {};
            return { color: cfg.color || "#fff", dash: [] };
        } else {
            const seriesId = key.includes(":") ? key.split(":").pop() : key;
            const cfg = CHART_SERIES_DEF[seriesId] || {};
            return { color: cfg.color || "#fff", dash: [] };
        }
    }

    function plainSeriesIds(keys) {
        return keys.map(k => (k.includes(":") ? k.split(":").pop() : k));
    }

    function onMove(ev) {
        const rect = canvas.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;

        if (mx < x0 || mx > x0 + PW || my < y0 || my > y0 + PH) {
            tip.hidden = true;
            drawChart();
            return;
        }

        const n = rows.length;
        const i = Math.max(0, Math.min(n - 1, Math.round((mx - x0) / (PW / (n - 1 || 1)))));

        drawChartBaseOnly(); // base redraw
        const ctx = canvas.getContext("2d");
        ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);

        const px = xAt(i);

        // guide
        ctx.strokeStyle = "rgba(255,255,255,.4)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px, y0); ctx.lineTo(px, y0 + PH); ctx.stroke();

        // points
        keysDraw.forEach(k => {
            const val = series[k]?.[i];
            if (val == null || !isFinite(val)) return;
            const py = yAt(val);
            const { color } = getSeriesStyle(k);
            ctx.fillStyle = color;
            ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
        });

        // tooltip
        const dtStr = new Date(rows[i].ts * 1000).toLocaleString();
        let html = `<div class="ts"><strong>${dtStr}</strong></div>`;
        keysDraw.forEach(k => {
            const val = series[k]?.[i];
            if (val == null || !isFinite(val)) return;
            const seriesId = k.includes(":") ? k.split(":").pop() : k;
            const cfg = CHART_SERIES_DEF[seriesId];
            const label = (cfg && cfg.label) ? cfg.label : seriesId;
            const { color } = getSeriesStyle(k);
            const fmtFn = (cfg && cfg.fmt) ? cfg.fmt : (v => String(v));
            html += `<div><span style="color:${color}">●</span> ${label}: ${fmtFn(val)}</div>`;
        });
        tip.innerHTML = html;
        tip.hidden = false;

        // clamp inside plot
        const tipRect = tip.getBoundingClientRect();
        const spaceAbove = (my - y0);
        const spaceBelow = (y0 + PH) - my;
        let tx = px + 10;
        let ty;
        if (spaceBelow >= tipRect.height + 8) ty = my + 8;
        else if (spaceAbove >= tipRect.height + 8) ty = my - tipRect.height - 8;
        else ty = Math.min(y0 + PH - tipRect.height - 4, Math.max(y0 + 4, my + 8));
        const maxLeft = (x0 + PW) - tipRect.width - 8;
        tx = Math.max(x0 + 8, Math.min(tx, maxLeft));
        tip.style.left = `${tx}px`;
        tip.style.top = `${ty}px`;
    }

    function onLeave() {
        tip.hidden = true;
        drawChart();
    }

    canvas.onmousemove = onMove;
    canvas.onmouseleave = onLeave;

    // base redraw shared with hover
    function drawChartBaseOnly() {
        const ctx = canvas.getContext("2d");
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.clientWidth || canvas.width;
        const cssH = canvas.clientHeight || canvas.height;
        if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
            canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        // axes
        const ticks = niceTicks(min, max, 6);
        ctx.font = "12px " + getComputedStyle(document.body).getPropertyValue("--mono");
        const pad = { top: 12, right: 56, bottom: 22, left: 8 };
        const x0b = pad.left, y0b = pad.top;
        const PWb = cssW - pad.left - pad.right;
        const PHb = cssH - pad.top - pad.bottom;
        ctx.strokeStyle = "rgba(255,255,255,.1)";
        ctx.textAlign = "right"; ctx.textBaseline = "middle";
        const plainKeys = plainSeriesIds(keysDraw);
        ticks.forEach(t => {
            const y = y0b + PHb - ((t - min) / (max - min)) * PHb;
            ctx.beginPath(); ctx.moveTo(x0b, y); ctx.lineTo(x0b + PWb, y); ctx.stroke();
            const label = formatForAxis(t, plainKeys);
            ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--text") || "#fff";
            ctx.fillText(label, x0b + PWb + 44, y);
        });

        // x labels
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        if (rows.length > 0) {
            const s0 = new Date(rows[0].ts * 1000).toLocaleString();
            const s1 = new Date(rows[rows.length - 1].ts * 1000).toLocaleString();
            ctx.fillText(s0, x0b, y0b + PHb + 4);
            const w = ctx.measureText(s1).width;
            ctx.fillText(s1, x0b + PWb - w, y0b + PHb + 4);
        }

        // lines
        keysDraw.forEach(k => {
            const data = series[k] || [];
            const { color, dash } = getSeriesStyle(k);
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.setLineDash(dash || []);
            ctx.beginPath();
            let started = false;
            for (let i = 0; i < data.length; i++) {
                const v = data[i];
                if (v == null || !isFinite(v)) { started = false; continue; }
                const x = x0b + (data.length <= 1 ? 0 : (PWb * (i / (data.length - 1))));
                const y = y0b + PHb - ((v - min) / (max - min)) * PHb;
                if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
            }
            ctx.stroke();
        });
        ctx.setLineDash([]);
    }
}

// Trading fee schedule:
// minute 0 after launch: 95%
// then -1% per minute until minute 85 reaches 10%
// after that: flat 10%. If launchTs missing, default to 10%.
function computeTradingFeePercent(tsSec) {
    const launch = state.launchTs;
    if (!Number.isFinite(launch)) return 10;
    const delta = tsSec - launch;
    if (delta < 0) return 95; // edge: before launch
    const minutes = Math.floor(delta / 60);
    const fee = 95 - minutes;
    return Math.max(10, fee);
}

function breakevenMultipleFromFee(pct) {
    if (pct == null || !isFinite(pct)) return null;
    const denom = 100 - pct;
    if (denom <= 0) return null;
    return 100 / denom;
}

function fmtPercent(p) {
    if (p == null || !isFinite(p)) return "—";
    // whole percent display (e.g., 95%, 10%)
    return `${Math.round(p)}%`;
}

function fmtMultiple(x) {
    if (x == null || !isFinite(x)) return "—";
    const r = Math.round(x * 100) / 100;
    // nice: drop trailing .00 (so 20x instead of 20.00x)
    return (Math.abs(r - Math.round(r)) < 1e-9) ? `${Math.round(r)}x` : `${r.toFixed(2)}x`;
}

async function prefillStartFromLaunch() {
    if (!els.startAtLaunch?.checked) return;
    const contract = getSelectedContract();
    if (!contract) return;
    try {
        const json = await fetchTokenWithTopPools(FIXED_NETWORK, contract);
        const launchTs = computeLaunchTsFromTokenJson(json);
        if (launchTs) {
            state.launchTs = launchTs;
            els.start.value = dateToLocalInput(new Date(launchTs * 1000));
        }
    } catch (_) { /* ignore prefill errors */ }
}

function computeLaunchTsFromTokenJson(tokenJson) {
    const pools = (tokenJson?.included || []).filter(x => x.type === "pool");
    const tsList = pools
        .map(p => Date.parse(p.attributes?.pool_created_at || "") / 1000)
        .filter((x) => Number.isFinite(x));
    return tsList.length ? Math.min(...tsList) : null;
}

async function copyTextToClipboard(text) {
    if (!text) return false;
    // Try modern API first (works on https or localhost)
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (_) { /* fall through */ }

    // Fallback: temporary textarea + execCommand
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
    } catch (_) {
        return false;
    }
}

function shortAddr(addr) {
    if (!addr) return "—";
    const a = String(addr);
    return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function getSelectedContract() {
    const key = (els.strategy?.value || "").trim();
    if (key === "__ALL__") return null; // special all-mode
    return STRATEGIES[key] || null;
}

function numOrNull(x) {
    if (x == null) return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
}

function normalizeFromTotal(totalSupplyRaw, decimals) {
    const t = numOrNull(totalSupplyRaw);
    const d = Number(decimals || 0);
    if (t == null) return null;
    // Guard against absurd decimals
    if (!Number.isFinite(d) || d < 0 || d > 36) return null;
    return t / Math.pow(10, d);
}

/**
 * Pick a supply (tokens) for historical Market Cap = price_usd_at_ts × supply.
 * Priority:
 *   1) normalized_circulating_supply (if present)
 *   2) circulating_supply (assumed normalized)
 *   3) normalized_total_supply
 *   4) total_supply normalized via `decimals`
 *   5) market_cap_usd / refPrice
 *   6) fdv_usd / refPrice
 */
function deriveSupplyForMcap(tokenAttrs, refPrice) {
    const price = numOrNull(refPrice);
    const dec = tokenAttrs?.decimals;

    const normCirc = numOrNull(tokenAttrs?.normalized_circulating_supply);
    if (normCirc != null && normCirc > 0) return normCirc;

    const circ = numOrNull(tokenAttrs?.circulating_supply);
    if (circ != null && circ > 0) return circ;

    const normTotal = numOrNull(tokenAttrs?.normalized_total_supply);
    if (normTotal != null && normTotal > 0) return normTotal;

    const totalRaw = tokenAttrs?.total_supply; // raw base units (string/number)
    const normFromRaw = normalizeFromTotal(totalRaw, dec);
    if (normFromRaw != null && normFromRaw > 0) return normFromRaw;

    // Fallbacks (need price)
    if (price && price > 0) {
        const mcap = numOrNull(tokenAttrs?.market_cap_usd);
        if (mcap != null && mcap > 0) return mcap / price;

        const fdv = numOrNull(tokenAttrs?.fdv_usd);
        if (fdv != null && fdv > 0) return fdv / price;
    }

    return null;
}


function fmtUSD(n, maxDp = 2) {
    if (n == null || Number.isNaN(n)) return "—";
    const num = Number(n);
    if (Math.abs(num) >= 100000) return Intl.NumberFormat(undefined, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(num);
    return Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: maxDp }).format(num);
}

function humanAge(fromTsSec) {
    if (!fromTsSec) return "—";
    const ms = Date.now() - fromTsSec * 1000;
    if (ms <= 0) return "just now";
    const s = Math.floor(ms / 1000);
    const y = Math.floor(s / (365 * 24 * 3600));
    const mo = Math.floor((s % (365 * 24 * 3600)) / (30 * 24 * 3600));
    const d = Math.floor((s % (30 * 24 * 3600)) / (24 * 3600));
    const h = Math.floor((s % (24 * 3600)) / 3600);
    const parts = [];
    if (y) parts.push(`${y}y`);
    if (mo) parts.push(`${mo}m`);
    if (d && parts.length < 2) parts.push(`${d}d`);
    if (!parts.length) parts.push(`${h}h`);
    return parts.join(" ");
}

function pad(n) { return String(n).padStart(2, "0"); }
function dateToLocalInput(dt) {
    const y = dt.getFullYear(), m = pad(dt.getMonth() + 1), d = pad(dt.getDate());
    const hh = pad(dt.getHours()), mm = pad(dt.getMinutes());
    return `${y}-${m}-${d}T${hh}:${mm}`;
}
function localInputToDate(v) { return v ? new Date(v) : null; }
function fmt(n, dp = 8) {
    if (n === null || n === undefined || Number.isNaN(n)) return "—";
    if (Math.abs(n) >= 100000) return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(n);
    const s = Number(n).toFixed(Math.min(dp, 8));
    return s.replace(/\.?0+$/, "");
}
function setStatus(t, busy = false) {
    els.status.textContent = t;
    els.load.disabled = busy;
    els.stop.disabled = !busy;
    els.status.classList.toggle("busy", !!busy);
}

function normAddr(a) { return (a || "").toLowerCase(); }

async function gtFetch(path, { signal } = {}) {
    const res = await fetch(`${API_ROOT}${path}`, { signal, headers: { "accept": "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    return res.json();
}

async function fetchTokenWithTopPools(network, tokenAddress, signal) {
    const include = "top_pools";
    const path = `/networks/${encodeURIComponent(network)}/tokens/${encodeURIComponent(tokenAddress)}?include=${include}`;
    const json = await gtFetch(path, { signal });
    return json; // { data: token, included: [pools] }
}

function pickMostLiquidPool(tokenJson, tokenAddress) {
    const data = tokenJson?.included?.filter(x => x.type === "pool") || [];
    if (!data.length) return null;

    // Sort by reserve_in_usd desc (fallback 24h volume)
    data.sort((a, b) => {
        const ra = Number(a.attributes?.reserve_in_usd || 0);
        const rb = Number(b.attributes?.reserve_in_usd || 0);
        if (rb !== ra) return rb - ra;
        const va = Number(a.attributes?.volume_usd?.h24 || 0);
        const vb = Number(b.attributes?.volume_usd?.h24 || 0);
        return vb - va;
    });

    const pool = data[0];
    const baseId = pool?.relationships?.base_token?.data?.id || "";
    const quoteId = pool?.relationships?.quote_token?.data?.id || "";
    const base = { address: (baseId.includes("_") ? baseId.split("_")[1] : baseId) };
    const quote = { address: (quoteId.includes("_") ? quoteId.split("_")[1] : quoteId) };

    const t = normAddr(tokenAddress);
    const side = normAddr(quote.address) === t ? "quote" : "base";

    return {
        poolAddress: pool.attributes?.address,
        reserveUSD: Number(pool.attributes?.reserve_in_usd || 0),
        dexName: pool.attributes?.dex_name || "—",
        base, quote, side,
        createdAtISO: pool.attributes?.pool_created_at || null
    };
}


// Step 2: OHLCV for pool
async function fetchOHLCV({ network, poolAddress, timeframe, aggregate, limit, beforeTs, side, signal, includeEmpty }) {
    const params = new URLSearchParams();
    params.set("aggregate", String(aggregate));
    params.set("limit", String(limit));
    if (beforeTs) params.set("before_timestamp", String(beforeTs));
    params.set("currency", "usd");
    if (includeEmpty) params.set("include_empty_intervals", "true");
    if (side === "quote" || side === "base") params.set("token", side);

    const path = `/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe}?${params.toString()}`;
    const json = await gtFetch(path, { signal });
    const list = json?.data?.attributes?.ohlcv_list || [];
    // Each entry: [timestamp, open, high, low, close, volume]
    return list.map(a => ({
        ts: a[0], o: a[1], h: a[2], l: a[3], c: a[4], v: a[5]
    }));
}

// Client-side 10m aggregation from 1m candles
function aggregateTo10m(oneMin) {
    // Group by floor(ts/600)*600
    const buckets = new Map();
    for (const k of oneMin) {
        const key = Math.floor(k.ts / 600) * 600;
        const b = buckets.get(key);
        if (!b) {
            buckets.set(key, { ts: key, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, firstTs: k.ts, lastTs: k.ts });
        } else {
            b.h = Math.max(b.h, k.h);
            b.l = Math.min(b.l, k.l);
            // choose open of earliest, close of latest
            if (k.ts < b.firstTs) { b.o = k.o; b.firstTs = k.ts; }
            if (k.ts > b.lastTs) { b.c = k.c; b.lastTs = k.ts; }
            b.v += k.v;
        }
    }
    return Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
}

function updateInfoBarFromToken(tokenJson, chosenPool) {
    const token = tokenJson?.data?.attributes || {};
    // Earliest pool_created_at among included pools (proxy for “launch” on GT)
    const pools = (tokenJson?.included || []).filter(x => x.type === "pool");
    const tsList = pools
        .map(p => Date.parse(p.attributes?.pool_created_at || "") / 1000 || Infinity)
        .filter(x => Number.isFinite(x));
    const launchTs = tsList.length ? Math.min(...tsList) : (chosenPool?.createdAtISO ? Math.floor(Date.parse(chosenPool.createdAtISO) / 1000) : null);
    state.launchTs = launchTs; // remember for “At Launch”

    const mcap = token.market_cap_usd ?? null;
    const fdv = token.fdv_usd ?? null;
    const mcapText = mcap != null ? fmtUSD(mcap) : (fdv != null ? `${fmtUSD(fdv)} (FDV)` : "—");

    els.ti.name.textContent = token.name || "—";
    els.ti.symbol.textContent = token.symbol || "—";
    els.ti.launch.textContent = launchTs ? new Date(launchTs * 1000).toLocaleString() : "—";
    els.ti.age.textContent = humanAge(launchTs);
    els.ti.liq.textContent = fmtUSD(token.total_reserve_in_usd ?? chosenPool?.reserveUSD ?? null);
    els.ti.vol24.textContent = fmtUSD(token.volume_usd?.h24 ?? null);
    els.ti.mcap.textContent = mcapText;

    // Show selected contract + actions
    const selectedAddr = getSelectedContract();
    const short = shortAddr(selectedAddr);
    els.ti.contract.textContent = short;
    els.ti.contract.title = selectedAddr || "—";

    // Enable/hide buttons depending on availability
    const hasAddr = !!selectedAddr;
    els.ti.copyContract.hidden = !hasAddr;
    els.ti.copyContract.disabled = !hasAddr;

    // Etherscan (fixed to Ethereum mainnet)
    els.ti.scanLink.href = hasAddr ? `https://etherscan.io/token/${selectedAddr}` : "#";
    els.ti.scanLink.target = "_blank";
    els.ti.scanLink.rel = "noopener";
    els.ti.scanLink.hidden = !hasAddr;

    els.ti.wrap.hidden = false;
}

function renderRows(rows) {
    els.tbody.innerHTML = "";
    const supply = state.mcapSupply; // tokens (may be null)
    const frag = document.createDocumentFragment();

    rows.forEach((r, idx) => {
        // Market cap at this timestamp (close * supply)
        const mcap = (supply != null && r?.c != null) ? r.c * supply : null;

        // Trading fee + breakeven
        const feePct = computeTradingFeePercent(r.ts);
        const bMultiple = breakevenMultipleFromFee(feePct);
        const bMC = (bMultiple != null && mcap != null) ? (bMultiple * mcap) : null;

        const tr = document.createElement("tr");
        tr.innerHTML = `
      <td>${idx + 1}</td>
      <td data-col="timestamp">${new Date(r.ts * 1000).toLocaleString()}</td>
      <td data-col="unix">${r.ts}</td>
      <td data-col="open">${fmt(r.o)}</td>
      <td data-col="high">${fmt(r.h)}</td>
      <td data-col="low">${fmt(r.l)}</td>
      <td data-col="close">${fmt(r.c)}</td>
      <td data-col="volume">${fmt(r.v)}</td>
      <td data-col="mcap">${mcap == null ? "—" : fmtUSD(mcap)}</td>
      <td data-col="fee">${fmtPercent(feePct)}</td>
      <td data-col="breakeven">${fmtMultiple(bMultiple)}</td>
      <td data-col="breakeven_mc">${bMC == null ? "—" : fmtUSD(bMC)}</td>
    `;
        frag.appendChild(tr);
    });

    els.tbody.appendChild(frag);
}

function initColumnPicker() {
    if (!els.colPicker) return;
    els.colPicker.addEventListener("change", () => {
        const hidden = new Set();
        els.colPicker.querySelectorAll('input[type="checkbox"][data-col]').forEach(cb => {
            if (!cb.checked) hidden.add(cb.getAttribute("data-col"));
        });
        state.hiddenCols = hidden;

        const allKeys = ["timestamp", "unix", "open", "high", "low", "close", "volume", "mcap", "fee", "breakeven", "breakeven_mc"];
        allKeys.forEach(k => {
            els.table.classList.toggle(`hide-col-${k}`, hidden.has(k));
        });
    });
    els.colPicker.dispatchEvent(new Event("change")); // apply once so defaults take effect without user interaction
}


async function loadPrices(e) {
    e?.preventDefault?.();

    if (aborter) { aborter.abort(); aborter = null; }
    aborter = new AbortController();
    const { signal } = aborter;

    try {
        const network = FIXED_NETWORK;
        const stepKey = els.step.value;
        const step = STEP_MAP[stepKey];
        const maxRows = Math.max(1, Math.min(1000, parseInt(els.rows.value, 10) || 100));

        // global time range
        const now = new Date();
        let startUnix;
        if (els.startAtLaunch?.checked) {
            const singleAddr = getSelectedContract();
            if (singleAddr) {
                setStatus("Finding launch…", true);
                const json = await fetchTokenWithTopPools(network, singleAddr, signal);
                const launchTs = computeLaunchTsFromTokenJson(json);
                startUnix = launchTs ?? Math.floor((localInputToDate(els.start.value) || new Date(now.getTime() - 3600 * 1000)).getTime() / 1000);
            } else {
                startUnix = Math.floor((localInputToDate(els.start.value) || new Date(now.getTime() - 3600 * 1000)).getTime() / 1000);
            }
        } else {
            const start = localInputToDate(els.start.value) || new Date(now.getTime() - 60 * 60 * 1000);
            startUnix = Math.floor(start.getTime() / 1000);
        }
        const endUnix = startUnix + (maxRows - 1) * step.sec;

        const key = (els.strategy?.value || "").trim();

        if (key === "__ALL__") {
            // === COMPARE ALL ===
            setStatus("Loading all strategies…", true);
            state.datasets = {};
            const keys = Object.keys(STRATEGIES);

            for (const k of keys) {
                setStatus(`Loading ${k}…`, true);
                const ds = await loadOneToken({
                    network,
                    nameKey: k,
                    address: STRATEGIES[k],
                    step, maxRows, startUnix, endUnix, signal
                });
                if (!ds.error) state.datasets[k] = ds;
            }

            const loadedKeys = Object.keys(state.datasets);
            if (!loadedKeys.length) {
                setStatus("No data for any strategy.", false);
                return;
            }

            // Chart on a canonical grid
            state.chart.timeGrid = createTimeGrid(startUnix, endUnix, step.sec);
            state.chart.rows = state.chart.timeGrid.map(ts => ({ ts }));

            // Tabs + pick first dataset
            state.activeTableKey = loadedKeys[0];
            buildTableTabs(loadedKeys);

            const first = state.datasets[state.activeTableKey];

            // IMPORTANT: set supply/launch BEFORE rendering table so MCAP shows
            state.mcapSupply = first.supply ?? null;
            state.launchTs = first.launchTs ?? null;

            renderInfoBarFromDataset(first);
            renderRows(first.rows || []);

            // Chart overlays
            state.chart.seriesKeys = getCheckedSeriesKeys();   // metric keys
            renderStrategyCheckboxes(loadedKeys);              // tokens toggles
            const stratKeys = getCheckedStrategyKeys();
            buildChartDataMulti(state.chart.seriesKeys, stratKeys);
            drawChart();

            setStatus(`Done. Loaded ${loadedKeys.length} tokens.`, false);
            return;
        }

        // === single token ===
        const contract = getSelectedContract();
        if (!contract) { setStatus("Please select a strategy.", false); return; }

        state.datasets = {};
        state.activeTableKey = null;

        setStatus("Loading…", true);
        const ds = await loadOneToken({
            network, nameKey: (els.strategy.value || "").trim(), address: contract,
            step, maxRows, startUnix, endUnix, signal
        });
        if (ds.error) { setStatus("No pool found for this token.", false); return; }

        // IMPORTANT: set supply/launch BEFORE rendering table so MCAP shows
        state.mcapSupply = ds.supply ?? null;
        state.launchTs = ds.launchTs ?? null;

        renderInfoBarFromDataset(ds);
        renderRows(ds.rows || []);

        // Single chart
        state.chart.timeGrid = null;
        state.chart.rows = ds.rows || [];
        state.chart.seriesKeys = getCheckedSeriesKeys();
        buildChartData(ds.rows || []);
        drawChart();

        const tabsEl = document.getElementById("table-tabs");
        if (tabsEl) tabsEl.hidden = true;
        const cs = document.getElementById("chart-strategy-controls");
        if (cs) cs.hidden = true;

        setStatus(`Done. ${ds.rows?.length || 0} rows shown.`, false);
    } catch (err) {
        if (err.name === "AbortError") { setStatus("Stopped.", false); return; }
        console.error(err);
        setStatus(`Error: ${err.message}`, false);
    } finally {
        aborter = null;
    }
}


// Wire up UI
els.form.addEventListener("submit", loadPrices);
els.stop.addEventListener("click", () => { if (aborter) aborter.abort(); });


// -----------INIT---------------

(function init() {
    const now = new Date();
    initColumnPicker();

    // Default start = last 1h
    els.start.value = dateToLocalInput(new Date(now.getTime() - 60 * 60 * 1000));

    setStatus("Ready. Pick strategy + set Start, Step, Rows, then Load.");

    // Copy contract to clipboard
    if (els.ti.copyContract) {
        els.ti.copyContract.addEventListener("click", async () => {
            const addr = getSelectedContract();
            if (!addr) return;
            const ok = await copyTextToClipboard(addr);
            const oldTitle = els.ti.copyContract.title || "Copy address";
            els.ti.copyContract.title = ok ? "Copied!" : "Copy failed";
            setTimeout(() => { els.ti.copyContract.title = oldTitle; }, 1200);
        });
    }

    // remember checks per column
    els.colPicker.querySelectorAll('input[type="checkbox"][data-col]').forEach(cb => {
        const key = `col:${cb.dataset.col}`;
        const saved = localStorage.getItem(key);
        if (saved !== null) cb.checked = saved === "true";
        cb.addEventListener("change", () => localStorage.setItem(key, String(cb.checked)));
    });

    // "At Launch" wiring
    if (els.startAtLaunch) els.startAtLaunch.addEventListener("change", prefillStartFromLaunch);
    if (els.strategy) els.strategy.addEventListener("change", prefillStartFromLaunch);

    // Chart control handlers (metrics + tokens) + resize
    wireChartControlHandlers();

    // Submit/Stop
    els.form.addEventListener("submit", loadPrices);
    els.stop.addEventListener("click", () => { if (aborter) aborter.abort(); });
})();


