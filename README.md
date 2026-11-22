# Kalshi BTC 15m Edge

A phone-first, read-only web app that compares a live probability model with Kalshi's BTC 15-minute Up/Down market
(series `KXBTC15M`). It shows when a side is cheap, overpriced or worth cashing out. It also grades itself against
Kalshi's own prices.

No trading. No Kalshi account or API keys.

## Deploy to Vercel

This app lives in the `kalshi-btc-edge/` folder of the repo.

1. In Vercel: **Add New → Project**, import this repository.
2. Set **Root Directory** to `kalshi-btc-edge`. Leave everything else at its defaults (Next.js is detected automatically).
3. Deploy. No environment variables are needed.

On iPhone: open the deployed URL in Safari → Share → **Add to Home Screen**.

## Run locally

```bash
cd kalshi-btc-edge
npm install
npm run dev     # http://localhost:3000
npm test        # model, fee, parsing, calibration and scorecard tests
npm run build
```

## How it works

| Piece | Where |
|---|---|
| `/api/kalshi`: allow-listed read-only proxy to Kalshi's public API, ~1s cache (memory + Vercel edge), falls back between `external-api.kalshi.com` and `api.elections.kalshi.com` | `app/api/kalshi/route.ts` |
| Kalshi parsing (`*_dollars` fields and legacy cent fields) | `lib/kalshi.ts` |
| Composite BTC price from Coinbase, Kraken, Bitstamp and Gemini WebSockets, plus a Binance perp lead feed | `lib/feeds.ts` |
| Model: Student-t(4) CDF, blended volatility, effective time | `lib/model.ts` |
| Taker fee `ceil(0.07 × C × P × (1−P))` to the cent | `lib/fees.ts` |
| IndexedDB log of readings and settled results | `lib/db.ts` |
| Scorecard: Brier scores, calibration table, hypothetical P/L | `lib/scorecard.ts` |
| Auto-calibration: spread multiplier and per-bucket shrink | `lib/calibrate.ts` |

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

The **fast-move guard** fires when the composite has moved more than 2× the 1-minute σ in the last 60 seconds. BUY
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

- The composite price approximates CF Benchmarks' BRTI, which settles the market. It is not BRTI itself.
- iOS suspends home-screen apps in the background. Readings are only logged while the app is on screen. Feeds reconnect
  when you return.
- Graded data lives on the device (IndexedDB). Use Settings → Export / Import to move it between devices.
- The Binance lead feed is often blocked from US IP addresses. The app marks it "blocked" and carries on without it.
- Not financial advice.
