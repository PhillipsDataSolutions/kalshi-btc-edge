// Kalshi taker fee for KXBTC15M.
// GET /series/KXBTC15M reports fee_type "quadratic", fee_multiplier 1, i.e. the standard
// schedule: fee = round_up_to_cent(0.07 × C × P × (1 − P)), P in dollars.
// (https://kalshi.com/docs/kalshi-fee-schedule.pdf; rounding per
// https://docs.kalshi.com/getting_started/fee_rounding.md: non-direct members are charged to
// the cent, with per-order rounding accumulated across fills.)

export const TAKER_RATE = 0.07;

/** Total taker fee in cents for `contracts` contracts at `priceCents`. */
export function takerFeeTotalCents(priceCents: number, contracts = 1): number {
  const P = priceCents / 100;
  const raw = TAKER_RATE * contracts * P * (1 - P) * 100; // cents
  return Math.ceil(raw - 1e-9);
}

/** Fee per contract in cents (fractional when buying several, since rounding is per order). */
export function takerFeeCents(priceCents: number, contracts = 1): number {
  const c = Math.max(1, Math.round(contracts));
  return takerFeeTotalCents(priceCents, c) / c;
}
