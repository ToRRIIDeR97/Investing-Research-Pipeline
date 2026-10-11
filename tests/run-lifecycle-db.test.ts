import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import test, { after, before, describe } from "node:test";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { ResearchAgentRunError } from "../src/lib/agent-harness/errors";
import { recordModelCall } from "../src/lib/agents/model-calls";
import { STAGE_HANDLERS } from "../src/lib/research/handlers";
import { runResearchPipeline } from "../src/lib/research/pipeline-runner";
import { completeV3Task, createV3Task, type ResearchRunContext, type StageHandler } from "../src/lib/research/run-context";
import { claimNextResearchRun, enqueueResearchRun, reconcileOrphanedResearchRuns } from "../src/lib/research/run-queue";
import { cancelRun, createStagesForRun, failRun, pauseForHumanReview, resumeResearchRun } from "../src/lib/workflow/orchestrator";
import { processNextResearchRunJob } from "../src/workers/research-worker";
import { POST as cancelRoute } from "../src/app/api/research-runs/[id]/cancel/route";
import { POST as reviewRoute } from "../src/app/api/research-runs/[id]/review/route";

const transient = () => new ResearchAgentRunError("Agent attempts exhausted: Provider HTTP 529: overloaded_error", {} as any,
  { error_type: "server_error" });

