import pg, { type PoolClient, type QueryResultRow } from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 12,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function one<T extends QueryResultRow>(
  client: Pick<PoolClient, "query">,
  text: string,
  values: unknown[] = []
): Promise<T> {
  const result = await client.query<T>(text, values);
  if (result.rows.length !== 1) throw new Error(`Expected one row, received ${result.rows.length}`);
  return result.rows[0]!;
}

export async function maybeOne<T extends QueryResultRow>(
  client: Pick<PoolClient, "query">,
  text: string,
  values: unknown[] = []
): Promise<T | null> {
  const result = await client.query<T>(text, values);
  if (result.rows.length > 1) throw new Error(`Expected at most one row, received ${result.rows.length}`);
  return result.rows[0] ?? null;
}

