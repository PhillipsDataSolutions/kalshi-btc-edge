"use client";

import type { Engine, SideView } from "@/lib/useEngine";
import { entryZone } from "@/lib/entry";
import { cents, mmss, pct } from "@/lib/format";
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
        <div className={`text-[15px] font-bold ${isUp ? "text-up" : "text-down"}`}>{isUp ? "▲ UP" : "▼ DOWN"}</div>
        <div className={`text-[15px] font-bold ${v.cls}`}>{v.text}</div>
      </div>
      <div className="tnum mt-2 grid grid-cols-2 gap-2">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-ink3">Kalshi (ask)</div>
          <div className="text-[28px] font-bold leading-none">{cents(s.ask)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-ink3">Fair value</div>
          <div className="text-[28px] font-bold leading-none">{cents(s.fair)}</div>
        </div>
      </div>
      <div className="tnum mt-2 text-[11px] text-ink3">
        bid {cents(s.bid)} · ask {cents(s.ask)} · cost w/ fee {cents(s.buyCost, 1)} · edge{" "}
        {s.edgeBuy === null ? "–" : `${s.edgeBuy >= 0 ? "+" : ""}${s.edgeBuy.toFixed(1)}¢`}
      </div>
    </div>
  );
}

export default function Hero({ e, entryMinute }: { e: Engine; entryMinute: number }) {
  const zone = entryZone(entryMinute);
  const mi = e.minuteIn;
  const sig = e.signal;
  const phase = mi === null ? "none" : mi < zone.from ? "before" : mi <= zone.to ? "entry" : "after";
  const sideTxt = sig.side === "up" ? "▲ UP" : sig.side === "down" ? "▼ DOWN" : "";

  let call: { title: string; sub: string; cls: string };
  if (!e.market || e.pUp === null) call = { title: "Loading…", sub: "", cls: "bg-card2 text-ink3" };
  else if (e.fast) call = { title: "⚠ FAST MOVE — DON'T CHASE", sub: "Price moved > 2σ in 60s", cls: "bg-warn/15 text-warn border border-warn/40" };
  else if (phase === "before") {
    const toEntry = e.market.openTime + zone.from * 60000 - e.now;
    call = {
      title: `ENTRY IN ${mmss(toEntry)}`,
      sub: sig.side ? `Leaning ${sideTxt} ${sig.edge?.toFixed(1)}¢ · ${sig.ready ? "all checks pass" : sig.blockers[0]}` : "No edge yet",
      cls: "bg-card2 text-ink",
    };
  } else if (phase === "entry") {
    call = sig.ready
      ? {
          title: `${sideTxt === "▲ UP" ? "▲ BUY UP" : "▼ BUY DOWN"} · ${sig.edge?.toFixed(1)}¢ edge`,
          sub: `Held ${Math.floor(sig.heldSec)}s · entry zone min ${zone.from}–${zone.to}`,
          cls: sig.side === "up" ? "bg-up/15 text-up border border-up/40" : "bg-down/15 text-down border border-down/40",
        }
      : { title: "NO TRADE THIS WINDOW", sub: sig.blockers.join(" · "), cls: "bg-card2 text-ink2 border border-line" };
  } else {
    call = {
      title: "PAST ENTRY",
      sub: "Use the cash-out check if you hold a position",
      cls: "bg-card2 text-ink2",
    };
  }

  return (
    <Card className="space-y-3">
      <div className={`rounded-xl px-3 py-2 text-center ${call.cls}`}>
        <div className="text-[17px] font-extrabold tracking-wide">{call.title}</div>
        {call.sub ? <div className="mt-0.5 text-[12px] opacity-80">{call.sub}</div> : null}
      </div>
      <div className="tnum flex justify-between px-1 text-[11px] text-ink3">
        <span>Model {pct(e.pModel)}</span>
        <span>Kalshi {e.market && e.market.yesBid !== null && e.market.yesAsk !== null ? pct((e.market.yesBid + e.market.yesAsk) / 200) : "–"}</span>
        <span className="text-ink2">
          Decision {pct(e.pUp)} {e.pBlend !== null && e.pUp === e.pBlend ? "(learned blend)" : "(model)"}
        </span>
      </div>
      <SideRow s={e.up} fast={e.fast} />
      <SideRow s={e.down} fast={e.fast} />
    </Card>
  );
}
