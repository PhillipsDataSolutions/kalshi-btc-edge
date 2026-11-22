// Client-side BTC price feeds. Message formats checked live against each exchange on 2026-11-22.
//
// Coinbase  wss://ws-feed.exchange.coinbase.com  {type:"subscribe",product_ids:["BTC-USD"],channels:["ticker"]}
//           -> {type:"ticker", best_bid:"60589.76", best_ask:"60589.77", ...}
// Kraken    wss://ws.kraken.com/v2  {method:"subscribe",params:{channel:"ticker",symbol:["BTC/USD"],event_trigger:"bbo"}}
//           -> {channel:"ticker", type:"snapshot"|"update", data:[{bid:60599.8, ask:60599.9, ...}]}
// Bitstamp  wss://ws.bitstamp.net  {event:"bts:subscribe",data:{channel:"order_book_btcusd"}}
//           -> {event:"data", channel:"order_book_btcusd", data:{bids:[["60590.47","0.77"],...], asks:[...]}}
// Gemini    wss://api.gemini.com/v1/marketdata/BTCUSD?top_of_book=true&trades=false
//           -> {type:"update", events:[{type:"change", side:"bid"|"ask", price:"60610.27", remaining:"0.46"}]}
// Binance   wss://fstream.binance.com/ws/btcusdt@bookTicker (USDT perp; lead/momentum only, geo-blocked in the US)
//           -> {e:"bookTicker", b:"60668.70", a:"60668.80", ...}

export type FeedId = "coinbase" | "kraken" | "bitstamp" | "gemini" | "binance";
export type FeedStatus = "connecting" | "live" | "stale" | "down" | "blocked" | "off";

export interface FeedSnapshot {
  id: FeedId;
  label: string;
  status: FeedStatus;
  mid: number | null;
  ageMs: number | null;
  inComposite: boolean;
}

interface FeedDef {
  id: FeedId;
  label: string;
  url: string;
  sub?: unknown;
  parse: (msg: any, f: FeedRuntime) => void;
  lead?: boolean;
}

interface FeedRuntime {
  def: FeedDef;
  ws: WebSocket | null;
  bid: number | null;
  ask: number | null;
  ts: number; // last good quote
  lastMsg: number;
  status: FeedStatus;
  failures: number;
  everOpened: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  enabled: boolean;
}

