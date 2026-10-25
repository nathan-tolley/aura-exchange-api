import { Decimal } from "decimal.js";

// Numbers go out as decimal strings, rounded half-up (API-CONTRACT.md → Numbers). Decimal is set to ROUND_HALF_UP
// in src/core/market.ts.
const noNegativeZero = (text: string) => (/^-0(\.0+)?$/.test(text) ? text.slice(1) : text);

/** A$ amounts and prices: exactly 2 decimals. */
export function money(value: Decimal.Value): string {
  return noNegativeZero(new Decimal(value).toFixed(2, Decimal.ROUND_HALF_UP));
}

/** Percent units with 2 decimals: 0.1219 as a ratio is "12.19". */
export function percentOfRatio(ratio: Decimal.Value): string {
  return money(new Decimal(ratio).mul(100));
}

/** Share quantities: up to 4 decimals, no trailing zeros ("20", "12.5"). */
export function shares(value: Decimal.Value): string {
  return noNegativeZero(new Decimal(value).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed());
}
