import type { PoolClient } from "pg";
import { accounts, postLedgerTransaction } from "../core/ledger.js";
import { one, withTransaction } from "../db.js";
import { applyAuraEntry } from "./aura-service.js";

type Choice = "SUPPORT" | "DECLINE" | "RECONSIDER";

interface PollRow {
  id:string; submission_id:string; ruling_id:string; season_id:string; author_id:string;
  subject_stock_id:string; explanation:string; status:string; verdict:"GAIN"|"LOSS"|"NEUTRAL"|"REVIEW";
  delta:number; rationale:string;
}

export async function resolveExpiredAuraFarming():Promise<void> {
  const due=await withTransaction(async(client)=>client.query<{id:string}>(
    "SELECT id FROM aura_swing_polls WHERE status='OPEN' AND closes_at<=now() ORDER BY closes_at LIMIT 25"
  ));
  for(const candidate of due.rows) await resolvePoll(candidate.id);
}

async function resolvePoll(pollId:string):Promise<void> {
  await withTransaction(async(client:PoolClient)=>{
    const poll=await one<PollRow>(client,
      `SELECT p.id,p.submission_id,p.ruling_id,s.season_id,s.author_id,s.subject_stock_id,s.explanation,s.status,
              r.verdict,r.delta,r.rationale
         FROM aura_swing_polls p JOIN aura_submissions s ON s.id=p.submission_id
         JOIN aura_rulings r ON r.id=p.ruling_id
        WHERE p.id=$1 AND p.status='OPEN' AND p.closes_at<=now() FOR UPDATE OF p,s`,[pollId]);
    const counts=await client.query<{choice:Choice;count:number}>(
      "SELECT choice,COUNT(*)::int AS count FROM aura_swing_votes WHERE poll_id=$1 GROUP BY choice",[poll.id]);
    const count=(choice:Choice)=>counts.rows.find(row=>row.choice===choice)?.count??0;
    const support=count("SUPPORT"),decline=count("DECLINE"),reconsider=count("RECONSIDER");
    const outcome:Choice=support>decline&&support>reconsider?"SUPPORT":decline>support&&decline>reconsider?"DECLINE":"RECONSIDER";

    const voters=await client.query<{voter_id:string;stock_id:string}>(
      `SELECT v.voter_id,ps.id AS stock_id FROM aura_swing_votes v
       JOIN person_stocks ps ON ps.owner_user_id=v.voter_id AND ps.is_active=true WHERE v.poll_id=$1`,[poll.id]);
    for(const voter of voters.rows){
      await client.query(
        `INSERT INTO aura_ledger_entries(season_id,stock_id,delta,reason,created_by)
         VALUES ($1,$2,2,$3,$4)`,[poll.season_id,voter.stock_id,`Aura Farming participation ${poll.id}`,voter.voter_id]);
      await client.query(
        "UPDATE person_stocks SET seasonal_aura=seasonal_aura+2,career_aura=career_aura+2,updated_at=now() WHERE id=$1",[voter.stock_id]);
      await postLedgerTransaction(client,"AURA_FARMING_REWARD","Aura Farming participation reward",[
        {accountKey:accounts.userCash(voter.voter_id,poll.season_id),amount:100},
        {accountKey:accounts.issuance(poll.season_id),amount:-100}
      ],poll.id);
    }

    if(outcome==="SUPPORT"){
      await applyAuraEntry(client,poll,poll.ruling_id,poll.delta,poll.rationale);
    }else if(outcome==="DECLINE"){
      await client.query("UPDATE aura_submissions SET status='DECLINED',updated_at=now() WHERE id=$1",[poll.submission_id]);
    }else{
      await client.query("UPDATE aura_rulings SET is_current=false WHERE id=$1",[poll.ruling_id]);
      await client.query("UPDATE aura_submissions SET status='PENDING',updated_at=now() WHERE id=$1",[poll.submission_id]);
      await client.query("INSERT INTO jobs(type,payload) VALUES ('JUDGE_AURA',$1)",[JSON.stringify({
        submissionId:poll.submission_id,finalReconsideration:true,
        priorRuling:{verdict:poll.verdict,delta:poll.delta,rationale:poll.rationale}
      })]);
    }
    await client.query("UPDATE aura_swing_polls SET status='RESOLVED',outcome=$1,resolved_at=now() WHERE id=$2",[outcome,poll.id]);
    await client.query(
      `INSERT INTO feed_events(season_id,kind,subject_stock_id,payload) VALUES ($1,'AURA_FARMING_RESOLVED',$2,$3)`,
      [poll.season_id,poll.subject_stock_id,JSON.stringify({pollId:poll.id,submissionId:poll.submission_id,outcome,support,decline,reconsider,voterCount:voters.rowCount})]);
  });
}
