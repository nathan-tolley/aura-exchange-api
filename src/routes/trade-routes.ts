import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { guard } from "../auth.js";
import { one, maybeOne, pool, withTransaction } from "../db.js";
import { accounts, accountBalance, postLedgerTransaction } from "../core/ledger.js";
import { marketAuraAdjustment, quoteTrade, reserveVersion } from "../core/market.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { portfolioTotals } from "../services/portfolio-service.js";
import { executeTrade, loadPosition, type PoolRow, type PositionRow } from "../services/trade-execution.js";
import type { TradeSide } from "../types.js";

const quoteInput = z.object({
  stockId: z.string().uuid(),
  side: z.enum(["BUY", "SELL", "SHORT", "COVER"]),
  quantity: z.coerce.number().positive().max(100_000)
});

async function validateOrder(
  client: PoolClient,
  userId: string,
  stockId: string,
  side: TradeSide,
  quote: ReturnType<typeof quoteTrade>,
  position: PositionRow,
  seasonId: string
): Promise<void> {
  const quantity = new Decimal(quote.quantity);
  const cash = await accountBalance(client, accounts.userCash(userId, seasonId));
  if (side === "BUY") {
    if (new Decimal(position.short_qty).gt(0)) throw conflict("Cover your short before buying long");
    if (cash.lt(quote.netAmount)) throw badRequest("Insufficient Aura Credits", "INSUFFICIENT_FUNDS");
  }
  if (side === "SELL" && new Decimal(position.long_qty).lt(quantity)) {
    throw badRequest("You do not own enough shares", "INSUFFICIENT_SHARES");
  }
  if (side === "SELL") {
    const reserved = await client.query<{ quantity: string }>(
      "SELECT COALESCE(SUM(quantity),0)::text AS quantity FROM limit_orders WHERE season_id=$1 AND user_id=$2 AND stock_id=$3 AND side='SELL' AND status='OPEN'",
      [seasonId,userId,stockId]
    );
    if (new Decimal(position.long_qty).minus(reserved.rows[0]?.quantity??0).lt(quantity)) {
      throw badRequest("Some of your shares are reserved by open sell limit orders", "SHARES_RESERVED");
    }
  }
  if (side === "SHORT") {
    if (new Decimal(position.long_qty).gt(0)) throw conflict("Sell your long position before shorting");
    const totals = await portfolioTotals(client, userId, seasonId);
    const notional = new Decimal(quote.grossAmount);
    const margin = notional.mul("0.50");
    if (cash.lt(margin)) throw badRequest("Insufficient collateral", "INSUFFICIENT_COLLATERAL");
    const stockExposure = new Decimal(position.short_qty).mul(quote.currentPrice).plus(notional);
    if (stockExposure.gt(totals.equity.mul("0.20"))) throw badRequest("Per-stock short cap is 20% of portfolio equity", "SHORT_CAP");
    if (totals.shortLiability.plus(notional).gt(totals.equity.mul("0.50"))) throw badRequest("Total short cap is 50% of portfolio equity", "SHORT_CAP");
  }
  if (side === "COVER") {
    if (new Decimal(position.short_qty).lt(quantity)) throw badRequest("Cover quantity exceeds your short", "INVALID_COVER");
    const ratio = quantity.div(position.short_qty);
    const available = new Decimal(position.short_proceeds).plus(position.short_collateral).mul(ratio);
    const deficit = new Decimal(quote.netAmount).minus(available);
    if (deficit.gt(0) && cash.lt(deficit)) throw badRequest("Insufficient cash to cover this short", "INSUFFICIENT_FUNDS");
  }
}

