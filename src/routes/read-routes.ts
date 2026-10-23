import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Decimal } from "decimal.js";
import { guard } from "../auth.js";
import { pool, withTransaction } from "../db.js";
import { accounts, accountBalance } from "../core/ledger.js";
import { auraComposite, marketIndex } from "../core/market.js";
import { portfolioTotals } from "../services/portfolio-service.js";
import { serializeFeedEvent, type FeedRow } from "../services/feed-service.js";
import { replayPriceHistory, type HistoricalTrade } from "../core/price-history.js";
import { notFound } from "../errors.js";

export async function registerReadRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async () => {
    await pool.query("SELECT 1");
    return { status: "ok" };
  });

  app.get("/api/market", { preHandler: guard() }, async () => {
    const result = await pool.query<{
      id: string; display_name: string; ticker: string; avatar_path:string|null; seasonal_aura: string; career_aura: string;
      price: string; opening_price: string; day_open_price: string; halted_until: Date | null;
    }>(
      `SELECT ps.id, ps.display_name, ps.ticker::text, ps.avatar_path, ps.seasonal_aura, ps.career_aura,
              (mp.credit_reserve/mp.share_reserve)::text AS price, mp.opening_price::text,
              mp.day_open_price::text, mp.halted_until
         FROM person_stocks ps JOIN market_pools mp ON mp.stock_id=ps.id
         JOIN seasons s ON s.id=mp.season_id AND s.status='ACTIVE'
        WHERE ps.is_active=true ORDER BY ps.ticker`
    );
    const stocks = result.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      ticker: row.ticker,
      avatarPath: row.avatar_path,
      aura: Number(row.seasonal_aura),
      careerAura: Number(row.career_aura),
      price: Number(row.price),
      dayChangePct: new Decimal(row.price).div(row.day_open_price).minus(1).mul(100).toNumber(),
      seasonChangePct: new Decimal(row.price).div(row.opening_price).minus(1).mul(100).toNumber(),
      haltedUntil: row.halted_until
    }));
    return {
      stocks,
      auraComposite: auraComposite(result.rows.map((row) => Number(row.seasonal_aura) - 100)),
      marketIndex: marketIndex(result.rows.map((row) => new Decimal(row.price).div(row.opening_price)))
    };
  });

  app.get("/api/portfolio", { preHandler: guard() }, async (request) => {
    const auth = request.auth!;
    return withTransaction(async (client) => {
      const seasonResult = await client.query<{ id: string }>("SELECT id FROM seasons WHERE status='ACTIVE'");
      const seasonId = seasonResult.rows[0]?.id;
      if (!seasonId) return { cash: 0, equity: 0, positions: [] };
      const totals = await portfolioTotals(client, auth.id, seasonId);
      const positions = await client.query<{
        id: string; stock_id: string; ticker: string; display_name: string; long_qty: string; avg_long_cost: string;
        short_qty: string; avg_short_entry: string; short_proceeds: string; short_collateral: string;
        realized_pnl: string; price: string;
      }>(
        `SELECT p.id, p.stock_id, ps.ticker::text, ps.display_name, p.long_qty::text, p.avg_long_cost::text,
                p.short_qty::text, p.avg_short_entry::text, p.short_proceeds::text, p.short_collateral::text,
                p.realized_pnl::text, (mp.credit_reserve/mp.share_reserve)::text AS price
           FROM positions p JOIN person_stocks ps ON ps.id=p.stock_id
           JOIN market_pools mp ON mp.stock_id=p.stock_id AND mp.season_id=p.season_id
          WHERE p.user_id=$1 AND p.season_id=$2 AND (p.long_qty>0 OR p.short_qty>0)
          ORDER BY ps.ticker`, [auth.id, seasonId]
      );
      return {
        cash: totals.cash.toNumber(),
        equity: totals.equity.toNumber(),
        longValue: totals.longValue.toNumber(),
        shortLiability: totals.shortLiability.toNumber(),
        positions: positions.rows.map((row) => {
          const price = new Decimal(row.price);
          const longQty = new Decimal(row.long_qty);
          const shortQty = new Decimal(row.short_qty);
          const unrealized = longQty.gt(0)
            ? price.minus(row.avg_long_cost).mul(longQty)
            : new Decimal(row.avg_short_entry).minus(price).mul(shortQty);
          return {
            id: row.id, stockId: row.stock_id, ticker: row.ticker, displayName: row.display_name,
            longQty: Number(row.long_qty), shortQty: Number(row.short_qty), price: Number(row.price),
            averageEntry: Number(longQty.gt(0) ? row.avg_long_cost : row.avg_short_entry),
            unrealizedPnl: unrealized.toNumber(), realizedPnl: Number(row.realized_pnl)
          };
        })
      };
    });
  });

  app.get("/api/feed", { preHandler: guard() }, async (request) => {
    const auth = request.auth!;
    const result = await pool.query<FeedRow>(
      `SELECT f.*, actor_stock.display_name AS actor_name, actor_stock.ticker::text AS actor_ticker,
              subject.display_name AS subject_name, subject.ticker::text AS subject_ticker,
              COALESCE(v.upvotes,0)::int AS upvotes, COALESCE(v.downvotes,0)::int AS downvotes,
              COALESCE(v.vote_score,0)::int AS vote_score, COALESCE(v.viewer_vote,0)::int AS viewer_vote
         FROM feed_events f
         LEFT JOIN person_stocks actor_stock ON actor_stock.owner_user_id=f.actor_id
         LEFT JOIN person_stocks subject ON subject.id=f.subject_stock_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE direction=1) AS upvotes,
                  COUNT(*) FILTER (WHERE direction=-1) AS downvotes,
                  COALESCE(SUM(direction),0) AS vote_score,
                  COALESCE(MAX(direction) FILTER (WHERE voter_id=$1),0) AS viewer_vote
             FROM aura_votes WHERE feed_event_id=f.id
         ) v ON true
        WHERE f.hidden_at IS NULL ORDER BY f.created_at DESC LIMIT 100`
      , [auth.id]
    );
    return { items: result.rows.map((row) => serializeFeedEvent(row, { role: auth.role, stockId: auth.stockId })) };
  });

  app.get("/api/stocks/:id/history", { preHandler: guard() }, async (request) => {
    const auth = request.auth!;
    const stockId = String((request.params as { id?: string }).id ?? "");
    const stockResult = await pool.query<{
      id: string; display_name: string; ticker: string; starts_at: Date; opening_price: string;
      current_price: string; seasonal_aura: string;
    }>(
      `SELECT ps.id, ps.display_name, ps.ticker::text, ps.seasonal_aura,
              s.starts_at, mp.opening_price::text,
              (mp.credit_reserve/mp.share_reserve)::text AS current_price
         FROM person_stocks ps
         JOIN market_pools mp ON mp.stock_id=ps.id
         JOIN seasons s ON s.id=mp.season_id AND s.status='ACTIVE'
        WHERE ps.id=$1 AND ps.is_active=true`, [stockId]
    );
    const stock = stockResult.rows[0];
    if (!stock) throw notFound("That stock is not active");

    const tradesResult = await pool.query<{
      id: string; side: HistoricalTrade["side"]; quantity: string; gross_amount: string; created_at: Date; actor_name: string;
    }>(
      `SELECT t.id, t.side, t.quantity::text, t.gross_amount::text, t.created_at,
              COALESCE(actor.display_name,u.username::text,'System') AS actor_name
         FROM trades t
         JOIN seasons s ON s.id=t.season_id AND s.status='ACTIVE'
         LEFT JOIN users u ON u.id=t.user_id
         LEFT JOIN person_stocks actor ON actor.owner_user_id=t.user_id
        WHERE t.stock_id=$1 ORDER BY t.created_at, t.id`, [stockId]
    );
    const points = replayPriceHistory(stock.starts_at, tradesResult.rows.map((trade) => ({
      id: trade.id,
      side: trade.side,
      quantity: trade.quantity,
      grossAmount: trade.gross_amount,
      createdAt: trade.created_at,
      actorName: trade.actor_name
    })));
    const currentPrice = Number(stock.current_price);
    const last = points.at(-1)!;
    if (Math.abs(last.price - currentPrice) > 0.0001) {
      points.push({ timestamp: new Date().toISOString(), price: currentPrice, cause: { type: "CURRENT" } });
    }
    const prices = points.map((point) => point.price);
    const ticksResult = await pool.query<{
      timestamp: Date; price: string; cause: "OPEN" | "TRADE" | "AMBIENT"; reference_id: string | null; is_synthetic: boolean; feed_event_id: string | null;
    }>(
      `SELECT history.timestamp,history.price,history.cause,history.reference_id,history.is_synthetic,history.feed_event_id
         FROM (
           SELECT t.created_at AS timestamp,t.price::text,t.cause,t.reference_id,t.is_synthetic,f.id AS feed_event_id,t.id AS row_id
             FROM market_price_ticks t
             LEFT JOIN feed_events f ON f.subject_stock_id=t.stock_id
              AND f.kind IN ('TRADE','LIQUIDATION') AND f.payload->>'tradeId'=t.reference_id::text
            WHERE t.season_id=(SELECT id FROM seasons WHERE status='ACTIVE') AND t.stock_id=$1
           UNION ALL
           SELECT tr.created_at,tr.execution_price::text,'TRADE',tr.id,false,f.id,tr.id
             FROM trades tr
             LEFT JOIN feed_events f ON f.subject_stock_id=tr.stock_id
              AND f.kind IN ('TRADE','LIQUIDATION') AND f.payload->>'tradeId'=tr.id::text
            WHERE tr.season_id=(SELECT id FROM seasons WHERE status='ACTIVE') AND tr.stock_id=$1
              AND NOT EXISTS (SELECT 1 FROM market_price_ticks tick WHERE tick.reference_id=tr.id)
         ) history
        ORDER BY history.timestamp,history.row_id`, [stockId]
    );
    const ticks = ticksResult.rows.map((tick) => ({
      timestamp: tick.timestamp.toISOString(),
      price: Number(tick.price),
      cause: tick.cause,
      referenceId: tick.reference_id,
      feedEventId: tick.feed_event_id,
      synthetic: tick.is_synthetic
    }));
    if (!ticks.length || Math.abs(ticks.at(-1)!.price - currentPrice) > 0.0001) {
      ticks.push({ timestamp: new Date().toISOString(), price: currentPrice, cause: "AMBIENT", referenceId: null, feedEventId: null, synthetic: true });
    }

    const auraResult = await pool.query<FeedRow>(
      `SELECT f.*, actor_stock.display_name AS actor_name, actor_stock.ticker::text AS actor_ticker,
              subject.display_name AS subject_name, subject.ticker::text AS subject_ticker,
              COALESCE(v.upvotes,0)::int AS upvotes, COALESCE(v.downvotes,0)::int AS downvotes,
              COALESCE(v.vote_score,0)::int AS vote_score, COALESCE(v.viewer_vote,0)::int AS viewer_vote
         FROM feed_events f
         LEFT JOIN person_stocks actor_stock ON actor_stock.owner_user_id=f.actor_id
         LEFT JOIN person_stocks subject ON subject.id=f.subject_stock_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE direction=1) AS upvotes,
                  COUNT(*) FILTER (WHERE direction=-1) AS downvotes,
                  COALESCE(SUM(direction),0) AS vote_score,
                  COALESCE(MAX(direction) FILTER (WHERE voter_id=$2),0) AS viewer_vote
             FROM aura_votes WHERE feed_event_id=f.id
         ) v ON true
        WHERE f.subject_stock_id=$1 AND f.kind='AURA_RULING' AND f.hidden_at IS NULL
        ORDER BY f.created_at DESC LIMIT 20`, [stockId, auth.id]
    );

    return {
      stock: { id: stock.id, displayName: stock.display_name, ticker: stock.ticker, aura: Number(stock.seasonal_aura) },
      summary: {
        opening: Number(stock.opening_price),
        current: currentPrice,
        high: Math.max(...prices),
        low: Math.min(...prices)
      },
      points,
      ticks,
      auraEvents: auraResult.rows.map((row) => serializeFeedEvent(row, { role: auth.role, stockId: auth.stockId }))
    };
  });

  app.get("/api/leaderboards", { preHandler: guard() }, async () => {
    const aura = await pool.query(
      `SELECT id, display_name, ticker::text, seasonal_aura, career_aura
         FROM person_stocks WHERE is_active=true ORDER BY seasonal_aura DESC, display_name LIMIT 25`
    );
    const wealth = await pool.query(
      `WITH active AS (SELECT id FROM seasons WHERE status='ACTIVE'), balances AS (
         SELECT split_part(account_key, ':', 2)::uuid AS user_id, SUM(amount) AS cash
           FROM cash_ledger_entries, active
          WHERE account_key LIKE 'USER:%:CASH:' || active.id::text GROUP BY 1
       ), exposure AS (
         SELECT p.user_id,SUM(p.long_qty*(mp.credit_reserve/mp.share_reserve)
                +p.short_proceeds+p.short_collateral-p.short_qty*(mp.credit_reserve/mp.share_reserve)) AS marked_value
           FROM positions p JOIN active a ON a.id=p.season_id
           JOIN market_pools mp ON mp.season_id=p.season_id AND mp.stock_id=p.stock_id GROUP BY p.user_id
       )
       SELECT u.id,ps.display_name,ps.ticker::text,
              (COALESCE(b.cash,0)+COALESCE(e.marked_value,0))::text AS net_worth
         FROM users u JOIN person_stocks ps ON ps.owner_user_id=u.id
         LEFT JOIN balances b ON b.user_id=u.id LEFT JOIN exposure e ON e.user_id=u.id
        WHERE ps.is_active=true ORDER BY COALESCE(b.cash,0)+COALESCE(e.marked_value,0) DESC LIMIT 25`
    );
    return { aura: aura.rows, wealth: wealth.rows };
  });

  app.get("/api/health", { preHandler: guard({ roles: ["OWNER", "MODERATOR"] }) }, async () => {
    const dbStarted = performance.now();
    await pool.query("SELECT 1");
    const worker = await pool.query<{ updated_at: Date }>("SELECT updated_at FROM system_state WHERE key='worker_heartbeat'");
    let newestBackup: Date | null = null;
    try {
      const dir = path.resolve("backups");
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".dump")) continue;
        const info = await stat(path.join(dir, file));
        if (!newestBackup || info.mtime > newestBackup) newestBackup = info.mtime;
      }
    } catch { /* backup folder can be unavailable in development */ }
    return {
      database: { ok: true, latencyMs: Math.round(performance.now() - dbStarted) },
      worker: { ok: Boolean(worker.rows[0] && Date.now() - worker.rows[0].updated_at.getTime() < 30_000), lastSeenAt: worker.rows[0]?.updated_at ?? null },
      ai: { configured: Boolean(process.env.OPENAI_API_KEY) || process.env.AI_PROVIDER === "fake", provider: process.env.AI_PROVIDER ?? "fake" },
      backup: { latestAt: newestBackup, stale: !newestBackup || Date.now() - newestBackup.getTime() > 36 * 60 * 60 * 1000 }
    };
  });
}

