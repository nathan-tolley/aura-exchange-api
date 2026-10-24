export interface User {
  id: string;
  username: string;
  role: "OWNER" | "MODERATOR" | "MEMBER";
  stockId: string | null;
  displayName: string | null;
  ticker: string | null;
  csrfToken: string;
}

export interface Stock {
  id: string;
  displayName: string;
  ticker: string;
  avatarPath?: string | null;
  aura: number;
  careerAura: number;
  price: number;
  dayChangePct: number;
  seasonChangePct: number;
  haltedUntil: string | null;
}

export interface Market { stocks: Stock[]; auraComposite: number; marketIndex: number }
export interface CompositeStock {ticker:string;name:string;current:number;open:number;high:number;low:number;change:number;points:Array<{timestamp:string;value:number}>}

export interface FeedItem {
  id: string;
  kind: string;
  createdAt: string;
  actor: { displayName: string; ticker: string | null };
  subject: { id: string; displayName: string; ticker: string } | null;
  payload: Record<string, unknown>;
  votes?: { up: number; down: number; viewerVote: -1 | 0 | 1; effectiveDelta: number };
}

export interface Position {
  id: string;
  stockId: string;
  ticker: string;
  displayName: string;
  longQty: number;
  shortQty: number;
  price: number;
  averageEntry: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

export interface Portfolio {
  cash: number;
  equity: number;
  longValue: number;
  shortLiability: number;
  positions: Position[];
}

let csrfToken = "";
export const setCsrf = (token: string) => { csrfToken = token; };

export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const method = init.method?.toUpperCase() ?? "GET";
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" && method !== "HEAD" && csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...init.headers
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message ?? `Request failed (${response.status})`);
  return data as T;
}

export const money = (value: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
export const signed = (value: number, suffix = "") => `${value >= 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;

