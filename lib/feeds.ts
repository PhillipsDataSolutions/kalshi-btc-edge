// Price engine: a live replica of CF Benchmarks' BRTI (the index Kalshi settles KXBTC15M on),
// computed once per second from the L2 order books of all seven BRTI constituent exchanges.
// See lib/brti.ts (methodology) and lib/books.ts (exchange feeds).
//
// Optional lead feed: Binance USDT perpetual best bid/ask, for momentum only (never in the price).
//   wss://fstream.binance.com/ws/btcusdt@bookTicker -> {e:"bookTicker", b:"60668.70", a:"60668.80"}

import { ADAPTERS, BookFeed, type BookFeedState, type WsFactory } from "./books";
import { computeRti, screen, type ExchangeBook, type RtiResult } from "./brti";

export interface PricePoint {
  t: number; // ms, whole second
  p: number;
}

export interface LeadState {
  status: "connecting" | "live" | "down" | "blocked" | "off";
  mid: number | null;
}

const HISTORY_SECONDS = 3900;
const browserWs: WsFactory = (url) => new WebSocket(url) as unknown as ReturnType<WsFactory>;

export class PriceHub {
  feeds: BookFeed[];
  history: PricePoint[] = []; // BRTI replica, 1/second
  lead: PricePoint[] = []; // Binance mid, 1/second
  minuteCloses: number[] = []; // 1-minute closes: Coinbase candles, then live replica
  candles: PricePoint[] = []; // Coinbase 1-minute closes stamped at minute end (chart backfill only)
  last: RtiResult | null = null;
  simpleMean: number | null = null; // plain average of best-bid/ask mids, for comparison
  leadState: LeadState = { status: "off", mid: null };

  private lastMinute = -1;
  private lastMinutePrice: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private excludedPrev = new Set<string>();
  private leadWs: WebSocket | null = null;
  private leadEnabled: boolean;
  private leadFailures = 0;
  private leadOpened = false;
  private leadRetry: ReturnType<typeof setTimeout> | null = null;
  private leadBid: number | null = null;
  private leadAsk: number | null = null;
  private leadTs = 0;
  private stopped = false;
  private onVis = () => {
    if (document.visibilityState === "visible") {
      this.feeds.forEach((f) => f.ensure());
      if (this.leadEnabled && (!this.leadWs || this.leadWs.readyState > 1) && this.leadState.status !== "blocked") this.connectLead();
    }
  };

  constructor(opts: { lite: boolean; lead: boolean }) {
    this.feeds = ADAPTERS.map((a) => new BookFeed(a, browserWs, opts.lite));
    this.leadEnabled = opts.lead;
  }

  start() {
    this.stopped = false;
    this.feeds.forEach((f) => f.start());
    if (this.leadEnabled) this.connectLead();
    document.addEventListener("visibilitychange", this.onVis);
    this.schedule();
    void this.seedCandles();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    document.removeEventListener("visibilitychange", this.onVis);
    this.feeds.forEach((f) => f.stop());
    this.stopLead();
  }

  setLite(lite: boolean) {
    for (const f of this.feeds) if (f.lite !== lite) f.restart(lite);
  }

