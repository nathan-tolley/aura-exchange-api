/** ISO 8601 in UTC to the second, the contract's timestamp format ("2026-10-24T13:21:00Z"). */
export function isoTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isoTimeOrNull(date: Date | null | undefined): string | null {
  return date ? isoTime(date) : null;
}
