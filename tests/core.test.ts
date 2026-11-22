import { test } from "node:test";
import assert from "node:assert/strict";
import { F, tcdf4, effectiveMinutes, modelProbUp, massBetween, isFastMove, stdLogReturns } from "../lib/model.ts";
import { takerFeeCents, takerFeeTotalCents } from "../lib/fees.ts";
import { normalizeMarket, normalizeOrderBook, pickCurrent } from "../lib/kalshi.ts";
import { bucketOf, shrink, fitShrink, fitCalib, computeCalibration } from "../lib/calibrate.ts";
import { computeScorecard, type Graded } from "../lib/scorecard.ts";

test("t4 CDF matches known values", () => {
  assert.equal(tcdf4(0), 0.5);
  // Student-t(4): P(T<=2.132) ≈ 0.95, P(T<=1) ≈ 0.8130
  assert.ok(Math.abs(tcdf4(2.132) - 0.95) < 1e-3);
  assert.ok(Math.abs(tcdf4(1) - 0.81305) < 1e-4);
  assert.ok(Math.abs(tcdf4(50) - 1) < 1e-3);
  assert.ok(Math.abs(F(1) + F(-1) - 1) < 1e-12);
});

test("effective minutes", () => {
  assert.equal(effectiveMinutes(15), 15 - 2 / 3);
  assert.ok(Math.abs(effectiveMinutes(0.6) - 0.2) < 1e-12);
});

test("model probability direction and edge cases", () => {
  const base = { target: 60000, volPerMin: 0.0008, minsLeft: 10, calib: 1 };
  assert.equal(modelProbUp({ ...base, price: 60000 }).pUp, 0.5);
  assert.ok(modelProbUp({ ...base, price: 60100 }).pUp > 0.5);
  assert.ok(modelProbUp({ ...base, price: 59900 }).pUp < 0.5);
  assert.equal(modelProbUp({ ...base, price: 60001, minsLeft: 0 }).pUp, 1);
  // bigger calib -> less confident
  const a = modelProbUp({ ...base, price: 60100 }).pUp;
  const b = modelProbUp({ ...base, price: 60100, calib: 2 }).pUp;
  assert.ok(b < a && b > 0.5);
});

test("histogram mass sums to ~1", () => {
  const price = 60000, spread = 0.002;
  let total = 0;
  for (let k = -400; k < 400; k++) total += massBetween(price, spread, price * Math.exp(k * 0.0005), price * Math.exp((k + 1) * 0.0005));
  assert.ok(Math.abs(total - 1) < 1e-3, String(total));
});

test("fees: ceil(0.07·C·P·(1−P)) to the cent", () => {
  assert.equal(takerFeeTotalCents(50, 1), 2); // 1.75 -> 2
  assert.equal(takerFeeTotalCents(50, 100), 175);
  assert.equal(takerFeeTotalCents(10, 1), 1); // 0.63 -> 1
  assert.equal(takerFeeTotalCents(99, 1), 1);
  assert.equal(takerFeeCents(50, 4), 1.75); // ceil(7.00) / 4
});

test("normalizeMarket handles dollars and legacy cents", () => {
  const live = normalizeMarket({
    ticker: "KXBTC15M-26NOV221430-30",
    open_time: "2026-11-22T19:15:00Z",
    close_time: "2026-11-22T19:30:00Z",
    floor_strike: 60640.58,
    yes_bid_dollars: "0.1400",
    yes_ask_dollars: "0.1500",
    no_bid_dollars: "0.8500",
    no_ask_dollars: "0.8600",
    last_price_dollars: "0.1400",
    status: "active",
    result: "",
  });
  assert.equal(live.target, 60640.58);
  assert.equal(live.yesAsk, 15);
  assert.equal(live.noBid, 85);
  const legacy = normalizeMarket({ ticker: "X", yes_bid: 40, yes_ask: 42, no_bid: 58, no_ask: 60, yes_sub_title: "Target Price: $60,610.83" });
  assert.equal(legacy.yesBid, 40);
  assert.equal(legacy.target, 60610.83);
  assert.equal(normalizeMarket({ yes_ask_dollars: "0.0000", yes_bid_dollars: "0.0000" }).yesAsk, null);
});

