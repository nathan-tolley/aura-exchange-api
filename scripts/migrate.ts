import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString });
await pool.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

const migrationDir = path.resolve("db/migrations");
const files = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();

for (const filename of files) {
  const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [filename]);
  if (applied.rowCount) continue;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(await readFile(path.join(migrationDir, filename), "utf8"));
    await client.query("INSERT INTO schema_migrations(filename) VALUES ($1)", [filename]);
    await client.query("COMMIT");
    console.log(`Applied ${filename}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

await pool.end();

