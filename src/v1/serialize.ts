import { Decimal } from "decimal.js";

/** ISO 8601 in UTC to the second, the contract's timestamp format ("2026-10-24T13:21:00Z"). */
export function isoTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isoTimeOrNull(date: Date | null | undefined): string | null {
  return date ? isoTime(date) : null;
}

/** Tickers always go out uppercase with a $ ("$JAKE"). */
export function formatTicker(ticker: string): string {
  return `$${ticker.toUpperCase()}`;
}

export function serializeUser(row: { id: string; email: string | null; display_name: string | null; username: string | null; created_at: Date }) {
  return {
    id: row.id,
    displayName: row.display_name ?? row.username ?? "Trader",
    email: row.email ?? "",
    createdAt: isoTime(row.created_at)
  };
}

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
