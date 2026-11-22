# Kalshi BTC 15m Edge

A phone-first, read-only web app that compares a live probability model with Kalshi's BTC 15-minute Up/Down market
(series `KXBTC15M`). It shows when a side is cheap, overpriced or worth cashing out. It also grades itself against
Kalshi's own prices.

No trading. No Kalshi account or API keys.

## Deploy to Vercel

1. In Vercel: **Add New → Project**, import this repository. Leave everything at its defaults (Next.js is detected
   automatically). If the app sits in a subfolder of a bigger repo, set **Root Directory** to that folder.
2. Add an environment variable **`PASSWORD`** (Settings → Environment Variables) with the password you want, for
   Production (and Preview if you use it). Then deploy. The app shows a sign-in page and stays signed in for a year
   per device. If `PASSWORD` is missing in production, the app refuses to serve. Changing it signs everyone out.

On iPhone: open the deployed URL in Safari → Share → **Add to Home Screen**.

## Run locally

```bash
npm install
npm run dev     # http://localhost:3000 (no password locally unless you set PASSWORD)
npm test        # BRTI, model, fee, parsing, calibration, blend and scorecard tests
npm run learn   # re-learn from settled windows → lib/priors.json (commit + redeploy to ship it)
npm run build
```

## Built around your entry minute

You enter about 8 minutes into each window (7 minutes left). The app is organised around that minute. Change it in
Settings → Your entry minute.

- **Before the entry zone** (minute 7), the top card counts down to entry and previews which side is leaning, and why
  it would or wouldn't trade.
- **In the entry zone** (minutes 7–9), it shows **BUY UP / BUY DOWN** only when every check passes. Otherwise it
  shows **NO TRADE THIS WINDOW** and lists the reasons. The checks:
  1. Edge after fees ≥ your margin (default 3¢).
  2. The edge has held for 10 seconds, so one-tick flickers don't trigger.
  3. No fast move (60-second move under 2σ).
  4. Kalshi's Up spread is 3¢ or less.
  5. At least 5 of the 7 exchanges are live.
  6. **The backtest proved an edge at this minute.** On windows the fit never saw, the blend had to score better
     than Kalshi's own price and make money after fees.
- **After the entry zone**, it switches to managing the trade: use the cash-out check.

Skipping windows without a measured edge is what makes the app consistent. It trades less, but only where it has
evidence.

## Learning: blend of model and Kalshi

Kalshi's price is hard to beat on its own: it already reflects everyone's information. So the app doesn't pit its
model against Kalshi. It learns how much to trust each, per minute into the window:

```
P(Up) = σ( w0 + w1·logit(P_model) + w2·logit(P_kalshi) + w3·mom1 + w4·mom5 )
```

`mom1` and `mom5` are the 1- and 5-minute moves in σ units. `npm run learn` rebuilds every settled window from the
last 21 days (`--days N` for more). For each minute 1–14 it rebuilds what the app would have seen:

- Kalshi's Up bid and ask from 1-minute candlesticks
- the BTC price from Coinbase 1-minute closes, corrected by the Coinbase−BRTI gap measured against each window's target
- volatility, the model probability and momentum

It fits the weights by ridge-regularised logistic regression on the older 70% of windows and tests on the newest
30%. Results are in `lib/priors.json`, and the Scorecard tab shows them as "Backtest by entry minute".

- If the model adds nothing, `w1 → 0` and the decision collapses to Kalshi's price, so no edges are flagged.
- On the phone, once it has 300+ graded readings in your entry zone, the app re-fits the weights from your own data.
  The re-fit is shrunk toward the backtest weights.
- Re-run `npm run learn` every week or two and redeploy, so the weights follow the market.

## How it works

| Piece | Where |
|---|---|
| `/api/kalshi`: allow-listed read-only proxy to Kalshi's public API, ~1s cache (memory + Vercel edge), falls back between `external-api.kalshi.com` and `api.elections.kalshi.com` | `app/api/kalshi/route.ts` |
| Kalshi parsing (`*_dollars` fields and legacy cent fields) | `lib/kalshi.ts` |
| Live replica of CF Benchmarks' BRTI (the settlement index), built from the order books of all 7 constituent exchanges | `lib/brti.ts`, `lib/books.ts`, `lib/feeds.ts` |
| Price accuracy tracker: replica's 60s average vs Kalshi's official `expiration_value` per window, with optional offset correction | `lib/tracking.ts`, `components/Accuracy.tsx` |
| Model: Student-t(4) CDF, blended volatility, effective time | `lib/model.ts` |
| Taker fee `ceil(0.07 × C × P × (1−P))` to the cent | `lib/fees.ts` |
| IndexedDB log of readings and settled results | `lib/db.ts` |
| Scorecard: Brier scores, calibration table, hypothetical P/L | `lib/scorecard.ts` |
| Auto-calibration: spread multiplier and per-bucket shrink | `lib/calibrate.ts` |

### Price engine: BRTI replica

