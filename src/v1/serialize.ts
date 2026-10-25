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
