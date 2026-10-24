import type { PoolClient } from "pg";

/** exchangeId is the exchange the notification is about, or null for account-level ones. */
export async function notifyUser(client:PoolClient,exchangeId:string|null,userId:string,kind:string,payload:Record<string,unknown>):Promise<void>{
  await client.query("INSERT INTO notifications(exchange_id,user_id,kind,payload) VALUES($1,$2,$3,$4)",[exchangeId,userId,kind,JSON.stringify(payload)]);
}

export async function notifyStockOwner(client:PoolClient,stockId:string,kind:string,payload:Record<string,unknown>):Promise<void>{
  await client.query(
    `INSERT INTO notifications(exchange_id,user_id,kind,payload)
     SELECT exchange_id,owner_user_id,$2,$3 FROM listings WHERE id=$1 AND owner_user_id IS NOT NULL`,
    [stockId,kind,JSON.stringify(payload)]
  );
}
