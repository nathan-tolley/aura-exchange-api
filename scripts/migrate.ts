import pg from "pg";
import { applyMigrations } from "../src/services/migration-service.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString });
try {
  await applyMigrations(pool);
} finally {
  await pool.end();
}
