import { readdir } from "node:fs/promises";
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
