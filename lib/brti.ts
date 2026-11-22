// Replica of the CME CF Bitcoin Real Time Index (BRTI) calculation.
// Source: "CME CF Cryptocurrency Real Time Indices Methodology Guide", v17.0, 21 Sep 2026,
// https://docs.cfbenchmarks.com/CME%20CF%20Real%20Time%20Indices%20Methodology.pdf
//
// BRTI parameters (section 6): spacing = dynamic, deviation from mid D = 0.5%,
// potentially-erroneous-data threshold = 5%, order size cap = dynamic, λ = 1/(0.3·v_T),
// target levels τ = 100, retrieval lag threshold = 10 s, effective time every 200 ms.

export type Level = [price: number, size: number];

export interface ExchangeBook {
  id: string;
  bids: Level[]; // descending by price
  asks: Level[]; // ascending by price
}

export interface RtiResult {
  value: number;
  used: string[]; // exchanges included
  excluded: { id: string; reason: string }[];
  utilizedDepth: number; // BTC
  spacing: number; // BTC
  cap: number; // BTC
  points: number;
}

export const D = 0.005;
export const ERRONEOUS = 0.05;
export const TAU = 100;
const MAX_POINTS = 400_000;

const mid = (b: ExchangeBook) => (b.bids[0][0] + b.asks[0][0]) / 2;

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** Winsorize 1% each side; return trimmed mean, winsorized mean and winsorized sample sd. */
function robustStats(sizes: number[]) {
  const s = [...sizes].sort((a, b) => a - b);
  const n = s.length;
  const k = Math.floor(0.01 * n);
  let trimSum = 0;
  for (let i = k; i < n - k; i++) trimSum += s[i];
  const trimmed = trimSum / Math.max(1, n - 2 * k);
  const w = s.map((x, i) => (i < k ? s[k] : i >= n - k ? s[n - k - 1] : x));
  const wMean = w.reduce((a, b) => a + b, 0) / n;
  const wSd = n > 1 ? Math.sqrt(w.reduce((a, x) => a + (x - wMean) ** 2, 0) / (n - 1)) : 0;
  return { trimmed, w, wMean, wSd, n };
}

/** Eq. 4a/4b: number of levels within 5% of the best price, but at least min(|side|, 50). */
function sampleCount(levels: Level[], side: "bid" | "ask") {
  if (!levels.length) return 0;
  const best = levels[0][0];
  let c = 0;
  for (const [p] of levels) {
    if (side === "ask" ? p <= 1.05 * best : p >= 0.95 * best) c++;
    else break;
  }
  return Math.max(c, Math.min(levels.length, 50));
}

/** Eq. 6g–6j: mode of a Gaussian KDE of order sizes. */
function kdeMode(w: number[], sd: number) {
  const n = w.length;
  if (n < 4) return Math.min(...w);
  const h = 1.06 * sd * Math.pow(n, -0.2);
  if (!(h > 0)) return w[0];
  const lo = w[0];
  const hi = w[n - 1];
  // Coarse grid search then refine around the best point.
  let best = lo;
  let bestF = -Infinity;
  const evalF = (x: number) => {
    let f = 0;
    for (let i = 0; i < n; i++) {
      const u = (x - w[i]) / h;
      if (u > -8 && u < 8) f += Math.exp(-0.5 * u * u);
    }
    return f;
  };
  const steps = 400;
  for (let i = 0; i <= steps; i++) {
    const x = lo + ((hi - lo) * i) / steps;
    const f = evalF(x);
    if (f > bestF) {
      bestF = f;
      best = x;
    }
  }
  let step = (hi - lo) / steps;
  for (let r = 0; r < 30 && step > 1e-12; r++) {
    const l = evalF(best - step / 2);
    const rr = evalF(best + step / 2);
    if (l > bestF && l >= rr) {
      best -= step / 2;
      bestF = l;
    } else if (rr > bestF) {
      best += step / 2;
      bestF = rr;
    } else step /= 2;
  }
  return best;
}

function consolidate(books: ExchangeBook[]) {
  const bidMap = new Map<number, number>();
  const askMap = new Map<number, number>();
  for (const b of books) {
    for (const [p, s] of b.bids) bidMap.set(p, (bidMap.get(p) ?? 0) + s);
    for (const [p, s] of b.asks) askMap.set(p, (askMap.get(p) ?? 0) + s);
  }
  const bids: Level[] = [...bidMap.entries()].sort((a, b) => b[0] - a[0]);
  const asks: Level[] = [...askMap.entries()].sort((a, b) => a[0] - b[0]);
  return { bids, asks };
}

