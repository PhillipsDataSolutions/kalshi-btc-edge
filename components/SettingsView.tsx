"use client";

import { useRef, useState } from "react";
import { allLogs, allResults, clearAll, importAll } from "@/lib/db";
import type { Settings } from "@/lib/storage";
import type { Engine } from "@/lib/useEngine";
import { usd } from "@/lib/format";
import { Card, Label } from "./ui";

function Stepper({ value, onChange, min, max, suffix }: { value: number; onChange: (v: number) => void; min: number; max: number; suffix: string }) {
  return (
    <div className="flex items-center gap-2">
      <button type="button" className="h-9 w-9 rounded-lg bg-card2 text-lg" onClick={() => onChange(Math.max(min, value - 1))}>
        −
      </button>
      <span className="tnum w-12 text-center text-[15px] font-semibold">
        {value}
        {suffix}
      </span>
      <button type="button" className="h-9 w-9 rounded-lg bg-card2 text-lg" onClick={() => onChange(Math.min(max, value + 1))}>
        +
      </button>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative h-7 w-12 rounded-full transition ${on ? "bg-up" : "bg-line"}`}
    >
      <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white transition ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

export default function SettingsView({ e, settings, update }: { e: Engine; settings: Settings; update: (p: Partial<Settings>) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState("");

  const exportData = async () => {
    const data = { exportedAt: new Date().toISOString(), logs: await allLogs(), results: await allResults() };
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kalshi-btc-edge-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <div className="space-y-3">
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[15px]">Value margin</div>
            <div className="text-[12px] text-ink3">Edge (after fees) needed to call a side cheap or overpriced</div>
          </div>
          <Stepper value={settings.margin} min={0} max={20} suffix="¢" onChange={(v) => update({ margin: v })} />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[15px]">Contracts per order</div>
            <div className="text-[12px] text-ink3">Fee rounds up per order, so more contracts means less fee per contract</div>
          </div>
          <Stepper value={settings.contracts} min={1} max={500} suffix="" onChange={(v) => update({ contracts: v })} />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[15px]">Binance lead feed</div>
            <div className="text-[12px] text-ink3">Momentum only. Often blocked in the US.</div>
          </div>
          <Toggle on={settings.lead} onChange={(v) => update({ lead: v })} />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[15px]">Order book depth</div>
            <div className="text-[12px] text-ink3">Polls Kalshi's order book every 5s</div>
          </div>
          <Toggle on={settings.showBook} onChange={(v) => update({ showBook: v })} />
        </div>
      </Card>

      <Card>
        <Label>Price feeds</Label>
        <div className="tnum mt-2 text-[13px]">
          {e.feeds.map((f) => (
            <div key={f.id} className="flex justify-between border-b border-line py-1.5 last:border-0">
              <span>
                {f.label} {f.inComposite ? <span className="text-ink3">· in composite</span> : null}
              </span>
              <span className="text-ink2">
                {usd(f.mid)} · {f.status}
                {f.ageMs !== null && f.status !== "off" ? ` · ${(f.ageMs / 1000).toFixed(0)}s` : ""}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-2 text-[11px] text-ink3">
          Composite = mean of live Coinbase, Kraken, Bitstamp and Gemini mids (a feed older than 10s or more than 0.3% from the median is
          skipped). It approximates CF Benchmarks' BRTI, which settles the market, but it is not BRTI.
        </div>
      </Card>

      <Card className="space-y-2">
        <Label>Self-grading data</Label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="rounded-lg bg-card2 px-3 py-2 text-[13px]" onClick={exportData}>
            Export JSON
          </button>
          <button type="button" className="rounded-lg bg-card2 px-3 py-2 text-[13px]" onClick={() => fileRef.current?.click()}>
            Import JSON
          </button>
          <button
            type="button"
            className="rounded-lg bg-down/15 px-3 py-2 text-[13px] text-down"
            onClick={async () => {
              if (!confirm("Delete all logged readings and results? This can't be undone.")) return;
              await clearAll();
              localStorage.removeItem("kbe.calib");
              await e.grade();
              setMsg("Cleared.");
            }}
          >
            Clear all
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={async (ev) => {
            const file = ev.target.files?.[0];
            if (!file) return;
            try {
              const data = JSON.parse(await file.text());
              await importAll(data);
              await e.grade();
              setMsg(`Imported ${data.logs?.length ?? 0} readings.`);
            } catch {
              setMsg("Import failed: not a valid export file.");
            }
            ev.target.value = "";
          }}
        />
        {msg ? <div className="text-[12px] text-ink2">{msg}</div> : null}
        <div className="text-[11px] text-ink3">
          Data stays on this device (IndexedDB). Readings are only logged while the app is open on screen; iOS pauses it in the background.
        </div>
      </Card>

      <Card>
        <div className="space-y-1 text-[11px] text-ink3">
          <p>Read-only. No trading, no Kalshi account access. Not financial advice.</p>
          <p>Up wins if the 60-second BRTI average before close is at least the target (the previous window's average).</p>
        </div>
      </Card>
    </div>
  );
}
