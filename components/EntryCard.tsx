"use client";

import { PRIORS, entryZone, isProven } from "@/lib/entry";
import { Card, Label } from "./ui";

const b4 = (x: number) => x.toFixed(4);
const money = (c: number) => `${c >= 0 ? "+" : "−"}$${(Math.abs(c) / 100).toFixed(2)}`;

/** Backtest of every minute into the window, highlighting the user's entry zone. */
export default function EntryCard({ entryMinute }: { entryMinute: number }) {
  const rows = PRIORS.outOfSample ?? [];
  const zone = entryZone(entryMinute);
  if (!rows.length) {
    return (
      <Card>
        <Label>Backtest by entry minute</Label>
        <div className="mt-2 text-[13px] text-ink3">No backtest bundled. Run `npm run learn` and redeploy.</div>
      </Card>
    );
  }
  const at = rows.find((r) => r.minute === entryMinute);
  const proven = isProven(entryMinute);
  return (
    <Card className="mb-3 space-y-2">
      <Label>Backtest by entry minute (out-of-sample)</Label>
      <div className={`rounded-xl border p-3 text-[14px] font-semibold leading-snug ${proven.ok ? "border-up/50 bg-up/10 text-up" : "border-warn/50 bg-warn/10 text-warn"}`}>
        {at
          ? proven.ok
            ? `Minute ${entryMinute}: the learned blend beat Kalshi on unseen windows (Brier ${b4(at.brierBlend)} vs ${b4(at.brierKalshi)}) and made ${money(at.pnlBlend.pnl)} over ${at.pnlBlend.trades} trades (${at.pnlBlend.perTrade}¢/trade, ${Math.round((at.pnlBlend.wins / Math.max(1, at.pnlBlend.trades)) * 100)}% won).`
            : `Minute ${entryMinute}: no proven edge. ${proven.reason}. The app will show NO TRADE here rather than guess.`
          : `No backtest row for minute ${entryMinute}.`}
      </div>
      <table className="tnum w-full text-[12px]">
        <thead className="text-[10px] text-ink3">
          <tr>
            <th className="text-left font-normal">Min in</th>
            <th className="text-right font-normal">Raw model</th>
            <th className="text-right font-normal">Kalshi</th>
            <th className="text-right font-normal">Blend</th>
            <th className="text-right font-normal">Trades</th>
            <th className="text-right font-normal">P/L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const inZone = r.minute >= zone.from && r.minute <= zone.to;
            const beat = r.brierBlend < r.brierKalshi;
            return (
              <tr key={r.minute} className={`border-t border-line ${inZone ? "bg-card2" : ""}`}>
                <td className="py-1">
                  {r.minute}
                  {r.minute === entryMinute ? " ◀" : ""}
                </td>
                <td className="text-right text-ink3">{b4(r.brierModel)}</td>
                <td className="text-right text-ink2">{b4(r.brierKalshi)}</td>
                <td className={`text-right ${beat ? "font-semibold text-ink" : "text-ink3"}`}>{b4(r.brierBlend)}</td>
                <td className="text-right text-ink3">{r.pnlBlend.trades}</td>
                <td className={`text-right ${r.pnlBlend.pnl > 0 ? "text-up" : r.pnlBlend.pnl < 0 ? "text-down" : "text-ink3"}`}>
                  {r.pnlBlend.trades ? money(r.pnlBlend.pnl) : "–"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="text-[11px] text-ink3">
        Brier scores (lower is better) and P/L of one 1-contract trade per window when the blend&apos;s edge ≥ {PRIORS.margin}¢ after fees.
        Fitted on the older 70% of {PRIORS.windows} windows ({PRIORS.days} days), tested on the newest 30%. Generated{" "}
        {PRIORS.generatedAt ? new Date(PRIORS.generatedAt).toLocaleDateString() : "–"}.
      </div>
    </Card>
  );
}
