import {Decimal} from "decimal.js";
import type {PoolClient} from "pg";
import {accounts,postLedgerTransaction} from "../core/ledger.js";
import {optionPayout,type PredictionSide} from "../core/derivatives.js";
import {maybeOne,one,pool,withTransaction} from "../db.js";
import {notifyUser} from "./notification-service.js";

export async function resolvePrediction(marketId:string,outcome:PredictionSide|"CANCEL",resolverId:string):Promise<void>{
  await withTransaction(async client=>{
    const market=await one<{id:string;season_id:string;status:string;closes_at:Date}>(client,"SELECT id,season_id,status,closes_at FROM prediction_markets WHERE id=$1 FOR UPDATE",[marketId]);
    if(market.status!=="OPEN")throw new Error("Prediction market is already closed");
    if(outcome!=="CANCEL"&&market.closes_at>new Date())throw new Error("Prediction market cannot resolve before its close time");
    const bets=await client.query<{id:string;user_id:string;side:PredictionSide;amount:string}>("SELECT id,user_id,side,amount::text FROM prediction_bets WHERE market_id=$1 ORDER BY created_at FOR UPDATE",[market.id]);
    const pot=bets.rows.reduce((sum,bet)=>sum.plus(bet.amount),new Decimal(0));
    const winners=outcome==="CANCEL"?[]:bets.rows.filter(bet=>bet.side===outcome);
    const winningPool=winners.reduce((sum,bet)=>sum.plus(bet.amount),new Decimal(0));
    const canceled=outcome==="CANCEL"||winningPool.isZero();
    if(pot.gt(0)){
      if(canceled){
        await postLedgerTransaction(client,"PREDICTION_REFUND","Prediction market refunded",[
          {accountKey:accounts.predictionEscrow(market.id,market.season_id),amount:pot.negated()},
          ...bets.rows.map(bet=>({accountKey:accounts.userCash(bet.user_id,market.season_id),amount:bet.amount}))
        ],market.id);
        for(const bet of bets.rows)await client.query("UPDATE prediction_bets SET payout=amount WHERE id=$1",[bet.id]);
      }else{
        const distributable=pot.mul("0.98").toDecimalPlaces(8),payouts=winners.map(bet=>({bet,payout:distributable.mul(bet.amount).div(winningPool).toDecimalPlaces(8)}));
        const paid=payouts.reduce((sum,row)=>sum.plus(row.payout),new Decimal(0)),fee=pot.minus(paid);
        await postLedgerTransaction(client,"PREDICTION_SETTLEMENT","Prediction market settlement",[
          {accountKey:accounts.predictionEscrow(market.id,market.season_id),amount:pot.negated()},
          ...payouts.map(row=>({accountKey:accounts.userCash(row.bet.user_id,market.season_id),amount:row.payout})),
          {accountKey:accounts.fees(market.season_id),amount:fee}
        ],market.id);
        for(const row of payouts)await client.query("UPDATE prediction_bets SET payout=$1 WHERE id=$2",[row.payout.toFixed(8),row.bet.id]);
      }
    }
    await client.query("UPDATE prediction_markets SET status=$1,outcome=$2,resolved_by=$3,resolved_at=now() WHERE id=$4",[canceled?"CANCELED":"RESOLVED",canceled?null:outcome,resolverId,market.id]);
    for(const userId of new Set(bets.rows.map(bet=>bet.user_id)))await notifyUser(client,userId,"PREDICTION_RESOLVED",{marketId:market.id,outcome:canceled?"CANCELED":outcome});
    await client.query("INSERT INTO feed_events(season_id,kind,actor_id,payload) VALUES($1,'PREDICTION_RESOLVED',$2,$3)",[market.season_id,resolverId,JSON.stringify({marketId:market.id,outcome:canceled?"CANCELED":outcome,pot:pot.toNumber()})]);
  });
}

