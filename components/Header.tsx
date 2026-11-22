"use client";

import type { Engine } from "@/lib/useEngine";
import { mmss, signedUsd, usd, windowLabel } from "@/lib/format";

function Ring({ frac, label, urgent }: { frac: number; label: string; urgent: boolean }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const f = Math.min(1, Math.max(0, frac));
  return (
    <svg viewBox="0 0 72 72" className="h-[76px] w-[76px] shrink-0" role="img" aria-label={`${label} left`}>
      <circle cx="36" cy="36" r={r} fill="none" stroke="var(--color-line)" strokeWidth="6" />
      <circle
        cx="36"
        cy="36"
        r={r}
        fill="none"
        stroke={urgent ? "var(--color-warn)" : "var(--color-ink2)"}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={`${c * f} ${c}`}
        transform="rotate(-90 36 36)"
      />
      <text x="36" y="40" textAnchor="middle" className="tnum" fontSize="15" fontWeight="700" fill="var(--color-ink)">
        {label}
      </text>
    </svg>
  );
}

export default function Header({ e }: { e: Engine }) {
  const m = e.market;
  const msLeft = m ? m.closeTime - e.now : 0;
  const gap = e.price !== null && e.target !== null ? e.price - e.target : null;
  const above = gap !== null && gap >= 0;
  return (
    <div className="flex items-center gap-3">
      <Ring frac={m ? msLeft / (e.windowMins * 60000) : 0} label={m ? mmss(msLeft) : "--:--"} urgent={msLeft < 3 * 60000} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[13px] text-ink2">{m ? windowLabel(m.openTime, m.closeTime) : e.marketErr ? "Kalshi unreachable" : "Waiting for window…"}</div>
          <div className="text-[11px] text-ink3">KXBTC15M</div>
        </div>
        <div className="tnum mt-0.5 text-[26px] font-bold leading-tight">{usd(e.price)}</div>
        <div className="tnum flex items-baseline gap-2 text-[13px]">
          <span className="text-ink3">Target {usd(e.target)}</span>
          {gap !== null ? (
            <span className={above ? "text-up font-semibold" : "text-down font-semibold"}>
              {above ? "▲" : "▼"} {signedUsd(gap)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function FeedDots({ e }: { e: Engine }) {
  const color: Record<string, string> = {
    live: "bg-up",
    stale: "bg-warn",
    connecting: "bg-ink3",
    down: "bg-down",
    blocked: "bg-ink3",
    off: "bg-line",
  };
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink3">
      {e.feeds.map((f) => (
        <span key={f.id} className="flex items-center gap-1" title={f.status}>
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${color[f.status] ?? "bg-ink3"}`} />
          <span className={f.inComposite ? "text-ink2" : ""}>{f.label}</span>
          {f.status === "blocked" ? <span>(blocked)</span> : null}
        </span>
      ))}
    </div>
  );
}