export async function registerTradeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/limit-orders", { preHandler: guard() }, async (request) => {
    const auth=request.auth!;
    const result=await pool.query(
      `SELECT o.id,o.stock_id,o.side,o.quantity::text,o.limit_price::text,o.status,o.created_at,o.filled_at,o.canceled_at,
              ps.display_name,ps.ticker::text
         FROM limit_orders o JOIN listings ps ON ps.id=o.stock_id
        WHERE o.user_id=$1 AND o.exchange_id=$2 ORDER BY (o.status='OPEN') DESC,o.created_at DESC LIMIT 50`,[auth.id,auth.exchangeId]);
    return {items:result.rows};
  });

  app.post("/api/limit-orders", { preHandler: guard({csrf:true}) }, async (request,reply) => {
    const input=z.object({stockId:z.string().uuid(),side:z.enum(["BUY","SELL"]),quantity:z.coerce.number().positive().max(100_000),limitPrice:z.coerce.number().positive()}).parse(request.body);
    const auth=request.auth!;if(auth.stockId===input.stockId)throw forbidden("You cannot trade your own Aura stock");
    const order=await withTransaction(async client=>{
      const market=await maybeOne<PoolRow>(client,`SELECT mp.* FROM market_pools mp JOIN seasons s ON s.id=mp.season_id JOIN listings ps ON ps.id=mp.stock_id WHERE mp.stock_id=$1 AND mp.exchange_id=$2 AND s.status='ACTIVE' AND ps.is_active=true FOR UPDATE OF mp`,[input.stockId,auth.exchangeId]);
      if(!market)throw notFound("Market not found");if(market.halted_until&&market.halted_until>new Date())throw conflict("This market is temporarily halted","MARKET_HALTED");
      quoteTrade({shareReserve:market.share_reserve,creditReserve:market.credit_reserve},input.side,input.quantity);
      const pos=await loadPosition(client,auth.id,input.stockId,market.season_id,true),id=randomUUID();
      let reservedCash=new Decimal(0);
      if(input.side==="BUY"){
        if(new Decimal(pos.short_qty).gt(0))throw conflict("Cover your short before placing a buy order");
        reservedCash=new Decimal(input.quantity).mul(input.limitPrice).mul("1.005").toDecimalPlaces(8);
        const cash=await accountBalance(client,accounts.userCash(auth.id,market.season_id));
        if(cash.lt(reservedCash))throw badRequest(`This limit order reserves ${reservedCash.toFixed(2)} AC, but you have ${cash.toFixed(2)} AC`,"INSUFFICIENT_FUNDS");
        await postLedgerTransaction(client,"LIMIT_RESERVE",`Reserve cash for buy limit ${id}`,[
          {accountKey:accounts.userCash(auth.id,market.season_id),amount:reservedCash.negated()},
          {accountKey:accounts.limitEscrow(id,market.season_id),amount:reservedCash}
        ],id);
      }else{
        const reserved=await client.query<{quantity:string}>("SELECT COALESCE(SUM(quantity),0)::text AS quantity FROM limit_orders WHERE season_id=$1 AND user_id=$2 AND stock_id=$3 AND side='SELL' AND status='OPEN'",[market.season_id,auth.id,input.stockId]);
        const available=new Decimal(pos.long_qty).minus(reserved.rows[0]?.quantity??0);
        if(available.lt(input.quantity))throw badRequest(`Only ${available.toFixed(4)} unreserved shares are available to sell`,"INSUFFICIENT_SHARES");
      }
      return one(client,"INSERT INTO limit_orders(id,season_id,user_id,stock_id,side,quantity,limit_price,reserved_cash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[id,market.season_id,auth.id,input.stockId,input.side,input.quantity,input.limitPrice,reservedCash.toFixed(8)]);
    });
    reply.code(201);return order;
  });

  app.post("/api/limit-orders/:id/cancel",{preHandler:guard({csrf:true})},async(request)=>{
    const params=z.object({id:z.string().uuid()}).parse(request.params),auth=request.auth!;
    await withTransaction(async client=>{
      const order=await maybeOne<{id:string;season_id:string;user_id:string;side:string;reserved_cash:string;status:string}>(client,"SELECT * FROM limit_orders WHERE id=$1 AND user_id=$2 AND exchange_id=$3 FOR UPDATE",[params.id,auth.id,auth.exchangeId]);
      if(!order)throw notFound("Limit order not found");if(order.status!=="OPEN")throw conflict("Only open orders can be canceled");
      if(order.side==="BUY"&&new Decimal(order.reserved_cash).gt(0))await postLedgerTransaction(client,"LIMIT_CANCEL",`Refund canceled buy limit ${order.id}`,[
        {accountKey:accounts.limitEscrow(order.id,order.season_id),amount:new Decimal(order.reserved_cash).negated()},
        {accountKey:accounts.userCash(auth.id,order.season_id),amount:order.reserved_cash}
      ],order.id);
      await client.query("UPDATE limit_orders SET status='CANCELED',canceled_at=now(),updated_at=now() WHERE id=$1",[order.id]);
    });return {ok:true};
  });

  app.post("/api/trades/preview", { preHandler: guard({ csrf: true }) }, async (request) => {
    const input = quoteInput.parse(request.body);
    const auth = request.auth!;
    if (auth.stockId === input.stockId) throw forbidden("You cannot trade your own Aura stock");
    return withTransaction(async (client) => {
      const pool = await maybeOne<PoolRow>(client,
        `SELECT mp.* FROM market_pools mp JOIN seasons s ON s.id=mp.season_id
          JOIN listings ps ON ps.id=mp.stock_id
         WHERE mp.stock_id=$1 AND mp.exchange_id=$2 AND s.status='ACTIVE' AND ps.is_active=true`, [input.stockId, auth.exchangeId]);
      if (!pool) throw notFound("Market not found");
      const position = await loadPosition(client, auth.id, input.stockId, pool.season_id);
      const quote = quoteTrade({ shareReserve: pool.share_reserve, creditReserve: pool.credit_reserve }, input.side, input.quantity);
      const cash = await accountBalance(client, accounts.userCash(auth.id, pool.season_id));
      let canExecute = true, reason: string | null = null;
      try { await validateOrder(client, auth.id, input.stockId, input.side, quote, position, pool.season_id); }
      catch (error) { canExecute = false; reason = error instanceof Error ? error.message : "Order is not available"; }
      const qty = new Decimal(quote.quantity), gross = new Decimal(quote.grossAmount), net = new Decimal(quote.netAmount);
      const longBefore = new Decimal(position.long_qty), shortBefore = new Decimal(position.short_qty);
      let cashChange = new Decimal(0), collateralRequired = new Decimal(0), escrowChange = new Decimal(0);
      if (input.side === "BUY") cashChange = net.negated();
      else if (input.side === "SELL") cashChange = net;
      else if (input.side === "SHORT") {
        collateralRequired = gross.mul("0.50"); cashChange = collateralRequired.negated(); escrowChange = net.plus(collateralRequired);
      } else if (shortBefore.gt(0) && qty.lte(shortBefore)) {
        const ratio = qty.div(shortBefore);
        const available = new Decimal(position.short_proceeds).plus(position.short_collateral).mul(ratio);
        cashChange = available.minus(net); escrowChange = available.negated();
      }
      return {
        ...quote, canExecute, reason, availableCash: cash.toFixed(8), cashChange: cashChange.toFixed(8),
        projectedCash: cash.plus(cashChange).toFixed(8), collateralRequired: collateralRequired.toFixed(8),
        escrowChange: escrowChange.toFixed(8), longBefore: longBefore.toFixed(8), shortBefore: shortBefore.toFixed(8),
        longAfter: (input.side === "BUY" ? longBefore.plus(qty) : input.side === "SELL" ? longBefore.minus(qty) : longBefore).toFixed(8),
        shortAfter: (input.side === "SHORT" ? shortBefore.plus(qty) : input.side === "COVER" ? shortBefore.minus(qty) : shortBefore).toFixed(8),
        auraImpact: marketAuraAdjustment(input.side, quote.grossAmount).toFixed(2)
      };
    });
  });

  app.post("/api/trades/quote", { preHandler: guard({ csrf: true }) }, async (request, reply) => {
    const input = quoteInput.parse(request.body);
    const auth = request.auth!;
    if (auth.stockId === input.stockId) throw forbidden("You cannot trade your own Aura stock");

    const saved = await withTransaction(async (client) => {
      const pool = await maybeOne<PoolRow>(client,
        `SELECT mp.* FROM market_pools mp JOIN seasons s ON s.id = mp.season_id
          JOIN listings ps ON ps.id = mp.stock_id
         WHERE mp.stock_id = $1 AND mp.exchange_id = $2 AND s.status = 'ACTIVE' AND ps.is_active = true`, [input.stockId, auth.exchangeId]
      );
      if (!pool) throw notFound("Market not found");
      if (pool.halted_until && pool.halted_until > new Date()) throw conflict("This market is temporarily halted", "MARKET_HALTED");
      const position = await loadPosition(client, auth.id, input.stockId, pool.season_id);
      const quote = quoteTrade({ shareReserve: pool.share_reserve, creditReserve: pool.credit_reserve }, input.side, input.quantity);
      await validateOrder(client, auth.id, input.stockId, input.side, quote, position, pool.season_id);
      const id = randomUUID();
      await client.query(
        `INSERT INTO trade_quotes(id, season_id, user_id, stock_id, side, quantity, gross_amount, fee_amount,
          net_amount, execution_price, price_impact, reserve_version, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now() + interval '15 seconds')`,
        [id, pool.season_id, auth.id, input.stockId, input.side, quote.quantity, quote.grossAmount,
          quote.feeAmount, quote.netAmount, quote.executionPrice, quote.priceImpact, quote.reserveVersion]
      );
      return { id, expiresInSeconds: 15, ...quote };
    });
    reply.code(201);
    return saved;
  });

  app.post("/api/trades/execute", { preHandler: guard({ csrf: true }) }, async (request, reply) => {
    const input = z.object({ quoteId: z.string().uuid(), idempotencyKey: z.string().min(8).max(100) }).parse(request.body);
    const auth = request.auth!;
    const executed = await withTransaction(async (client) => {
      const duplicate = await maybeOne<{ id: string }>(client,
        "SELECT id FROM trades WHERE user_id = $1 AND idempotency_key = $2", [auth.id, input.idempotencyKey]
      );
      if (duplicate) return { tradeId: duplicate.id, duplicate: true };

      const quote = await maybeOne<{
        id: string; season_id: string; user_id: string; stock_id: string; side: TradeSide; quantity: string;
        gross_amount: string; fee_amount: string; net_amount: string; execution_price: string;
        reserve_version: string; expires_at: Date; consumed_at: Date | null;
      }>(client, "SELECT * FROM trade_quotes WHERE id = $1 AND exchange_id = $2 FOR UPDATE", [input.quoteId, auth.exchangeId]);
      if (!quote || quote.user_id !== auth.id) throw notFound("Quote not found");
      if (quote.consumed_at) throw conflict("Quote has already been used", "QUOTE_USED");
      if (quote.expires_at < new Date()) throw conflict("Quote expired; request a new one", "QUOTE_EXPIRED");

      const market = await one<PoolRow>(client, "SELECT * FROM market_pools WHERE season_id = $1 AND stock_id = $2 FOR UPDATE", [quote.season_id, quote.stock_id]);
      if (market.halted_until && market.halted_until > new Date()) throw conflict("This market is temporarily halted", "MARKET_HALTED");
      if (reserveVersion({ shareReserve: market.share_reserve, creditReserve: market.credit_reserve }) !== quote.reserve_version) {
        throw conflict("Market moved; request a fresh quote", "STALE_QUOTE");
      }
      const calculated = quoteTrade({ shareReserve: market.share_reserve, creditReserve: market.credit_reserve }, quote.side, quote.quantity);
      const position = await loadPosition(client, auth.id, quote.stock_id, quote.season_id, true);
      await validateOrder(client, auth.id, quote.stock_id, quote.side, calculated, position, quote.season_id);

      const { tradeId, auraImpact } = await executeTrade(client, {
        userId: auth.id, quoteId: quote.id, seasonId: quote.season_id, stockId: quote.stock_id, side: quote.side,
        idempotencyKey: input.idempotencyKey, market, position, calculated, auraCoupling: true
      });
      return {
        tradeId,
        duplicate: false,
        side: quote.side,
        quantity: calculated.quantity,
        executionPrice: calculated.executionPrice,
        auraImpact: auraImpact.toNumber()
      };
    });
    reply.code(executed.duplicate ? 200 : 201);
    return executed;
  });

  app.post("/api/positions/:id/close", { preHandler: guard({ csrf: true }) }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const auth = request.auth!;
    return withTransaction(async (client) => {
      const position = await maybeOne<PositionRow & { stock_id: string; season_id: string }>(client,
        "SELECT * FROM positions WHERE id=$1 AND user_id=$2 AND exchange_id=$3", [params.id, auth.id, auth.exchangeId]
      );
      if (!position) throw notFound("Position not found");
      const side: TradeSide = new Decimal(position.long_qty).gt(0) ? "SELL" : "COVER";
      const quantity = side === "SELL" ? position.long_qty : position.short_qty;
      if (new Decimal(quantity).lte(0)) throw badRequest("Position is already closed");
      const market = await one<PoolRow>(client, "SELECT * FROM market_pools WHERE season_id=$1 AND stock_id=$2", [position.season_id, position.stock_id]);
      const calculated = quoteTrade({ shareReserve: market.share_reserve, creditReserve: market.credit_reserve }, side, quantity);
      await validateOrder(client, auth.id, position.stock_id, side, calculated, position, position.season_id);
      const id = randomUUID();
      await client.query(
        `INSERT INTO trade_quotes(id, season_id, user_id, stock_id, side, quantity, gross_amount, fee_amount,
          net_amount, execution_price, price_impact, reserve_version, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now() + interval '15 seconds')`,
        [id, position.season_id, auth.id, position.stock_id, side, calculated.quantity, calculated.grossAmount,
          calculated.feeAmount, calculated.netAmount, calculated.executionPrice, calculated.priceImpact, calculated.reserveVersion]
      );
      return { quoteId: id, expiresInSeconds: 15, ...calculated };
    });
  });
}

