"use client";

import type { Engine, SideView } from "@/lib/useEngine";
import { cents } from "@/lib/format";
import { Card } from "./ui";

function verdictText(s: SideView, fast: boolean) {
  switch (s.verdict) {
    case "cheap":
      return fast
        ? { text: `${Math.round(s.edgeBuy!)}¢ CHEAP · don't chase`, cls: "text-warn" }
        : { text: `${Math.round(s.edgeBuy!)}¢ CHEAP`, cls: "text-up" };
    case "overpriced":
      return { text: `${Math.round(s.edgeSell!)}¢ OVERPRICED`, cls: "text-down" };
    case "fair":
      return { text: "FAIR · no edge", cls: "text-ink3" };
    default:
      return { text: "no quote", cls: "text-ink3" };
  }
}

function SideRow({ s, fast }: { s: SideView; fast: boolean }) {
  const isUp = s.side === "up";
  const v = verdictText(s, fast);
  const border =
    s.verdict === "cheap" && !fast ? "border-up/60" : s.verdict === "overpriced" ? "border-down/60" : "border-line";
  return (
    <div className={`rounded-xl border ${border} bg-card2 p-3`}>
      <div className="flex items-center justify-between">
        <div className={`text-[15px] font-bold ${isUp ? "text-up" : "text-down"}`}>
          {isUp ? "▲ UP" : "▼ DOWN"}
        </div>
        <div className={`text-[15px] font-bold ${v.cls}`}>{v.text}</div>
      </div>
      <div className="tnum mt-2 grid grid-cols-2 gap-2">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-ink3">Kalshi (ask)</div>
          <div className="text-[28px] font-bold leading-none">{cents(s.ask)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-ink3">Model</div>
          <div className="text-[28px] font-bold leading-none">{cents(s.fair)}</div>
        </div>
      </div>
      <div className="tnum mt-2 text-[11px] text-ink3">
        bid {cents(s.bid)} · ask {cents(s.ask)} · cost w/ fee {cents(s.buyCost, 1)} · edge {s.edgeBuy === null ? "–" : `${s.edgeBuy >= 0 ? "+" : ""}${s.edgeBuy.toFixed(1)}¢`}
      </div>
    </div>
  );
}

export default function Hero({ e, margin }: { e: Engine; margin: number }) {
  const buyUp = e.up.verdict === "cheap";
  const buyDown = e.down.verdict === "cheap";
  let call: { text: string; cls: string };
  if (e.pUp === null || !e.market) call = { text: "Loading…", cls: "bg-card2 text-ink3" };
  else if (e.fast) call = { text: "⚠ FAST MOVE — DON'T CHASE", cls: "bg-warn/15 text-warn border border-warn/40" };
  else if (buyUp && (!buyDown || e.up.edgeBuy! >= e.down.edgeBuy!)) call = { text: "▲ BUY UP", cls: "bg-up/15 text-up border border-up/40" };
  else if (buyDown) call = { text: "▼ BUY DOWN", cls: "bg-down/15 text-down border border-down/40" };
  else call = { text: "NO TRADE · no edge ≥ " + margin + "¢", cls: "bg-card2 text-ink2" };

  return (
    <Card className="space-y-3">
      <div className={`rounded-xl px-3 py-2 text-center text-[16px] font-extrabold tracking-wide ${call.cls}`}>{call.text}</div>
      <SideRow s={e.up} fast={e.fast} />
      <SideRow s={e.down} fast={e.fast} />
    </Card>
  );
}
