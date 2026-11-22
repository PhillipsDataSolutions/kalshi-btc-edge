// Probability model, ported from the TradingView indicator.

/** Student-t CDF with 4 degrees of freedom (closed form). */
export function tcdf4(x: number): number {
  const q = 1 + (x * x) / 4;
  return 0.5 + 0.375 * (x / Math.sqrt(q)) * (1 - (x * x) / (12 * q));
}

/** t(4) scaled to unit variance (t4 has variance 2). */
export function F(z: number): number {
  return tcdf4(z * Math.SQRT2);
}

/** Effective minutes left, accounting for the 60-second settlement average. */
export function effectiveMinutes(minsLeft: number): number {
  return Math.max(minsLeft - 2 / 3, minsLeft / 3);
}

/** Sample standard deviation of log returns over the last `n` intervals of `closes`. */
export function stdLogReturns(closes: number[], n: number): number | null {
  const start = Math.max(1, closes.length - n);
  const rets: number[] = [];
  for (let i = start; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 10) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const v = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v);
}

/** 60% × 1h σ + 40% × 24h σ of 1-minute log returns. */
export function blendedVolPerMin(minuteCloses: number[]): number | null {
  const s60 = stdLogReturns(minuteCloses, 60);
  const s1440 = stdLogReturns(minuteCloses, 1440);
  if (s60 === null && s1440 === null) return null;
  if (s60 === null) return s1440;
  if (s1440 === null) return s60;
  return 0.6 * s60 + 0.4 * s1440;
}

export interface ModelInputs {
  price: number;
  target: number;
  volPerMin: number;
  minsLeft: number;
  calib: number;
  /** BRTI seconds already observed inside the 60s settlement window (sum and count). */
  obsSum?: number;
  obsCount?: number;
}

export interface ModelOutput {
  pUp: number; // 0..1, before per-bucket shrink
  center: number; // expected settlement average (= price before the final minute)
  spread: number; // log-space σ to settlement
  tEff: number;
  lnr: number; // ln(price/target)
  z: number;
}

/**
 * Inside the final minute part of the settlement average is already known. With n of the 60
 * one-second BRTI values observed (sum S) and k = 60 − n still to come, the settlement average is
 * (S + k·price)/60 plus noise whose variance is σ²·(k/60)³/3 — the exact continuation of the
 * tEff = m − 2/3 formula (the two agree at m = 1). If observations are missing (app opened mid-
 * window) it falls back to the indicator's tEff = max(m − 2/3, m/3) on the live price.
 */
export function settlementTerms(minsLeft: number, price: number, obsSum = 0, obsCount = 0) {
  if (minsLeft < 1 && obsCount > 0) {
    const secsLeft = Math.max(0, minsLeft * 60);
    const k = Math.max(0, 60 - obsCount);
    // Only trust the observed sum if we have (almost) every second elapsed so far.
    if (Math.abs(k - Math.ceil(secsLeft)) <= 3) {
      const m = k / 60;
      return { center: (obsSum + k * price) / 60, tEff: (m * m * m) / 3 };
    }
  }
  return { center: price, tEff: effectiveMinutes(minsLeft) };
}

export function modelProbUp({ price, target, volPerMin, minsLeft, calib, obsSum, obsCount }: ModelInputs): ModelOutput {
  const { center, tEff } = settlementTerms(minsLeft, price, obsSum, obsCount);
  const lnr = Math.log(center / target);
  if (minsLeft <= 0 || tEff <= 0) {
    return { pUp: center >= target ? 1 : 0, center, spread: 0, tEff: 0, lnr, z: lnr >= 0 ? Infinity : -Infinity };
  }
  const spread = Math.max(1e-9, volPerMin * Math.sqrt(tEff) * calib);
  const z = lnr / spread;
  return { pUp: clamp01(F(z)), center, spread, tEff, lnr, z };
}

export function clamp01(p: number) {
  return Math.min(1, Math.max(0, p));
}

/** Probability mass of settlement price between two prices, given current price and spread. */
export function massBetween(price: number, spread: number, lo: number, hi: number): number {
  if (spread <= 0) return price >= lo && price < hi ? 1 : 0;
  const zl = Math.log(lo / price) / spread;
  const zh = Math.log(hi / price) / spread;
  return Math.max(0, F(zh) - F(zl));
}

/** Fast move: |60s log move| > 2 × 1-minute σ. */
export function isFastMove(priceNow: number, price60sAgo: number | null, volPerMin: number | null): boolean {
  if (!price60sAgo || !volPerMin) return false;
  return Math.abs(Math.log(priceNow / price60sAgo)) > 2 * volPerMin;
}
