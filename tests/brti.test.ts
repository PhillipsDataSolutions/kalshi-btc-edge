import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRti, screen, type ExchangeBook } from "../lib/brti.ts";
import { settlementTerms, modelProbUp } from "../lib/model.ts";

function ladder(mid: number, half: number, step: number, n: number, size: (i: number) => number) {
  const bids: [number, number][] = [];
  const asks: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    bids.push([mid - half - i * step, size(i)]);
    asks.push([mid + half + i * step, size(i)]);
  }
  return { bids, asks };
}

test("symmetric book -> index equals mid", () => {
  const b: ExchangeBook = { id: "x", ...ladder(60000, 0.5, 1, 400, () => 0.5) };
  const r = computeRti([b])!;
  assert.ok(Math.abs(r.value - 60000) < 1e-6, String(r.value));
  assert.ok(r.utilizedDepth > 0);
});

test("asymmetric depth pulls the index toward the thin side", () => {
  // Thick bids, thin asks: deeper volume is reached at higher ask prices -> index above best mid.
  const thick = ladder(60000, 0.5, 1, 400, () => 1);
  const thin = ladder(60000, 0.5, 1, 400, () => 0.25);
  const r = computeRti([{ id: "x", bids: thick.bids, asks: thin.asks }])!;
  assert.ok(r.value > 60000, String(r.value));
});

test("a giant order is capped and cannot dominate", () => {
  const base = ladder(60000, 0.5, 1, 400, () => 0.5);
  const bids = base.bids.map((l, i) => (i === 3 ? ([l[0], 10_000] as [number, number]) : l));
  const r = computeRti([{ id: "x", bids, asks: base.asks }])!;
  assert.ok(r.cap < 10, String(r.cap));
  assert.ok(Math.abs(r.value - 60000) < 5, String(r.value));
});

test("crossed books across exchanges get uncrossed", () => {
  const a = ladder(60000, 0.5, 1, 300, () => 0.5);
  const b = ladder(60010, 0.5, 1, 300, () => 0.5); // b's bids above a's asks
  const r = computeRti([
    { id: "a", ...a },
    { id: "b", ...b },
  ])!;
  assert.ok(r.value > 60000 && r.value < 60010, String(r.value));
});

test("screening drops crossed, empty and >5% outlier books", () => {
  const good = (m: number, id: string): ExchangeBook => ({ id, ...ladder(m, 0.5, 1, 50, () => 1) });
  const crossed: ExchangeBook = { id: "c", bids: [[60010, 1]], asks: [[60000, 1]] };
  const empty: ExchangeBook = { id: "e", bids: [], asks: [[60000, 1]] };
  const { ok, excluded } = screen([good(60000, "a"), good(60005, "b"), good(70000, "o"), crossed, empty]);
  assert.deepEqual(ok.map((b) => b.id).sort(), ["a", "b"]);
  assert.deepEqual(excluded.map((x) => x.id).sort(), ["c", "e", "o"]);
});

test("final-minute settlement terms", () => {
  // 3 minutes left: indicator formula, centre = price
  assert.deepEqual(settlementTerms(3, 60000), { center: 60000, tEff: 3 - 2 / 3 });
  // 30s left, 30 seconds observed averaging 60100, price 60000 -> centre 60050, tEff = (0.5)^3/3
  const t = settlementTerms(0.5, 60000, 30 * 60100, 30);
  assert.ok(Math.abs(t.center - 60050) < 1e-9);
  assert.ok(Math.abs(t.tEff - 0.125 / 3) < 1e-12);
  // missing observations -> fall back
  assert.deepEqual(settlementTerms(0.5, 60000, 5 * 60100, 5), { center: 60000, tEff: 0.5 / 3 });
  // continuity at the window start
  assert.ok(Math.abs(settlementTerms(1, 1).tEff - 1 / 3) < 1e-12);
  // locked-in average above target makes Up near certain even if spot dips below target
  const p = modelProbUp({ price: 59990, target: 60000, volPerMin: 0.0008, minsLeft: 5 / 60, calib: 1, obsSum: 55 * 60100, obsCount: 55 });
  assert.ok(p.pUp > 0.99, String(p.pUp));
});
