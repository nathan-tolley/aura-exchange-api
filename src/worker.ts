import os from "node:os";
import { config } from "./config.js";
import { pool, withTransaction } from "./db.js";
import { processAuraSubmission } from "./services/aura-service.js";
import { runSchedulers } from "./jobs/schedulers.js";

interface JobRow { id: string; type: string; payload: Record<string, unknown>; attempts: number }
const workerId = `${os.hostname()}:${process.pid}`;

async function claimJob(): Promise<JobRow | null> {
  return withTransaction(async (client) => {
    const result = await client.query<JobRow>(
      `SELECT id, type, payload, attempts FROM jobs
        WHERE status='PENDING' AND run_after<=now()
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`
    );
    const job = result.rows[0];
    if (!job) return null;
    await client.query(
      "UPDATE jobs SET status='RUNNING', attempts=attempts+1, locked_at=now(), locked_by=$1, updated_at=now() WHERE id=$2",
      [workerId, job.id]
    );
    return job;
  });
}

async function finishJob(job: JobRow, error?: unknown): Promise<void> {
  if (!error) {
    await pool.query("UPDATE jobs SET status='DONE', last_error=NULL, updated_at=now() WHERE id=$1", [job.id]);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (job.attempts + 1 < 3) {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE jobs SET status='PENDING', run_after=now()+($2::text || ' seconds')::interval,
           last_error=$3, locked_at=NULL, locked_by=NULL, updated_at=now() WHERE id=$1`,
        [job.id, 2 ** (job.attempts + 1) * 10, message.slice(0, 1000)]
      );
      if (job.type === "JUDGE_AURA" && typeof job.payload.submissionId === "string") {
        await client.query(
          "UPDATE aura_submissions SET status='FAILED', updated_at=now() WHERE id=$1 AND status='JUDGING'",
          [job.payload.submissionId]
        );
      }
    });
  } else {
    await withTransaction(async (client) => {
      await client.query("UPDATE jobs SET status='FAILED', last_error=$2, updated_at=now() WHERE id=$1", [job.id, message.slice(0, 1000)]);
      if (job.type === "JUDGE_AURA" && typeof job.payload.submissionId === "string") {
        await client.query(
          `INSERT INTO aura_rulings(submission_id, verdict, delta, confidence, rationale, category, provider, model, requires_review)
           VALUES ($1,'REVIEW',0,0,'The judge could not reach a reliable ruling.','SYSTEM','system','fallback',true)
           ON CONFLICT DO NOTHING`, [job.payload.submissionId]
        );
        await client.query("UPDATE aura_submissions SET status='REVIEW', updated_at=now() WHERE id=$1", [job.payload.submissionId]);
      }
    });
  }
}

async function processJob(job: JobRow): Promise<void> {
  if (job.type === "JUDGE_AURA" && typeof job.payload.submissionId === "string") {
    const prior=job.payload.priorRuling as {verdict:"GAIN"|"LOSS"|"NEUTRAL"|"REVIEW";delta:number;rationale:string}|undefined;
    await processAuraSubmission(job.payload.submissionId,{
      finalReconsideration:job.payload.finalReconsideration===true,
      priorRuling:prior
    });
    return;
  }
  throw new Error(`Unknown job type ${job.type}`);
}

async function main(): Promise<void> {
  console.log(`Aura worker ${workerId} started`);
  const recovered=await pool.query(
    `UPDATE jobs SET status='PENDING',locked_at=NULL,locked_by=NULL,run_after=now(),updated_at=now(),
            last_error=COALESCE(last_error||E'\n','')||'Recovered after worker restart'
      WHERE status='RUNNING' AND locked_at<now()-interval '5 minutes' RETURNING id`
  );
  if(recovered.rowCount) console.warn(`Recovered ${recovered.rowCount} stale jobs`);
  for (;;) {
    await pool.query(
      `INSERT INTO system_state(key,value,updated_at) VALUES ('worker_heartbeat',$1,now())
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [JSON.stringify({ workerId })]
    );
    await runSchedulers();
    const job = await claimJob();
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, config.WORKER_POLL_MS));
      continue;
    }
    try {
      await processJob(job);
      await finishJob(job);
    } catch (error) {
      console.error(`Job ${job.id} failed`, error);
      await finishJob(job, error);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

