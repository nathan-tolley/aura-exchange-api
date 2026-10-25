import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DEFAULT_HOURS, isValidTime, isValidTimeZone, validateHours } from "../core/market-hours.js";
import { pool, withTransaction } from "../db.js";
import { appError } from "../errors.js";
import { createExchange, EXCHANGE_COLUMNS, type ExchangeRow, loadExchange } from "../services/exchange-service.js";
import { membershipGuard } from "./membership.js";
import { exchangeView } from "./views.js";

const time = z.string().refine(isValidTime, "HH:MM");
const exchangeCreate = z.object({
  name: z.string().trim().min(2).max(40),
  timezone: z.string().refine(isValidTimeZone, "IANA timezone"),
  hours: z.object({ preOpen: time, open: time, close: time, afterClose: time }).refine(validateHours, "pre-open → open → close → after-close").optional()
});

export async function registerExchangeRoutes(v1: FastifyInstance): Promise<void> {
  v1.post("/exchanges", async (request, reply) => {
    const input = exchangeCreate.parse(request.body);
    const userId = request.v1User!.id;
    const exchangeId = await withTransaction((client) => createExchange(client, {
      name: input.name, timezone: input.timezone, hours: input.hours ?? DEFAULT_HOURS, createdBy: userId
    }));
    reply.code(201);
    return exchangeView(pool, (await loadExchange(pool, exchangeId))!, userId);
  });

  v1.get("/exchanges", async (request) => {
    const userId = request.v1User!.id;
    const exchanges = await pool.query<ExchangeRow>(
      `SELECT ${EXCHANGE_COLUMNS.split(",").map((column) => `e.${column}`).join(",")}
         FROM exchanges e JOIN memberships m ON m.exchange_id=e.id AND m.user_id=$1
        ORDER BY m.joined_at,e.id`,
      [userId]
    );
    return { items: await Promise.all(exchanges.rows.map((exchange) => exchangeView(pool, exchange, userId))) };
  });

  v1.get("/exchanges/:exchangeId", { preHandler: membershipGuard() }, async (request) => {
    const exchange = await loadExchange(pool, request.membership!.exchangeId);
    if (!exchange) throw appError("NOT_FOUND", { resource: "exchange" });
    return exchangeView(pool, exchange, request.v1User!.id);
  });
}
