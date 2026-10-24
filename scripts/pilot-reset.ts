import pg from "pg";

if (process.env.PILOT_RESET_CONFIRM !== "RESET-PILOT") {
  throw new Error("Set PILOT_RESET_CONFIRM=RESET-PILOT to close the pilot and create a fresh season");
}
const connectionString=process.env.DATABASE_URL;
if(!connectionString)throw new Error("DATABASE_URL is required");
const pool=new pg.Pool({connectionString});
const active=await pool.query<{id:string;season_number:number}>("SELECT id,season_number FROM seasons WHERE status='ACTIVE'");
const season=active.rows[0];
if(!season)throw new Error("No active season exists");
const client=await pool.connect();
try{
  await client.query("BEGIN");
  await client.query("UPDATE seasons SET ends_at=now() WHERE id=$1",[season.id]);
  await client.query("DELETE FROM scheduled_runs WHERE key LIKE 'season-check:%'");
  await client.query("INSERT INTO audit_logs(action,entity_type,entity_id,metadata) VALUES('PILOT_RESET_REQUESTED','SEASON',$1,$2)",[season.id,JSON.stringify({seasonNumber:season.season_number})]);
  await client.query("COMMIT");
}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}

const deadline=Date.now()+30_000;
while(Date.now()<deadline){
  const result=await pool.query<{id:string;season_number:number}>("SELECT id,season_number FROM seasons WHERE status='ACTIVE'");
  if(result.rows[0]?.id!==season.id){
    console.log(`Pilot season ${season.season_number} closed; season ${result.rows[0]?.season_number} is active.`);
    await pool.end();
    process.exit(0);
  }
  await new Promise((resolve)=>setTimeout(resolve,1000));
}
await pool.end();
throw new Error("Reset was requested but the worker did not close the season within 30 seconds; check Operations health");
