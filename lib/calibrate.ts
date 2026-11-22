// Self-calibration: a global spread multiplier (calib) plus per-time-bucket shrinkage of
// overconfident odds ("said 74%, won 69%"). Each kicks in only after enough graded readings.

import { F } from "./model.ts";

export const BUCKETS = [
  { label: "0–3m", lo: 0, hi: 3 },
  { label: "3–6m", lo: 3, hi: 6 },
  { label: "6–9m", lo: 6, hi: 9 },
  { label: "9–12m", lo: 9, hi: 12 },
  { label: "12–15m", lo: 12, hi: 15 },
] as const;

export const MIN_PER_BUCKET = 200;

export function bucketOf(minsLeft: number): number {
  return Math.min(BUCKETS.length - 1, Math.max(0, Math.floor(minsLeft / 3)));
}

const EPS = 1e-4;
function logit(p: number) {
  const q = Math.min(1 - EPS, Math.max(EPS, p));
  return Math.log(q / (1 - q));
}
function sigmoid(x: number) {
  return 1 / (1 + Math.exp(-x));
}

/** Shrink p toward 50% in logit space. a = 1 → unchanged, a < 1 → less confident. */
export function shrink(p: number, a: number): number {
  if (a === 1 || p <= 0 || p >= 1) return p;
  return sigmoid(a * logit(p));
}

export interface CalibState {
  calib: number;
  shrink: number[]; // per bucket
  calibActive: boolean;
  shrinkActive: boolean[];
  graded: number;
  perBucket: number[];
  updatedAt: number;
}

export const DEFAULT_CALIB: CalibState = {
  calib: 1,
  shrink: BUCKETS.map(() => 1),
  calibActive: false,
  shrinkActive: BUCKETS.map(() => false),
  graded: 0,
  perBucket: BUCKETS.map(() => 0),
  updatedAt: 0,
};

export interface CalibRow {
  lnr: number;
  vol: number;
  tEff: number;
  minsLeft: number;
  y: 0 | 1;
}

function rawP(r: CalibRow, c: number) {
  if (r.tEff <= 0 || r.vol <= 0) return r.lnr >= 0 ? 1 : 0;
  return F(r.lnr / (r.vol * Math.sqrt(r.tEff) * c));
}

/** Spread multiplier that minimises Brier score over all graded readings. */
export function fitCalib(rows: CalibRow[]): number {
  let best = 1;
  let bestErr = Infinity;
  for (let c = 0.5; c <= 3.0001; c += 0.025) {
    let err = 0;
    for (const r of rows) err += (rawP(r, c) - r.y) ** 2;
    if (err < bestErr) {
      bestErr = err;
      best = c;
    }
  }
  return Math.round(best * 1000) / 1000;
}

/** Shrink factor in [0.3, 1] minimising log loss of shrink(p, a). */
export function fitShrink(ps: number[], ys: (0 | 1)[]): number {
  let best = 1;
  let bestLoss = Infinity;
  for (let a = 0.3; a <= 1.0001; a += 0.01) {
    let loss = 0;
    for (let i = 0; i < ps.length; i++) {
      const q = Math.min(1 - EPS, Math.max(EPS, shrink(ps[i], a)));
      loss -= ys[i] ? Math.log(q) : Math.log(1 - q);
    }
    if (loss < bestLoss) {
      bestLoss = loss;
      best = a;
    }
  }
  return Math.round(best * 100) / 100;
}

export function computeCalibration(rows: CalibRow[]): CalibState {
  const perBucket = BUCKETS.map(() => 0);
  for (const r of rows) perBucket[bucketOf(r.minsLeft)]++;
  const calibActive = rows.length >= MIN_PER_BUCKET;
  const calib = calibActive ? fitCalib(rows) : 1;
  const shrinkArr = BUCKETS.map(() => 1);
  const shrinkActive = BUCKETS.map(() => false);
  BUCKETS.forEach((_, b) => {
    if (perBucket[b] < MIN_PER_BUCKET) return;
    const sub = rows.filter((r) => bucketOf(r.minsLeft) === b);
    shrinkArr[b] = fitShrink(
      sub.map((r) => rawP(r, calib)),
      sub.map((r) => r.y),
    );
    shrinkActive[b] = true;
  });
  return {
    calib,
    shrink: shrinkArr,
    calibActive,
    shrinkActive,
    graded: rows.length,
    perBucket,
    updatedAt: Date.now(),
  };
}

/** Final displayed P(Up): raw model (already using calib) → per-bucket shrink. */
export function correctedP(pRaw: number, minsLeft: number, state: CalibState): number {
  const b = bucketOf(minsLeft);
  return state.shrinkActive[b] ? shrink(pRaw, state.shrink[b]) : pRaw;
}
