# Mini DEX Price Viewer — GeckoTerminal

A tiny vanilla-JS web app that shows on-chain token prices from **GeckoTerminal**.
Pick a network + token contract, a time range, and a step (1m…1d). The app picks the most liquid pool, fetches OHLCV, and renders a table you can customize with a column picker. It also computes **historical Market Cap per row**.

> No build tools, no dependencies, no API keys. Just open with any static web server.

---

## Features

* **DEX-native data (GeckoTerminal):** token metadata + top pools + pool OHLCV.
* **Info bar** (snapshot): Name, Ticker, Launch (proxy), Token age, Liquidity (USD), 24h Volume (USD), Market Cap (USD / FDV fallback).
* **Historical table:** Timestamp, Unix, Open, High, Low, Close, Volume, **Market Cap** (per row).
* **Column picker:** Toggle any table column.
* **Flexible steps:** 1m, 5m, **10m** (client-aggregated), 15m, 1h, 4h, 12h, 1d.
* **Two requests per load:** 1) token (+top pools) 2) OHLCV for the chosen pool.

---

## Quick start

```bash
# clone repo
git clone https://github.com/<you>/<repo>.git
cd <repo>

# serve statically (choose one)
python3 -m http.server 8080
# or
npx serve -p 8080
# or any static server you like
```

Open [http://localhost:8080](http://localhost:8080) and:

1. Choose **Network** (e.g., `eth`, `bsc`, `polygon_pos`, `arbitrum`, `base`, `avax`, `optimism`, `solana`).
2. Paste **Token contract** (checksummed or lowercase is fine).
3. Pick **Step**, **Rows (N)**, and optional **Start/End**.
4. Click **Load prices**.

---

## File structure

```
.
├── index.html   # UI skeleton and layout
├── style.css    # Dark minimal theme + responsive styles
└── app.js       # All logic: fetch, state, transforms, rendering
```

---

## How it works

1. **Read inputs** from the form (network, contract, step, time range, rows).
2. **Token + pools:** `GET /networks/{network}/tokens/{address}?include=top_pools`

   * Used for name, symbol, decimals, (normalized) supplies, market cap/FDV,
     total liquidity, 24h volume, and pool discovery.
3. **Pick pool:** choose the most liquid pool (fallback: highest 24h volume).
4. **OHLCV:** `GET /networks/{network}/pools/{pool}/ohlcv/{timeframe}?aggregate=…&currency=usd&token=base|quote&limit=…&before_timestamp=…`

   * For **10m** we fetch **1m** and aggregate client-side.
5. **Historical Market Cap per row:**
   `MCAP(ts) = close_price_usd(ts) × supply_estimate`
6. **Render:** info bar + table; column picker toggles CSS classes to show/hide columns.

**Request budget:** always 2 requests per “Load prices”. Default rate limit on GeckoTerminal is ~30 req/min, so you’re well within it.

---

## Data & calculations

### Pool selection

* Pools from `include=top_pools`, sorted by `reserve_in_usd` (then h24 volume).
* Determine token **side** (base/quote) from the pool; OHLCV is requested for the correct side so prices are in USD for the token.

### Time steps

* `1m`, `5m`, `15m`, `1h`, `4h`, `12h`, `1d` come directly from OHLCV.
* `10m` is computed by grouping 1m candles:
  Open = first open, Close = last close, High/Low = max/min, Volume = sum.

### Historical Market Cap (per row)

We assume supply is **constant over the selected range**, estimated once per load:

Priority for **supply estimate** (tokens):

1. `normalized_circulating_supply`
2. `circulating_supply` (assumed normalized)
3. `normalized_total_supply`
4. `total_supply / 10^decimals` (app normalizes using `decimals`)
5. `market_cap_usd / refPrice`
6. `fdv_usd / refPrice`

`refPrice` = token’s current `price_usd` if available, else the last candle’s close.

> Info bar uses **current** Market Cap (or FDV), while the table shows **historical** Market Cap computed from the candle close at each timestamp × supply estimate.

---

## UI overview

* **Controls**: Network, Token contract, Step, Rows (N), Start/End, Load / Stop.
* **Info bar**: Snapshot of token + liquidity/volume/mcap and a launch proxy (earliest pool creation seen on GeckoTerminal).
* **Column picker**: Checkboxes to show/hide columns.
* **Table**: Sticky header, progressive render, responsive.

---

## Known limitations

* **Supply drift** (mints/burns) isn’t modeled over time; we use a single supply estimate for the selected range. For tokens with rapidly changing supply, historical mcap will be approximate.
* **Earliest pool as “launch”** is a proxy; actual token deploy time may differ.
* If a token or pool is newly created, indexing latency may cause sparse data.
* No pagination/backfill across multiple OHLCV requests yet (kept intentionally simple).

---

## Extending

* **Backfill** multiple OHLCV pages to cover long ranges with small steps.
* **Secondary data source** (e.g., DexScreener, DefiLlama) for resilience.
* **Live updates** (polling or websockets if/when available).
* **Sparkline/Chart** with Canvas or `<svg>` (no libs needed).
* **Persistent settings** in `localStorage`.
* **Per-chain launch time** via explorers (contract creation block).

---

## Security & privacy

* No secrets in the browser; the app calls public endpoints directly.
* Works on any static host (GitHub Pages, Netlify, Vercel static, S3, etc.).

---

## Credits

Data fetched from GeckoTerminal’s open endpoints.
Coded by Luka Piskorec with ChatGPT, 2025
MIT License. See `LICENSE` file.