test("pickCurrent picks soonest open close_time", () => {
  const now = Date.parse("2026-11-22T19:20:00Z");
  const mk = (o: string, c: string) => normalizeMarket({ ticker: c, open_time: o, close_time: c });
  const cur = pickCurrent([mk("2026-11-22T19:30:00Z", "2026-11-22T19:45:00Z"), mk("2026-11-22T19:15:00Z", "2026-11-22T19:30:00Z")], now);
  assert.equal(cur?.ticker, "2026-11-22T19:30:00Z");
});

test("orderbook normalizes best first", () => {
  const ob = normalizeOrderBook({ orderbook_fp: { yes_dollars: [["0.1300", "5"], ["0.1400", "10"]], no_dollars: [["0.8500", "3"]] } });
  assert.deepEqual(ob.upBids[0], { price: 14, size: 10 });
  assert.equal(ob.downBids[0].price, 85);
});

test("fast move guard", () => {
  assert.equal(isFastMove(60200, 60000, 0.001), true); // 33bp > 20bp
  assert.equal(isFastMove(60050, 60000, 0.001), false);
});

test("stdLogReturns", () => {
  const closes = Array.from({ length: 100 }, (_, i) => 100 * Math.exp((i % 2 ? 1 : -1) * 0.001));
  const s = stdLogReturns(closes, 60)!;
  assert.ok(s > 0.0019 && s < 0.0021);
});

test("buckets and shrink", () => {
  assert.equal(bucketOf(0), 0);
  assert.equal(bucketOf(2.99), 0);
  assert.equal(bucketOf(14.9), 4);
  assert.equal(bucketOf(15), 4);
  assert.equal(shrink(0.5, 0.5), 0.5);
  assert.ok(shrink(0.8, 0.5) < 0.8 && shrink(0.8, 0.5) > 0.5);
});

// Deterministic PRNG
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test("fitShrink detects overconfidence", () => {
  const r = rng(1);
  const ps: number[] = [], ys: (0 | 1)[] = [];
  for (let i = 0; i < 3000; i++) {
    const said = 0.05 + 0.9 * r();
    const truth = shrink(said, 0.6); // reality is less extreme than the model says
    ps.push(said);
    ys.push(r() < truth ? 1 : 0);
  }
  const a = fitShrink(ps, ys);
  assert.ok(a > 0.45 && a < 0.75, String(a));
});

test("fitCalib recovers a too-small spread", () => {
  const r = rng(7);
  const rows = [];
  for (let i = 0; i < 3000; i++) {
    const vol = 0.0008, tEff = 1 + 13 * r();
    const lnr = (r() - 0.5) * 0.006;
    const trueP = F(lnr / (vol * Math.sqrt(tEff) * 1.5));
    rows.push({ lnr, vol, tEff, minsLeft: tEff, y: (r() < trueP ? 1 : 0) as 0 | 1 });
  }
  const c = fitCalib(rows);
  assert.ok(c > 1.25 && c < 1.8, String(c));
  const st = computeCalibration(rows);
  assert.equal(st.calibActive, true);
  assert.equal(computeCalibration(rows.slice(0, 150)).calibActive, false);
});

test("scorecard P/L and verdict", () => {
  const base = { lnr: 0, vol: 0.001, tEff: 5, calib: 1, yesBid: 39, noBid: 59, noAsk: 61, price: 1, target: 1, fast: false, closeTime: 0 };
  const rows: Graded[] = [];
  for (let w = 0; w < 12; w++) {
    for (let i = 0; i < 20; i++) {
      const y = (w % 2) as 0 | 1;
      rows.push({ ...base, ts: w * 1000 + i, ticker: "T" + w, minsLeft: i / 2, pUp: y ? 0.7 : 0.3, kalshiMid: 50, yesAsk: 41, y });
    }
  }
  const sc = computeScorecard(rows, 3, 1);
  assert.equal(sc.windows, 12);
  assert.ok(sc.modelBrier! < sc.kalshiBrier!);
  assert.equal(sc.verdict.kind, "beats");
  // Up bought when pUp=0.7 at 41+2=43 (edge 27) -> wins 57 each; Down bought when pUp=0.3 at 61+2=63 (edge 7) -> wins 37
  assert.equal(sc.pnlFirst.trades, 12);
  assert.equal(sc.pnlFirst.pnl, 6 * 57 + 6 * 37);
});