/** Section 5.2/5.3 screening. `excludedPrev` gives hysteresis for the 5% deviation rule. */
export function screen(books: ExchangeBook[], excludedPrev: Set<string> = new Set()) {
  const excluded: { id: string; reason: string }[] = [];
  const ok: ExchangeBook[] = [];
  for (const b of books) {
    const bids = b.bids.filter(([p, s]) => p > 0 && s > 0 && Number.isFinite(p) && Number.isFinite(s));
    const asks = b.asks.filter(([p, s]) => p > 0 && s > 0 && Number.isFinite(p) && Number.isFinite(s));
    if (!bids.length || !asks.length) excluded.push({ id: b.id, reason: "empty side" });
    else if (bids[0][0] >= asks[0][0]) excluded.push({ id: b.id, reason: "crossed" });
    else ok.push({ id: b.id, bids, asks });
  }
  if (!ok.length) return { ok, excluded };
  const med = median(ok.map(mid));
  const kept: ExchangeBook[] = [];
  for (const b of ok) {
    const dev = Math.abs(mid(b) / med - 1);
    const limit = excludedPrev.has(b.id) ? ERRONEOUS / 2 : ERRONEOUS;
    if (dev > limit) excluded.push({ id: b.id, reason: `${(dev * 100).toFixed(1)}% from median` });
    else kept.push(b);
  }
  return { ok: kept, excluded };
}

export function computeRti(input: ExchangeBook[], excludedPrev?: Set<string>): RtiResult | null {
  const { ok, excluded } = screen(input, excludedPrev);
  if (!ok.length) return null;

  // Step 1–2: consolidated book; dynamic order size cap from the uncapped book (4.1.3).
  const { bids: rawBids, asks: rawAsks } = consolidate(ok);
  const bc = sampleCount(rawBids, "bid");
  const ac = sampleCount(rawAsks, "ask");
  const sizes = [...rawBids.slice(0, bc).map((l) => l[1]), ...rawAsks.slice(0, ac).map((l) => l[1])];
  const st = robustStats(sizes);
  const cap = st.trimmed + 5 * st.wSd;

  const bids: Level[] = rawBids.map(([p, s]) => [p, Math.min(s, cap)]);
  const asks: Level[] = rawAsks.map(([p, s]) => [p, Math.min(s, cap)]);

  // Step 2a: uncross.
  let bi = 0;
  let ai = 0;
  while (bi < bids.length && ai < asks.length && bids[bi][0] >= asks[ai][0]) {
    const q = Math.min(bids[bi][1], asks[ai][1]);
    bids[bi][1] -= q;
    asks[ai][1] -= q;
    if (bids[bi][1] <= 1e-15) bi++;
    if (asks[ai][1] <= 1e-15) ai++;
  }
  const B = bids.slice(bi).filter((l) => l[1] > 1e-15);
  const A = asks.slice(ai).filter((l) => l[1] > 1e-15);
  if (!B.length || !A.length) return null;

  // Dynamic spacing (4.1.4).
  const totA = A.reduce((s, l) => s + l[1], 0);
  const totB = B.reduce((s, l) => s + l[1], 0);
  const sLev = Math.min(totA, totB) / TAU;
  const bc2 = sampleCount(B, "bid");
  const ac2 = sampleCount(A, "ask");
  let cumB = 0;
  for (let i = 0; i < bc2; i++) cumB += B[i][1];
  let cumA = 0;
  for (let i = 0; i < ac2; i++) cumA += A[i][1];
  const sideSizes = cumB < cumA ? B.slice(0, bc2).map((l) => l[1]) : A.slice(0, ac2).map((l) => l[1]);
  const ss = robustStats(sideSizes);
  const sKde = ss.n >= 4 ? kdeMode(ss.w, ss.wSd) : Math.min(...sideSizes);
  let s = Math.min(sLev, sKde);
  if (!(s > 0)) s = sLev > 0 ? sLev : 1e-4;

  // Price-volume curves on the grid v = s, 2s, ... (Eq. 1–2). Pointer walk over cumulative sizes.
  const maxV = Math.min(totA, totB);
  if (maxV / s > MAX_POINTS) s = maxV / MAX_POINTS; // safety guard for pathological books
  const mids: number[] = [];
  let ia = 0;
  let ib = 0;
  let ca = A[0][1];
  let cb = B[0][1];
  for (let k = 1; ; k++) {
    const v = k * s;
    if (v > maxV + 1e-12) break;
    while (ca < v - 1e-12 && ia < A.length - 1) ca += A[++ia][1];
    while (cb < v - 1e-12 && ib < B.length - 1) cb += B[++ib][1];
    if (ca < v - 1e-12 || cb < v - 1e-12) break;
    const ask = A[ia][0];
    const bid = B[ib][0];
    const m = (ask + bid) / 2;
    const spread = ask / m - 1;
    if (spread > D) break;
    mids.push(m);
  }
  if (!mids.length) {
    // Utilized depth floors at the spacing parameter: use the first grid point.
    mids.push((A[0][0] + B[0][0]) / 2);
  }
  const vT = mids.length * s;
  const lambda = 1 / (0.3 * vT);
  let num = 0;
  let nf = 0;
  for (let k = 0; k < mids.length; k++) {
    const w = lambda * Math.exp(-lambda * (k + 1) * s);
    num += mids[k] * w;
    nf += w;
  }
  return {
    value: num / nf,
    used: ok.map((b) => b.id),
    excluded,
    utilizedDepth: vT,
    spacing: s,
    cap,
    points: mids.length,
  };
}