const f = (v: unknown) => {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const DEFS: FeedDef[] = [
  {
    id: "coinbase",
    label: "Coinbase",
    url: "wss://ws-feed.exchange.coinbase.com",
    sub: { type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker"] },
    parse(m, rt) {
      if (m.type !== "ticker") return;
      setQuote(rt, f(m.best_bid), f(m.best_ask));
    },
  },
  {
    id: "kraken",
    label: "Kraken",
    url: "wss://ws.kraken.com/v2",
    sub: { method: "subscribe", params: { channel: "ticker", symbol: ["BTC/USD"], event_trigger: "bbo" } },
    parse(m, rt) {
      if (m.channel !== "ticker" || !Array.isArray(m.data) || !m.data[0]) return;
      setQuote(rt, f(m.data[0].bid), f(m.data[0].ask));
    },
  },
  {
    id: "bitstamp",
    label: "Bitstamp",
    url: "wss://ws.bitstamp.net",
    sub: { event: "bts:subscribe", data: { channel: "order_book_btcusd" } },
    parse(m, rt) {
      if (m.event === "bts:request_reconnect") {
        rt.ws?.close();
        return;
      }
      if (m.event !== "data" || !m.data) return;
      const b = m.data.bids?.[0]?.[0];
      const a = m.data.asks?.[0]?.[0];
      setQuote(rt, f(b), f(a));
    },
  },
  {
    id: "gemini",
    label: "Gemini",
    url: "wss://api.gemini.com/v1/marketdata/BTCUSD?top_of_book=true&trades=false",
    parse(m, rt) {
      if (m.type !== "update" || !Array.isArray(m.events)) return;
      let bid = rt.bid;
      let ask = rt.ask;
      for (const e of m.events) {
        if (e.type !== "change" || !(parseFloat(e.remaining) > 0)) continue;
        if (e.side === "bid") bid = f(e.price);
        else if (e.side === "ask") ask = f(e.price);
      }
      setQuote(rt, bid, ask);
    },
  },
  {
    id: "binance",
    label: "Binance perp",
    url: "wss://fstream.binance.com/ws/btcusdt@bookTicker",
    lead: true,
    parse(m, rt) {
      if (m.b === undefined) return;
      setQuote(rt, f(m.b), f(m.a));
    },
  },
];

function setQuote(rt: FeedRuntime, bid: number | null, ask: number | null) {
  if (bid === null || ask === null) return;
  rt.bid = bid;
  rt.ask = ask;
  rt.ts = Date.now();
}

const STALE_MS = 10_000;
const WATCHDOG_MS = 20_000;
const HISTORY_SECONDS = 3900;
const OUTLIER = 0.003; // drop a feed >0.3% away from the median

export interface PricePoint {
  t: number; // ms, whole second
  p: number;
}

export class PriceHub {
  feeds: FeedRuntime[];
  history: PricePoint[] = []; // composite, 1/second
  lead: PricePoint[] = []; // binance mid, 1/second
  minuteCloses: number[] = []; // 1-minute closes: Coinbase candles, then live composite
  private lastMinute = -1;
  private lastMinutePrice: number | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private onVis = () => {
    if (document.visibilityState === "visible") this.feeds.forEach((rt) => this.ensure(rt));
  };

  constructor(enableLead = true) {
    this.feeds = DEFS.map((def) => ({
      def,
      ws: null,
      bid: null,
      ask: null,
      ts: 0,
      lastMsg: 0,
      status: "connecting",
      failures: 0,
      everOpened: false,
      retryTimer: null,
      enabled: def.lead ? enableLead : true,
    }));
  }

  start() {
    this.feeds.forEach((rt) => rt.enabled && this.connect(rt));
    this.tickTimer = setInterval(() => this.tick(), 1000);
    document.addEventListener("visibilitychange", this.onVis);
    void this.seedCandles();
  }

  stop() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    document.removeEventListener("visibilitychange", this.onVis);
    for (const rt of this.feeds) {
      if (rt.retryTimer) clearTimeout(rt.retryTimer);
      rt.enabled = false;
      rt.ws?.close();
    }
  }

  setLeadEnabled(on: boolean) {
    const rt = this.feeds.find((x) => x.def.lead);
    if (!rt || rt.enabled === on) return;
    rt.enabled = on;
    if (on) {
      rt.failures = 0;
      rt.status = "connecting";
      this.connect(rt);
    } else {
      if (rt.retryTimer) clearTimeout(rt.retryTimer);
      rt.ws?.close();
      rt.status = "off";
    }
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private connect(rt: FeedRuntime) {
    if (!rt.enabled) return;
    if (rt.retryTimer) {
      clearTimeout(rt.retryTimer);
      rt.retryTimer = null;
    }
    try {
      rt.ws?.close();
    } catch {}
    rt.status = rt.status === "blocked" ? "blocked" : "connecting";
    let ws: WebSocket;
    try {
      ws = new WebSocket(rt.def.url);
    } catch {
      this.scheduleRetry(rt);
      return;
    }
    rt.ws = ws;
    rt.lastMsg = Date.now();
    ws.onopen = () => {
      rt.everOpened = true;
      rt.failures = 0;
      if (rt.def.sub) ws.send(JSON.stringify(rt.def.sub));
    };
    ws.onmessage = (ev) => {
      rt.lastMsg = Date.now();
      try {
        rt.def.parse(JSON.parse(typeof ev.data === "string" ? ev.data : ""), rt);
      } catch {}
    };
    ws.onclose = () => {
      if (rt.ws !== ws) return;
      rt.ws = null;
      this.scheduleRetry(rt);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  private scheduleRetry(rt: FeedRuntime) {
    if (!rt.enabled) return;
    rt.failures++;
    // The lead feed is often geo-blocked (HTTP 451): give up quickly and retry rarely.
    if (rt.def.lead && !rt.everOpened && rt.failures >= 3) {
      rt.status = "blocked";
      rt.retryTimer = setTimeout(() => this.connect(rt), 5 * 60_000);
      return;
    }
    rt.status = "down";
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(rt.failures, 5));
    rt.retryTimer = setTimeout(() => this.connect(rt), delay);
  }

  /** Reconnect if the socket is missing or silent (iOS freezes sockets in the background). */
  private ensure(rt: FeedRuntime) {
    if (!rt.enabled || rt.status === "blocked") return;
    const silent = Date.now() - rt.lastMsg > WATCHDOG_MS;
    if (!rt.ws || rt.ws.readyState > 1 || silent) {
      rt.failures = 0;
      this.connect(rt);
    }
  }

  private tick() {
    const now = Date.now();
    const sec = Math.floor(now / 1000) * 1000;
    for (const rt of this.feeds) {
      if (!rt.enabled) continue;
      if (rt.status !== "blocked" && rt.status !== "down" && rt.status !== "connecting" && now - rt.lastMsg > WATCHDOG_MS) {
        this.ensure(rt);
      }
      if (rt.ts && now - rt.ts <= STALE_MS) rt.status = "live";
      else if (rt.ws && rt.ws.readyState === 1) rt.status = rt.ts ? "stale" : "connecting";
    }

    const comp = this.composite();
    if (comp !== null) {
      this.history.push({ t: sec, p: comp.price });
      if (this.history.length > HISTORY_SECONDS) this.history.splice(0, this.history.length - HISTORY_SECONDS);
      const minute = Math.floor(now / 60000);
      if (this.lastMinute !== -1 && minute !== this.lastMinute && this.lastMinutePrice !== null) {
        this.minuteCloses.push(this.lastMinutePrice);
        if (this.minuteCloses.length > 1500) this.minuteCloses.splice(0, this.minuteCloses.length - 1500);
      }
      this.lastMinute = minute;
      this.lastMinutePrice = comp.price;
    }
    const lead = this.feeds.find((x) => x.def.lead);
    if (lead && lead.status === "live" && lead.bid && lead.ask) {
      this.lead.push({ t: sec, p: (lead.bid + lead.ask) / 2 });
      if (this.lead.length > 400) this.lead.splice(0, this.lead.length - 400);
    }
    this.listeners.forEach((fn) => fn());
  }

  composite(): { price: number; used: FeedId[] } | null {
    const now = Date.now();
    const quotes = this.feeds
      .filter((rt) => !rt.def.lead && rt.enabled && rt.bid && rt.ask && now - rt.ts <= STALE_MS)
      .map((rt) => ({ id: rt.def.id, mid: ((rt.bid as number) + (rt.ask as number)) / 2 }));
    if (!quotes.length) return null;
    const sorted = quotes.map((q) => q.mid).sort((a, b) => a - b);
    const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const kept = quotes.filter((q) => Math.abs(q.mid / median - 1) <= OUTLIER);
    const use = kept.length ? kept : quotes;
    return { price: use.reduce((s, q) => s + q.mid, 0) / use.length, used: use.map((q) => q.id) };
  }

  snapshots(): FeedSnapshot[] {
    const now = Date.now();
    const used = new Set(this.composite()?.used ?? []);
    return this.feeds.map((rt) => ({
      id: rt.def.id,
      label: rt.def.label,
      status: rt.enabled ? rt.status : "off",
      mid: rt.bid && rt.ask ? (rt.bid + rt.ask) / 2 : null,
      ageMs: rt.ts ? now - rt.ts : null,
      inComposite: used.has(rt.def.id),
    }));
  }

  /** Composite price `secondsAgo` seconds back (nearest stored point at or before). */
  priceAgo(secondsAgo: number, series: PricePoint[] = this.history): number | null {
    if (!series.length) return null;
    const want = series[series.length - 1].t - secondsAgo * 1000;
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i].t <= want) return series[i].p;
    }
    return null;
  }

  /** Seed 24h of 1-minute closes from Coinbase's public candles API (CORS-enabled). */
  private async seedCandles() {
    try {
      const end = Math.floor(Date.now() / 60000) * 60; // seconds, start of current minute
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
      // [time, low, high, open, close, volume]; skip the in-progress current minute.
      for (const r of rows) if (Array.isArray(r) && r[0] < end) byTime.set(r[0], r[4]);
      const closes = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      // Live minutes collected while we were fetching come after the seed.
      this.minuteCloses = [...closes, ...this.minuteCloses].slice(-1500);
      this.listeners.forEach((fn) => fn());
    } catch {
      // Volatility will build from live data instead.
    }
  }
}
