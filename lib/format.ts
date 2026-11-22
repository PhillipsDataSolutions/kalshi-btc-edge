export const usd = (n: number | null | undefined, dp = 2) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "–"
    : "$" + n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export const signedUsd = (n: number | null, dp = 2) =>
  n === null ? "–" : (n >= 0 ? "+" : "−") + usd(Math.abs(n), dp);

export const cents = (n: number | null | undefined, dp = 0) =>
  n === null || n === undefined || !Number.isFinite(n) ? "–" : `${n.toFixed(dp)}¢`;

export const pct = (p: number | null | undefined, dp = 0) =>
  p === null || p === undefined || !Number.isFinite(p) ? "–" : `${(p * 100).toFixed(dp)}%`;

const etTime = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

export function windowLabel(openMs: number, closeMs: number) {
  const a = etTime.format(new Date(openMs)).replace(/\s?(AM|PM)$/, "");
  const b = etTime.format(new Date(closeMs));
  return `${a}–${b} ET`;
}

export function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
