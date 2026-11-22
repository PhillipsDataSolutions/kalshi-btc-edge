// Measures the price engine against the truth: for every window, our replica's 60-second average
// vs Kalshi's official expiration_value (the real CF Benchmarks BRTI settlement average).

import { readLS, writeLS } from "./storage";

export interface TrackEntry {
  ticker: string;
  closeTime: number;
  ours: number; // replica's 60s average before close (raw, no bias correction)
  n: number; // seconds observed (of 60)
  official: number | null; // Kalshi expiration_value
}

const KEY = "kbe.track";
export const BIAS_MIN_WINDOWS = 5;
const BIAS_LOOKBACK = 20;

/**
 * Kalshi: "the simple average of the sixty seconds of CF Benchmarks' BRTI before <close>".
 * We average the replica's per-second values stamped close−59s … close (inclusive).
 */
export const SETTLE_FIRST_OFFSET_S = -59;
export const SETTLE_LAST_OFFSET_S = 0;

export function loadTrack(): TrackEntry[] {
  return readLS<{ list: TrackEntry[] }>(KEY, { list: [] }).list;
}

export function saveTrack(list: TrackEntry[]) {
  writeLS(KEY, { list: list.slice(-300) });
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0;
};

export interface TrackStats {
  n: number;
  meanErr: number | null; // ours − official, $
  mae: number | null;
  maxAbs: number | null;
  bias: number; // add to replica to correct (official − ours, median of recent windows)
  biasActive: boolean;
  recent: TrackEntry[];
}

export function trackStats(list: TrackEntry[]): TrackStats {
  const done = list.filter((e) => e.official !== null && e.n >= 55).sort((a, b) => a.closeTime - b.closeTime);
  const errs = done.map((e) => e.ours - (e.official as number));
  const recent = done.slice(-BIAS_LOOKBACK);
  const biasActive = recent.length >= BIAS_MIN_WINDOWS;
  return {
    n: done.length,
    meanErr: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null,
    mae: errs.length ? errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length : null,
    maxAbs: errs.length ? Math.max(...errs.map(Math.abs)) : null,
    bias: biasActive ? median(recent.map((e) => (e.official as number) - e.ours)) : 0,
    biasActive,
    recent: done.slice(-12).reverse(),
  };
}
