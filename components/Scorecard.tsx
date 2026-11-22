"use client";

import { useEffect, useState } from "react";
import { BUCKETS, MIN_PER_BUCKET } from "@/lib/calibrate";
import { allLogs, allResults } from "@/lib/db";
import { pct } from "@/lib/format";
import { Scorecard as SC, computeScorecard, gradeLogs } from "@/lib/scorecard";
import type { Engine } from "@/lib/useEngine";
import { Card, Label } from "./ui";

const b4 = (x: number | null) => (x === null ? "–" : x.toFixed(4));
const money = (c: number) => `${c >= 0 ? "+" : "−"}$${(Math.abs(c) / 100).toFixed(2)}`;

export default function Scorecard({ e, margin, contracts }: { e: Engine; margin: number; contracts: number }) {
  const [sc, setSc] = useState<SC | null>(null);
  const [counts, setCounts] = useState({ logs: 0, results: 0, pending: 0 });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [logs, results] = await Promise.all([allLogs(), allResults()]);
      const graded = gradeLogs(logs, results);
      if (!alive) return;
      const done = new Set(results.map((r) => r.ticker));
      setCounts({
        logs: logs.length,
        results: results.length,
        pending: new Set(logs.filter((l) => !done.has(l.ticker)).map((l) => l.ticker)).size,
      });
      setSc(computeScorecard(graded, margin, contracts));
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [e.gradedVersion, margin, contracts]);

  if (!sc) return <Card>Loading scorecard…</Card>;

  const banner =
    sc.verdict.kind === "beats"
      ? "border-up/50 bg-up/10 text-up"
      : sc.verdict.kind === "loses"
        ? "border-down/50 bg-down/10 text-down"
        : sc.verdict.kind === "tie"
          ? "border-warn/50 bg-warn/10 text-warn"
          : "border-line bg-card2 text-ink2";

  return (
    <div className="space-y-3">
      <div className={`rounded-2xl border p-4 text-[15px] font-semibold leading-snug ${banner}`}>{sc.verdict.text}</div>

      <Card>
        <Label>Brier score (lower is better)</Label>
        <div className="tnum mt-2 grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-card2 p-3">
            <div className="text-[11px] text-ink3">Model</div>
            <div className="text-[24px] font-bold">{b4(sc.modelBrier)}</div>
          </div>
          <div className="rounded-xl bg-card2 p-3">
            <div className="text-[11px] text-ink3">Kalshi (Up mid)</div>
            <div className="text-[24px] font-bold">{b4(sc.kalshiBrier)}</div>
          </div>
        </div>
        <table className="tnum mt-3 w-full text-[13px]">
          <thead className="text-[11px] text-ink3">
            <tr>
              <th className="text-left font-normal">Min left</th>
              <th className="text-right font-normal">n</th>
              <th className="text-right font-normal">Model</th>
              <th className="text-right font-normal">Kalshi</th>
            </tr>
          </thead>
          <tbody>
            {sc.buckets.map((b) => {
              const win = b.model !== null && b.kalshi !== null ? b.model < b.kalshi : null;
              return (
                <tr key={b.label} className="border-t border-line">
                  <td className="py-1.5">{b.label}</td>
                  <td className="text-right text-ink3">{b.n}</td>
                  <td className={`text-right ${win === true ? "font-semibold text-ink" : "text-ink2"}`}>
                    {b4(b.model)}
                    {win === true ? " ✓" : ""}
                  </td>
                  <td className={`text-right ${win === false ? "font-semibold text-ink" : "text-ink2"}`}>
                    {b4(b.kalshi)}
                    {win === false ? " ✓" : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="mt-2 text-[11px] text-ink3">
          {sc.nCompared} readings with a Kalshi quote, {sc.windows} window{sc.windows === 1 ? "" : "s"}.
          {sc.tStat !== null ? ` Paired t across windows: ${sc.tStat.toFixed(2)} (below −2 = model clearly better, above +2 = Kalshi clearly better).` : ""}
        </div>
      </Card>

      <Card>
        <Label>Calibration: model said X%, Up won Y%</Label>
        {sc.calibration.length ? (
          <table className="tnum mt-2 w-full text-[13px]">
            <thead className="text-[11px] text-ink3">
              <tr>
                <th className="text-left font-normal">Bin</th>
                <th className="text-right font-normal">n</th>
                <th className="text-right font-normal">Said</th>
                <th className="text-right font-normal">Won</th>
                <th className="text-right font-normal">Kalshi said</th>
              </tr>
            </thead>
            <tbody>
              {sc.calibration.map((r) => {
                const off = Math.abs(r.said - r.won);
                return (
                  <tr key={r.label} className="border-t border-line">
                    <td className="py-1.5">{r.label}</td>
                    <td className="text-right text-ink3">{r.n}</td>
                    <td className="text-right">{pct(r.said)}</td>
                    <td className={`text-right ${r.n >= 30 && off > 0.08 ? "font-semibold text-warn" : ""}`}>{pct(r.won)}</td>
                    <td className="text-right text-ink2">{pct(r.kalshiSaid)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="mt-2 text-[13px] text-ink3">No graded readings yet.</div>
        )}
      </Card>

      <Card>
        <Label>Hypothetical P/L: buy when edge ≥ {margin}¢ (fees in, 1 contract)</Label>
        <div className="tnum mt-2 space-y-2 text-[13px]">
          {[
            { name: "Every signal (every 10s reading)", p: sc.pnlAll },
            { name: "First signal per window only", p: sc.pnlFirst },
          ].map(({ name, p }) => (
            <div key={name} className="rounded-xl bg-card2 p-3">
              <div className="text-[11px] text-ink3">{name}</div>
              <div className="flex items-baseline justify-between">
                <span className={`text-[20px] font-bold ${p.pnl >= 0 ? "text-up" : "text-down"}`}>{p.trades ? money(p.pnl) : "–"}</span>
                <span className="text-ink2">
                  {p.trades} trades · {p.trades ? pct(p.wins / p.trades) : "–"} won · {p.trades ? `${(p.pnl / p.trades).toFixed(1)}¢/trade` : ""}
                </span>
              </div>
            </div>
          ))}
          <div className="text-[11px] text-ink3">Fast-move readings are excluded. Assumes you fill at the logged ask.</div>
        </div>
      </Card>

      <Card>
        <Label>Auto-calibration</Label>
        <div className="tnum mt-2 text-[13px]">
          <div className="flex justify-between border-b border-line py-1.5">
            <span>Spread multiplier (calib)</span>
            <span>
              {e.calib.calib.toFixed(3)} {e.calib.calibActive ? "· auto" : `· needs ${MIN_PER_BUCKET} graded (${e.calib.graded})`}
            </span>
          </div>
          {BUCKETS.map((b, i) => (
            <div key={b.label} className="flex justify-between border-b border-line py-1.5 last:border-0">
              <span>{b.label} shrink</span>
              <span className={e.calib.shrinkActive[i] ? "" : "text-ink3"}>
                {e.calib.shrinkActive[i]
                  ? `×${e.calib.shrink[i].toFixed(2)} (${e.calib.perBucket[i]} graded)`
                  : `off · ${e.calib.perBucket[i]}/${MIN_PER_BUCKET}`}
              </span>
            </div>
          ))}
          <div className="pt-2 text-[11px] text-ink3">
            Shrink pulls odds toward 50% in a bucket where the model has been overconfident (×1.00 = no change). Readings inside one
            window are correlated, so 200 readings is roughly 11 windows of evidence, not 200 independent ones.
          </div>
        </div>
      </Card>

      <Card>
        <div className="tnum flex items-center justify-between text-[12px] text-ink3">
          <span>
            {counts.logs} logged · {counts.results} window{counts.results === 1 ? "" : "s"} settled · {counts.pending} awaiting result
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await e.grade();
              setBusy(false);
            }}
            className="rounded-lg bg-card2 px-3 py-1.5 text-ink"
          >
            {busy ? "Grading…" : "Grade now"}
          </button>
        </div>
      </Card>
    </div>
  );
}
