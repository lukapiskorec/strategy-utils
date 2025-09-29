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

function getCheckedSeriesKeys() {
    if (!els.chartControls) return state.chart.seriesKeys;
    const keys = [];
    els.chartControls.querySelectorAll('input[type="checkbox"][data-ser]').forEach(cb => {
        if (cb.checked) keys.push(cb.getAttribute("data-ser"));
    });
    return keys.length ? keys : []; // allow empty
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

    // Hi-DPI scale
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const rows = state.chart.rows || [];
    const n = rows.length;
    if (!n) { drawEmpty(ctx, cssW, cssH); return; }

    const keys = state.chart.seriesKeys;
    const series = state.chart.series;

    // Collect min/max across selected series (ignore nulls)
    let min = +Infinity, max = -Infinity;
    keys.forEach(k => {
        (series[k] || []).forEach(v => {
            if (v == null || !isFinite(v)) return;
            if (v < min) min = v; if (v > max) max = v;
        });
    });
    if (!isFinite(min) || !isFinite(max)) { drawEmpty(ctx, cssW, cssH); return; }
    if (min === max) { min -= 1; max += 1; }

    // === Add vertical padding/breathing room ===
    const span = max - min;
    const padAmount = Math.max(span * CHART_Y_PAD_FRAC, 1e-6); // tiny fallback
    const minP = min - padAmount;
    const maxP = max + padAmount;

    // Layout
    const pad = { top: 12, right: 56, bottom: 22, left: 8 };
    const W = cssW, H = cssH;
    const x0 = pad.left, y0 = pad.top;
    const PW = W - pad.left - pad.right;
    const PH = H - pad.top - pad.bottom;

    // Scales
    const xAt = i => x0 + (n <= 1 ? 0 : (PW * (i / (n - 1))));
    const yAt = v => y0 + PH - ((v - minP) / (maxP - minP)) * PH;

    // Grid + right axis ticks
    ctx.font = "12px " + getComputedStyle(document.body).getPropertyValue("--mono");
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "rgba(255,255,255,.1)";
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--text") || "#fff";
    const ticks = niceTicks(minP, maxP, 6);
    ticks.forEach(t => {
        const y = yAt(t);
        ctx.beginPath();
        ctx.moveTo(x0, y); ctx.lineTo(x0 + PW, y);
        ctx.stroke();
        const label = formatForAxis(t, keys);
        ctx.fillText(label, x0 + PW + 44, y);
    });


    // X min/max labels
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    if (n > 0) {
        ctx.fillText(new Date(rows[0].ts * 1000).toLocaleString(), x0, y0 + PH + 4);
        const w = ctx.measureText(new Date(rows[n - 1].ts * 1000).toLocaleString()).width;
        ctx.fillText(new Date(rows[n - 1].ts * 1000).toLocaleString(), x0 + PW - w, y0 + PH + 4);
    }

    // Draw lines
    keys.forEach(k => {
        const cfg = CHART_SERIES_DEF[k];
        const data = series[k] || [];
        ctx.strokeStyle = cfg.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
            const v = data[i];
            if (v == null || !isFinite(v)) { started = false; continue; }
            const x = xAt(i), y = yAt(v);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    });

    // Legend
    renderLegend(keys);

    // Hover interaction
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
    const rows = state.chart.rows;
    const keys = state.chart.seriesKeys;
    const series = state.chart.series;

    function onMove(ev) {
        const rect = canvas.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;

        // inside plotting area?
        if (mx < x0 || mx > x0 + PW || my < y0 || my > y0 + PH) {
            tip.hidden = true;
            drawChart(); // redraw to clear hover line
            return;
        }

        // nearest index
        const n = rows.length;
        const i = Math.max(0, Math.min(n - 1, Math.round((mx - x0) / (PW / (n - 1 || 1)))));

        // redraw base chart then draw hover
        drawChartBaseOnly(); // lightweight redraw without re-binding
        const ctx = canvas.getContext("2d");
        ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
        const cssW = canvas.clientWidth || canvas.width;
        const cssH = canvas.clientHeight || canvas.height;
        const W = cssW, H = cssH;
        const px = xAt(i);

        // vertical line
        ctx.strokeStyle = "rgba(255,255,255,.4)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px, y0); ctx.lineTo(px, y0 + PH); ctx.stroke();

        // points
        keys.forEach(k => {
            const cfg = CHART_SERIES_DEF[k];
            const val = series[k]?.[i];
            if (val == null || !isFinite(val)) return;
            const py = yAt(val);
            ctx.fillStyle = cfg.color;
            ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
        });

        // Build tooltip HTML (timestamp + all selected series)
        const dt = new Date(rows[i].ts * 1000);
        const dtStr = dt.toLocaleString();
        let html = `<div class="ts"><strong>${dtStr}</strong></div>`;
        keys.forEach(k => {
            const cfg = CHART_SERIES_DEF[k];
            const val = series[k]?.[i];
            if (val == null || !isFinite(val)) return;
            html += `<div><span style="color:${cfg.color}">●</span> ${cfg.label}: ${cfg.fmt(val)}</div>`;
        });
        tip.innerHTML = html;

        // show first so we can measure it
        tip.hidden = false;

        // Clamp tooltip within the chart so it never overflows
        const tipRect = tip.getBoundingClientRect();
        const chartRect = canvas.getBoundingClientRect();

        // Base positions relative to the canvas (same coords you used for mx/my)
        let tx = px + 10;                 // prefer to the right of the cursor
        let ty;                           // decide above/below based on space

        // Flip above/below
        const spaceAbove = (y0 + (my - y0));                // distance from top pad to mouse
        const spaceBelow = (y0 + PH) - my;                  // distance from mouse to bottom pad
        if (spaceBelow >= tipRect.height + 8) {
            // place below the cursor
            ty = my + 8;
        } else if (spaceAbove >= tipRect.height + 8) {
            // place above the cursor
            ty = my - tipRect.height - 8;
        } else {
            // not enough space either way—anchor to inside the plot, below is nicer
            ty = Math.min(y0 + PH - tipRect.height - 4, Math.max(y0 + 4, my + 8));
        }

        // Horizontal clamp (8px padding on both sides)
        const maxLeft = (x0 + PW) - tipRect.width - 8;
        tx = Math.max(x0 + 8, Math.min(tx, maxLeft));

        // Apply
        tip.style.left = `${tx}px`;
        tip.style.top = `${ty}px`;

    }

    function onLeave() {
        tip.hidden = true;
        drawChart(); // full redraw
    }

    canvas.onmousemove = onMove;
    canvas.onmouseleave = onLeave;

    // internal: quick redraw without re-binding handlers
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

        // re-draw same as drawChart() up to lines
        const ticks = niceTicks(min, max, 6);
        // axes + labels
        ctx.font = "12px " + getComputedStyle(document.body).getPropertyValue("--mono");
        const pad = { top: 12, right: 56, bottom: 22, left: 8 };
        const W = cssW, H = cssH;
        const x0b = pad.left, y0b = pad.top;
        const PWb = W - pad.left - pad.right;
        const PHb = H - pad.top - pad.bottom;
        ctx.strokeStyle = "rgba(255,255,255,.1)";
        ctx.textAlign = "right"; ctx.textBaseline = "middle";
        ticks.forEach(t => {
            const y = y0b + PHb - ((t - min) / (max - min)) * PHb;
            ctx.beginPath(); ctx.moveTo(x0b, y); ctx.lineTo(x0b + PWb, y); ctx.stroke();
            const label = formatForAxis(t, keys);
            ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--text") || "#fff";
            ctx.fillText(label, x0b + PWb + 44, y);
        });
        // x labels
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        if (state.chart.rows.length > 0) {
            ctx.fillText(new Date(state.chart.rows[0].ts * 1000).toLocaleString(), x0b, y0b + PHb + 4);
            const endStr = new Date(state.chart.rows[state.chart.rows.length - 1].ts * 1000).toLocaleString();
            const w = ctx.measureText(endStr).width;
            ctx.fillText(endStr, x0b + PWb - w, y0b + PHb + 4);
        }
        // lines
        const keysB = state.chart.seriesKeys;
        keysB.forEach(k => {
            const cfg = CHART_SERIES_DEF[k];
            const data = state.chart.series[k] || [];
            ctx.strokeStyle = cfg.color;
            ctx.lineWidth = 2;
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
        const contract = getSelectedContract();
        const stepKey = els.step.value;
        const step = STEP_MAP[stepKey];
        const maxRows = Math.max(1, Math.min(1000, parseInt(els.rows.value, 10) || 100));

        if (!contract) {
            setStatus("Please select a strategy.", false);
            return;
        }

        // Reset state for this load
        Object.assign(state, {
            network,
            contract,
            tokenAttrs: null,
            chosenPool: null,
            mcapSupply: null,
            launchTs: state.launchTs ?? null, // may be set by prefetch
        });

        setStatus("Selecting pool…", true);

        // 1) Fetch token + pools first so we know Launch (proxy)
        const tokenJson = await fetchTokenWithTopPools(network, contract, signal);
        const chosen = pickMostLiquidPool(tokenJson, contract);

        state.tokenAttrs = tokenJson?.data?.attributes || null;
        state.chosenPool = chosen || null;

        if (!chosen?.poolAddress) {
            setStatus("No pools found for this token on the selected network.", false);
            return;
        }

        // Update info bar (also sets state.launchTs internally)
        updateInfoBarFromToken(tokenJson, chosen);

        // 2) Now decide the time range
        const now = new Date();
        let startUnix;

        if (els.startAtLaunch?.checked && state.launchTs) {
            startUnix = state.launchTs;
            // reflect it in the input for transparency
            els.start.value = dateToLocalInput(new Date(startUnix * 1000));
        } else {
            const start = localInputToDate(els.start.value) || new Date(now.getTime() - 60 * 60 * 1000);
            startUnix = Math.floor(start.getTime() / 1000);
        }

        const endUnix = startUnix + (maxRows - 1) * step.sec; // implied end
        setStatus("Fetching OHLCV…", true);

        // 3) Fetch OHLCV
        const needByRange = Math.ceil((endUnix - startUnix) / (step.client10m ? 60 : step.sec));
        const rawLimit = Math.min(1000,
            (step.client10m ? Math.max(maxRows * 10, needByRange) + 10
                : Math.max(maxRows, needByRange) + 5));

        const rawCandles = await fetchOHLCV({
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

        const asc = rawCandles.slice().sort((a, b) => a.ts - b.ts);
        const series = step.client10m ? aggregateTo10m(asc) : asc;

        const inRange = series.filter(k => k.ts >= startUnix && k.ts <= endUnix);
        const rows = inRange.slice(0, maxRows);

        // Supply for historical MCAP
        const refCandle = rows[rows.length - 1] || series[series.length - 1];
        const refPrice = numOrNull((state.tokenAttrs || {}).price_usd) ?? (refCandle?.c ?? null);
        state.mcapSupply = deriveSupplyForMcap(state.tokenAttrs || {}, refPrice);

        renderRows(rows);

        // Build + draw chart
        state.chart.seriesKeys = getCheckedSeriesKeys();
        buildChartData(rows);
        drawChart();

        const note = rows.length < maxRows ? ` (only ${rows.length} available)` : "";
        setStatus(`Done. ${rows.length} rows shown${note}.`, false);
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

    // prefill start from lunch field
    if (els.startAtLaunch) {
        els.startAtLaunch.addEventListener("change", prefillStartFromLaunch);
    }
    if (els.strategy) {
        els.strategy.addEventListener("change", prefillStartFromLaunch);
    }

    // Chart series toggles
    if (els.chartControls) {
        els.chartControls.addEventListener("change", () => {
            state.chart.seriesKeys = getCheckedSeriesKeys();
            buildChartData(state.chart.rows || []);
            drawChart();
        });
    }

    // Redraw on resize
    window.addEventListener("resize", () => drawChart());

})();

