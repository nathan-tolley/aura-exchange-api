import {randomUUID} from "node:crypto";
import {Decimal} from "decimal.js";
import type {PoolClient} from "pg";
import {accounts,postLedgerTransaction} from "../core/ledger.js";
import {marketAuraAdjustment,quoteTrade,reserveVersion} from "../core/market.js";
import {one,pool,withTransaction} from "../db.js";

interface LimitOrder { id:string;season_id:string;user_id:string;stock_id:string;side:"BUY"|"SELL";quantity:string;limit_price:string;reserved_cash:string }

export async function processOpenLimitOrders():Promise<void>{
  const candidates=await pool.query<{id:string}>("SELECT id FROM limit_orders WHERE status='OPEN' ORDER BY created_at LIMIT 50");
  for(const candidate of candidates.rows){
    try{await fillLimitOrder(candidate.id)}catch(error){console.error(`Limit order ${candidate.id} failed`,error)}
  }
}

async function position(client:PoolClient,order:LimitOrder){
  await client.query("INSERT INTO positions(season_id,user_id,stock_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[order.season_id,order.user_id,order.stock_id]);
  return one<{id:string;long_qty:string;avg_long_cost:string;short_qty:string}>(client,
    "SELECT id,long_qty::text,avg_long_cost::text,short_qty::text FROM positions WHERE season_id=$1 AND user_id=$2 AND stock_id=$3 FOR UPDATE",[order.season_id,order.user_id,order.stock_id]);
}

async function fillLimitOrder(id:string):Promise<void>{
  await withTransaction(async client=>{
    const result=await client.query<LimitOrder>("SELECT * FROM limit_orders WHERE id=$1 AND status='OPEN' FOR UPDATE",[id]);
    const order=result.rows[0];if(!order)return;
    const market=await one<{id:string;share_reserve:string;credit_reserve:string;day_open_price:string;halted_until:Date|null}>(client,
      "SELECT id,share_reserve::text,credit_reserve::text,day_open_price::text,halted_until FROM market_pools WHERE season_id=$1 AND stock_id=$2 FOR UPDATE",[order.season_id,order.stock_id]);
    if(market.halted_until&&market.halted_until>new Date())return;
    let quote;try{quote=quoteTrade({shareReserve:market.share_reserve,creditReserve:market.credit_reserve},order.side,order.quantity)}catch{return}
    const execution=new Decimal(quote.executionPrice),limit=new Decimal(order.limit_price);
    if(order.side==="BUY"?execution.gt(limit):execution.lt(limit))return;
    const pos=await position(client,order),qty=new Decimal(quote.quantity),gross=new Decimal(quote.grossAmount),fee=new Decimal(quote.feeAmount),net=new Decimal(quote.netAmount);
    if(order.side==="SELL"&&new Decimal(pos.long_qty).lt(qty)){
      await client.query("UPDATE limit_orders SET status='CANCELED',canceled_at=now(),updated_at=now() WHERE id=$1",[order.id]);return;
    }
    const quoteId=randomUUID(),tradeId=randomUUID();
    await client.query(
      `INSERT INTO trade_quotes(id,season_id,user_id,stock_id,side,quantity,gross_amount,fee_amount,net_amount,execution_price,price_impact,reserve_version,expires_at,consumed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),now())`,
      [quoteId,order.season_id,order.user_id,order.stock_id,order.side,quote.quantity,quote.grossAmount,quote.feeAmount,quote.netAmount,quote.executionPrice,quote.priceImpact,reserveVersion({shareReserve:market.share_reserve,creditReserve:market.credit_reserve})]);
    if(order.side==="BUY"){
      const reserved=new Decimal(order.reserved_cash),refund=reserved.minus(net);
      if(refund.lt(0))return;
      await postLedgerTransaction(client,"LIMIT_BUY",`Filled buy limit at ${order.limit_price}`,[
        {accountKey:accounts.limitEscrow(order.id,order.season_id),amount:reserved.negated()},
        {accountKey:accounts.poolCash(order.stock_id,order.season_id),amount:gross},
        {accountKey:accounts.fees(order.season_id),amount:fee},
        ...(refund.gt(0)?[{accountKey:accounts.userCash(order.user_id,order.season_id),amount:refund}]:[])
      ],tradeId);
      const oldQty=new Decimal(pos.long_qty),newQty=oldQty.plus(qty),avg=oldQty.mul(pos.avg_long_cost).plus(net).div(newQty);
      await client.query("UPDATE positions SET long_qty=$1,avg_long_cost=$2,updated_at=now() WHERE id=$3",[newQty.toFixed(8),avg.toFixed(8),pos.id]);
    }else{
      await postLedgerTransaction(client,"LIMIT_SELL",`Filled sell limit at ${order.limit_price}`,[
        {accountKey:accounts.poolCash(order.stock_id,order.season_id),amount:gross.negated()},
        {accountKey:accounts.userCash(order.user_id,order.season_id),amount:net},
        {accountKey:accounts.fees(order.season_id),amount:fee}
      ],tradeId);
      const newQty=new Decimal(pos.long_qty).minus(qty),realized=execution.minus(pos.avg_long_cost).mul(qty).minus(fee);
      await client.query("UPDATE positions SET long_qty=$1,avg_long_cost=$2,realized_pnl=realized_pnl+$3,updated_at=now() WHERE id=$4",[newQty.toFixed(8),newQty.isZero()?0:pos.avg_long_cost,realized.toFixed(8),pos.id]);
    }
    const nextPrice=new Decimal(quote.nextCreditReserve).div(quote.nextShareReserve),dayMove=nextPrice.div(market.day_open_price).minus(1).abs();
    await client.query("UPDATE market_pools SET share_reserve=$1,credit_reserve=$2,halted_until=CASE WHEN $3::numeric>=0.35 THEN now()+interval '30 minutes' ELSE halted_until END,organic_price=$4,ambient_deviation=0,updated_at=now() WHERE id=$5",[quote.nextShareReserve,quote.nextCreditReserve,dayMove.toFixed(8),nextPrice.toFixed(8),market.id]);
    await client.query("INSERT INTO trades(id,season_id,user_id,stock_id,quote_id,idempotency_key,side,quantity,gross_amount,fee_amount,execution_price) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[tradeId,order.season_id,order.user_id,order.stock_id,quoteId,`limit:${order.id}`,order.side,quote.quantity,quote.grossAmount,quote.feeAmount,quote.executionPrice]);
    const auraImpact=marketAuraAdjustment(order.side,quote.grossAmount);
    await client.query("INSERT INTO aura_ledger_entries(season_id,stock_id,delta,reason,created_by) VALUES($1,$2,$3,$4,$5)",[order.season_id,order.stock_id,auraImpact.toFixed(2),`Market confidence from filled ${order.side.toLowerCase()} limit ${order.id}`,order.user_id]);
    await client.query("UPDATE person_stocks SET seasonal_aura=seasonal_aura+$1,career_aura=career_aura+$1,updated_at=now() WHERE id=$2",[auraImpact.toFixed(2),order.stock_id]);
    await client.query("INSERT INTO market_price_ticks(season_id,stock_id,price,cause,reference_id,is_synthetic) VALUES($1,$2,$3,'TRADE',$4,false)",[order.season_id,order.stock_id,nextPrice.toFixed(8),tradeId]);
    await client.query("INSERT INTO feed_events(season_id,kind,actor_id,subject_stock_id,payload) VALUES($1,'TRADE',$2,$3,$4)",[order.season_id,order.user_id,order.stock_id,JSON.stringify({tradeId,limitOrderId:order.id,side:order.side,quantity:quote.quantity,price:quote.executionPrice,auraImpact:auraImpact.toNumber()})]);
    await client.query("UPDATE limit_orders SET status='FILLED',filled_trade_id=$1,filled_at=now(),updated_at=now() WHERE id=$2",[tradeId,order.id]);
  });
}