Kalshi settles on CF Benchmarks' BRTI, so the app recomputes BRTI itself every second. It follows the
[CME CF Real Time Indices Methodology v17.0](https://docs.cfbenchmarks.com/CME%20CF%20Real%20Time%20Indices%20Methodology.pdf)
(21 Sep 2026):

1. Live L2 order books from the BTC-USD constituent exchanges in the
   [CME CF constituent list](https://docs.cfbenchmarks.com/CME%20CF%20Constituent%20Exchanges.pdf): Coinbase, Kraken,
   Bitstamp, Gemini, LMAX Digital, Bullish and Crypto.com. itBit was suspended on 27 Jul 2026.
2. Books are dropped if they are older than 10s, empty on one side, crossed, or more than 5% from the median mid (with
   the methodology's 2.5% re-entry rule).
3. The books are merged into one consolidated book. Each level is capped at the dynamic order size cap (1%-trimmed mean
   + 5 × winsorized sd of sizes within 5% of the touch, minimum 50 levels). The book is then uncrossed.
4. Dynamic spacing is `min(min side volume / 100, KDE mode of the lower-liquidity side's sizes)`.
5. The mid price-volume curve is exponentially weighted (λ = 1 / (0.3 · v_T)) up to the utilized depth v_T, where
   the mid spread first exceeds 0.5%.

Every exchange endpoint and message format was checked live. The browser receives roughly 140 KB/s before WebSocket
compression. **Light mode** uses top-of-book feeds and a screened mean of the exchange mids instead, to save data.

**Settlement window.** In the final minute the app averages the replica's own one-second values, from close − 59s
through close. The model is centred on the expected settlement average, `(observed sum + seconds left × price) / 60`.
Its variance is `σ²·(k/60)³/3` for the k seconds still to come, which matches the `tEff = m − 2/3` formula at
m = 1.

**Self-check.** For every window the app watches through its close, it stores the replica's 60-second average. It
then compares that with Kalshi's official `expiration_value` (the real BRTI average). The Live tab shows the average
and worst miss. After 5 windows it can shift the price by the median miss (Settings → Auto-correct price offset).

### Verified against the live API (2026-11-22)

- Current window: `GET /markets?series_ticker=KXBTC15M&status=open`, soonest `close_time`.
- **Target = `floor_strike`.** It matches `yes_sub_title` ("Target Price: $60,640.58"). It also equals the previous
  window's `expiration_value` (its final 60-second BRTI average).
- Prices come as strings in dollars: `yes_bid_dollars`, `yes_ask_dollars`, `no_bid_dollars`, `no_ask_dollars`,
  `last_price_dollars`. Integer-cent fields (`yes_bid`, …) are still accepted as a fallback.
- Settled windows: `GET /markets/{ticker}` returns `status: "finalized"`, `result: "yes" | "no"` and `expiration_value`.
  (The list filter is spelled `status=settled`.)
- Order book: `GET /markets/{ticker}/orderbook` returns `orderbook_fp.yes_dollars` / `no_dollars` as `[price, size]`.
  These are bids only, ascending, best last. A Down bid at X is an Up ask at 100−X.
- Fees: `GET /series/KXBTC15M` reports `fee_type: "quadratic"`, `fee_multiplier: 1`. That is the standard 0.07 taker
  schedule, charged to the cent for non-direct members.

### Model

```
minsLeft  = time to close_time
volPerMin = 0.6·σ(1-min log returns, last 60m) + 0.4·σ(last 24h)     (24h seeded from Coinbase candles)
tEff      = max(minsLeft − 2/3, minsLeft/3)
spread    = volPerMin · √tEff · calib
P(Up)     = F(ln(price/target) / spread),  F(z) = tcdf4(z·√2)
edge Up   = fair Up − (yes_ask + fee)        → CHEAP when ≥ margin
sell Up   = (yes_bid − fee) − fair Up        → OVERPRICED / CASH OUT when ≥ margin
```

The **fast-move guard** fires when the BRTI replica has moved more than 2× the 1-minute σ in the last 60 seconds. BUY
calls are then suppressed.

### Self-grading

- A reading is logged every 10 seconds while the app is open. Each one records the ticker, minutes left, P(Up), Kalshi
  Up mid, asks and bids, price, target and the model ingredients.
- Every 30 seconds the app fetches results for closed windows and grades every reading from them.
- The Scorecard shows:
  - Brier score, model vs Kalshi mid, overall and by 0–3 / 3–6 / 6–9 / 9–12 / 12–15 minutes left.
  - A "said X%, won Y%" table.
  - Hypothetical P/L from buying whenever edge ≥ margin, with fees included. It is counted two ways: every signal, and
    first signal per window.
  - A paired t-test across windows behind the "beats Kalshi?" banner. Readings inside one window are strongly
    correlated, so windows are the honest sample size.
- **Calibration:**
  - With 200+ graded readings, `calib` is re-fit to minimise Brier.
  - With 200+ graded readings in a time bucket, that bucket gets a logit shrink factor (≤1) that pulls overconfident
    odds toward 50%.

## Limits to know

- Nothing here guarantees a profit. The backtest is honest (out-of-sample, fees included, one trade per window), but
  markets change. Watch the live Scorecard: if the edge disappears there, stop.
- The backtest assumes you fill at the 1-minute closing ask. Real fills at a busy moment can be worse.

- The replica uses the same exchanges and formula as BRTI, but CF Benchmarks sees the books from its own servers, every 200ms and with no network lag. Small differences remain; the accuracy card measures them.
- iOS suspends home-screen apps in the background. Readings are only logged while the app is on screen. Feeds reconnect
  when you return.
- Graded data lives on the device (IndexedDB). Use Settings → Export / Import to move it between devices.
- The Binance lead feed is often blocked from US IP addresses. The app marks it "blocked" and carries on without it.
- Not financial advice.
