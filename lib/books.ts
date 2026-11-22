// Live L2 order books for the BRTI constituent exchanges (CME CF constituent list, BTC-USD:
// Bitstamp, Coinbase, Kraken, Gemini, LMAX Digital, Bullish, Crypto.com; itBit suspended 27-Jul-26).
// Every endpoint and message format below was checked live on 2026-11-22.
// Shared by the browser app and the Node verification script (pass a WebSocket factory).

export type ExchangeId = "coinbase" | "kraken" | "bitstamp" | "gemini" | "lmax" | "bullish" | "cryptocom";

export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;

export class Book {
  bids = new Map<number, number>();
  asks = new Map<number, number>();
  lastMsg = 0; // any message (incl. heartbeats) — the socket is alive
  lastBook = 0; // last book change
  clear() {
    this.bids.clear();
    this.asks.clear();
  }
  set(side: "bid" | "ask", price: number, size: number) {
    if (!(price > 0) || !Number.isFinite(size)) return;
    const m = side === "bid" ? this.bids : this.asks;
    if (size > 0) m.set(price, size);
    else m.delete(price);
  }
  replace(bids: Iterable<[number, number]>, asks: Iterable<[number, number]>) {
    this.clear();
    for (const [p, s] of bids) this.set("bid", p, s);
    for (const [p, s] of asks) this.set("ask", p, s);
  }
}

interface Adapter {
  id: ExchangeId;
  label: string;
  url: (lite: boolean) => string;
  subscribe?: (lite: boolean) => unknown[];
  handle: (msg: any, book: Book, send: (o: unknown) => void, lite: boolean) => void;
  maxDepth?: (lite: boolean) => number; // truncate to this many levels per side (feeds that expect the client to)
  keepalive?: { everyMs: number; msg: unknown };
}

const n = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v)));
const pairs = (arr: any[] | undefined): [number, number][] => (arr ?? []).map((l) => [n(l[0]), n(l[1])]);
const objPairs = (arr: any[] | undefined, p: string, q: string): [number, number][] =>
  (arr ?? []).map((l) => [n(l[p]), n(l[q])]);
const flatPairs = (arr: any[] | undefined): [number, number][] => {
  const out: [number, number][] = [];
  if (!arr) return out;
  for (let i = 0; i + 1 < arr.length; i += 2) out.push([n(arr[i]), n(arr[i + 1])]);
  return out;
};