  setLeadEnabled(on: boolean) {
    if (on === this.leadEnabled) return;
    this.leadEnabled = on;
    if (on) {
      this.leadFailures = 0;
      this.connectLead();
    } else this.stopLead();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Align calculations to whole seconds (BRTI is published per second for settlement). */
  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick();
      this.schedule();
    }, 1000 - (Date.now() % 1000) + 5);
  }

  private tickCount = 0;

  private tick() {
    this.tickCount++;
    const now = Date.now();
    const sec = Math.round(now / 1000) * 1000;
    const books: ExchangeBook[] = [];
    const mids: number[] = [];
    for (const f of this.feeds) {
      if (this.tickCount % 5 === 0) f.ensure(); // periodic watchdog
      const l = f.levels(now);
      if (l && l.bids.length && l.asks.length) {
        books.push({ id: f.adapter.id, bids: l.bids, asks: l.asks });
        mids.push((l.bids[0][0] + l.asks[0][0]) / 2);
      }
    }
    this.simpleMean = mids.length ? mids.reduce((a, b) => a + b, 0) / mids.length : null;
    const r = !books.length ? null : this.feeds[0].lite ? liteIndex(books, this.excludedPrev) : computeRti(books, this.excludedPrev);
    this.last = r;
    if (r) {
      this.excludedPrev = new Set(r.excluded.map((e) => e.id));
      this.history.push({ t: sec, p: r.value });
      if (this.history.length > HISTORY_SECONDS) this.history.splice(0, this.history.length - HISTORY_SECONDS);
      const minute = Math.floor(sec / 60000);
      if (this.lastMinute !== -1 && minute !== this.lastMinute && this.lastMinutePrice !== null) {
        this.minuteCloses.push(this.lastMinutePrice);
        if (this.minuteCloses.length > 1500) this.minuteCloses.splice(0, this.minuteCloses.length - 1500);
      }
      this.lastMinute = minute;
      this.lastMinutePrice = r.value;
    }
    // Lead feed
    if (this.leadEnabled && this.leadBid && this.leadAsk && now - this.leadTs < 10_000) {
      const m = (this.leadBid + this.leadAsk) / 2;
      this.leadState = { status: "live", mid: m };
      this.lead.push({ t: sec, p: m });
      if (this.lead.length > 400) this.lead.splice(0, this.lead.length - 400);
    } else if (this.leadEnabled && this.leadState.status === "live") {
      this.leadState = { status: "connecting", mid: null };
    }
    this.listeners.forEach((fn) => fn());
  }

  feedStates(): BookFeedState[] {
    const now = Date.now();
    return this.feeds.map((f) => f.state(now));
  }

  bandwidth(): number {
    return this.feeds.reduce((a, f) => a + f.bytes, 0);
  }

  /** Replica value `secondsAgo` back (nearest stored point at or before). */
  priceAgo(secondsAgo: number, series: PricePoint[] = this.history): number | null {
    if (!series.length) return null;
    const want = series[series.length - 1].t - secondsAgo * 1000;
    for (let i = series.length - 1; i >= 0; i--) if (series[i].t <= want) return series[i].p;
    return null;
  }

  /** Points with fromMs <= t <= toMs. */
  between(fromMs: number, toMs: number): PricePoint[] {
    const out: PricePoint[] = [];
    for (let i = this.history.length - 1; i >= 0; i--) {
      const pt = this.history[i];
      if (pt.t < fromMs) break;
      if (pt.t <= toMs) out.push(pt);
    }
    return out.reverse();
  }

  // ---- Binance lead (momentum only; often geo-blocked in the US) ----
  private connectLead() {
    if (!this.leadEnabled || this.stopped) return;
    if (this.leadRetry) clearTimeout(this.leadRetry);
    try {
      this.leadWs?.close();
    } catch {}
    if (this.leadState.status !== "blocked") this.leadState = { status: "connecting", mid: null };
    let ws: WebSocket;
    try {
      ws = new WebSocket("wss://fstream.binance.com/ws/btcusdt@bookTicker");
    } catch {
      this.leadFail();
      return;
    }
    this.leadWs = ws;
    ws.onopen = () => {
      this.leadOpened = true;
      this.leadFailures = 0;
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data));
        const b = parseFloat(m.b);
        const a = parseFloat(m.a);
        if (b > 0 && a > 0) {
          this.leadBid = b;
          this.leadAsk = a;
          this.leadTs = Date.now();
        }
      } catch {}
    };
    ws.onclose = () => {
      if (this.leadWs !== ws) return;
      this.leadWs = null;
      this.leadFail();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  private leadFail() {
    if (!this.leadEnabled || this.stopped) return;
    this.leadFailures++;
    if (!this.leadOpened && this.leadFailures >= 3) {
      this.leadState = { status: "blocked", mid: null };
      this.leadRetry = setTimeout(() => this.connectLead(), 5 * 60_000);
      return;
    }
    this.leadState = { status: "down", mid: null };
    this.leadRetry = setTimeout(() => this.connectLead(), Math.min(30_000, 1000 * 2 ** this.leadFailures));
  }

  private stopLead() {
    if (this.leadRetry) clearTimeout(this.leadRetry);
    const ws = this.leadWs;
    this.leadWs = null;
    try {
      ws?.close();
    } catch {}
    this.leadState = { status: "off", mid: null };
    this.lead = [];
  }

  /** Seed 24h of 1-minute closes from Coinbase's public candles API (CORS-enabled), for volatility. */
  private async seedCandles() {
    try {
      const end = Math.floor(Date.now() / 60000) * 60;
      const chunks: Promise<number[][]>[] = [];
      for (let i = 0; i < 5; i++) {
        const e = end - i * 300 * 60;
        const s = e - 300 * 60;
        const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${new Date(
          s * 1000,
        ).toISOString()}&end=${new Date(e * 1000).toISOString()}`;
        chunks.push(fetch(url).then((r) => (r.ok ? r.json() : [])).catch(() => []));
      }
      const rows = (await Promise.all(chunks)).flat();
      const byTime = new Map<number, number>();
      for (const r of rows) if (Array.isArray(r) && r[0] < end) byTime.set(r[0], r[4]);
      const sorted = [...byTime.entries()].sort((a, b) => a[0] - b[0]);
      const closes = sorted.map((x) => x[1]);
      this.candles = sorted.slice(-30).map(([t, c]) => ({ t: (t + 60) * 1000, p: c }));
      this.minuteCloses = [...closes, ...this.minuteCloses].slice(-1500);
      this.listeners.forEach((fn) => fn());
    } catch {}
  }
}

/**
 * Light mode: top-of-book feeds can't support the depth-weighted BRTI calculation (measured
 * $7 off on a settled window), so use the screened mean of the exchange mids instead.
 */
function liteIndex(books: ExchangeBook[], excludedPrev: Set<string>): RtiResult | null {
  const { ok, excluded } = screen(books, excludedPrev);
  if (!ok.length) return null;
  const mids = ok.map((b) => (b.bids[0][0] + b.asks[0][0]) / 2);
  return {
    value: mids.reduce((a, b) => a + b, 0) / mids.length,
    used: ok.map((b) => b.id),
    excluded,
    utilizedDepth: 0,
    spacing: 0,
    cap: 0,
    points: 0,
  };
}
