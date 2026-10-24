import type { PoolClient } from "pg";

export async function notifyUser(client:PoolClient,userId:string,kind:string,payload:Record<string,unknown>):Promise<void>{
  await client.query("INSERT INTO notifications(user_id,kind,payload) VALUES($1,$2,$3)",[userId,kind,JSON.stringify(payload)]);
}

export async function notifyStockOwner(client:PoolClient,stockId:string,kind:string,payload:Record<string,unknown>):Promise<void>{
  await client.query(
    `INSERT INTO notifications(user_id,kind,payload)
     SELECT owner_user_id,$2,$3 FROM person_stocks WHERE id=$1 AND owner_user_id IS NOT NULL`,
    [stockId,kind,JSON.stringify(payload)]
  );
}
