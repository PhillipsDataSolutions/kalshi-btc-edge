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
  pnlModel: PnlSummary;
  pnlBlend: PnlSummary;
}

export interface PnlSummary {
  trades: number;
  wins: number;
  pnl: number; // cents
  perTrade: number; // cents
  t?: number; // mean / standard error
}

export interface ZoneRow extends PnlSummary {
  center: number;
  from: number;
  to: number;
  testWindows: number;
}

export interface Priors {
  generatedAt: string;
  days: number;
  windows: number;
  samples: number;
  margin: number;
  coef: Record<string, number[]>;
  outOfSample: OosRow[];
  zones?: ZoneRow[];
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

export const MIN_ZONE_TRADES = 30;
export const MIN_ZONE_T = 2;

export function zoneRow(entryMinute: number): ZoneRow | null {
  return PRIORS.zones?.find((z) => z.center === entryMinute) ?? null;
}

/**
 * "Proven" for an entry zone = on windows the fit never saw, trading the first qualifying minute of the
 * zone made money after fees over at least 30 trades with t ≥ 2 (unlikely to be luck), and the blend
 * scored better than Kalshi's own price at the zone's centre minute.
 */
export function isProven(entryMinute: number): { ok: boolean; reason: string } {
  const z = zoneRow(entryMinute);
  const r = oosRow(entryMinute);
  if (!z || !r) return { ok: false, reason: "no backtest for this entry zone" };
  if (z.trades < MIN_ZONE_TRADES) return { ok: false, reason: `only ${z.trades} test trades in min ${z.from}–${z.to}` };
  if (z.pnl <= 0) return { ok: false, reason: `min ${z.from}–${z.to} lost money in testing` };
  if ((z.t ?? 0) < MIN_ZONE_T) return { ok: false, reason: `min ${z.from}–${z.to} profit not significant (t=${z.t})` };
  if (r.brierBlend >= r.brierKalshi) return { ok: false, reason: `Kalshi priced minute ${r.minute} better in testing` };
  return { ok: true, reason: "" };
}

/** Best backtested entry zone by t-statistic among profitable zones with enough trades. */
export function bestZone(): ZoneRow | null {
  const z = (PRIORS.zones ?? []).filter((x) => x.trades >= MIN_ZONE_TRADES && x.pnl > 0);
  return z.sort((a, b) => (b.t ?? 0) - (a.t ?? 0))[0] ?? null;
}