export const ADAPTERS: Adapter[] = [
  {
    id: "coinbase",
    label: "Coinbase",
    url: () => "wss://ws-feed.exchange.coinbase.com",
    // level2_batch (served as "level2_50"): full book snapshot + batched updates. Lite: ticker best bid/ask.
    subscribe: (lite) => [{ type: "subscribe", product_ids: ["BTC-USD"], channels: [lite ? "ticker" : "level2_batch"] }],
    handle(m, book) {
      if (m.type === "snapshot") book.replace(pairs(m.bids), pairs(m.asks));
      else if (m.type === "l2update" && Array.isArray(m.changes)) {
        for (const [side, p, s] of m.changes) book.set(side === "buy" ? "bid" : "ask", n(p), n(s));
      } else if (m.type === "ticker") book.replace([[n(m.best_bid), n(m.best_bid_size)]], [[n(m.best_ask), n(m.best_ask_size)]]);
      else return;
      book.lastBook = Date.now();
    },
  },
  {
    id: "kraken",
    label: "Kraken",
    url: () => "wss://ws.kraken.com/v2",
    subscribe: (lite) => [{ method: "subscribe", params: { channel: "book", symbol: ["BTC/USD"], depth: lite ? 10 : 1000 } }],
    maxDepth: (lite) => (lite ? 10 : 1000),
    handle(m, book) {
      if (m.channel !== "book" || !Array.isArray(m.data) || !m.data[0]) return;
      const d = m.data[0];
      if (m.type === "snapshot") book.replace(objPairs(d.bids, "price", "qty"), objPairs(d.asks, "price", "qty"));
      else {
        for (const [p, s] of objPairs(d.bids, "price", "qty")) book.set("bid", p, s);
        for (const [p, s] of objPairs(d.asks, "price", "qty")) book.set("ask", p, s);
      }
      book.lastBook = Date.now();
    },
  },
  {
    id: "bitstamp",
    label: "Bitstamp",
    url: () => "wss://ws.bitstamp.net",
    // Pushes the top 100 levels per side on every change.
    subscribe: () => [{ event: "bts:subscribe", data: { channel: "order_book_btcusd" } }],
    keepalive: { everyMs: 20_000, msg: { event: "bts:heartbeat" } },
    handle(m, book, send) {
      if (m.event === "bts:request_reconnect") throw new Error("reconnect");
      if (m.event !== "data" || !m.data?.bids) return;
      book.replace(pairs(m.data.bids), pairs(m.data.asks));
      book.lastBook = Date.now();
      void send;
    },
  },
  {
    id: "gemini",
    label: "Gemini",
    // Full book: initial snapshot as "change" events (reason "initial"), then changes with the new
    // remaining size (0 = level removed). Lite: top of book only.
    url: (lite) =>
      lite
        ? "wss://api.gemini.com/v1/marketdata/BTCUSD?top_of_book=true&trades=false&heartbeat=true"
        : "wss://api.gemini.com/v1/marketdata/BTCUSD?trades=false&heartbeat=true",
    handle(m, book, _send, lite) {
      if (m.type !== "update" || !Array.isArray(m.events)) return;
      for (const e of m.events) {
        if (e.type !== "change") continue;
        const side = e.side === "bid" ? "bid" : "ask";
        if (lite) {
          const map = side === "bid" ? book.bids : book.asks;
          if (n(e.remaining) > 0) {
            map.clear();
            map.set(n(e.price), n(e.remaining));
          }
        } else book.set(side, n(e.price), n(e.remaining));
      }
      book.lastBook = Date.now();
    },
  },
  {
    id: "lmax",
    label: "LMAX Digital",
    url: () => "wss://public-data-api.london-digital.lmax.com/v1/web-socket",
    // Full snapshot of the visible book every second.
    subscribe: () => [{ type: "SUBSCRIBE", channels: [{ name: "ORDER_BOOK", instruments: ["btc-usd"] }] }],
    handle(m, book) {
      if (m.type !== "ORDER_BOOK" || m.instrument_id !== "btc-usd") return;
      book.replace(objPairs(m.bids, "price", "quantity"), objPairs(m.asks, "price", "quantity"));
      book.lastBook = Date.now();
    },
  },
  {
    id: "bullish",
    label: "Bullish",
    url: () => "wss://api.exchange.bullish.com/trading-api/v1/market-data/orderbook",
    // l2Orderbook: snapshots with flat [price, qty, price, qty, ...] arrays. Lite: l1Orderbook {bid:[p,q], ask:[p,q]}.
    subscribe: (lite) => [
      { jsonrpc: "2.0", type: "command", method: "subscribe", params: { topic: lite ? "l1Orderbook" : "l2Orderbook", symbol: "BTCUSD" }, id: "1" },
    ],
    keepalive: { everyMs: 60_000, msg: { jsonrpc: "2.0", type: "command", method: "keepalivePing", params: {}, id: "2" } },
    handle(m, book) {
      if (m.dataType === "V1TALevel1" && m.data?.symbol === "BTCUSD" && m.data.bid && m.data.ask) {
        book.replace([[n(m.data.bid[0]), n(m.data.bid[1])]], [[n(m.data.ask[0]), n(m.data.ask[1])]]);
        book.lastBook = Date.now();
        return;
      }
      if (m.dataType !== "V1TALevel2" || !m.data || m.data.symbol !== "BTCUSD") return;
      if (m.type === "snapshot") book.replace(flatPairs(m.data.bids), flatPairs(m.data.asks));
      else {
        for (const [p, s] of flatPairs(m.data.bids)) book.set("bid", p, s);
        for (const [p, s] of flatPairs(m.data.asks)) book.set("ask", p, s);
      }
      book.lastBook = Date.now();
    },
  },
  {
    id: "cryptocom",
    label: "Crypto.com",
    url: () => "wss://stream.crypto.com/exchange/v1/market",
    subscribe: (lite) => [{ id: 1, method: "subscribe", params: { channels: [lite ? "book.BTC_USD.10" : "book.BTC_USD.150"] } }],
    handle(m, book, send) {
      if (m.method === "public/heartbeat") {
        send({ id: m.id, method: "public/respond-heartbeat" });
        return;
      }
      const r = m.result;
      if (!r || r.instrument_name !== "BTC_USD" || !Array.isArray(r.data) || !r.data[0]) return;
      const d = r.data[0];
      if (r.channel === "book") book.replace(pairs(d.bids), pairs(d.asks));
      else if (r.channel === "book.update" && d.update) {
        for (const [p, s] of pairs(d.update.bids)) book.set("bid", p, s);
        for (const [p, s] of pairs(d.update.asks)) book.set("ask", p, s);
      } else return;
      book.lastBook = Date.now();
    },
  },
];

export type FeedStatus = "connecting" | "live" | "stale" | "down" | "off";

