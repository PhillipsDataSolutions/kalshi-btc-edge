"use client";

import { useEffect, useRef, useState } from "react";
import type { Engine } from "@/lib/useEngine";
import { entryZone } from "@/lib/entry";
import { usd } from "@/lib/format";
import { Card } from "./ui";

const MODEL_COLOR = "#60a5fa"; // model/blend line (identity colour, not up/down)
const KALSHI_COLOR = "#a5adb8";

const W = 360;
const H = 170;
const OH = 74;
const PAD_L = 4;
const PAD_R = 58;

const etClock = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" });

/** Live ticker: flashing last price, window price chart with target & entry zone, odds chart. */
export default function Ticker({ e, entryMinute }: { e: Engine; entryMinute: number }) {
  const m = e.market;
  const prev = useRef<number | null>(null);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);

  useEffect(() => {
    if (e.price === null) return;
    if (prev.current !== null && Math.abs(e.price - prev.current) >= 0.005) {
      setFlash(e.price > prev.current ? "up" : "down");
      const id = setTimeout(() => setFlash(null), 450);
      prev.current = e.price;
      return () => clearTimeout(id);
    }
    prev.current = e.price;
  }, [e.price]);

  if (!m || e.price === null) {
    return (
      <Card>
        <div className="py-8 text-center text-[13px] text-ink3">Connecting to exchanges…</div>
      </Card>
    );
  }

  const t0 = m.openTime;
  const t1 = m.closeTime;
  const pts = e.history.filter((p) => p.t >= t0 && p.t <= t1).map((p) => ({ t: p.t, p: p.p + e.bias }));
  const openPrice = pts[0]?.p ?? null;
  const change = openPrice !== null ? e.price - openPrice : null;

  // y-range: include target and every price, padded
  const ys = [...pts.map((p) => p.p), e.target ?? e.price, e.price];
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  const minRange = Math.max(30, (e.volPerMin ?? 0.0005) * e.price * 2);
  if (hi - lo < minRange) {
    const c = (hi + lo) / 2;
    lo = c - minRange / 2;
    hi = c + minRange / 2;
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const x = (t: number) => PAD_L + ((t - t0) / (t1 - t0)) * (W - PAD_L - PAD_R);
  const y = (p: number) => 8 + (1 - (p - lo) / (hi - lo)) * (H - 24);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`).join("");
  const zone = entryZone(entryMinute);
  const zx0 = x(t0 + zone.from * 60000);
  const zx1 = x(t0 + zone.to * 60000);
  const last = pts[pts.length - 1];
  const above = e.target !== null && e.price >= e.target;

  // Odds chart (0–100¢)
  const op = e.oddsHistory.filter((p) => p.t >= t0 && p.t <= t1);
  const oy = (c: number) => 6 + (1 - c / 100) * (OH - 14);
  const line = (key: "kalshi" | "fair") => {
    let d = "";
    let pen = false;
    for (const p of op) {
      const v = p[key];
      if (v === null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${x(p.t).toFixed(1)},${oy(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const hover = hoverT !== null ? pts.reduce((b, p) => (Math.abs(p.t - hoverT) < Math.abs(b.t - hoverT) ? p : b), pts[0]) : null;
  const hoverOdds = hoverT !== null && op.length ? op.reduce((b, p) => (Math.abs(p.t - hoverT) < Math.abs(b.t - hoverT) ? p : b), op[0]) : null;

  const onMove = (ev: React.PointerEvent<SVGSVGElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const fx = ((ev.clientX - r.left) / r.width) * W;
    const t = t0 + ((fx - PAD_L) / (W - PAD_L - PAD_R)) * (t1 - t0);
    setHoverT(Math.min(Math.max(t, t0), Math.min(t1, e.now)));
  };

  const last1 = e.oddsHistory[e.oddsHistory.length - 1];

  return (
    <Card className="space-y-2 !p-3">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-ink3">BTC · BRTI replica</div>
          <div
            className={`tnum rounded px-1 -mx-1 text-[34px] font-bold leading-none transition-colors duration-300 ${
              flash === "up" ? "bg-up/25 text-up" : flash === "down" ? "bg-down/25 text-down" : "text-ink"
            }`}
          >
            {usd(e.price)}
          </div>
        </div>
        <div className="tnum text-right text-[12px]">
          <div className={change === null ? "text-ink3" : change >= 0 ? "text-up" : "text-down"}>
            {change === null ? "–" : `${change >= 0 ? "▲" : "▼"} ${usd(Math.abs(change))} since open`}
          </div>
          <div className={above ? "text-up" : "text-down"}>
            {e.target !== null ? `${above ? "▲" : "▼"} ${usd(Math.abs(e.price - e.target))} vs target` : ""}
          </div>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none select-none"
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHoverT(null)}
        role="img"
        aria-label="BTC price this window with target line"
      >
        <rect x={zx0} y={0} width={Math.max(0, zx1 - zx0)} height={H - 16} fill="var(--color-ink3)" opacity={0.12} />
        <text x={(zx0 + zx1) / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="var(--color-ink3)">
          your entry · min {entryMinute}
        </text>
        {e.target !== null ? (
          <>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(e.target)} y2={y(e.target)} stroke="var(--color-ink2)" strokeDasharray="4 3" strokeWidth={1} />
            <text x={W - PAD_R + 4} y={y(e.target) + 3} fontSize="9" fill="var(--color-ink2)">
              target
            </text>
          </>
        ) : null}
        <path d={path} fill="none" stroke={above ? "var(--color-up)" : "var(--color-down)"} strokeWidth={2} strokeLinejoin="round" />
        {last ? (
          <>
            <circle cx={x(last.t)} cy={y(last.p)} r={4} fill={above ? "var(--color-up)" : "var(--color-down)"} stroke="var(--color-card)" strokeWidth={2} />
            <rect x={W - PAD_R + 2} y={y(last.p) - 8} width={PAD_R - 2} height={16} rx={3} fill={above ? "var(--color-up)" : "var(--color-down)"} />
            <text x={W - PAD_R / 2 + 1} y={y(last.p) + 3.5} textAnchor="middle" fontSize="9.5" fontWeight="700" fill="#0b0d10">
              {Math.round(last.p).toLocaleString("en-US")}
            </text>
          </>
        ) : null}
        {hover ? (
          <>
            <line x1={x(hover.t)} x2={x(hover.t)} y1={0} y2={H - 16} stroke="var(--color-ink2)" strokeWidth={1} />
            <circle cx={x(hover.t)} cy={y(hover.p)} r={3.5} fill="var(--color-ink)" />
          </>
        ) : null}
      </svg>

      <div className="tnum min-h-[16px] text-[11px] text-ink2">
        {hover
          ? `${etClock(hover.t)} ET · ${usd(hover.p)}${hoverOdds ? ` · Kalshi ${hoverOdds.kalshi?.toFixed(0) ?? "–"}¢ · model ${hoverOdds.fair?.toFixed(0) ?? "–"}¢` : ""}`
          : `Drag across the chart to inspect. Shaded = your entry zone (min ${zone.from}–${zone.to}).`}
      </div>

      <div className="flex items-center gap-3 text-[11px] text-ink2">
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4" style={{ background: MODEL_COLOR }} /> Model fair Up {last1?.fair?.toFixed(0) ?? "–"}¢
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4" style={{ background: KALSHI_COLOR }} /> Kalshi Up {last1?.kalshi?.toFixed(0) ?? "–"}¢
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${OH}`} className="w-full" role="img" aria-label="Model vs Kalshi Up price this window">
        <rect x={zx0} y={0} width={Math.max(0, zx1 - zx0)} height={OH - 8} fill="var(--color-ink3)" opacity={0.12} />
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line x1={PAD_L} x2={W - PAD_R} y1={oy(v)} y2={oy(v)} stroke="var(--color-line)" strokeWidth={1} />
            <text x={W - PAD_R + 4} y={oy(v) + 3} fontSize="9" fill="var(--color-ink3)">
              {v}¢
            </text>
          </g>
        ))}
        <path d={line("kalshi")} fill="none" stroke={KALSHI_COLOR} strokeWidth={2} />
        <path d={line("fair")} fill="none" stroke={MODEL_COLOR} strokeWidth={2} />
        {hover ? <line x1={x(hover.t)} x2={x(hover.t)} y1={0} y2={OH - 8} stroke="var(--color-ink2)" strokeWidth={1} /> : null}
      </svg>
    </Card>
  );
}
