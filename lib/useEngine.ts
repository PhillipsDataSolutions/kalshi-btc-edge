"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CalibState, DEFAULT_CALIB, computeCalibration, correctedP } from "./calibrate";
import { addLog, allLogs, allResults, putResult } from "./db";
import { takerFeeCents } from "./fees";
import { PriceHub } from "./feeds";
import { Market, OrderBook, fetchMarket, fetchOpenMarkets, fetchOrderBook, pickCurrent, upMid } from "./kalshi";
import { blendedVolPerMin, isFastMove, modelProbUp } from "./model";
import { gradeLogs } from "./scorecard";
import { featuresFor, fitLogistic, predictLogistic } from "./blend";
import { BlendState, blendCoef, isProven, loadLiveBlend, saveLiveBlend, entryZone } from "./entry";
import { Settings, readLS, writeLS } from "./storage";
import {
  SETTLE_FIRST_OFFSET_S,
  SETTLE_LAST_OFFSET_S,
  TrackEntry,
  loadTrack,
  saveTrack,
  trackStats,
} from "./tracking";

export interface OddsPoint {
  t: number;
  kalshi: number | null; // Up mid, cents
  fair: number | null; // decision fair Up, cents
}

export interface Signal {
  side: "up" | "down" | null;
  edge: number | null;
  ready: boolean; // every gate passed
  blockers: string[];
  heldSec: number;
}

export interface FeedView {
  id: string;
  label: string;
  status: string;
  mid: number | null;
  ageMs: number | null;
  inComposite: boolean;
  levels: number;
}

export type Verdict = "cheap" | "overpriced" | "fair" | "na";

export interface SideView {
  side: "up" | "down";
  fair: number | null; // cents
  ask: number | null;
  bid: number | null;
  buyCost: number | null; // ask + fee
  sellNet: number | null; // bid - fee
  edgeBuy: number | null; // fair - buyCost
  edgeSell: number | null; // sellNet - fair
  verdict: Verdict;
}

const CALIB_KEY = "kbe.calib";
const LOG_EVERY_MS = 10_000;

