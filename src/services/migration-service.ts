import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

export interface MigrationStatus {
  current: boolean;
  applied: number;
  expected: number;
  pending: string[];
  latest: string | null;
}

export async function migrationStatus(pool: Pool): Promise<MigrationStatus> {
  const expectedFiles = (await readdir(path.resolve("db/migrations")))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const result = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations ORDER BY filename");
  const applied = new Set(result.rows.map((row) => row.filename));
  const pending = expectedFiles.filter((file) => !applied.has(file));
  return { current: pending.length === 0, applied: applied.size, expected: expectedFiles.length, pending, latest: expectedFiles.at(-1) ?? null };
}

export async function assertMigrationsCurrent(pool: Pool): Promise<void> {
  const status = await migrationStatus(pool);
  if (!status.current) throw new Error(`Database migrations are pending: ${status.pending.join(", ")}`);
}

/** Applies every pending db/migrations/*.sql in filename order, each in its own transaction. */
export async function applyMigrations(pool: Pool, log: (message: string) => void = console.log): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const migrationDir = path.resolve("db/migrations");
  const files = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();
  const appliedNow: string[] = [];
  for (const filename of files) {
    const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [filename]);
    if (applied.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(await readFile(path.join(migrationDir, filename), "utf8"));
      await client.query("INSERT INTO schema_migrations(filename) VALUES ($1)", [filename]);
      await client.query("COMMIT");
      appliedNow.push(filename);
      log(`Applied ${filename}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return appliedNow;
}
