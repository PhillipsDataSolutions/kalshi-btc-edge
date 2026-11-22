"use client";

import { useEffect, useState } from "react";
import { DEFAULT_POSITION, DEFAULT_SETTINGS, usePersisted } from "@/lib/storage";
import { useEngine } from "@/lib/useEngine";
import Header, { FeedDots } from "./Header";
import Accuracy from "./Accuracy";
import Hero from "./Hero";
import Histogram from "./Histogram";
import { CashOut, Depth, Stats } from "./LiveExtras";
import Scorecard from "./Scorecard";
import Ticker from "./Ticker";
import EntryCard from "./EntryCard";
import SettingsView from "./SettingsView";

type Tab = "live" | "score" | "settings";

export default function App() {
  const [settings, updateSettings] = usePersisted("kbe.settings", DEFAULT_SETTINGS);
  const [pos, setPos] = usePersisted("kbe.position", DEFAULT_POSITION);
  const [tab, setTab] = useState<Tab>("live");
  const e = useEngine(settings);

  useEffect(() => {
    if ("serviceWorker" in navigator && location.protocol === "https:") {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  const tabs: { id: Tab; label: string }[] = [
    { id: "live", label: "Live" },
    { id: "score", label: "Scorecard" },
    { id: "settings", label: "Settings" },
  ];

  return (
    <div className="mx-auto min-h-dvh max-w-md">
      <main className="space-y-3 px-4 pb-24 pt-3">
        {tab === "live" ? (
          <>
            <Header e={e} />
            <FeedDots e={e} />
            {e.marketErr && !e.market ? (
              <div className="rounded-xl border border-down/40 bg-down/10 p-3 text-[13px] text-down">Kalshi: {e.marketErr}. Retrying…</div>
            ) : null}
            <Hero e={e} entryMinute={settings.entryMinute} />
            <Ticker e={e} entryMinute={settings.entryMinute} />
            <Histogram e={e} />
            <Stats e={e} />
            <CashOut e={e} pos={pos} setPos={setPos} margin={settings.margin} />
            {settings.showBook ? <Depth e={e} /> : null}
            <Accuracy e={e} />
          </>
        ) : tab === "score" ? (
          <>
            <EntryCard entryMinute={settings.entryMinute} />
            <Scorecard e={e} margin={settings.margin} contracts={settings.contracts} />
          </>
        ) : (
          <SettingsView e={e} settings={settings} update={updateSettings} />
        )}
      </main>
      <nav
        className="fixed inset-x-0 bottom-0 border-t border-line bg-bg/95 backdrop-blur"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto flex max-w-md">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`flex-1 py-3 text-[13px] font-semibold ${tab === t.id ? "text-ink" : "text-ink3"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
