"use client";

import type { Engine } from "@/lib/useEngine";
import { usd } from "@/lib/format";
import { BIAS_MIN_WINDOWS } from "@/lib/tracking";
import { Card, Label } from "./ui";

const signed = (x: number | null, dp = 2) => (x === null ? "–" : `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(dp)}`);
const etTime = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

export default function Accuracy({ e }: { e: Engine }) {
  const t = e.tstats;
  const r = e.rti;
  const verdict =
    t.n === 0
      ? { text: "Not verified on this device yet. Keep the app open through a window close and it will check itself against the official settlement.", cls: "text-ink2" }
      : t.mae !== null && t.mae <= 2
        ? { text: `Tracking the official BRTI settlement within $${t.mae.toFixed(2)} on average (${t.n} windows).`, cls: "text-up" }
        : t.mae !== null && t.mae <= 10
          ? { text: `Average miss vs official settlement: $${t.mae.toFixed(2)} (${t.n} windows).`, cls: "text-warn" }
          : { text: `Large miss vs official settlement: $${t.mae?.toFixed(2)} average (${t.n} windows). Check the feeds.`, cls: "text-down" };
  return (
    <Card className="space-y-2">
      <Label>Price accuracy vs official settlement</Label>
      <div className={`text-[13px] font-semibold ${verdict.cls}`}>{verdict.text}</div>
      <div className="tnum grid grid-cols-3 gap-2 text-[12px]">
        <div className="rounded-lg bg-card2 p-2">
          <div className="text-[10px] uppercase text-ink3">Avg miss</div>
          <div className="font-semibold">{t.mae === null ? "–" : `$${t.mae.toFixed(2)}`}</div>
        </div>
        <div className="rounded-lg bg-card2 p-2">
          <div className="text-[10px] uppercase text-ink3">Worst</div>
          <div className="font-semibold">{t.maxAbs === null ? "–" : `$${t.maxAbs.toFixed(2)}`}</div>
        </div>
        <div className="rounded-lg bg-card2 p-2">
          <div className="text-[10px] uppercase text-ink3">Correction</div>
          <div className="font-semibold">{e.bias ? signed(e.bias) : t.biasActive ? "off" : `after ${BIAS_MIN_WINDOWS}`}</div>
        </div>
      </div>
      {t.recent.length ? (
        <table className="tnum w-full text-[12px]">
          <thead className="text-[10px] text-ink3">
            <tr>
              <th className="text-left font-normal">Window close</th>
              <th className="text-right font-normal">Official</th>
              <th className="text-right font-normal">Ours</th>
              <th className="text-right font-normal">Miss</th>
            </tr>
          </thead>
          <tbody>
            {t.recent.map((x) => (
              <tr key={x.ticker} className="border-t border-line">
                <td className="py-1">{etTime(x.closeTime)}</td>
                <td className="text-right">{usd(x.official)}</td>
                <td className="text-right text-ink2">{usd(x.ours)}</td>
                <td className="text-right">{signed(x.ours - (x.official as number))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <div className="tnum space-y-0.5 text-[11px] text-ink3">
        <div>
          Live: {r ? `${r.used.length}/7 exchanges` : "no data"}
          {r?.excluded.length ? ` · excluded ${r.excluded.map((x) => `${x.id} (${x.reason})`).join(", ")}` : ""}
          {r && r.utilizedDepth ? ` · utilized depth ${r.utilizedDepth.toFixed(0)} BTC` : r ? " · light mode (mid average)" : ""}
        </div>
        <div>
          Simple average of best bid/ask mids: {usd(e.simpleMean)} (
          {e.simpleMean !== null && e.rawPrice !== null ? signed(e.simpleMean - e.rawPrice) : "–"} vs replica)
        </div>
        <div>Kalshi quote age: {e.marketAgeMs === null ? "–" : `${(e.marketAgeMs / 1000).toFixed(1)}s`} (polled every second)</div>
      </div>
    </Card>
  );
}
