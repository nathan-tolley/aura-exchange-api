import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {guard} from "../auth.js";
import {pool,maybeOne,withTransaction} from "../db.js";
import {conflict,forbidden,notFound} from "../errors.js";

export async function registerAuraFarmingRoutes(app:FastifyInstance):Promise<void>{
  app.get("/api/aura-farming",{preHandler:guard()},async(request)=>{
    const auth=request.auth!;
    const result=await pool.query(
      `SELECT p.id,p.status,p.outcome,p.closes_at,p.resolved_at,s.explanation,s.subject_stock_id,
              ps.display_name,ps.ticker::text,r.verdict,r.delta,r.confidence,r.rationale,
              COUNT(v.*) FILTER(WHERE v.choice='SUPPORT')::int AS support,
              COUNT(v.*) FILTER(WHERE v.choice='DECLINE')::int AS decline,
              COUNT(v.*) FILTER(WHERE v.choice='RECONSIDER')::int AS reconsider,
              COALESCE(MAX(v.choice) FILTER(WHERE v.voter_id=$1),NULL) AS viewer_choice
         FROM aura_swing_polls p JOIN aura_submissions s ON s.id=p.submission_id
         JOIN listings ps ON ps.id=s.subject_stock_id JOIN aura_rulings r ON r.id=p.ruling_id
         LEFT JOIN aura_swing_votes v ON v.poll_id=p.id
        WHERE p.exchange_id=$2
        GROUP BY p.id,s.id,ps.id,r.id
        ORDER BY (p.status='OPEN') DESC,p.created_at DESC LIMIT 50`,[auth.id,auth.exchangeId]);
    return {items:result.rows};
  });

  app.post("/api/aura-farming/:id/vote",{preHandler:guard({csrf:true})},async(request)=>{
    const params=z.object({id:z.string().uuid()}).parse(request.params);
    const input=z.object({choice:z.enum(["SUPPORT","DECLINE","RECONSIDER"])}).parse(request.body);
    const auth=request.auth!;
    if(!auth.stockId)throw forbidden("Claim an Aura stock before voting");
    await withTransaction(async client=>{
      const poll=await maybeOne<{id:string;subject_stock_id:string;status:string;closes_at:Date}>(client,
        `SELECT p.id,s.subject_stock_id,p.status,p.closes_at FROM aura_swing_polls p
         JOIN aura_submissions s ON s.id=p.submission_id WHERE p.id=$1 AND p.exchange_id=$2 FOR UPDATE OF p`,[params.id,auth.exchangeId]);
      if(!poll)throw notFound("Aura Farming poll not found");
      if(poll.status!=="OPEN"||poll.closes_at<=new Date())throw conflict("Voting has closed");
      if(poll.subject_stock_id===auth.stockId)throw forbidden("You cannot vote on your own Aura");
      await client.query(
        `INSERT INTO aura_swing_votes(poll_id,voter_id,choice) VALUES($1,$2,$3)
         ON CONFLICT(poll_id,voter_id) DO UPDATE SET choice=EXCLUDED.choice,updated_at=now()`,
        [poll.id,auth.id,input.choice]);
    });
    return {ok:true};
  });
}
