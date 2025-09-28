/* Mini DEX Price Viewer — GeckoTerminal
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

const els = {
    form: document.getElementById("controls"),
    chain: document.getElementById("chain"),
    contract: document.getElementById("contract"),
    step: document.getElementById("step"),
    rows: document.getElementById("rows"),
    start: document.getElementById("start"),
    end: document.getElementById("end"),
    load: document.getElementById("load"),
    stop: document.getElementById("stop"),
    status: document.getElementById("status"),
    tbody: document.getElementById("tbody"),
    useSample: document.getElementById("use-sample"),
    chipPool: document.getElementById("chosen-pool"),
    chipDex: document.getElementById("chosen-dex"),
    chipSide: document.getElementById("token-side"),
    ti: {
        wrap: document.getElementById("token-info"),
        name: document.getElementById("ti-name"),
        symbol: document.getElementById("ti-symbol"),
        launch: document.getElementById("ti-launch"),
        age: document.getElementById("ti-age"),
        liq: document.getElementById("ti-liq"),
        vol24: document.getElementById("ti-vol24"),
        mcap: document.getElementById("ti-mcap"),
    },
    table: document.getElementById("prices"),
    colPicker: document.querySelector(".columns-picker"),
};

// ---- Global app state ----
const state = {
    network: null,
    contract: null,
    tokenAttrs: null,   // tokenJson.data.attributes
    chosenPool: null,   // { poolAddress, side, ... }
    mcapSupply: null,   // supply estimate used to compute historical market cap (tokens)
    hiddenCols: new Set()
};

let aborter = null;


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

    els.ti.wrap.hidden = false;
}

function renderRows(rows) {
    els.tbody.innerHTML = "";
    const supply = state.mcapSupply; // tokens (may be null)
    const frag = document.createDocumentFragment();

    rows.forEach((r, idx) => {
        const mcap = (supply != null && r?.c != null) ? r.c * supply : null;
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

        const allKeys = ["timestamp", "unix", "open", "high", "low", "close", "volume", "mcap"];
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
        const network = els.chain.value.trim();
        const contract = els.contract.value.trim();
        const stepKey = els.step.value;
        const step = STEP_MAP[stepKey];
        const maxRows = Math.max(1, Math.min(1000, parseInt(els.rows.value, 10) || 100));

        if (!network || !contract) {
            setStatus("Please enter both network and token contract.", false);
            return;
        }

        // 2) reset state
        Object.assign(state, {
            network,
            contract,
            tokenAttrs: null,
            chosenPool: null,
            mcapSupply: null,
        });

        // Time range
        const now = new Date();
        const end = localInputToDate(els.end.value) || now;
        const start = localInputToDate(els.start.value) || new Date(end.getTime() - 24 * 60 * 60 * 1000);
        const startUnix = Math.floor(start.getTime() / 1000);
        const endUnix = Math.floor(end.getTime() / 1000);
        if (endUnix < startUnix) {
            setStatus("End must be after Start.", false);
            return;
        }

        setStatus("Selecting pool…", true);

        // 1) find top pools
        const tokenJson = await fetchTokenWithTopPools(network, contract, signal);
        const chosen = pickMostLiquidPool(tokenJson, contract);

        state.tokenAttrs = tokenJson?.data?.attributes || null;
        state.chosenPool = chosen || null;

        if (!chosen?.poolAddress) {
            setStatus("No pools found for this token on the selected network.", false);
            return;
        }

        updateInfoBarFromToken(tokenJson, chosen);

        els.chipPool.textContent = `Pool: ${chosen.poolAddress.slice(0, 6)}…${chosen.poolAddress.slice(-4)}`;
        els.chipDex.textContent = `DEX: ${chosen.dexName || "—"}`;
        els.chipSide.textContent = `Token side: ${chosen.side}`;

        setStatus("Fetching OHLCV…", true);

        // Compute how many raw candles to request
        let rawLimit;
        if (step.client10m) {
            // Need 1m candles; request a bit more than needed for the range or N*10
            const needByN = maxRows * 10;
            const needByRange = Math.ceil((endUnix - startUnix) / 60); // minutes
            rawLimit = Math.min(1000, Math.max(needByN, needByRange) + 10);
        } else {
            const needByN = maxRows;
            const needByRange = Math.ceil((endUnix - startUnix) / step.sec);
            rawLimit = Math.min(1000, Math.max(needByN, needByRange) + 5);
        }

        // before_timestamp near end, API returns up to `limit` candles ending before/at that time
        const beforeTs = endUnix;

        // 2) fetch OHLCV
        const rawCandles = await fetchOHLCV({
            network,
            poolAddress: chosen.poolAddress,
            timeframe: step.tf,
            aggregate: step.client10m ? 1 : step.agg,
            limit: rawLimit,
            beforeTs,
            side: chosen.side,
            includeEmpty: true, // fill gaps if supported
            signal
        });

        // We get reverse or forward? Normalize to ascending by timestamp:
        const asc = rawCandles.slice().sort((a, b) => a.ts - b.ts);

        // Client 10m aggregation if needed
        const series = step.client10m ? aggregateTo10m(asc) : asc;

        // Filter by range, then take the last N rows (closest to end)
        const inRange = series.filter(k => k.ts >= startUnix && k.ts <= endUnix);
        const rows = inRange.slice(-maxRows);

        // Choose a reference price close to the end to derive supply (if needed)
        const refCandle = rows[rows.length - 1] || series[series.length - 1];
        // Prefer token’s current price_usd if present (stable orientation), else last candle close.
        const refPrice = numOrNull((state.tokenAttrs || {}).price_usd) ?? (refCandle?.c ?? null);

        // Derive/choose supply once per load (assumed constant over the selected range)
        state.mcapSupply = deriveSupplyForMcap(state.tokenAttrs || {}, refPrice);

        renderRows(rows);
        const note = rows.length < maxRows ? ` (only ${rows.length} in range)` : "";
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
els.useSample.addEventListener("click", () => {
    // Sample: UNI on Ethereum
    els.chain.value = "eth";
    els.contract.value = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";
});

// Defaults
(function init() {
    const now = new Date();
    initColumnPicker();
    els.end.value = dateToLocalInput(now);
    els.start.value = dateToLocalInput(new Date(now.getTime() - 60 * 60 * 1000)); // last 1h
    els.contract.placeholder = "0x0000000000000000000000000000000000000000";
    setStatus("Ready. Set token + range, then Load.");
})();
