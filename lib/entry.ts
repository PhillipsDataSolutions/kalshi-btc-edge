// Entry-time helpers: the learned blend coefficients (from `npm run learn` → lib/priors.json, plus an
// optional on-device re-fit) and whether the backtest proved an edge at a given minute.

import priors from "./priors.json";
import { readLS, writeLS } from "./storage";

export interface OosRow {
  minute: number;
  minsLeft: number;
  nTrain: number;
  nTest: number;
  brierModel: number;
  brierKalshi: number;
  brierBlend: number;
  pnlModel: { trades: number; wins: number; pnl: number; perTrade: number };
  pnlBlend: { trades: number; wins: number; pnl: number; perTrade: number };
}

export interface Priors {
  generatedAt: string;
  days: number;
  windows: number;
  samples: number;
  margin: number;
  coef: Record<string, number[]>;
  outOfSample: OosRow[];
}

export const PRIORS = priors as unknown as Priors;

export interface BlendState {
  entryMinute: number;
  coef: number[];
  n: number;
  updatedAt: number;
}

const LIVE_KEY = "kbe.liveblend";

export function loadLiveBlend(): BlendState | null {
  const v = readLS<{ s: BlendState | null }>(LIVE_KEY, { s: null }).s;
  return v && Array.isArray(v.coef) ? v : null;
}
export function saveLiveBlend(s: BlendState) {
  writeLS(LIVE_KEY, { s });
}

/** Entry zone: your entry minute ± 1 minute (minutes into the window). */
export function entryZone(entryMinute: number) {
  return { from: entryMinute - 1, to: entryMinute + 1 };
}

/** Coefficients for the nearest backtested minute; the live re-fit overrides inside its entry zone. */
export function blendCoef(minuteIn: number, live: BlendState | null): number[] | null {
  if (live) {
    const z = entryZone(live.entryMinute);
    if (minuteIn >= z.from && minuteIn <= z.to) return live.coef;
  }
  const m = Math.min(14, Math.max(1, Math.round(minuteIn)));
  return PRIORS.coef?.[String(m)] ?? null;
}

export function oosRow(minuteIn: number): OosRow | null {
  const m = Math.min(14, Math.max(1, Math.round(minuteIn)));
  return PRIORS.outOfSample?.find((r) => r.minute === m) ?? null;
}

/**
 * "Proven" = on windows the fit never saw, the blend had a lower Brier score than Kalshi's own price
 * AND its one-trade-per-window strategy made money after fees.
 */
export function isProven(minuteIn: number): { ok: boolean; reason: string } {
  const r = oosRow(minuteIn);
  if (!r) return { ok: false, reason: "no backtest for this minute" };
  if (r.brierBlend >= r.brierKalshi) return { ok: false, reason: `Kalshi priced minute ${r.minute} better in testing` };
  if (r.pnlBlend.trades < 20) return { ok: false, reason: `too few test trades at minute ${r.minute}` };
  if (r.pnlBlend.pnl <= 0) return { ok: false, reason: `minute ${r.minute} lost money in testing` };
  return { ok: true, reason: "" };
}
