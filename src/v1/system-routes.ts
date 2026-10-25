import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { isoTime, isoTimeOrNull } from "./serialize.js";
import type { V1Options } from "./index.js";

/** The worker writes a heartbeat every loop; older than this and the market data may be stale. */
export const WORKER_STALE_AFTER_MS = 30_000;

export async function registerSystemRoutes(v1: FastifyInstance, options: V1Options): Promise<void> {
  v1.get("/health", { config: { public: true } }, async () => {
    const now = new Date();
    const heartbeat = await pool.query<{ updated_at: Date }>("SELECT updated_at FROM system_state WHERE key='worker_heartbeat'");
    const lastGoodUpdate = heartbeat.rows[0]?.updated_at ?? null;
    const workerFresh = lastGoodUpdate !== null && now.getTime() - lastGoodUpdate.getTime() < WORKER_STALE_AFTER_MS;
    const inMaintenance = options.maintenanceUntil !== undefined && options.maintenanceUntil > now;
    return {
      status: inMaintenance ? "MAINTENANCE" : workerFresh ? "OK" : "DEGRADED",
      serverTime: isoTime(now),
      minBuild: options.minAppBuild,
      lastGoodUpdate: isoTimeOrNull(lastGoodUpdate)
    };
  });
}
