import pg from "pg";
import { applyMigrations } from "../src/services/migration-service.js";

/** Drops and recreates the test database, then applies every migration. */
export default async function setup(): Promise<void> {
  const testUrl = new URL(process.env.TEST_DATABASE_URL ?? "postgres://aura:aura_dev_password@localhost:5433/aura_test");
  const databaseName = decodeURIComponent(testUrl.pathname.slice(1));
  if (!/^[a-z0-9_]+_test$/.test(databaseName)) {
    throw new Error(`Refusing to reset "${databaseName}": the test database name must end in _test`);
  }

  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
  try {
    await admin.query("SELECT 1");
  } catch (error) {
    await admin.end();
    throw new Error(
      `The test database at ${testUrl.host} is unreachable (${(error as Error).message}). ` +
      "Start it with: docker compose -f compose.dev.yaml up -d"
    );
  }
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${databaseName}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: testUrl.toString(), max: 1 });
  try {
    await applyMigrations(pool, () => undefined);
  } finally {
    await pool.end();
  }
}
