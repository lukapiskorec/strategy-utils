/* Mini DEX Price Viewer — GeckoTerminal
   Flow:
   1) Find top pools for {network}:{tokenAddress}
   2) Pick the most liquid pool
   3) Fetch OHLCV for timeframe/aggregate (USD)
   4) Optionally aggregate 1m -> 10m client-side
   Docs:
     - Root & rate limit: https://api.geckoterminal.com/api/v2 (30 req/min)
     - Use /networks/{network}/tokens/{address}/pools?include=base_token,quote_token
     - OHLCV: /networks/{network}/pools/{pool}/ohlcv/{timeframe}?aggregate=...
*/

const API_ROOT = "https://api.geckoterminal.com/api/v2";

const STEP_MAP = {
  "1m":  { tf: "minute", agg: 1,   sec: 60,   client10m: false },
  "5m":  { tf: "minute", agg: 5,   sec: 300,  client10m: false },
  "10m": { tf: "minute", agg: 1,   sec: 600,  client10m: true  }, // build from 1m
  "15m": { tf: "minute", agg: 15,  sec: 900,  client10m: false },
  "1h":  { tf: "hour",   agg: 1,   sec: 3600, client10m: false },
  "4h":  { tf: "hour",   agg: 4,   sec: 14400,client10m: false },
  "12h": { tf: "hour",   agg: 12,  sec: 43200,client10m: false },
  "1d":  { tf: "day",    agg: 1,   sec: 86400,client10m: false },
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
};

let aborter = null;

function pad(n){ return String(n).padStart(2,"0"); }
function dateToLocalInput(dt){
  const y = dt.getFullYear(), m = pad(dt.getMonth()+1), d = pad(dt.getDate());
  const hh = pad(dt.getHours()), mm = pad(dt.getMinutes());
  return `${y}-${m}-${d}T${hh}:${mm}`;
}
function localInputToDate(v){ return v ? new Date(v) : null; }
function fmt(n, dp=8){
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 100000) return Intl.NumberFormat(undefined, {notation:"compact", maximumFractionDigits:2}).format(n);
  const s = Number(n).toFixed(Math.min(dp,8));
  return s.replace(/\.?0+$/,"");
}
function setStatus(t, busy=false){
  els.status.textContent = t;
  els.load.disabled = busy;
  els.stop.disabled = !busy;
  els.status.classList.toggle("busy", !!busy);
}

function normAddr(a){ return (a||"").toLowerCase(); }

async function gtFetch(path, { signal } = {}){
  const res = await fetch(`${API_ROOT}${path}`, { signal, headers: { "accept":"application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json();
}

// Step 1: top pools for a token (includes base/quote metadata)
async function fetchTopPoolsForToken(network, tokenAddress, signal){
  const include = "base_token,quote_token,dex";
  // Prefer highest liquidity; GT notes sorting params exist
  const order = "reserve_in_usd_desc"; // alternative: h24_volume_usd_desc
  const url = `/networks/${network}/tokens/${tokenAddress}/pools?include=${encodeURIComponent(include)}&order=${order}`;
  const json = await gtFetch(url, { signal });
  return json; // raw; we will map below
}

function pickMostLiquidPool(topPoolsJson, tokenAddress) {
  const data = topPoolsJson?.data || [];
  const included = Object.fromEntries(
    (topPoolsJson?.included || []).map(x => [x.id, x])
  );

  // Pools are already ordered by our "order" param; take the first with both sides present
  const pool = data.find(p => {
    const baseRel = p.relationships?.base_token?.data?.id;
    const quoteRel = p.relationships?.quote_token?.data?.id;
    return baseRel && quoteRel && included[baseRel] && included[quoteRel];
  });
  if (!pool) return null;

  const baseId = pool.relationships.base_token.data.id;
  const quoteId = pool.relationships.quote_token.data.id;
  const base = included[baseId]?.attributes || {};
  const quote = included[quoteId]?.attributes || {};
  const dex = included[pool.relationships?.dex?.data?.id]?.attributes || {};

  // Decide token side: base or quote?
  const t = normAddr(tokenAddress);
  let side = "base";
  if (normAddr(quote.address) === t) side = "quote";
  else if (normAddr(base.address) === t) side = "base";
  else {
    // If neither matches (weird indexing), default to base
    side = "base";
  }

  return {
    poolAddress: pool.attributes?.address,
    reserveUSD: pool.attributes?.reserve_in_usd,
    dexName: dex?.name || pool.attributes?.dex_name || "—",
    base, quote, side
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
  return Array.from(buckets.values()).sort((a,b)=>a.ts-b.ts);
}

function renderRows(rows) {
  els.tbody.innerHTML = "";
  const frag = document.createDocumentFragment();
  rows.forEach((r, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${new Date(r.ts * 1000).toLocaleString()}</td>
      <td>${r.ts}</td>
      <td>${fmt(r.o)}</td>
      <td>${fmt(r.h)}</td>
      <td>${fmt(r.l)}</td>
      <td>${fmt(r.c)}</td>
      <td>${fmt(r.v)}</td>
    `;
    frag.appendChild(tr);
  });
  els.tbody.appendChild(frag);
}

async function loadPrices(e){
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

    // Time range
    const now = new Date();
    const end = localInputToDate(els.end.value) || now;
    const start = localInputToDate(els.start.value) || new Date(end.getTime() - 24*60*60*1000);
    const startUnix = Math.floor(start.getTime()/1000);
    const endUnix = Math.floor(end.getTime()/1000);
    if (endUnix < startUnix) {
      setStatus("End must be after Start.", false);
      return;
    }

    setStatus("Selecting pool…", true);

    // 1) find top pools
    const topPoolsJson = await fetchTopPoolsForToken(network, contract, signal);
    const chosen = pickMostLiquidPool(topPoolsJson, contract);
    if (!chosen?.poolAddress) {
      setStatus("No pools found for this token on the selected network.", false);
      return;
    }

    els.chipPool.textContent = `Pool: ${chosen.poolAddress.slice(0,6)}…${chosen.poolAddress.slice(-4)}`;
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
    const asc = rawCandles.slice().sort((a,b)=>a.ts-b.ts);

    // Client 10m aggregation if needed
    const series = step.client10m ? aggregateTo10m(asc) : asc;

    // Filter by range, then take the last N rows (closest to end)
    const inRange = series.filter(k => k.ts >= startUnix && k.ts <= endUnix);
    const rows = inRange.slice(-maxRows);

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
(function init(){
  const now = new Date();
  els.end.value = dateToLocalInput(now);
  els.start.value = dateToLocalInput(new Date(now.getTime() - 60*60*1000)); // last 1h
  els.contract.placeholder = "0x0000000000000000000000000000000000000000";
  setStatus("Ready. Set token + range, then Load.");
})();
