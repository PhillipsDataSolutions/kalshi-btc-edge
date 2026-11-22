// Learns from settled KXBTC15M windows and writes lib/priors.json.
//
//   npm run learn               # last 21 days
//   npm run learn -- --days 45  # more history (Kalshi live endpoints reach back to the historical cutoff)
//
// For every settled window and every minute 1..14 into it, it rebuilds what the app would have seen:
//   - Kalshi Up bid/ask at that minute (1-minute candlesticks, yes_bid/yes_ask close)
//   - BTC price (Coinbase 1-minute closes, shifted by the Coinbase−BRTI basis measured at the window's open)
//   - volatility (60% 1h + 40% 24h σ of 1-minute log returns), target (floor_strike), outcome (result)
// Then, per minute-into-window, it fits a logistic blend
//   P(Up) = σ(a + b·logit(P_model) + c·logit(P_kalshi) + d·momentum)
// on the older 70% of windows and tests it on the newest 30% (out-of-sample), reporting Brier scores
// and the fee-inclusive P/L of one trade per window when the edge ≥ margin.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { modelProbUp, blendedVolPerMin } from "../lib/model.ts";
import { takerFeeCents } from "../lib/fees.ts";
import { fitLogistic, predictLogistic, featuresFor, type BlendFeatures } from "../lib/blend.ts";

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const args = process.argv.slice(2);
const DAYS = Number(args[args.indexOf("--days") + 1]) || 21;
const MARGIN = Number(args[args.indexOf("--margin") + 1]) || 3;
const CACHE = "scripts/.cache";
mkdirSync(CACHE, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, tries = 6): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (r.status === 429 || r.status >= 500) {
        await sleep(1000 * 2 ** i);
        continue;
      }
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
}

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const f = `${CACHE}/${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const v = await fn();
  writeFileSync(f, JSON.stringify(v));
  return v;
}

interface Mkt {
  ticker: string;
  open: number; // s
  close: number; // s
  target: number;
  y: 0 | 1;
}

async function settledMarkets(): Promise<Mkt[]> {
  const minClose = Math.floor(Date.now() / 1000) - DAYS * 86400;
  const out: Mkt[] = [];
  let cursor = "";
  for (;;) {
    const d = await getJson(
      `${KALSHI}/markets?series_ticker=KXBTC15M&status=settled&limit=1000&min_close_ts=${minClose}${cursor ? `&cursor=${cursor}` : ""}`,
    );
    for (const m of d.markets ?? []) {
      if (m.result !== "yes" && m.result !== "no") continue;
      if (!(m.floor_strike > 0)) continue;
      out.push({
        ticker: m.ticker,
        open: Date.parse(m.open_time) / 1000,
        close: Date.parse(m.close_time) / 1000,
        target: m.floor_strike,
        y: m.result === "yes" ? 1 : 0,
      });
    }
    cursor = d.cursor;
    if (!cursor || !(d.markets ?? []).length) break;
  }
  return out.sort((a, b) => a.close - b.close);
}

/** Up bid/ask (cents) at the end of each minute of the window, keyed by end_period_ts. */
async function kalshiMinutes(m: Mkt): Promise<Record<number, { bid: number | null; ask: number | null }>> {
  return cached(`k_${m.ticker}`, async () => {
    const d = await getJson(
      `${KALSHI}/series/KXBTC15M/markets/${m.ticker}/candlesticks?start_ts=${m.open}&end_ts=${m.close}&period_interval=1`,
    );
    const out: Record<number, { bid: number | null; ask: number | null }> = {};
    for (const c of d.candlesticks ?? []) {
      const bid = parseFloat(c.yes_bid?.close_dollars);
      const ask = parseFloat(c.yes_ask?.close_dollars);
      out[c.end_period_ts] = {
        bid: bid > 0 && bid < 1 ? Math.round(bid * 1000) / 10 : null,
        ask: ask > 0 && ask < 1 ? Math.round(ask * 1000) / 10 : null,
      };
    }
    return out;
  });
}

/** Coinbase 1-minute candles: Map minute-start (s) -> [low, high, open, close]. */
async function coinbase(from: number, to: number) {
  const map = new Map<number, number[]>();
  const step = 300 * 60;
  const jobs: number[] = [];
  for (let s = Math.floor(from / 60) * 60; s < to; s += step) jobs.push(s);
  for (let i = 0; i < jobs.length; i += 5) {
    await Promise.all(
      jobs.slice(i, i + 5).map(async (s) => {
        const e = Math.min(s + step, to);
        const rows: number[][] = await cached(`cb_${s}_${e}`, () =>
          getJson(
            `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${new Date(s * 1000).toISOString()}&end=${new Date(e * 1000).toISOString()}`,
          ),
        );
        for (const r of rows) map.set(r[0], [r[1], r[2], r[3], r[4]]);
      }),
    );
    await sleep(700);
  }
  return map;
}

interface Sample extends BlendFeatures {
  ticker: string;
  minute: number; // minutes into the window
  y: 0 | 1;
  bid: number;
  ask: number;
  pModel: number;
  pKalshi: number;
}

const brier = (ps: number[], ys: number[]) => ps.reduce((s, p, i) => s + (p - ys[i]) ** 2, 0) / Math.max(1, ps.length);

function pnl(samples: Sample[], probs: number[], margin: number) {
  let trades = 0;
  let wins = 0;
  let total = 0;
  samples.forEach((s, i) => {
    const p = probs[i];
    const upCost = s.ask + takerFeeCents(s.ask);
    const noAsk = 100 - s.bid;
    const downCost = noAsk + takerFeeCents(noAsk);
    const eu = 100 * p - upCost;
    const ed = 100 * (1 - p) - downCost;
    if (Math.max(eu, ed) < margin) return;
    trades++;
    const up = eu >= ed;
    const win = up ? s.y === 1 : s.y === 0;
    if (win) wins++;
    total += (win ? 100 : 0) - (up ? upCost : downCost);
  });
  return { trades, wins, pnl: Math.round(total * 10) / 10, perTrade: trades ? Math.round((total / trades) * 10) / 10 : 0 };
}

async function main() {
  console.log(`Fetching settled KXBTC15M windows from the last ${DAYS} days…`);
  const markets = await settledMarkets();
  console.log(`${markets.length} windows. Fetching Kalshi 1-minute quotes…`);
  const quotes = new Map<string, Record<number, { bid: number | null; ask: number | null }>>();
  for (let i = 0; i < markets.length; i += 6) {
    const batch = markets.slice(i, i + 6);
    const res = await Promise.all(batch.map((m) => kalshiMinutes(m).catch(() => ({}))));
    batch.forEach((m, j) => quotes.set(m.ticker, res[j]));
    if (i % 120 === 0) process.stdout.write(`  ${i}/${markets.length}\r`);
    await sleep(350);
  }
  console.log("\nFetching Coinbase 1-minute candles…");
  const cb = await coinbase(markets[0].open - 1500 * 60, markets[markets.length - 1].close + 60);
  const closeAt = (t: number) => cb.get(t - 60)?.[3] ?? null; // close of the minute ending at t
  const closes = (endT: number, n: number) => {
    const out: number[] = [];
    for (let t = endT - n * 60; t <= endT; t += 60) {
      const c = closeAt(t);
      if (c !== null) out.push(c);
    }
    return out;
  };

  const samples: Sample[] = [];
  for (const m of markets) {
    const q = quotes.get(m.ticker) ?? {};
    // Basis: Coinbase average over the minute before open vs the official BRTI average (= target).
    const last = cb.get(m.open - 60);
    if (!last) continue;
    const basis = (last[0] + last[1] + last[2] + last[3]) / 4 - m.target;
    const hist = closes(m.open, 1440);
    for (let minute = 1; minute <= 14; minute++) {
      const t = m.open + minute * 60;
      const kq = q[t];
      const cbNow = closeAt(t);
      if (!kq || kq.bid === null || kq.ask === null || cbNow === null) continue;
      if (kq.ask - kq.bid > 15) continue; // ignore stale/wide books
      const minuteCloses = [...hist, ...closes(t, minute).slice(1)];
      const vol = blendedVolPerMin(minuteCloses);
      if (!vol) continue;
      const price = cbNow - basis;
      const minsLeft = (m.close - t) / 60;
      const pm = modelProbUp({ price, target: m.target, volPerMin: vol, minsLeft, calib: 1 }).pUp;
      const c1 = closeAt(t - 60);
      const c5 = closeAt(t - 300);
      const mom1 = c1 ? Math.log(cbNow / c1) / vol : 0;
      const mom5 = c5 ? Math.log(cbNow / c5) / (vol * Math.sqrt(5)) : 0;
      const pk = (kq.bid + kq.ask) / 200;
      samples.push({ ticker: m.ticker, minute, y: m.y, bid: kq.bid, ask: kq.ask, pModel: pm, pKalshi: pk, ...featuresFor(pm, pk, mom1, mom5) });
    }
  }
  console.log(`${samples.length} samples.`);

  // Chronological split by window.
  const tickers = [...new Set(samples.map((s) => s.ticker))];
  const cut = new Set(tickers.slice(0, Math.floor(tickers.length * 0.7)));
  const perMinute: any[] = [];
  const coef: Record<number, number[]> = {};
  for (let minute = 1; minute <= 14; minute++) {
    const all = samples.filter((s) => s.minute === minute);
    const train = all.filter((s) => cut.has(s.ticker));
    const test = all.filter((s) => !cut.has(s.ticker));
    if (train.length < 100 || test.length < 30) continue;
    const w = fitLogistic(train, 1.0);
    const pb = test.map((s) => predictLogistic(w, s));
    const ys = test.map((s) => s.y);
    const row = {
      minute,
      minsLeft: 15 - minute,
      nTrain: train.length,
      nTest: test.length,
      brierModel: brier(test.map((s) => s.pModel), ys),
      brierKalshi: brier(test.map((s) => s.pKalshi), ys),
      brierBlend: brier(pb, ys),
      pnlModel: pnl(test, test.map((s) => s.pModel), MARGIN),
      pnlBlend: pnl(test, pb, MARGIN),
      coef: w,
    };
    perMinute.push(row);
    coef[minute] = fitLogistic(all, 1.0); // final coefficients use every window
  }

  const fmt = (x: number) => x.toFixed(4);
  console.log("\nOut-of-sample (newest 30% of windows), one reading per window per minute:");
  console.log("min-in  left  Brier model  Kalshi   blend    | blend P/L (1 contract, fees)");
  for (const r of perMinute) {
    console.log(
      `  ${String(r.minute).padStart(2)}    ${String(r.minsLeft).padStart(2)}    ${fmt(r.brierModel)}   ${fmt(r.brierKalshi)}  ${fmt(r.brierBlend)}  | ${r.pnlBlend.trades} trades, ${r.pnlBlend.wins} won, ${(r.pnlBlend.pnl / 100).toFixed(2)} $, ${r.pnlBlend.perTrade}¢/trade`,
    );
  }

  const out = {
    generatedAt: new Date().toISOString(),
    days: DAYS,
    windows: tickers.length,
    samples: samples.length,
    margin: MARGIN,
    note: "Coefficients for P(Up) = sigmoid(w · [1, logit(pModel), logit(pKalshi), mom1, mom5]) per minute into the window.",
    coef,
    outOfSample: perMinute.map(({ coef: _c, ...r }) => r),
  };
  writeFileSync("lib/priors.json", JSON.stringify(out, null, 1));
  console.log("\nWrote lib/priors.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
