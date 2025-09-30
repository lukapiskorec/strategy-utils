Here’s an updated `README.md` that keeps your original structure but reflects all the latest features — plus a GitHub Pages live link placeholder near the top.

---

# 🦎📈 Strategy Utils

A tiny vanilla-JS web app that shows on-chain token prices from **GeckoTerminal**.
Pick a predefined **Strategy** (Ethereum) or **COMPARE ALL**, a start time and step (1m…1d). The app picks the most liquid pool, fetches OHLCV, and renders a customizable table with **historical Market Cap per row** and extra metrics.

**Live demo:** [https://lukapiskorec.github.io/strategy-utils/](https://lukapiskorec.github.io/strategy-utils/) *(GitHub Pages)*

> No build tools, no dependencies, no API keys. Just open with any static web server.

---

## ✨ Features

* **DEX-native data (GeckoTerminal):** token metadata + top pools + pool OHLCV.
* **Strategies on Ethereum:** quick-select from a predefined list, or **COMPARE ALL** to overlay multiple strategies on one chart.
* **Info bar** (snapshot): Name, Ticker, Launch (proxy), Token age, Liquidity (USD), 24h Volume (USD), Market Cap (USD / FDV fallback), **Contract** (copy & Etherscan).
* **Historical table:** Timestamp, Unix, Open, High, Low, Close, Volume, **Market Cap**, **Trading fee %**, **Breakeven ×**, **Breakeven MC**.
* **Column picker:** Toggle any table column; themed scrollbars; fixed-height scrollable table.
* **Chart overlays:**

  * **Color = Strategy**, **Dash = Metric** (in COMPARE ALL),
  * Hover tooltip with **timestamp + values**, clamped inside the chart,
  * Right-side value axis, Y-padding for breathing room,
  * **Aligned time grid** across strategies (no trimming when switching tabs).
* **Flexible steps:** 1m, 5m, **10m** (client-aggregated), 15m, 1h, 4h, 12h, 1d.
* **Request budget:** Single token → **2 requests**; COMPARE ALL → **2 × N** requests.
* **Live API meter:** “*X API calls/min (30 allowed)*” auto-updates and decays over 60s.

---

## 🚀 Quick start

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

1. Choose **Strategy** (or **COMPARE ALL**).
2. Pick **Step** and **Rows (N)**.
   *(End time is auto-calculated from Start + Step × (N-1))*
3. Set **Start** or tick **At Launch** to auto-use the launch proxy time.
4. Click **Load prices**.
5. Use **Column picker** to show/hide table columns.
6. Use **Chart** checkboxes (metrics) and **Tokens** checkboxes (strategies) to control overlays.

---

## 🗂️ File structure

```
.
├── index.html   # UI skeleton and layout (controls, info bar, tabs, chart)
├── style.css    # Dark theme (retro-magenta), responsive grid, scrollbars
└── app.js       # All logic: fetch, rate meter, state, transforms, rendering
```

---

## 🧠 How it works

1. **Read inputs** from the form (strategy/COMPARE ALL, step, start, rows).
2. **Token + pools:** `GET /networks/eth/tokens/{address}?include=top_pools`
   Used for name/symbol/decimals/supplies, mcap/FDV, liquidity, 24h volume, and pool discovery.
3. **Pick pool:** choose the most liquid pool (fallback: highest 24h volume).
4. **OHLCV:**
   `GET /networks/eth/pools/{pool}/ohlcv/{timeframe}?aggregate=…&currency=usd&token=base|quote&limit=…&before_timestamp=…`

   * For **10m**, fetch **1m** and aggregate client-side.
5. **Supply estimate** once per load (see below), then compute **MCAP(ts) = close_usd(ts) × supply** per row.
6. **COMPARE ALL:** build a **canonical time grid** from Start→End so every strategy aligns by **timestamp** (missing points = gaps, not trims).
7. **Render:** info bar + table + chart overlays. Legends: **metric = dash**; **strategy = color**.
8. **API rate meter:** every fetch records a timestamp; a 1s ticker shows “*X API calls/min (30 allowed)*”.

---

## 🖥️ UI overview

* **Controls**: Strategy (or COMPARE ALL), Step, Rows (N), Start (+ **At Launch**), Load / Stop.
  *No End input; it’s auto-calculated.*
* **Meta row**: status + **API rate meter** on the left; provider on the right.
* **Info bar**: Name, Symbol, Launch (proxy), Age, Liquidity, 24h Volume, Market Cap, **Contract** (copy + Etherscan).
* **Tabs** (COMPARE ALL): switch which strategy’s **table** is visible; the **chart** stays aligned and overlaid.
* **Chart**: color-by-strategy; dash-by-metric; hover tooltip with timestamp; right axis; Y-padding; no horizontal scroll.
* **Column picker**: show/hide columns; themed scrollbars; compact, responsive layout.

---

## ⚠️ Known limitations

* **Supply drift** (mints/burns) isn’t modeled over time; we use a single supply estimate for the selected range.
* **Launch time** is proxied by earliest pool creation on GeckoTerminal; deploy time may differ.
* Newly created tokens/pools may have sparse data due to indexing latency.
* No multi-page backfill of OHLCV yet (kept intentionally simple).

---

## 🔒 Security & privacy

* No secrets; the app calls public endpoints directly from the browser.
* Works on any static host (GitHub Pages, Netlify, Vercel static, S3, etc.).

---

## 🙏 Credits

Data fetched from GeckoTerminal’s open endpoints.
Coded by Luka Piskorec with ChatGPT, 2025.
MIT License. See `LICENSE`.
