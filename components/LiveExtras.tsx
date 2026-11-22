"use client";

import type { Engine } from "@/lib/useEngine";
import { takerFeeCents } from "@/lib/fees";
import { cents, usd } from "@/lib/format";
import { Position } from "@/lib/storage";
import { Card, Label, Stat } from "./ui";

const bp = (x: number | null) => (x === null ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}bp`);

export function Stats({ e }: { e: Engine }) {
  const sigmaUsd = e.volPerMin && e.price ? e.volPerMin * e.price : null;
  return (
    <div className="grid grid-cols-3 gap-2">
      <Stat label="Vol / min" value={sigmaUsd ? usd(sigmaUsd, 0) : "–"} sub={e.volPerMin ? `${(e.volPerMin * 1e4).toFixed(1)}bp` : `${e.minuteCount}m hist`} />
      <Stat label="Mom 10s / 60s" value={bp(e.momentum.comp10)} sub={bp(e.momentum.comp60)} />
      <Stat
        label="Binance lead"
        value={e.momentum.lead10 === null ? "n/a" : bp(e.momentum.lead10)}
        sub={e.momentum.lead10 === null ? "unavailable" : bp(e.momentum.lead60)}
      />
      <Stat label="Calib" value={e.calib.calib.toFixed(2)} sub={e.calib.calibActive ? "auto" : `${e.calib.graded}/200 graded`} />
      <Stat label="z-score" value={e.model && Number.isFinite(e.model.z) ? e.model.z.toFixed(2) : "–"} sub={e.minsLeft !== null ? `${e.minsLeft.toFixed(1)} min left` : ""} />
      <Stat label="Logged" value={e.logCount} sub="every 10s" />
    </div>
  );
}

export function CashOut({
  e,
  pos,
  setPos,
  margin,
}: {
  e: Engine;
  pos: Position;
  setPos: (p: Partial<Position>) => void;
  margin: number;
}) {
  const ticker = e.market?.ticker ?? "";
  const active = pos.side !== "none" && pos.ticker === ticker;
  const side = active ? pos.side : "none";
  const s = side === "up" ? e.up : side === "down" ? e.down : null;
  const n = Math.max(1, pos.contracts || 1);
  const entryFee = pos.entry > 0 ? takerFeeCents(pos.entry, n) : 0;
  const plIfSold = s && s.bid !== null && pos.entry > 0 ? ((s.bid - takerFeeCents(s.bid, n)) - pos.entry - entryFee) * n : null;

  let verdict: { text: string; cls: string } | null = null;
  if (s && s.fair !== null) {
    if (s.sellNet === null) verdict = { text: "No bid to sell into", cls: "text-ink3" };
    else if (s.edgeSell !== null && s.edgeSell >= margin)
      verdict = { text: `CASH OUT — Kalshi pays ${s.edgeSell.toFixed(1)}¢ over model`, cls: "text-warn" };
    else if (s.fair - s.sellNet >= margin)
      verdict = { text: `HOLD — model says worth ${(s.fair - s.sellNet).toFixed(1)}¢ more`, cls: "text-up" };
    else verdict = { text: "Toss-up — selling ≈ fair value", cls: "text-ink2" };
  }

  const btn = (v: Position["side"], label: string, cls: string) => (
    <button
      type="button"
      onClick={() => setPos({ side: v, ticker })}
      className={`flex-1 rounded-lg py-2 text-[13px] font-semibold ${side === v ? cls : "bg-card2 text-ink3"}`}
    >
      {label}
    </button>
  );

  return (
    <Card className="space-y-3">
      <Label>Cash-out check (this window)</Label>
      <div className="flex gap-2">
        {btn("none", "No position", "bg-ink3/30 text-ink")}
        {btn("up", "▲ Holding Up", "bg-up/20 text-up")}
        {btn("down", "▼ Holding Down", "bg-down/20 text-down")}
      </div>
      {side !== "none" ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-ink3">
              Paid per contract (¢)
              <input
                inputMode="numeric"
                className="tnum mt-1 w-full rounded-lg border border-line bg-card2 px-2 py-2 text-[15px] text-ink"
                value={pos.entry || ""}
                onChange={(ev) => setPos({ entry: Math.min(99, Math.max(0, Number(ev.target.value) || 0)) })}
              />
            </label>
            <label className="text-[11px] text-ink3">
              Contracts
              <input
                inputMode="numeric"
                className="tnum mt-1 w-full rounded-lg border border-line bg-card2 px-2 py-2 text-[15px] text-ink"
                value={pos.contracts || ""}
                onChange={(ev) => setPos({ contracts: Math.max(1, Number(ev.target.value) || 1) })}
              />
            </label>
          </div>
          {s ? (
            <div className="tnum space-y-1 text-[13px]">
              <div className="flex justify-between">
                <span className="text-ink3">Sell now (bid − fee)</span>
                <span>{cents(s.sellNet, 1)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink3">Model fair value</span>
                <span>{cents(s.fair, 1)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink3">P/L if sold now</span>
                <span className={plIfSold === null ? "" : plIfSold >= 0 ? "text-up" : "text-down"}>
                  {plIfSold === null ? "–" : `${plIfSold >= 0 ? "+" : "−"}$${(Math.abs(plIfSold) / 100).toFixed(2)}`}
                </span>
              </div>
              {verdict ? <div className={`pt-1 text-[15px] font-bold ${verdict.cls}`}>{verdict.text}</div> : null}
            </div>
          ) : null}
        </>
      ) : (
        <div className="text-[12px] text-ink3">Tell it which side you hold to see whether selling beats holding.</div>
      )}
    </Card>
  );
}

export function Depth({ e }: { e: Engine }) {
  if (!e.book) return null;
  // A Down bid at X is an Up ask at 100−X (and vice versa).
  const upAsks = e.book.downBids.slice(0, 4).map((l) => ({ price: 100 - l.price, size: l.size }));
  const upBids = e.book.upBids.slice(0, 4);
  const rows = Math.max(upAsks.length, upBids.length);
  if (!rows) return null;
  const fmtSize = (s: number) => (s >= 1000 ? `${(s / 1000).toFixed(1)}k` : s.toFixed(0));
  return (
    <Card>
      <Label>Up order book (Down = 100 − price)</Label>
      <div className="tnum mt-2 grid grid-cols-2 gap-3 text-[12px]">
        <div>
          <div className="mb-1 text-ink3">Bids (sell Up)</div>
          {upBids.map((l, i) => (
            <div key={i} className="flex justify-between">
              <span className="text-up">{l.price.toFixed(l.price % 1 ? 1 : 0)}¢</span>
              <span className="text-ink2">{fmtSize(l.size)}</span>
            </div>
          ))}
        </div>
        <div>
          <div className="mb-1 text-ink3">Asks (buy Up)</div>
          {upAsks.map((l, i) => (
            <div key={i} className="flex justify-between">
              <span className="text-down">{l.price.toFixed(l.price % 1 ? 1 : 0)}¢</span>
              <span className="text-ink2">{fmtSize(l.size)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 text-[11px] text-ink3">
        Fee at {cents(e.up.ask)}: {e.up.ask !== null ? `${takerFeeCents(e.up.ask).toFixed(0)}¢/contract` : "–"}
      </div>
    </Card>
  );
}
