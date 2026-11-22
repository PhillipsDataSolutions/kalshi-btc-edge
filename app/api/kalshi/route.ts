// Read-only proxy for Kalshi's public market-data API.
// Usage: /api/kalshi?path=markets&series_ticker=KXBTC15M&status=open
//        /api/kalshi?path=markets/<TICKER>
//        /api/kalshi?path=markets/<TICKER>/orderbook
//        /api/kalshi?path=series/KXBTC15M
// Responses are cached ~1s (in memory + Vercel edge cache) to respect Kalshi's rate limits.

import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const BASES = [
  "https://external-api.kalshi.com/trade-api/v2",
  "https://api.elections.kalshi.com/trade-api/v2",
];

const ALLOWED_PATHS = [
  /^markets$/,
  /^markets\/[A-Za-z0-9._-]+$/,
  /^markets\/[A-Za-z0-9._-]+\/orderbook$/,
  /^series\/[A-Za-z0-9._-]+$/,
];

const ALLOWED_PARAMS = new Set(["series_ticker", "event_ticker", "status", "limit", "cursor", "depth", "tickers"]);

const TTL_MS = 1000;
type Entry = { t: number; status: number; body: string; final: boolean };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();

async function upstream(key: string): Promise<Entry> {
  let last: Entry = { t: Date.now(), status: 502, body: JSON.stringify({ error: "Kalshi unreachable" }), final: false };
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}/${key}`, {
        headers: { accept: "application/json", "user-agent": "kalshi-btc-edge/0.1 (read-only)" },
        cache: "no-store",
        signal: AbortSignal.timeout(6000),
      });
      const body = await res.text();
      // A settled market never changes again, so it can be cached for a long time.
      const final = res.ok && /^markets\/[^/]+$/.test(key) && /"status"\s*:\s*"(finalized|settled)"/.test(body);
      last = { t: Date.now(), status: res.status, body, final };
      if (res.status < 500 && res.status !== 429) return last;
    } catch (e) {
      last = { t: Date.now(), status: 502, body: JSON.stringify({ error: String(e) }), final: false };
    }
  }
  return last;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const path = sp.get("path") ?? "";
  if (!ALLOWED_PATHS.some((r) => r.test(path))) {
    return Response.json({ error: "path not allowed" }, { status: 400 });
  }
  const qs = new URLSearchParams();
  for (const [k, v] of sp) if (ALLOWED_PARAMS.has(k)) qs.set(k, v);
  qs.sort();
  const key = qs.size ? `${path}?${qs}` : path;

  let entry = cache.get(key);
  if (!entry || (!entry.final && Date.now() - entry.t > TTL_MS)) {
    let p = inflight.get(key);
    if (!p) {
      p = upstream(key).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    entry = await p;
    if (entry.status < 500) cache.set(key, entry);
    if (cache.size > 500) {
      const cutoff = Date.now() - 60_000;
      for (const [k, v] of cache) if (v.t < cutoff) cache.delete(k);
    }
  }

  return new Response(entry.body, {
    status: entry.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": entry.final
        ? "public, max-age=3600, s-maxage=86400"
        : "public, max-age=0, s-maxage=1, stale-while-revalidate=1",
    },
  });
}