describe("run lifecycle reliability", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, () => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const assetId = crypto.randomUUID();
  const instrumentId = crypto.randomUUID();
  const runIds: string[] = [];
  const intake = STAGE_HANDLERS.intake;
  let profileId: string;

  /** Replace the intake handler for one test; the stub may delegate to the real handler. */
  async function withIntake<T>(execute: StageHandler["execute"], run: () => Promise<T>) {
    STAGE_HANDLERS.intake = { stageKey: "intake", execute };
    try { return await run(); } finally { STAGE_HANDLERS.intake = intake; }
  }

  async function newRun(status = "pending") {
    const runId = crypto.randomUUID();
    runIds.push(runId);
    const cutoff = new Date().toISOString();
    await sql`INSERT INTO research_runs (id, asset_id, run_type, status, research_question, requested_by, profile_id, profile_version,
        source_cutoff_at, market_data_cutoff_at, budget_limit_usd, pipeline_version, metadata_json)
      VALUES (${runId}, ${assetId}, 'deep_dive', ${status}, 'Lifecycle test?', 'lifecycle-test', ${profileId}, 1,
        ${cutoff}, ${cutoff}, 10.00, 3, ${sql.json({ acceptance_provider: "mock" })})`;
    await sql`INSERT INTO asset_profile_assignments (asset_id, research_run_id, profile_id, assignment_reason, assigned_by, confidence, status)
      VALUES (${assetId}, ${runId}, ${profileId}, 'Run-scoped assignment', 'lifecycle-test', '1.0', 'active')`;
    await createStagesForRun(runId);
    return runId;
  }

  const stage = async (runId: string, key: string) =>
    (await sql`SELECT status, failure_reason, validation_result_json FROM research_stages WHERE research_run_id = ${runId} AND stage_key = ${key}`)[0];
  const runRow = async (runId: string) => (await sql`SELECT status, failure_reason FROM research_runs WHERE id = ${runId}`)[0];
  const jobs = async (runId: string) => sql`SELECT * FROM research_run_jobs WHERE research_run_id = ${runId} ORDER BY created_at`;

  before(async () => {
    process.env.RESEARCH_STAGE_RETRY_DELAY_MS = "1";
    [{ id: profileId }] = await sql`SELECT id FROM research_profiles WHERE profile_key = 'financials' LIMIT 1`;
    await sql`INSERT INTO assets (id, canonical_name, slug, primary_profile_id, status, asset_kind, base_currency)
      VALUES (${assetId}, 'Lifecycle Test Co', ${`lifecycle-${assetId.slice(0, 8)}`}, ${profileId}, 'active', 'equity', 'USD')`;
    await sql`INSERT INTO instruments (id, asset_id, name, instrument_type) VALUES (${instrumentId}, ${assetId}, 'Lifecycle common', 'equity')`;
    await sql`INSERT INTO listings (id, instrument_id, exchange, symbol, is_primary)
      VALUES (${crypto.randomUUID()}, ${instrumentId}, 'NASDAQ', ${`LIFE${assetId.slice(0, 4).toUpperCase()}`}, true)`;
  });

  after(async () => {
    STAGE_HANDLERS.intake = intake;
    const tables = (await sql`SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'research_run_id'`).map((row) => String(row.table_name));
    for (let pass = 0; pass < 4; pass++) for (const name of [...tables, "research_runs"]) {
      const column = name === "research_runs" ? "id" : "research_run_id";
      await sql`DELETE FROM ${sql(name)} WHERE ${sql(column)} = ANY(${runIds}::uuid[])`.catch(() => undefined);
    }
    await sql`DELETE FROM asset_profile_assignments WHERE asset_id = ${assetId}`;
    await sql`DELETE FROM listings WHERE instrument_id = ${instrumentId}`;
    await sql`DELETE FROM instruments WHERE id = ${instrumentId}`;
    await sql`DELETE FROM assets WHERE id = ${assetId}`;
    await sql.end();
  });

  test("RM2: a stage whose model call failed transiently is retried instead of ending the run", async () => {
    const runId = await newRun();
    let calls = 0;
    const result = await withIntake(async (ctx) => {
      calls += 1;
      if (calls === 1) throw transient();
      return intake.execute(ctx);
    }, () => runResearchPipeline(runId));
    assert.equal(calls, 2);
    assert.equal(result.status, "waiting_for_human", result.failure_reason || result.notes.join("\n"));
    assert.equal((await stage(runId, "intake")).status, "completed");
  });

  test("RM2: transient failures beyond the stage's max_retries stop the run as before", async () => {
    const runId = await newRun();
    let calls = 0;
    const result = await withIntake(async () => { calls += 1; throw transient(); }, () => runResearchPipeline(runId));
    assert.equal(calls, 3, "intake has max_retries 2");
    assert.equal(result.status, "needs_more_work");
    assert.match(result.failure_reason || "", /529/);
  });

  test("RM3: outputs completed by an attempt whose handler then threw are not replayed on resume", async () => {
    const runId = await newRun();
    const earlier = await createV3Task(sql, runId, "intake", "intake:earlier", "intake", "intake-planner");
    await completeV3Task(sql, earlier.id, { ok: true });
    const result = await withIntake(async (ctx: ResearchRunContext) => {
      const task = await createV3Task(sql, ctx.runId, "intake", "intake:this-attempt", "intake", "intake-planner");
      await completeV3Task(sql, task.id, { ok: true });
      throw new Error("Invalid company_genesis: evidence_claim_ids must contain at least 1 element");
    }, () => runResearchPipeline(runId));
    assert.equal(result.status, "needs_more_work");
    const tasks = await sql`SELECT task_key, validation_status FROM research_tasks WHERE research_run_id = ${runId} ORDER BY task_key`;
    assert.deepEqual(tasks.map((task) => [task.task_key, task.validation_status]),
      [["intake:earlier", null], ["intake:this-attempt", "invalid"]]);
  });

  test("RO5: failRun and pauseForHumanReview change nothing when one of their writes fails", async () => {
    const runId = await newRun("running");
    await sql`UPDATE research_stages SET status = 'running' WHERE research_run_id = ${runId} AND stage_key = 'intake'`;
    const fn = `lifecycle_fail_${runId.replace(/-/g, "")}`;
    await sql.unsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected stage write failure'; END $$`);
    await sql.unsafe(`CREATE TRIGGER ${fn} BEFORE UPDATE ON research_stages FOR EACH ROW
      WHEN (NEW.research_run_id = '${runId}'::uuid) EXECUTE FUNCTION ${fn}()`);
    try {
      await assert.rejects(failRun(runId, "boom", "needs_more_work"), /injected/);
      assert.equal((await runRow(runId)).status, "running", "the run is not failed while its stage stays running");
      await assert.rejects(pauseForHumanReview(runId, "check"), /injected/);
      assert.equal((await runRow(runId)).status, "running");
    } finally {
      await sql.unsafe(`DROP TRIGGER ${fn} ON research_stages`);
      await sql.unsafe(`DROP FUNCTION ${fn}()`);
    }
  });

  test("RO5: resume repairs a stopped run whose stage was left running", async () => {
    const runId = await newRun("needs_more_work");
    await sql`UPDATE research_stages SET status = 'running' WHERE research_run_id = ${runId} AND stage_key = 'intake'`;
    await sql`UPDATE research_stages SET status = 'cancelled' WHERE research_run_id = ${runId} AND status = 'pending'`;
    await resumeResearchRun(runId);
    assert.equal((await runRow(runId)).status, "running");
    assert.equal((await stage(runId, "intake")).status, "running");
    assert.equal((await stage(runId, "asset_identity")).status, "pending");
  });

  test("RO1: a running run left without a job is queued again by the worker's reconcile step", async () => {
    const orphan = await newRun("running");
    await sql`INSERT INTO research_run_jobs (research_run_id, status, failure_reason, updated_at, created_at, queued_at)
      VALUES (${orphan}, 'failed', 'Lease expired after maximum attempts', NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '2 minutes')`;
    await sql`UPDATE research_runs SET updated_at = NOW() - INTERVAL '2 minutes' WHERE id = ${orphan}`;
    const neverQueued = await newRun("running");
    await sql`UPDATE research_runs SET updated_at = NOW() - INTERVAL '2 minutes' WHERE id = ${neverQueued}`;
    assert.deepEqual(await reconcileOrphanedResearchRuns({ runId: orphan }), [orphan]);
    assert.deepEqual(await reconcileOrphanedResearchRuns({ runId: orphan }), [], "an active job already exists");
    assert.deepEqual(await reconcileOrphanedResearchRuns({ runId: neverQueued }), [], "runs never queued are left to their caller");
    assert.equal((await jobs(orphan)).filter((job) => job.status === "queued").length, 1);
  });

  test("RO1: retrying an approval whose enqueue failed queues the export", async () => {
    const runId = await newRun("running");
    await sql`UPDATE research_stages SET status = 'completed' WHERE research_run_id = ${runId}
      AND stage_key NOT IN ('export', 'refresh_schedule')`;
    await sql`INSERT INTO review_decisions (asset_id, research_run_id, status, reviewed_by, reviewed_at)
      VALUES (${assetId}, ${runId}, 'approved_for_tracking', 'reviewer', NOW())`;
    await sql`INSERT INTO research_run_jobs (research_run_id, status, completed_at) VALUES (${runId}, 'completed', NOW())`;
    const response = await reviewRoute(new NextRequest("http://localhost/api/test", { method: "POST",
      body: JSON.stringify({ status: "approved_for_tracking", reviewed_by: "reviewer" }) }), { params: Promise.resolve({ id: runId }) });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.equal((await jobs(runId)).filter((job) => job.status === "queued").length, 1);
  });

  test("G8: a claim limited to one run never takes another run's older job", async () => {
    const other = await newRun("running");
    const mine = await newRun("running");
    await sql`INSERT INTO research_run_jobs (research_run_id, status, queued_at) VALUES (${other}, 'queued', NOW() - INTERVAL '1 hour')`;
    await sql`INSERT INTO research_run_jobs (research_run_id, status) VALUES (${mine}, 'queued')`;
    const claimed = await claimNextResearchRun("lifecycle-test", undefined, { runId: mine });
    assert.equal(claimed?.research_run_id, mine);
    assert.equal((await jobs(other))[0].status, "queued");
    await sql`UPDATE research_run_jobs SET status = 'completed' WHERE research_run_id = ANY(${[other, mine]}::uuid[])`;
  });

  test("G8: the database test runner refuses a database with a live worker", async () => {
    const workerId = `lifecycle-guard-${crypto.randomUUID()}`;
    await sql`INSERT INTO research_worker_heartbeats (worker_id, status, last_seen_at) VALUES (${workerId}, 'healthy', NOW())`;
    try {
      const result = spawnSync("node", ["scripts/test-db.cjs", "tests/does-not-exist.test.ts"], { encoding: "utf8", env: process.env });
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`Refusing to run: research worker .*${workerId}`));
    } finally {
      await sql`DELETE FROM research_worker_heartbeats WHERE worker_id = ${workerId}`;
    }
  });

  test("RO7: a worker that finds the run locked by another puts the job back without using an attempt", async () => {
    const runId = await newRun("running");
    await sql`INSERT INTO research_run_jobs (research_run_id, status) VALUES (${runId}, 'queued')`;
    const holder = await sql.reserve();
    try {
      await holder`SELECT pg_advisory_lock(hashtextextended(${`research-run:${runId}`}, 0))`;
      assert.equal(await processNextResearchRunJob({ runId }), true);
      const [job] = await jobs(runId);
      assert.equal(job.status, "queued");
      assert.equal(job.attempt_count, 0);
      assert.ok(new Date(job.lease_expires_at).getTime() > Date.now(), "the job waits a lease before it is claimed again");
    } finally {
      await holder`SELECT pg_advisory_unlock(hashtextextended(${`research-run:${runId}`}, 0))`;
      holder.release();
    }
  });

  /** A stub stage that waits for its run's abort signal, as a model call does. */
  const waitForAbort = (timeoutMs: number) => (ctx: ResearchRunContext) => new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("abort signal never reached the stage")), timeoutMs);
    ctx.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Request cancelled by caller")); }, { once: true });
  });

  test("RO4: worker shutdown aborts the in-flight stage and requeues the job without using an attempt", async () => {
    const runId = await newRun();
    await enqueueResearchRun(runId, "lifecycle-test");
    const shutdown = new AbortController();
    setTimeout(() => shutdown.abort(), 300);
    await withIntake(waitForAbort(5_000), () => processNextResearchRunJob({ runId, signal: shutdown.signal }));
    const [job] = await jobs(runId);
    assert.equal(job.status, "queued");
    assert.equal(job.attempt_count, 0);
    assert.equal((await runRow(runId)).status, "running", "an interrupted run stays resumable");
    assert.equal((await stage(runId, "intake")).status, "running");
  });

  test("#15: cancelling a run closes its job and aborts the worker's in-flight call; the run cannot be queued again", { timeout: 30_000 }, async () => {
    const runId = await newRun();
    await enqueueResearchRun(runId, "lifecycle-test");
    const started = Date.now();
    const cancel = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const response = await cancelRoute(new NextRequest("http://localhost/api/test", { method: "POST", body: JSON.stringify({ actor: "tester" }) }),
        { params: Promise.resolve({ id: runId }) });
      assert.equal(response.status, 200);
    })();
    await withIntake(waitForAbort(25_000), () => processNextResearchRunJob({ runId }));
    await cancel;
    assert.ok(Date.now() - started < 20_000, "the call is aborted at the next lease renewal");
    assert.deepEqual(await runRow(runId), { status: "cancelled", failure_reason: "Cancelled by tester" });
    assert.equal((await stage(runId, "intake")).status, "cancelled");
    const [job] = await jobs(runId);
    assert.equal(job.status, "failed");
    assert.equal(job.failure_reason, "Cancelled by tester");
    await assert.rejects(enqueueResearchRun(runId), /cannot be queued from status cancelled/);
    assert.deepEqual(await cancelRun(runId), { cancelled: false, status: "cancelled" });
    await failRun(runId, "a handler that ignored the abort failed late", "needs_more_work");
    assert.equal((await runRow(runId)).status, "cancelled", "cancelled stays final");
  });

  test("RO8: a ledger row whose metadata PostgreSQL rejects still records the call's cost", async () => {
    const runId = await newRun("running");
    const id = await recordModelCall({
      researchRunId: runId, agentName: "source-reader", modelProvider: "mock", modelName: "mock", modelTier: "cheap",
      costUsd: 0.25, status: "failed", errorMessage: "Provider HTTP 500: bad\u0000body",
      responseMetadata: { raw_response_excerpt: "a\u0000b", literal: "keeps \\u0000 text" },
    });
    const [row] = await sql`SELECT error_message, response_metadata_json FROM model_call_logs WHERE id = ${id}`;
    assert.equal(row.error_message, "Provider HTTP 500: badbody");
    assert.equal(row.response_metadata_json.raw_response_excerpt, "ab");
    assert.equal(row.response_metadata_json.literal, "keeps \\u0000 text");
    const [ledger] = await sql`SELECT cost_usd FROM model_budget_ledger WHERE model_call_log_id = ${id}`;
    assert.equal(Number(ledger.cost_usd), 0.25);
  });
});
