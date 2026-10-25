import type { Pool, PoolClient } from "pg";
import { one } from "../db.js";
import { appError } from "../errors.js";

type Db = Pick<Pool | PoolClient, "query">;

/** PLAN.md → Force 2: the pool at IPO is 4,000 shares and A$400,000 (price 100), so A$10,000 moves it about 5%. */
export const IPO_SHARES = 4_000;
export const IPO_CREDITS = 400_000;
export const IPO_PRICE = 100;

/** The index is called AURA, so no person can be. */
const RESERVED_TICKERS = new Set(["AURA"]);
const TICKER = /^[A-Z]{3,5}$/;

/** "$nate " → "NATE". */
export const normalizeTicker = (raw: string) => raw.trim().replace(/^\$/, "").toUpperCase();

export const isValidTicker = (ticker: string) => TICKER.test(ticker) && !RESERVED_TICKERS.has(ticker);

async function takenTickers(db: Db, exchangeId: string, candidates: string[]): Promise<Set<string>> {
  const result = await db.query<{ ticker: string }>(
    "SELECT upper(ticker::text) AS ticker FROM listings WHERE exchange_id=$1 AND upper(ticker::text) = ANY($2::text[])",
    [exchangeId, candidates]
  );
  return new Set(result.rows.map((row) => row.ticker));
}

/** Free alternatives built from the wanted ticker's letters (or the person's name), at most three. */
export async function suggestTickers(db: Db, exchangeId: string, wanted: string, name: string): Promise<string[]> {
  const letters = (wanted.replace(/[^A-Z]/g, "") || name.toUpperCase().replace(/[^A-Z]/g, "") || "AUR").padEnd(3, "X");
  const consonants = letters[0] + letters.slice(1).replace(/[AEIOU]/g, "");
  const raw = [
    letters.slice(0, 5), letters.slice(0, 4), letters.slice(0, 3), consonants.slice(0, 4), consonants.slice(0, 3),
    letters.slice(0, 3) + letters.at(-1), letters.slice(0, 4) + "X", letters.slice(0, 3) + "X", letters.slice(0, 3) + "Z"
  ];
  const candidates = [...new Set(raw)].filter((ticker) => ticker !== wanted && isValidTicker(ticker));
  const taken = await takenTickers(db, exchangeId, candidates);
  return candidates.filter((ticker) => !taken.has(ticker)).slice(0, 3);
}

export async function isTickerAvailable(db: Db, exchangeId: string, ticker: string): Promise<boolean> {
  return isValidTicker(ticker) && !(await takenTickers(db, exchangeId, [ticker])).has(ticker);
}

/**
 * Lists a member: their consent, their listing, a fresh pool at 100.00 in the active season, the opening tick and
 * the IPO line on the tape. Answers TICKER_TAKEN and CONFLICT (already listed) as contract errors.
 */
export async function ipo(client: PoolClient, input: { exchangeId: string; userId: string; ticker: string }): Promise<{ id: string; ticker: string; display_name: string }> {
  const membership = await one<{ id: string }>(client,
    "SELECT id FROM memberships WHERE exchange_id=$1 AND user_id=$2 FOR UPDATE", [input.exchangeId, input.userId]
  );
  const existing = await client.query("SELECT 1 FROM listings WHERE exchange_id=$1 AND owner_user_id=$2", [input.exchangeId, input.userId]);
  if (existing.rowCount) throw appError("CONFLICT", { reason: "ALREADY_LISTED" }, "You are already listed on this exchange");
  if (!(await isTickerAvailable(client, input.exchangeId, input.ticker))) {
    throw appError("TICKER_TAKEN", { ticker: `$${input.ticker}` }, "That ticker is taken");
  }
  const season = await one<{ id: string }>(client, "SELECT id FROM seasons WHERE exchange_id=$1 AND status='ACTIVE'", [input.exchangeId]);
  let listing: { id: string; ticker: string; display_name: string };
  try {
    listing = await one(client,
      `INSERT INTO listings(exchange_id,display_name,ticker,owner_user_id,is_active,claimed_at,consented_at)
       SELECT $1, COALESCE(display_name, split_part(email::text,'@',1), 'Trader'), $2, id, true, now(), now() FROM users WHERE id=$3
       RETURNING id, ticker::text, display_name`,
      [input.exchangeId, input.ticker, input.userId]
    );
  } catch (error) {
    // Someone took it between the check and the insert; the transaction rolls back either way.
    if ((error as { code?: string }).code !== "23505") throw error;
    throw appError("TICKER_TAKEN", { ticker: `$${input.ticker}` }, "That ticker was just taken");
  }
  await client.query("UPDATE memberships SET listing_consent_at=now(),updated_at=now() WHERE id=$1", [membership.id]);
  await client.query(
    `INSERT INTO market_pools(exchange_id,season_id,stock_id,share_reserve,credit_reserve,opening_price,day_open_price,organic_price)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$6)`,
    [input.exchangeId, season.id, listing.id, IPO_SHARES, IPO_CREDITS, IPO_PRICE]
  );
  await client.query(
    "INSERT INTO market_price_ticks(exchange_id,season_id,stock_id,price,cause) VALUES ($1,$2,$3,$4,'OPEN')",
    [input.exchangeId, season.id, listing.id, IPO_PRICE]
  );
  await client.query(
    "INSERT INTO feed_events(exchange_id,season_id,kind,actor_id,subject_stock_id,payload) VALUES ($1,$2,'IPO',$3,$4,$5)",
    [input.exchangeId, season.id, input.userId, listing.id, JSON.stringify({ ticker: listing.ticker, price: "100.00" })]
  );
  return listing;
}
