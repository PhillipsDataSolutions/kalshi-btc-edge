// Learned blend of the model with Kalshi's own price (and short-term momentum).
// P(Up) = σ(w0 + w1·logit(pModel) + w2·logit(pKalshi) + w3·mom1 + w4·mom5)
// If the model carries no information Kalshi lacks, w1 → 0 and the blend collapses to Kalshi's
// price, so the app stops flagging trades instead of chasing noise.

export interface BlendFeatures {
  x: number[]; // [1, logit(pModel), logit(pKalshi), mom1, mom5]
  y?: 0 | 1;
}

const EPS = 0.005;
export const logit = (p: number) => {
  const q = Math.min(1 - EPS, Math.max(EPS, p));
  return Math.log(q / (1 - q));
};
export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

const clip = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));

export function featuresFor(pModel: number, pKalshi: number, mom1: number, mom5: number): BlendFeatures {
  return { x: [1, logit(pModel), logit(pKalshi), clip(mom1, 5), clip(mom5, 5)] };
}

export function predictLogistic(w: number[], f: BlendFeatures): number {
  let z = 0;
  for (let i = 0; i < w.length; i++) z += w[i] * f.x[i];
  return sigmoid(z);
}

/** Solve A·x = b (small dense system) by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}

/**
 * Ridge-regularised logistic regression by Newton's method.
 * `prior` is the coefficient vector the penalty shrinks toward (default: trust Kalshi, w2 = 1).
 * The intercept is pinned to prior[0] (0) by default: a fitted intercept just learns whether BTC
 * happened to trend up or down during the training weeks, which is not an edge and biases every call.
 */
export function fitLogistic(
  data: BlendFeatures[],
  ridge = 1,
  prior: number[] = [0, 0, 1, 0, 0],
  fitIntercept = false,
): number[] {
  const k = prior.length;
  let w = [...prior];
  for (let it = 0; it < 30; it++) {
    const g = new Array(k).fill(0);
    const H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (const d of data) {
      const p = predictLogistic(w, d);
      const r = p - (d.y ?? 0);
      const s = p * (1 - p);
      for (let i = 0; i < k; i++) {
        g[i] += r * d.x[i];
        for (let j = 0; j < k; j++) H[i][j] += s * d.x[i] * d.x[j];
      }
    }
    for (let i = 1; i < k; i++) {
      g[i] += ridge * (w[i] - prior[i]);
      H[i][i] += ridge;
    }
    const r0 = fitIntercept ? 1e-6 : 1e9;
    g[0] += r0 * (w[0] - prior[0]);
    H[0][0] += r0;
    const step = solve(H, g);
    let max = 0;
    w = w.map((v, i) => {
      max = Math.max(max, Math.abs(step[i]));
      return v - step[i];
    });
    if (max < 1e-7) break;
  }
  return w.map((v) => Math.round(v * 1e5) / 1e5);
}
