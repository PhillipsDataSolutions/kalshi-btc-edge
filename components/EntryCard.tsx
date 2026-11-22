"use client";

import { MIN_ZONE_T, MIN_ZONE_TRADES, PRIORS, bestZone, isProven, oosRow, zoneRow } from "@/lib/entry";
import { Card, Label } from "./ui";

const b4 = (x: number) => x.toFixed(4);
const money = (c: number) => `${c >= 0 ? "+" : "−"}$${(Math.abs(c) / 100).toFixed(2)}`;

/** Backtest by entry zone (out-of-sample), highlighting the user's zone and the best one. */
export default function EntryCard({ entryMinute }: { entryMinute: number }) {
  const zones = PRIORS.zones ?? [];
  if (!zones.length) {
    return (
      <Card className="mb-3">
        <Label>Backtest by entry zone</Label>
        <div className="mt-2 text-[13px] text-ink3">No backtest bundled. Run `npm run learn` and redeploy.</div>
      </Card>
    );
  }
  const mine = zoneRow(entryMinute);
  const r = oosRow(entryMinute);
  const proven = isProven(entryMinute);
  const best = bestZone();
  return (
    <Card className="mb-3 space-y-2">
      <Label>Backtest by entry zone (windows the fit never saw)</Label>
      <div
        className={`rounded-xl border p-3 text-[14px] font-semibold leading-snug ${
          proven.ok ? "border-up/50 bg-up/10 text-up" : "border-warn/50 bg-warn/10 text-warn"
        }`}
      >
        {mine
          ? proven.ok
            ? `Your zone (min ${mine.from}–${mine.to}) has a proven edge: ${money(mine.pnl)} over ${mine.trades} trades, ${mine.perTrade}¢/trade, t=${mine.t}.`
            : `Your zone (min ${mine.from}–${mine.to}): no proven edge yet. ${proven.reason}. The app shows NO TRADE there rather than guess.`
          : `No backtest for minute ${entryMinute}.`}
      </div>
      {r ? (
        <div className="tnum text-[12px] text-ink2">
          At minute {entryMinute}, Brier: raw model {b4(r.brierModel)} · Kalshi {b4(r.brierKalshi)} · learned blend {b4(r.brierBlend)}
          {r.brierBlend < r.brierKalshi ? " (blend best)" : " (Kalshi best)"}
        </div>
      ) : null}
      {best && best.center !== entryMinute ? (
        <div className="text-[12px] text-ink2">
          Strongest zone in the backtest: <span className="font-semibold text-ink">min {best.from}–{best.to}</span> ({money(best.pnl)},{" "}
          {best.trades} trades, t={best.t}). Change your entry minute in Settings to trade it.
        </div>
      ) : null}
      <table className="tnum w-full text-[12px]">
        <thead className="text-[10px] text-ink3">
          <tr>
            <th className="text-left font-normal">Zone</th>
            <th className="text-right font-normal">Trades</th>
            <th className="text-right font-normal">Won</th>
            <th className="text-right font-normal">¢/trade</th>
            <th className="text-right font-normal">P/L</th>
            <th className="text-right font-normal">t</th>
          </tr>
        </thead>
        <tbody>
          {zones.map((z) => {
            const sig = z.trades >= MIN_ZONE_TRADES && (z.t ?? 0) >= MIN_ZONE_T && z.pnl > 0;
            return (
              <tr key={z.center} className={`border-t border-line ${z.center === entryMinute ? "bg-card2" : ""}`}>
                <td className="py-1">
                  {z.from}–{z.to}
                  {z.center === entryMinute ? " ◀ you" : ""}
                </td>
                <td className="text-right text-ink3">{z.trades}</td>
                <td className="text-right text-ink3">{z.trades ? `${Math.round((z.wins / z.trades) * 100)}%` : "–"}</td>
                <td className="text-right text-ink2">{z.trades ? z.perTrade.toFixed(1) : "–"}</td>
                <td className={`text-right ${z.pnl > 0 ? "text-up" : z.pnl < 0 ? "text-down" : "text-ink3"}`}>
                  {z.trades ? money(z.pnl) : "–"}
                </td>
                <td className={`text-right ${sig ? "font-semibold text-up" : "text-ink3"}`}>{z.t?.toFixed(1) ?? "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="text-[11px] text-ink3">
        One 1-contract trade per window: the first minute in the zone where the learned blend&apos;s edge ≥ {PRIORS.margin}¢ after fees, filled
        at the 1-minute closing ask. Fitted on the older 70% of {PRIORS.windows} windows ({PRIORS.days} days), tested on the newest 30%.
        &quot;Proven&quot; needs {MIN_ZONE_TRADES}+ trades, a profit, and t ≥ {MIN_ZONE_T} (t = average profit ÷ its standard error; below 2
        can easily be luck). Generated {PRIORS.generatedAt ? new Date(PRIORS.generatedAt).toLocaleDateString() : "–"}.
      </div>
    </Card>
  );
}