export interface BookFeedState {
  id: ExchangeId;
  label: string;
  status: FeedStatus;
  bestBid: number | null;
  bestAsk: number | null;
  levels: number;
  ageMs: number | null;
}

export const RETRIEVAL_LAG_MS = 10_000;
const WATCHDOG_MS = 20_000;

/** One reconnecting WebSocket per exchange, maintaining a local L2 book. */
export class BookFeed {
  book = new Book();
  ws: WsLike | null = null;
  status: FeedStatus = "connecting";
  private failures = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private ka: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  bytes = 0;
  adapter: Adapter;
  lite: boolean;
  private factory: WsFactory;

  constructor(adapter: Adapter, factory: WsFactory, lite = false) {
    this.adapter = adapter;
    this.factory = factory;
    this.lite = lite;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.ka) clearInterval(this.ka);
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    this.status = "off";
  }

  restart(lite = this.lite) {
    this.lite = lite;
    this.stop();
    this.failures = 0;
    this.start();
  }

  /** Reconnect if the socket is gone or silent (e.g. iOS froze it in the background). */
  ensure() {
    if (this.stopped) return;
    if (!this.ws || this.ws.readyState > 1 || Date.now() - this.book.lastMsg > WATCHDOG_MS) {
      this.failures = 0;
      this.connect();
    }
  }

  private send = (o: unknown) => {
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o));
    } catch {}
  };

  private connect() {
    if (this.stopped) return;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (this.ka) {
      clearInterval(this.ka);
      this.ka = null;
    }
    const old = this.ws;
    this.ws = null;
    try {
      old?.close();
    } catch {}
    this.book.clear();
    this.status = "connecting";
    let ws: WsLike;
    try {
      ws = this.factory(this.adapter.url(this.lite));
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    this.book.lastMsg = Date.now();
    ws.onopen = () => {
      this.failures = 0;
      for (const s of this.adapter.subscribe?.(this.lite) ?? []) this.send(s);
      if (this.adapter.keepalive) {
        const k = this.adapter.keepalive;
        this.ka = setInterval(() => this.send(k.msg), k.everyMs);
      }
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.book.lastMsg = Date.now();
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      this.bytes += data.length;
      try {
        this.adapter.handle(JSON.parse(data), this.book, this.send, this.lite);
      } catch (e) {
        if (e instanceof Error && e.message === "reconnect") this.connect();
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.scheduleRetry();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  private scheduleRetry() {
    if (this.stopped) return;
    this.failures++;
    this.status = "down";
    this.book.clear();
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5));
    this.retry = setTimeout(() => this.connect(), delay);
  }

  /** Sorted levels within ±5% of this exchange's mid (wider levels never affect BRTI). */
  levels(now = Date.now()): { bids: [number, number][]; asks: [number, number][] } | null {
    const fresh = this.ws && this.ws.readyState === 1 && now - this.book.lastMsg <= RETRIEVAL_LAG_MS && this.book.lastBook > 0;
    this.status = this.stopped ? "off" : fresh ? "live" : this.ws && this.ws.readyState === 1 ? "stale" : this.status === "down" ? "down" : "connecting";
    if (!fresh) return null;
    let bids = [...this.book.bids.entries()].sort((a, b) => b[0] - a[0]);
    let asks = [...this.book.asks.entries()].sort((a, b) => a[0] - b[0]);
    const depth = this.adapter.maxDepth?.(this.lite);
    if (depth) {
      // Kraken expects clients to truncate to the subscribed depth.
      for (const [p] of bids.slice(depth)) this.book.bids.delete(p);
      for (const [p] of asks.slice(depth)) this.book.asks.delete(p);
      bids = bids.slice(0, depth);
      asks = asks.slice(0, depth);
    }
    if (!bids.length || !asks.length) return { bids, asks };
    const m = (bids[0][0] + asks[0][0]) / 2;
    return {
      bids: bids.filter(([p]) => p >= m * 0.95),
      asks: asks.filter(([p]) => p <= m * 1.05),
    };
  }

  state(now = Date.now()): BookFeedState {
    let bestBid: number | null = null;
    let bestAsk: number | null = null;
    for (const p of this.book.bids.keys()) if (bestBid === null || p > bestBid) bestBid = p;
    for (const p of this.book.asks.keys()) if (bestAsk === null || p < bestAsk) bestAsk = p;
    return {
      id: this.adapter.id,
      label: this.adapter.label,
      status: this.status,
      bestBid,
      bestAsk,
      levels: this.book.bids.size + this.book.asks.size,
      ageMs: this.book.lastMsg ? now - this.book.lastMsg : null,
    };
  }
}