export async function settleExpiredOptions():Promise<void>{
  const due=await pool.query<{id:string}>("SELECT id FROM aura_options WHERE status='OPEN' AND expires_at<=now() ORDER BY expires_at LIMIT 100");
  for(const row of due.rows)await withTransaction(async client=>{
    const option=await maybeOne<{id:string;season_id:string;user_id:string;stock_id:string;option_type:"CALL"|"PUT";strike:string;quantity:string;status:string}>(client,"SELECT id,season_id,user_id,stock_id,option_type,strike::text,quantity::text,status FROM aura_options WHERE id=$1 AND status='OPEN' FOR UPDATE",[row.id]);
    if(!option)return;
    const market=await maybeOne<{price:string}>(client,"SELECT (credit_reserve/share_reserve)::text AS price FROM market_pools WHERE season_id=$1 AND stock_id=$2",[option.season_id,option.stock_id]);
    const price=new Decimal(market?.price??option.strike),payout=optionPayout(price,option.strike,option.option_type,option.quantity);
    if(payout.gt(0))await postLedgerTransaction(client,"OPTION_SETTLEMENT","Aura option cash settlement",[
      {accountKey:accounts.userCash(option.user_id,option.season_id),amount:payout},
      {accountKey:accounts.issuance(option.season_id),amount:payout.negated()}
    ],option.id);
    await client.query("UPDATE aura_options SET status='SETTLED',settlement_price=$1,payout=$2,settled_at=now() WHERE id=$3",[price.toFixed(8),payout.toFixed(8),option.id]);
    await notifyUser(client,option.user_id,"OPTION_SETTLED",{optionId:option.id,stockId:option.stock_id,type:option.option_type,strike:Number(option.strike),settlementPrice:price.toNumber(),payout:payout.toNumber()});
  });
}

export async function settleSeasonDerivatives(client:PoolClient,seasonId:string):Promise<void>{
  const predictions=await client.query<{id:string}>("SELECT id FROM prediction_markets WHERE season_id=$1 AND status='OPEN' FOR UPDATE",[seasonId]);
  for(const market of predictions.rows){
    const bets=await client.query<{id:string;user_id:string;amount:string}>("SELECT id,user_id,amount::text FROM prediction_bets WHERE market_id=$1 FOR UPDATE",[market.id]);
    const pot=bets.rows.reduce((sum,bet)=>sum.plus(bet.amount),new Decimal(0));
    if(pot.gt(0))await postLedgerTransaction(client,"PREDICTION_REFUND","Prediction refunded at season close",[
      {accountKey:accounts.predictionEscrow(market.id,seasonId),amount:pot.negated()},
      ...bets.rows.map(bet=>({accountKey:accounts.userCash(bet.user_id,seasonId),amount:bet.amount}))
    ],market.id);
    await client.query("UPDATE prediction_bets SET payout=amount WHERE market_id=$1",[market.id]);
    await client.query("UPDATE prediction_markets SET status='CANCELED',resolved_at=now() WHERE id=$1",[market.id]);
    for(const userId of new Set(bets.rows.map(bet=>bet.user_id)))await notifyUser(client,userId,"PREDICTION_RESOLVED",{marketId:market.id,outcome:"CANCELED",reason:"SEASON_CLOSED"});
  }

  const options=await client.query<{id:string;user_id:string;stock_id:string;option_type:"CALL"|"PUT";strike:string;quantity:string;price:string}>(
    `SELECT o.id,o.user_id,o.stock_id,o.option_type,o.strike::text,o.quantity::text,
            (mp.credit_reserve/mp.share_reserve)::text AS price
       FROM aura_options o JOIN market_pools mp ON mp.season_id=o.season_id AND mp.stock_id=o.stock_id
      WHERE o.season_id=$1 AND o.status='OPEN' FOR UPDATE OF o`,[seasonId]
  );
  for(const option of options.rows){
    const payout=optionPayout(option.price,option.strike,option.option_type,option.quantity);
    if(payout.gt(0))await postLedgerTransaction(client,"OPTION_SETTLEMENT","Aura option settled at season close",[
      {accountKey:accounts.userCash(option.user_id,seasonId),amount:payout},
      {accountKey:accounts.issuance(seasonId),amount:payout.negated()}
    ],option.id);
    await client.query("UPDATE aura_options SET status='SETTLED',settlement_price=$1,payout=$2,settled_at=now() WHERE id=$3",[option.price,payout.toFixed(8),option.id]);
    await notifyUser(client,option.user_id,"OPTION_SETTLED",{optionId:option.id,stockId:option.stock_id,type:option.option_type,strike:Number(option.strike),settlementPrice:Number(option.price),payout:payout.toNumber(),reason:"SEASON_CLOSED"});
  }
}
