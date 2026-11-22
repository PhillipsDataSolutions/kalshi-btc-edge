// Grades logged readings against settled results.

import { BUCKETS, bucketOf } from "./calibrate.ts";
import type { LogEntry, ResultEntry } from "./db.ts";
import { takerFeeCents } from "./fees.ts";

export interface Graded extends LogEntry {
  y: 0 | 1;
}

export function gradeLogs(logs: LogEntry[], results: ResultEntry[]): Graded[] {
  const byTicker = new Map(results.map((r) => [r.ticker, r]));
  const out: Graded[] = [];
  for (const l of logs) {
    const r = byTicker.get(l.ticker);
    if (r) out.push({ ...l, y: r.result === "yes" ? 1 : 0 });
  }
  return out;
}

export interface BucketScore {
  label: string;
  n: number;
  model: number | null;
  kalshi: number | null;
}

export interface CalRow {
  label: string;
  n: number;
  said: number; // avg model P(Up), 0..1
  won: number; // realised Up rate
  kalshiSaid: number | null;
}

export interface PnL {
  trades: number;
  wins: number;
  pnl: number; // cents per 1 contract per signal, fees included
}

export type Verdict =
  | { kind: "insufficient"; text: string }
  | { kind: "beats"; text: string }
  | { kind: "loses"; text: string }
  | { kind: "tie"; text: string };

export interface Scorecard {
  n: number;
  nCompared: number;
  windows: number;
  modelBrier: number | null;
  kalshiBrier: number | null;
  tStat: number | null;
  buckets: BucketScore[];
  calibration: CalRow[];
  pnlAll: PnL;
  pnlFirst: PnL;
  verdict: Verdict;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

export function pnlFor(rows: Graded[], margin: number, contracts: number, firstOnly: boolean): PnL {
  const res: PnL = { trades: 0, wins: 0, pnl: 0 };
  const seen = new Set<string>();
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  for (const r of sorted) {
    if (r.fast) continue;
    if (firstOnly && seen.has(r.ticker)) continue;
    const legs: { ask: number | null; fair: number; win: boolean }[] = [
      { ask: r.yesAsk, fair: r.pUp * 100, win: r.y === 1 },
      { ask: r.noAsk, fair: (1 - r.pUp) * 100, win: r.y === 0 },
    ];
    for (const leg of legs) {
      if (leg.ask === null) continue;
      const cost = leg.ask + takerFeeCents(leg.ask, contracts);
      if (leg.fair - cost >= margin) {
        res.trades++;
        if (leg.win) res.wins++;
        res.pnl += (leg.win ? 100 : 0) - cost;
        seen.add(r.ticker);
      }
    }
  }
  return res;
}

export function computeScorecard(graded: Graded[], margin: number, contracts: number): Scorecard {
  const compared = graded.filter((g) => g.kalshiMid !== null);
  const modelSq = (g: Graded) => (g.pUp - g.y) ** 2;
  const kalshiSq = (g: Graded) => ((g.kalshiMid as number) / 100 - g.y) ** 2;

  const windows = new Set(graded.map((g) => g.ticker)).size;

  // Paired test over windows (readings inside one window are strongly correlated).
  const perWindow = new Map<string, number[]>();
  for (const g of compared) {
    const d = modelSq(g) - kalshiSq(g);
    const arr = perWindow.get(g.ticker) ?? [];
    arr.push(d);
    perWindow.set(g.ticker, arr);
  }
  const wd = [...perWindow.values()].map((a) => mean(a) as number);
  let tStat: number | null = null;
  if (wd.length >= 3) {
    const m = mean(wd) as number;
    const sd = Math.sqrt(wd.reduce((s, x) => s + (x - m) ** 2, 0) / (wd.length - 1));
    tStat = sd > 0 ? m / (sd / Math.sqrt(wd.length)) : 0;
  }

  const modelBrier = mean(compared.map(modelSq));
  const kalshiBrier = mean(compared.map(kalshiSq));

  const buckets: BucketScore[] = BUCKETS.map((b, i) => {
    const rows = compared.filter((g) => bucketOf(g.minsLeft) === i);
    return { label: b.label, n: rows.length, model: mean(rows.map(modelSq)), kalshi: mean(rows.map(kalshiSq)) };
  });

  const calibration: CalRow[] = [];
  for (let i = 0; i < 10; i++) {
    const lo = i / 10;
    const hi = (i + 1) / 10;
    const rows = graded.filter((g) => g.pUp >= lo && (i === 9 ? g.pUp <= hi : g.pUp < hi));
    if (!rows.length) continue;
    const ks = rows.filter((g) => g.kalshiMid !== null).map((g) => (g.kalshiMid as number) / 100);
    calibration.push({
      label: `${i * 10}–${i * 10 + 10}%`,
      n: rows.length,
      said: mean(rows.map((g) => g.pUp)) as number,
      won: mean(rows.map((g) => g.y)) as number,
      kalshiSaid: mean(ks),
    });
  }

  const pnlAll = pnlFor(graded, margin, contracts, false);
  const pnlFirst = pnlFor(graded, margin, contracts, true);

  let verdict: Verdict;
  const fmt = (x: number | null) => (x === null ? "–" : x.toFixed(4));
  if (compared.length < 200 || perWindow.size < 10) {
    verdict = {
      kind: "insufficient",
      text: `Not enough data yet: ${plural(compared.length, "graded reading")} across ${plural(perWindow.size, "window")}. Need at least 200 readings and 10 windows before judging.`,
    };
  } else if (modelBrier !== null && kalshiBrier !== null && modelBrier < kalshiBrier) {
    verdict =
      tStat !== null && tStat < -2
        ? { kind: "beats", text: `Model beats Kalshi: Brier ${fmt(modelBrier)} vs ${fmt(kalshiBrier)} over ${perWindow.size} windows.` }
        : {
            kind: "tie",
            text: `Model is slightly ahead (Brier ${fmt(modelBrier)} vs ${fmt(kalshiBrier)}), but not by enough to rule out luck over ${perWindow.size} windows.`,
          };
  } else {
    verdict =
      tStat !== null && tStat > 2
        ? {
            kind: "loses",
            text: `Model does NOT beat Kalshi. Kalshi's prices are more accurate: Brier ${fmt(kalshiBrier)} vs model ${fmt(modelBrier)}. Treat "cheap" calls with suspicion.`,
          }
        : {
            kind: "tie",
            text: `Model does not beat Kalshi yet (Brier ${fmt(modelBrier)} vs Kalshi ${fmt(kalshiBrier)}). The gap is within noise.`,
          };
  }

  return {
    n: graded.length,
    nCompared: compared.length,
    windows,
    modelBrier,
    kalshiBrier,
    tStat,
    buckets,
    calibration,
    pnlAll,
    pnlFirst,
    verdict,
  };
}
