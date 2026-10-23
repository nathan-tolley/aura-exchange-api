import type { Role } from "../types.js";

export interface FeedRow {
  id: string;
  kind: string;
  actor_id: string | null;
  subject_stock_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
  actor_name: string | null;
  actor_ticker: string | null;
  subject_name: string | null;
  subject_ticker: string | null;
}

export function serializeFeedEvent(row: FeedRow, viewer: { role: Role; stockId: string | null }) {
  const elevated = viewer.role === "OWNER" || viewer.role === "MODERATOR";
  const canRevealAuraAuthor = elevated || row.subject_stock_id === viewer.stockId;
  const payload = { ...row.payload };
  if (row.kind === "AURA_RULING" && !canRevealAuraAuthor) delete payload.authorId;
  return {
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at,
    subject: row.subject_stock_id ? {
      id: row.subject_stock_id,
      displayName: row.subject_name,
      ticker: row.subject_ticker
    } : null,
    actor: row.kind === "AURA_RULING" && !canRevealAuraAuthor
      ? { displayName: "Anonymous", ticker: null }
      : { displayName: row.actor_name ?? "System", ticker: row.actor_ticker },
    payload
  };
}