export function useEngine(settings: Settings) {
  const hubRef = useRef<PriceHub | null>(null);
  const [, setTick] = useState(0);
  const [market, setMarket] = useState<Market | null>(null);
  const [marketErr, setMarketErr] = useState<string | null>(null);
  const [book, setBook] = useState<OrderBook | null>(null);
  const [calib, setCalib] = useState<CalibState>(DEFAULT_CALIB);
  const [gradedVersion, setGradedVersion] = useState(0);
  const [logCount, setLogCount] = useState(0);
  const lastLog = useRef(0);
  const [marketAt, setMarketAt] = useState(0);
  const [track, setTrack] = useState<TrackEntry[]>([]);
  const trackRef = useRef<TrackEntry[]>([]);
  const seenWindows = useRef(new Map<string, number>()); // ticker -> closeTime
  const odds = useRef<{ ticker: string; pts: OddsPoint[] }>({ ticker: "", pts: [] });
  const streak = useRef<{ side: "up" | "down" | null; since: number }>({ side: null, since: 0 });
  const [liveBlend, setLiveBlend] = useState<BlendState | null>(null);
  const latest = useRef<{ entry: Parameters<typeof addLog>[0] | null }>({ entry: null });

  // Price feeds
  useEffect(() => {
    const hub = new PriceHub({ lite: settings.lite, lead: settings.lead });
    hubRef.current = hub;
    const unsub = hub.subscribe(() => setTick((t) => t + 1));
    hub.start();
    setCalib(readLS(CALIB_KEY, DEFAULT_CALIB));
    setLiveBlend(loadLiveBlend());
    trackRef.current = loadTrack();
    setTrack(trackRef.current);
    return () => {
      unsub();
      hub.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    hubRef.current?.setLeadEnabled(settings.lead);
  }, [settings.lead]);

  useEffect(() => {
    hubRef.current?.setLite(settings.lite);
  }, [settings.lite]);

  // Kalshi market polling
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const markets = await fetchOpenMarkets();
        if (!alive) return;
        const cur = pickCurrent(markets);
        setMarket(cur);
        setMarketAt(Date.now());
        setMarketErr(null);
        if (cur) seenWindows.current.set(cur.ticker, cur.closeTime);
      } catch (e) {
        if (alive) setMarketErr(e instanceof Error ? e.message : "Kalshi unavailable");
      }
    };
    void poll();
    const id = setInterval(poll, 1000);
    const onVis = () => document.visibilityState === "visible" && void poll();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Order book (optional depth)
  const ticker = market?.ticker;
  useEffect(() => {
    if (!ticker || !settings.showBook) {
      setBook(null);
      return;
    }
    let alive = true;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const b = await fetchOrderBook(ticker);
        if (alive) setBook(b);
      } catch {}
    };
    void poll();
    const id = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [ticker, settings.showBook]);

  // Grading: fetch settled results for closed windows, then re-fit calibration.
  const grade = useCallback(async () => {
    try {
      const [logs, results] = await Promise.all([allLogs(), allResults()]);
      setLogCount(logs.length);
      const have = new Set(results.map((r) => r.ticker));
      const now = Date.now();
      const trackPending = trackRef.current.filter((e) => e.official === null && e.closeTime < now).map((e) => e.ticker);
      const pending = [
        ...new Set([...trackPending, ...logs.filter((l) => l.closeTime < now && !have.has(l.ticker)).map((l) => l.ticker)]),
      ]
        .filter((t) => !have.has(t))
        .slice(0, 8);
      let added = 0;
      for (const t of pending) {
        try {
          const m = await fetchMarket(t);
          if (m && (m.result === "yes" || m.result === "no")) {
            await putResult({
              ticker: t,
              result: m.result,
              settle: m.expirationValue,
              target: m.target,
              closeTime: m.closeTime,
              fetchedAt: Date.now(),
            });
            added++;
          }
        } catch {}
      }
      const finalResults = added ? await allResults() : results;
      // Fill in official settlement values for the price-accuracy tracker.
      const official = new Map(finalResults.map((r) => [r.ticker, r.settle]));
      let changed = false;
      for (const e of trackRef.current) {
        const v = official.get(e.ticker);
        if (e.official === null && typeof v === "number" && v > 0) {
          e.official = v;
          changed = true;
        }
      }
      if (changed) {
        trackRef.current = [...trackRef.current];
        saveTrack(trackRef.current);
        setTrack(trackRef.current);
      }
      const graded = gradeLogs(logs, finalResults);
      const state = computeCalibration(
        graded
          .filter((g) => g.vol > 0 && Number.isFinite(g.lnr))
          .map((g) => ({ lnr: g.lnr, vol: g.vol, tEff: g.tEff, minsLeft: g.minsLeft, y: g.y })),
      );
      setCalib(state);
      writeLS(CALIB_KEY, state);
      // Re-fit the blend for the entry zone from this device's own graded readings, shrunk toward the
      // backtest coefficients. Needs 300+ graded readings in the zone.
      const zone = entryZone(settings.entryMinute);
      const zoneRows = graded.filter((g) => {
        const mi = 15 - g.minsLeft;
        return mi >= zone.from && mi <= zone.to && g.kalshiMid !== null && g.pModel !== undefined;
      });
      if (zoneRows.length >= 300) {
        const prior = blendCoef(settings.entryMinute, null);
        if (prior) {
          const coef = fitLogistic(
            zoneRows.map((g) => ({
              ...featuresFor(g.pModel as number, (g.kalshiMid as number) / 100, g.mom1 ?? 0, g.mom5 ?? 0),
              y: g.y,
            })),
            30,
            prior,
          );
          const lb: BlendState = { entryMinute: settings.entryMinute, coef, n: zoneRows.length, updatedAt: Date.now() };
          saveLiveBlend(lb);
          setLiveBlend(lb);
        }
      }
      setGradedVersion((v) => v + 1);
    } catch {}
  }, [settings.entryMinute]);

  useEffect(() => {
    void grade();
    const id = setInterval(() => document.visibilityState === "visible" && void grade(), 30_000);
    return () => clearInterval(id);
  }, [grade]);

  // ---- derived values (recomputed every second) ----
  const hub = hubRef.current;
  const now = Date.now();
  const tstats = trackStats(track);
  const bias = settings.biasCorrect && tstats.biasActive ? tstats.bias : 0;
  const rawPrice = hub?.history.length ? hub.history[hub.history.length - 1].p : null;
  const price = rawPrice !== null ? rawPrice + bias : null;
  const volPerMin = hub ? blendedVolPerMin(hub.minuteCloses) : null;
  const target = market?.target ?? null;
  const minsLeft = market ? Math.max(0, (market.closeTime - now) / 60000) : null;
  const windowMins = market ? (market.closeTime - market.openTime) / 60000 : 15;

  // Settlement window: the 60 one-second BRTI values before close.
  const settle = (() => {
    if (!market || !hub) return null;
    const from = market.closeTime + SETTLE_FIRST_OFFSET_S * 1000;
    const to = market.closeTime + SETTLE_LAST_OFFSET_S * 1000;
    if (now < from - 1000) return null;
    const pts = hub.between(from, to);
    const sum = pts.reduce((a, p) => a + p.p + bias, 0);
    return { count: pts.length, sum, avg: pts.length ? sum / pts.length : null };
  })();

  const model =
    price && target && volPerMin && minsLeft !== null
      ? modelProbUp({ price, target, volPerMin, minsLeft, calib: calib.calib, obsSum: settle?.sum, obsCount: settle?.count })
      : null;
  const pModel = model && minsLeft !== null ? correctedP(model.pUp, minsLeft, calib) : null;
  const price60 = hub?.priceAgo(60) ?? null;
  const price300 = hub?.priceAgo(300) ?? null;
  const minuteIn = market ? (now - market.openTime) / 60000 : null;
  const mom1 = rawPrice && price60 && volPerMin ? Math.log(rawPrice / price60) / volPerMin : 0;
  const mom5 = rawPrice && price300 && volPerMin ? Math.log(rawPrice / price300) / (volPerMin * Math.sqrt(5)) : 0;
  const kMid = market ? upMid(market) : null;
  // Learned blend of model + Kalshi price + momentum for this minute of the window (see lib/blend.ts).
  const coef = minuteIn !== null && minuteIn >= 0.5 && minuteIn <= 14.5 ? blendCoef(minuteIn, liveBlend) : null;
  const pBlend =
    coef && pModel !== null && kMid !== null ? predictLogistic(coef, featuresFor(pModel, kMid / 100, mom1, mom5)) : null;
  const pUp = settings.useBlend && pBlend !== null ? pBlend : pModel;
  const proven = minuteIn !== null ? isProven(minuteIn) : { ok: false, reason: "no window" };
  const fast = rawPrice ? isFastMove(rawPrice, price60, volPerMin) : false;

  const sideView = (side: "up" | "down"): SideView => {
    const fair = pUp === null ? null : (side === "up" ? pUp : 1 - pUp) * 100;
    const ask = market ? (side === "up" ? market.yesAsk : market.noAsk) : null;
    const bid = market ? (side === "up" ? market.yesBid : market.noBid) : null;
    const buyCost = ask !== null ? ask + takerFeeCents(ask, settings.contracts) : null;
    const sellNet = bid !== null ? bid - takerFeeCents(bid, settings.contracts) : null;
    const edgeBuy = fair !== null && buyCost !== null ? fair - buyCost : null;
    const edgeSell = fair !== null && sellNet !== null ? sellNet - fair : null;
    let verdict: Verdict = "na";
    if (fair !== null && (edgeBuy !== null || edgeSell !== null)) {
      if (edgeBuy !== null && edgeBuy >= settings.margin) verdict = "cheap";
      else if (edgeSell !== null && edgeSell >= settings.margin) verdict = "overpriced";
      else verdict = "fair";
    }
    return { side, fair, ask, bid, buyCost, sellNet, edgeBuy, edgeSell, verdict };
  };
  const up = sideView("up");
  const down = sideView("down");

  // Momentum
  const mom = (secs: number, series = hub?.history) => {
    if (!hub || !series?.length) return null;
    const ago = hub.priceAgo(secs, series);
    const nowP = series[series.length - 1].p;
    return ago ? (Math.log(nowP / ago) * 1e4) : null; // basis points
  };
  const momentum = {
    comp10: mom(10),
    comp60: mom(60),
    lead10: hub?.lead.length ? mom(10, hub.lead) : null,
    lead60: hub?.lead.length ? mom(60, hub.lead) : null,
  };

  // Latest loggable reading
  latest.current.entry =
    market && model && pUp !== null && pModel !== null && price && target && minsLeft !== null && minsLeft > 0 && volPerMin
      ? {
          ts: now,
          ticker: market.ticker,
          closeTime: market.closeTime,
          minsLeft,
          pUp,
          pModel: pModel ?? undefined,
          mom1,
          mom5,
          lnr: model.lnr,
          vol: volPerMin,
          tEff: model.tEff,
          calib: calib.calib,
          kalshiMid: upMid(market),
          yesBid: market.yesBid,
          yesAsk: market.yesAsk,
          noBid: market.noBid,
          noAsk: market.noAsk,
          price,
          target,
          fast,
        }
      : null;

  // Log every 10 seconds
  useEffect(() => {
    const id = setInterval(() => {
      const e = latest.current.entry;
      if (!e || Date.now() - lastLog.current < LOG_EVERY_MS - 500) return;
      if (Date.now() - e.ts > 3000) return; // stale reading (app was backgrounded)
      lastLog.current = Date.now();
      addLog({ ...e, ts: Date.now() })
        .then(() => setLogCount((c) => c + 1))
        .catch(() => {});
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ---- trade signal with consistency gates ----
  const best = [up, down]
    .filter((s) => s.edgeBuy !== null)
    .sort((a, b) => (b.edgeBuy as number) - (a.edgeBuy as number))[0];
  const candidate = best && (best.edgeBuy as number) >= settings.margin ? best.side : null;
  if (candidate !== streak.current.side) streak.current = { side: candidate, since: now };
  const heldSec = candidate ? (now - streak.current.since) / 1000 : 0;
  const blockers: string[] = [];
  if (!candidate) blockers.push(`no side ≥ ${settings.margin}¢ edge after fees`);
  else {
    if (heldSec < settings.holdSec) blockers.push(`edge held ${Math.floor(heldSec)}s of ${settings.holdSec}s`);
    if (fast) blockers.push("fast move");
    if (settings.useBlend && !proven.ok) blockers.push(proven.reason);
    const spread = market && market.yesBid !== null && market.yesAsk !== null ? market.yesAsk - market.yesBid : null;
    if (spread === null || spread > settings.maxSpread) blockers.push(`Kalshi spread ${spread ?? "?"}¢ > ${settings.maxSpread}¢`);
    const nEx = hub?.last?.used.length ?? 0;
    if (!settings.lite && nEx < 5) blockers.push(`only ${nEx}/7 exchanges live`);
    if (settings.useBlend && pBlend === null) blockers.push("no blend for this minute");
  }
  const signal: Signal = {
    side: candidate,
    edge: best?.edgeBuy ?? null,
    ready: !!candidate && blockers.length === 0,
    blockers,
    heldSec,
  };

  if (market) {
    if (odds.current.ticker !== market.ticker) odds.current = { ticker: market.ticker, pts: [] };
    const pts = odds.current.pts;
    const sec = Math.floor(now / 1000) * 1000;
    if (!pts.length || pts[pts.length - 1].t !== sec) {
      pts.push({ t: sec, kalshi: kMid, fair: pUp !== null ? pUp * 100 : null });
      if (pts.length > 1000) pts.shift();
    }
  }

  const used = new Set(hub?.last?.used ?? []);
  const feeds: FeedView[] = (hub?.feedStates() ?? []).map((f) => ({
    id: f.id,
    label: f.label,
    status: f.status,
    mid: f.bestBid !== null && f.bestAsk !== null ? (f.bestBid + f.bestAsk) / 2 : null,
    ageMs: f.ageMs,
    inComposite: used.has(f.id),
    levels: f.levels,
  }));
  if (hub && settings.lead) {
    feeds.push({
      id: "binance",
      label: "Binance perp",
      status: hub.leadState.status,
      mid: hub.leadState.mid,
      ageMs: null,
      inComposite: false,
      levels: 0,
    });
  }

  // Record our replica's settlement average for every window we watched through its close.
  useEffect(() => {
    const h = hubRef.current;
    if (!h) return;
    for (const [ticker, close] of seenWindows.current) {
      if (Date.now() < close + 3000) continue;
      seenWindows.current.delete(ticker);
      if (trackRef.current.some((e) => e.ticker === ticker)) continue;
      const pts = h.between(close + SETTLE_FIRST_OFFSET_S * 1000, close + SETTLE_LAST_OFFSET_S * 1000);
      if (pts.length < 55) continue;
      const entry: TrackEntry = { ticker, closeTime: close, ours: pts.reduce((a, p) => a + p.p, 0) / pts.length, n: pts.length, official: null };
      trackRef.current = [...trackRef.current, entry];
      saveTrack(trackRef.current);
      setTrack(trackRef.current);
    }
  });

  return {
      now,
      market,
      marketErr,
      book,
      price,
      target,
      minsLeft,
      windowMins,
      volPerMin,
      model,
      pUp,
      fast,
      up,
      down,
      momentum,
      feeds,
      calib,
      gradedVersion,
      logCount,
      grade,
      minuteCount: hub?.minuteCloses.length ?? 0,
      rawPrice,
      pModel,
      pBlend,
      minuteIn,
      proven,
      signal,
      oddsHistory: odds.current.pts,
      history: hub?.history ?? [],
      liveBlend,
      mom1,
      mom5,
      bias,
      tstats,
      rti: hub?.last ?? null,
      simpleMean: hub?.simpleMean ?? null,
      settle,
      marketAgeMs: marketAt ? now - marketAt : null,
      bandwidth: hub?.bandwidth() ?? 0,
  };
}

export type Engine = ReturnType<typeof useEngine>;
