// Kalshi public market data helpers.
// Field names verified against the live API (GET /markets?series_ticker=KXBTC15M&status=open)
// and https://docs.kalshi.com on 2026-11-22:
//   ticker, event_ticker, open_time, close_time, floor_strike (the Target Price),
//   yes_bid_dollars / yes_ask_dollars / no_bid_dollars / no_ask_dollars / last_price_dollars
//   (strings like "0.1500"), status ("active" while trading, "finalized" when settled),
//   result ("yes" | "no" | ""), expiration_value (the final 60s BRTI average, a string).
// Older responses used integer-cent fields (yes_bid, yes_ask, ...). We accept both.

export const SERIES = "KXBTC15M";

export type Side = "up" | "down";

export interface Market {
  ticker: string;
  eventTicker: string;
  openTime: number; // ms epoch
  closeTime: number; // ms epoch
  target: number | null; // USD
  yesBid: number | null; // cents
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  last: number | null;
  status: string;
  result: "yes" | "no" | "";
  expirationValue: number | null;
}

export interface BookLevel {
  price: number; // cents
  size: number; // contracts
}

export interface OrderBook {
  // Best level first.
  upBids: BookLevel[];
  downBids: BookLevel[];
}

type Raw = Record<string, unknown>;

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = parseFloat(v.replace(/[$,]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Read a price in cents from either `<base>_dollars` ("0.1500") or legacy `<base>` (15). */
export function centsField(m: Raw, base: string): number | null {
  const d = num(m[`${base}_dollars`]);
  if (d !== null) return Math.round(d * 10000) / 100;
  const c = num(m[base]);
  if (c !== null) return c;
  return null;
}

/** Bids of 0 and asks of 0 or 100 mean "nothing there". */
function bid(v: number | null) {
  return v !== null && v > 0 ? v : null;
}
function ask(v: number | null) {
  return v !== null && v > 0 && v < 100 ? v : null;
}

export function parseTarget(m: Raw): number | null {
  const fs = num(m.floor_strike);
  if (fs !== null && fs > 0) return fs;
  // Fallback: "Target Price: $60,640.58"
  const sub = typeof m.yes_sub_title === "string" ? m.yes_sub_title : "";
  const match = sub.match(/\$([\d,]+(?:\.\d+)?)/);
  if (match) return num(match[1]);
  return null;
}

export function normalizeMarket(m: Raw): Market {
  const result = m.result === "yes" || m.result === "no" ? m.result : "";
  return {
    ticker: String(m.ticker ?? ""),
    eventTicker: String(m.event_ticker ?? ""),
    openTime: Date.parse(String(m.open_time ?? "")) || 0,
    closeTime: Date.parse(String(m.close_time ?? "")) || 0,
    target: parseTarget(m),
    yesBid: bid(centsField(m, "yes_bid")),
    yesAsk: ask(centsField(m, "yes_ask")),
    noBid: bid(centsField(m, "no_bid")),
    noAsk: ask(centsField(m, "no_ask")),
    last: centsField(m, "last_price"),
    status: String(m.status ?? ""),
    result,
    expirationValue: num(m.expiration_value),
  };
}

/** The open window = the open market with the soonest close_time still in the future. */
export function pickCurrent(markets: Market[], now = Date.now()): Market | null {
  const live = markets
    .filter((m) => m.closeTime > now && m.openTime <= now + 1000)
    .sort((a, b) => a.closeTime - b.closeTime);
  return live[0] ?? null;
}

export function upMid(m: Pick<Market, "yesBid" | "yesAsk">): number | null {
  if (m.yesBid !== null && m.yesAsk !== null) return (m.yesBid + m.yesAsk) / 2;
  return null;
}

/**
 * Orderbook: GET /markets/{ticker}/orderbook returns
 * { orderbook_fp: { yes_dollars: [["0.1400","6917.10"], ...], no_dollars: [...] } }
 * Bids only, ascending by price (best bid last). A YES bid at X = a NO ask at 100-X.
 * Legacy shape: { orderbook: { yes: [[14, 6917], ...], no: [...] } }.
 */
export function normalizeOrderBook(raw: Raw): OrderBook {
  const parse = (arr: unknown, dollars: boolean): BookLevel[] => {
    if (!Array.isArray(arr)) return [];
    const out: BookLevel[] = [];
    for (const lvl of arr) {
      if (!Array.isArray(lvl)) continue;
      const p = num(lvl[0]);
      const s = num(lvl[1]);
      if (p === null || s === null) continue;
      out.push({ price: dollars ? Math.round(p * 10000) / 100 : p, size: s });
    }
    return out.sort((a, b) => b.price - a.price);
  };
  const fp = raw.orderbook_fp as Raw | undefined;
  if (fp) return { upBids: parse(fp.yes_dollars, true), downBids: parse(fp.no_dollars, true) };
  const ob = raw.orderbook as Raw | undefined;
  if (ob) return { upBids: parse(ob.yes, false), downBids: parse(ob.no, false) };
  return { upBids: [], downBids: [] };
}

// ---- client-side fetch through our proxy ----

export async function kalshiGet(path: string, params: Record<string, string> = {}): Promise<Raw> {
  const qs = new URLSearchParams({ path, ...params });
  const res = await fetch(`/api/kalshi?${qs}`, { cache: "no-store" });
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.replace("/login");
    throw new Error("Signed out");
  }
  if (!res.ok) throw new Error(`Kalshi ${res.status}`);
  return (await res.json()) as Raw;
}

export async function fetchOpenMarkets(): Promise<Market[]> {
  const data = await kalshiGet("markets", { series_ticker: SERIES, status: "open" });
  const arr = Array.isArray(data.markets) ? (data.markets as Raw[]) : [];
  return arr.map(normalizeMarket);
}

export async function fetchMarket(ticker: string): Promise<Market | null> {
  const data = await kalshiGet(`markets/${ticker}`);
  return data.market ? normalizeMarket(data.market as Raw) : null;
}

export async function fetchOrderBook(ticker: string): Promise<OrderBook> {
  return normalizeOrderBook(await kalshiGet(`markets/${ticker}/orderbook`));
}
