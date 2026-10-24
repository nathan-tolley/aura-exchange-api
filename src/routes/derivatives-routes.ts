import {randomUUID} from "node:crypto";
import {Decimal} from "decimal.js";
import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {guard} from "../auth.js";
import {impliedProbability,optionPremium,strikeSet} from "../core/derivatives.js";
import {accountBalance,accounts,postLedgerTransaction} from "../core/ledger.js";
import {maybeOne,one,pool,withTransaction} from "../db.js";
import {badRequest,conflict,forbidden,notFound} from "../errors.js";
import {resolvePrediction} from "../services/derivatives-service.js";

export async function registerDerivativesRoutes(app:FastifyInstance):Promise<void>{
  app.get("/api/predictions",{preHandler:guard()},async request=>{
    const result=await pool.query(
      `SELECT m.id,m.question,m.description,m.status,m.closes_at,m.outcome,m.created_at,
              COALESCE(SUM(b.amount) FILTER(WHERE b.side='YES'),0)::text AS yes_pool,
              COALESCE(SUM(b.amount) FILTER(WHERE b.side='NO'),0)::text AS no_pool,
              COALESCE(SUM(b.amount) FILTER(WHERE b.user_id=$1 AND b.side='YES'),0)::text AS user_yes,
              COALESCE(SUM(b.amount) FILTER(WHERE b.user_id=$1 AND b.side='NO'),0)::text AS user_no,
              COALESCE(SUM(b.payout) FILTER(WHERE b.user_id=$1),0)::text AS user_payout
         FROM prediction_markets m LEFT JOIN prediction_bets b ON b.market_id=m.id
        GROUP BY m.id ORDER BY (m.status='OPEN') DESC,m.closes_at,m.created_at DESC LIMIT 50`,[request.auth!.id]);
    return {items:result.rows.map(row=>({...row,yes_probability:impliedProbability(row.yes_pool,row.no_pool)}))};
  });

  app.post("/api/predictions",{preHandler:guard({roles:["OWNER","MODERATOR"],csrf:true})},async(request,reply)=>{
    const input=z.object({question:z.string().trim().min(10).max(180),description:z.string().trim().max(500).default(""),closesAt:z.coerce.date().refine(date=>date.getTime()>Date.now()+5*60_000,"Close time must be at least five minutes away")}).parse(request.body);
    const season=await one<{id:string}>(pool,"SELECT id FROM seasons WHERE status='ACTIVE'");
    const row=await one(pool,"INSERT INTO prediction_markets(season_id,creator_id,question,description,closes_at) VALUES($1,$2,$3,$4,$5) RETURNING *",[season.id,request.auth!.id,input.question,input.description,input.closesAt]);
    await pool.query("INSERT INTO audit_logs(actor_id,action,entity_type,entity_id) VALUES($1,'PREDICTION_CREATED','PREDICTION_MARKET',$2)",[request.auth!.id,(row as {id:string}).id]);
    reply.code(201);return row;
  });

  app.post("/api/predictions/:id/bet",{preHandler:guard({csrf:true})},async request=>{
    const id=z.string().uuid().parse((request.params as {id:string}).id),input=z.object({side:z.enum(["YES","NO"]),amount:z.coerce.number().min(10).max(1000)}).parse(request.body),auth=request.auth!;
    return withTransaction(async client=>{
      const market=await maybeOne<{id:string;season_id:string;status:string;closes_at:Date}>(client,"SELECT id,season_id,status,closes_at FROM prediction_markets WHERE id=$1 FOR UPDATE",[id]);
      if(!market)throw notFound("Prediction market not found");if(market.status!=="OPEN"||market.closes_at<=new Date())throw conflict("Betting is closed");
      const existing=await one<{total:string}>(client,"SELECT COALESCE(SUM(amount),0)::text AS total FROM prediction_bets WHERE market_id=$1 AND user_id=$2",[id,auth.id]);
      if(new Decimal(existing.total).plus(input.amount).gt(2000))throw badRequest("Maximum exposure is 2,000 AC per prediction","PREDICTION_CAP");
      const cash=await accountBalance(client,accounts.userCash(auth.id,market.season_id));if(cash.lt(input.amount))throw badRequest("Insufficient Aura Credits","INSUFFICIENT_FUNDS");
      const bet=await one(client,"INSERT INTO prediction_bets(market_id,user_id,side,amount) VALUES($1,$2,$3,$4) RETURNING *",[id,auth.id,input.side,input.amount]);
      await postLedgerTransaction(client,"PREDICTION_BET",`Prediction stake: ${input.side}`,[{accountKey:accounts.userCash(auth.id,market.season_id),amount:-input.amount},{accountKey:accounts.predictionEscrow(id,market.season_id),amount:input.amount}],(bet as {id:string}).id);
      return bet;
    });
  });

  app.post("/api/predictions/:id/resolve",{preHandler:guard({roles:["OWNER","MODERATOR"],csrf:true})},async request=>{
    const id=z.string().uuid().parse((request.params as {id:string}).id),input=z.object({outcome:z.enum(["YES","NO","CANCEL"])}).parse(request.body);
    try{await resolvePrediction(id,input.outcome,request.auth!.id)}catch(error){throw conflict(error instanceof Error?error.message:"Could not resolve prediction")};return {ok:true};
  });

  app.get("/api/options",{preHandler:guard()},async request=>{
    const markets=await pool.query<{id:string;display_name:string;ticker:string;price:string}>(`SELECT ps.id,ps.display_name,ps.ticker::text,(mp.credit_reserve/mp.share_reserve)::text AS price FROM person_stocks ps JOIN market_pools mp ON mp.stock_id=ps.id JOIN seasons s ON s.id=mp.season_id AND s.status='ACTIVE' WHERE ps.is_active=true ORDER BY ps.ticker`);
    const positions=await pool.query(`SELECT o.id,o.stock_id,ps.ticker::text,ps.display_name,o.option_type,o.strike::text,o.quantity::text,o.premium_paid::text,o.expires_at,o.status,o.settlement_price::text,o.payout::text FROM aura_options o JOIN person_stocks ps ON ps.id=o.stock_id WHERE o.user_id=$1 ORDER BY (o.status='OPEN') DESC,o.created_at DESC LIMIT 50`,[request.auth!.id]);
    return {stocks:markets.rows.map(row=>({...row,strikes:strikeSet(row.price)})),positions:positions.rows};
  });

  app.post("/api/options/quote",{preHandler:guard({csrf:true})},async request=>{
    const input=z.object({stockId:z.string().uuid(),optionType:z.enum(["CALL","PUT"]),strike:z.coerce.number().positive(),quantity:z.coerce.number().positive().max(100),duration:z.enum(["ONE_DAY","ONE_WEEK"])}).parse(request.body),auth=request.auth!;
    if(auth.stockId===input.stockId)throw forbidden("You cannot option your own Aura stock");
    const market=await maybeOne<{season_id:string;price:string}>(pool,`SELECT mp.season_id,(mp.credit_reserve/mp.share_reserve)::text AS price FROM market_pools mp JOIN seasons s ON s.id=mp.season_id AND s.status='ACTIVE' JOIN person_stocks ps ON ps.id=mp.stock_id AND ps.is_active=true WHERE mp.stock_id=$1`,[input.stockId]);if(!market)throw notFound("Stock not found");
    if(!strikeSet(market.price).includes(input.strike))throw badRequest("Strike is no longer available; refresh the chain","STALE_STRIKE");
    const durationMs=input.duration==="ONE_DAY"?86_400_000:7*86_400_000,premium=optionPremium(market.price,input.strike,input.optionType,durationMs),total=premium.mul(input.quantity),id=randomUUID(),expiresAt=new Date(Date.now()+durationMs),quoteExpiresAt=new Date(Date.now()+5000);
    await pool.query(`INSERT INTO option_quotes(id,season_id,user_id,stock_id,option_type,strike,quantity,spot_price,premium_per_share,total_premium,expires_at,quote_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,market.season_id,auth.id,input.stockId,input.optionType,input.strike,input.quantity,market.price,premium.toFixed(8),total.toFixed(8),expiresAt,quoteExpiresAt]);
    return {quoteId:id,spot:Number(market.price),premiumPerShare:premium.toNumber(),totalPremium:total.toNumber(),strike:input.strike,quantity:input.quantity,optionType:input.optionType,expiresAt,quoteExpiresAt};
  });

  app.post("/api/options/buy",{preHandler:guard({csrf:true})},async(request,reply)=>{
    const input=z.object({quoteId:z.string().uuid()}).parse(request.body),auth=request.auth!;
    const option=await withTransaction(async client=>{
      const quote=await maybeOne<{id:string;season_id:string;user_id:string;stock_id:string;option_type:"CALL"|"PUT";strike:string;quantity:string;total_premium:string;expires_at:Date;quote_expires_at:Date;consumed_at:Date|null}>(client,"SELECT id,season_id,user_id,stock_id,option_type,strike::text,quantity::text,total_premium::text,expires_at,quote_expires_at,consumed_at FROM option_quotes WHERE id=$1 FOR UPDATE",[input.quoteId]);
      if(!quote||quote.user_id!==auth.id)throw notFound("Option quote not found");if(quote.consumed_at)throw conflict("Quote already used");if(quote.quote_expires_at<=new Date())throw conflict("Quote expired; request a new quote","QUOTE_EXPIRED");
      const cash=await accountBalance(client,accounts.userCash(auth.id,quote.season_id)),cost=new Decimal(quote.total_premium);if(cash.lt(cost))throw badRequest("Insufficient Aura Credits","INSUFFICIENT_FUNDS");if(cost.gt(cash.mul("0.25")))throw badRequest("One option purchase cannot exceed 25% of available cash","OPTION_CAP");
      const row=await one(client,`INSERT INTO aura_options(quote_id,season_id,user_id,stock_id,option_type,strike,quantity,premium_paid,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[quote.id,quote.season_id,auth.id,quote.stock_id,quote.option_type,quote.strike,quote.quantity,quote.total_premium,quote.expires_at]);
      await postLedgerTransaction(client,"OPTION_PREMIUM",`Purchased ${quote.option_type} option`,[{accountKey:accounts.userCash(auth.id,quote.season_id),amount:cost.negated()},{accountKey:accounts.fees(quote.season_id),amount:cost}],(row as {id:string}).id);
      await client.query("UPDATE option_quotes SET consumed_at=now() WHERE id=$1",[quote.id]);return row;
    });reply.code(201);return option;
  });
}
