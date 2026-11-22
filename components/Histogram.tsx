"use client";

import { useState } from "react";
import type { Engine } from "@/lib/useEngine";
import { massBetween } from "@/lib/model";
import { pct, usd } from "@/lib/format";
import { Card, Label } from "./ui";

interface Bin {
  lo: number;
  hi: number;
  mass: number;
  above: boolean;
  hasPrice: boolean;
}

/** Bins in log-price space, aligned so the target sits exactly on a bin edge. */
export function buildBins(price: number, target: number, spread: number, maxBins = 26): Bin[] {
  const w = spread / 3; // each bar ≈ ⅓ σ
  const lnLo = Math.log(price) - 3.2 * spread;
  const lnHi = Math.log(price) + 3.2 * spread;
  const lt = Math.log(target);
  let kLo = Math.floor((lnLo - lt) / w);
  let kHi = Math.ceil((lnHi - lt) / w);
  while (kHi - kLo > maxBins) {
    // trim the side further from the price
    if (Math.abs(lt + kHi * w - Math.log(price)) > Math.abs(lt + kLo * w - Math.log(price))) kHi--;
    else kLo++;
  }
  const bins: Bin[] = [];
  for (let k = kHi - 1; k >= kLo; k--) {
    const lo = Math.exp(lt + k * w);
    const hi = Math.exp(lt + (k + 1) * w);
    bins.push({ lo, hi, mass: massBetween(price, spread, lo, hi), above: k >= 0, hasPrice: price >= lo && price < hi });
  }
  return bins;
}

export default function Histogram({ e }: { e: Engine }) {
  const [sel, setSel] = useState<number | null>(null);
  const ready = e.price !== null && e.target !== null && e.model && e.model.spread > 0 && e.pUp !== null;
  if (!ready) {
    return (
      <Card>
        <Label>Probable settlement price</Label>
        <div className="py-10 text-center text-[13px] text-ink3">
          {e.minuteCount < 10 ? "Loading price history for volatility…" : "Waiting for price and target…"}
        </div>
      </Card>
    );
  }
  const bins = buildBins(e.price!, e.target!, e.model!.spread);
  const max = Math.max(...bins.map((b) => b.mass), 1e-9);
  const dp = e.price! > 1000 ? 0 : 2;
  const selected = sel !== null ? bins[sel] : null;
  const firstBelow = bins.findIndex((b) => !b.above);

  return (
    <Card>
      <div className="flex items-baseline justify-between">
        <Label>Probable settlement price</Label>
        <span className="text-[11px] text-ink3">tap a bar</span>
      </div>
      <div className="tnum mt-2 flex items-baseline justify-between text-[13px]">
        <span className="font-semibold text-up">▲ UP {pct(e.pUp)}</span>
        <span className="text-ink3">above target</span>
      </div>
      <div className="mt-1" role="list" aria-label="Settlement price distribution">
        {bins.map((b, i) => (
          <div key={i}>
            {i === firstBelow ? (
              <div className="tnum my-1 flex items-center gap-2 text-[11px] text-ink2">
                <span className="w-[68px] text-right font-semibold">{usd(e.target, dp)}</span>
                <span className="flex-1 border-t border-dashed border-ink2" />
                <span>TARGET</span>
              </div>
            ) : null}
            <button
              type="button"
              role="listitem"
              onClick={() => setSel(sel === i ? null : i)}
              className="flex h-[15px] w-full items-center gap-2 py-[1px] text-left"
              aria-label={`${usd(b.lo, dp)} to ${usd(b.hi, dp)}: ${pct(b.mass, 1)}`}
            >
              <span className={`tnum w-[68px] shrink-0 text-right text-[10px] ${b.hasPrice ? "font-bold text-ink" : "text-ink3"}`}>
                {i % 2 === 0 || b.hasPrice ? usd((b.lo + b.hi) / 2, dp) : ""}
              </span>
              <span className="relative h-full flex-1">
                <span
                  className={`absolute left-0 top-0 h-full rounded-r-[4px] ${b.above ? "bg-up" : "bg-down"} ${
                    sel !== null && sel !== i ? "opacity-40" : ""
                  }`}
                  style={{ width: `${Math.max(0.5, (b.mass / max) * 100)}%` }}
                />
              </span>
              <span className="w-[14px] text-[10px] text-ink">{b.hasPrice ? "◀" : ""}</span>
            </button>
          </div>
        ))}
      </div>
      <div className="tnum mt-1 flex items-baseline justify-between text-[13px]">
        <span className="font-semibold text-down">▼ DOWN {pct(1 - e.pUp!)}</span>
        <span className="text-ink3">below target</span>
      </div>
      <div className="tnum mt-2 min-h-[18px] text-[12px] text-ink2">
        {selected
          ? `${usd(selected.lo, dp)} – ${usd(selected.hi, dp)}: ${pct(selected.mass, 1)} chance`
          : `◀ = live price. Bars ≈ ⅓σ wide; σ to close ≈ ${usd(e.price! * e.model!.spread, 0)}.`}
      </div>
    </Card>
  );
}
