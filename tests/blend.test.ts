import { test } from "node:test";
import assert from "node:assert/strict";
import { featuresFor, fitLogistic, predictLogistic, logit, sigmoid } from "../lib/blend.ts";

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test("blend recovers known weights", () => {
  const r = rng(3);
  const data = [];
  for (let i = 0; i < 4000; i++) {
    const pm = 0.05 + 0.9 * r();
    const pk = 0.05 + 0.9 * r();
    const m1 = (r() - 0.5) * 4;
    const z = 0.2 + 0.8 * logit(pm) + 0.4 * logit(pk) + 0.3 * m1;
    data.push({ ...featuresFor(pm, pk, m1, 0), y: (r() < sigmoid(z) ? 1 : 0) as 0 | 1 });
  }
  const w = fitLogistic(data, 0.1);
  assert.ok(Math.abs(w[1] - 0.8) < 0.15, String(w));
  assert.ok(Math.abs(w[2] - 0.4) < 0.15, String(w));
  assert.ok(Math.abs(w[3] - 0.3) < 0.1, String(w));
});

test("when the model is pure noise the blend falls back to Kalshi", () => {
  const r = rng(9);
  const data = [];
  for (let i = 0; i < 4000; i++) {
    const pk = 0.05 + 0.9 * r();
    const pm = 0.05 + 0.9 * r(); // unrelated to outcome
    data.push({ ...featuresFor(pm, pk, 0, 0), y: (r() < pk ? 1 : 0) as 0 | 1 });
  }
  const w = fitLogistic(data, 1);
  assert.ok(Math.abs(w[1]) < 0.1, String(w));
  assert.ok(Math.abs(w[2] - 1) < 0.15, String(w));
  const p = predictLogistic(w, featuresFor(0.9, 0.5, 0, 0));
  assert.ok(Math.abs(p - 0.5) < 0.06, String(p));
});

test("strong ridge keeps the prior", () => {
  const w = fitLogistic([{ ...featuresFor(0.9, 0.5, 0, 0), y: 1 }], 1e6, [0, 0.5, 0.5, 0, 0]);
  assert.ok(Math.abs(w[1] - 0.5) < 1e-3 && Math.abs(w[2] - 0.5) < 1e-3);
});
