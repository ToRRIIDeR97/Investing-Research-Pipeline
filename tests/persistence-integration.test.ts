import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import postgres from "postgres";
import { recordModelCall, assertModelBudgetAvailable, releaseModelBudgetReservation } from "../src/lib/agents/model-calls";
import { createMessage } from "../src/lib/agent-harness/messages";
import { PostgresAgentSessionStore } from "../src/lib/agent-harness/session-store";
import { createV3Task, callResearchAgentArtifacts, type ResearchRunContext } from "../src/lib/research/run-context";
import { BUSINESS_PROCESS_CONTRACT } from '../src/lib/research/stage-contracts';
import { requestFocusedReviewRepair } from '../src/lib/research/review-repairs';
import { mergeGroupOutputs } from "../src/lib/research/system-pipeline";
import { failRun } from "../src/lib/workflow/orchestrator";
import { enqueueTask } from "../src/lib/workflow/task-queue";

function loadLocalEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

test('split tasks survive sibling failure and persisted effort cannot reset on resume', { skip: process.env.RUN_DB_INTEGRATION !== '1' }, async () => {
  loadLocalEnv();
  const provider = process.env.RESEARCH_MODEL_PROVIDER;
  process.env.RESEARCH_MODEL_PROVIDER = 'mock';
  const sql = postgres(process.env.DATABASE_URL!);
  const runId = crypto.randomUUID();
  try {
    const [asset] = await sql`SELECT id FROM assets ORDER BY created_at LIMIT 1`;
    await sql`INSERT INTO research_runs (id, asset_id, run_type, status, pipeline_version, budget_limit_usd)
      VALUES (${runId}, ${asset.id}, 'deep_dive', 'running', 4, 100)`;
    const [stage] = await sql`INSERT INTO research_stages (research_run_id, stage_key, stage_order, status)
      VALUES (${runId}, 'business_process_analysis', 1, 'running') RETURNING id`;
    const ctx = { runId, assetId: String(asset.id), assetName: 'SOFI fixture', assetSlug: 'sofi-fixture', symbol: 'SOFI',
      profileId: null, profileKey: 'financials', runType: 'deep_dive', pipelineVersion: 4, testMode: true } as ResearchRunContext;
    let injectFailure = true;
    const saved = new Set<string>();
    const execute = () => callResearchAgentArtifacts({ sql, ctx, stageKey: 'business_process_analysis', taskKeyPrefix: 'fixture',
      taskType: 'fixture', agentName: 'asset-analyst', packet: { asset: { symbol: 'SOFI' }, evidence_claims: [] },
      outputFormat: BUSINESS_PROCESS_CONTRACT, artifactWaves: [['segment_model', 'customer_decision_map']],
      promptFactory: (packet) => `Task packet:\n${JSON.stringify(packet)}`,
      onArtifact: (key) => { if (key === 'customer_decision_map' && injectFailure) throw new Error('Injected checkpoint-write failure'); saved.add(key); },
    });
    await assert.rejects(execute(), /Injected checkpoint-write failure/);
    assert.ok(saved.has('segment_model'));
    const [before] = await sql`SELECT COUNT(*) AS count FROM model_call_logs WHERE research_run_id = ${runId}`;
    assert.equal(Number(before.count), 2);
    injectFailure = false;
    await execute();
    const [after] = await sql`SELECT COUNT(*) AS count FROM model_call_logs WHERE research_run_id = ${runId}`;
    assert.equal(Number(after.count), 2, 'Resume must use both successful model outputs without a paid repeat');
    assert.ok(saved.has('customer_decision_map'));
    const findings = [{ severity: 'blocker', artifact_refs: ['segment_model'], message: 'Segment support is incomplete.' }];
    assert.equal(await requestFocusedReviewRepair(sql, runId, findings), true);
    assert.equal(await requestFocusedReviewRepair(sql, runId, findings), false, 'Only one persisted repair round is allowed');
    const repairedTasks = await sql`SELECT task_key, status FROM research_tasks WHERE research_run_id = ${runId}`;
    assert.equal(repairedTasks.find((row) => row.task_key.includes(':segment_model:'))?.status, 'failed');
    assert.equal(repairedTasks.find((row) => row.task_key.includes(':customer_decision_map:'))?.status, 'completed');
    const segmentTask = repairedTasks.find((row) => row.task_key.includes(':segment_model:'))!;
    const revision = await createV3Task(sql, runId, 'business_process_analysis', String(segmentTask.task_key), 'fixture', 'asset-analyst');
    assert.ok(revision.priorValidationErrors.some((error) => error.includes('Segment support is incomplete.')));
    const [task] = await sql`SELECT id, task_key FROM research_tasks WHERE research_run_id = ${runId} ORDER BY task_key LIMIT 1`;
    const reserve = () => assertModelBudgetAvailable({ researchRunId: runId, stageId: String(stage.id), taskId: String(task.id),
      modelTier: 'mid', reserveUsd: 0, checkpointKey: String(task.task_key), checkpointAttemptLimit: 2, stageAttemptLimit: 3 });
    const reservations = await Promise.allSettled([reserve(), reserve()]);
    assert.equal(reservations.filter((result) => result.status === 'fulfilled').length, 1);
    for (const result of reservations) if (result.status === 'fulfilled' && result.value) await releaseModelBudgetReservation(result.value);
    await assert.rejects(reserve(), /budget exhausted/i, 'Released reservations must still count toward effort');
    await sql`INSERT INTO research_stages (research_run_id, stage_key, stage_order, status)
      VALUES (${runId}, 'evidence_extraction', 2, 'running')`;
    for (let index = 0; index < 10; index++) await createV3Task(sql, runId, 'evidence_extraction', `batch:${index}`, 'fixture', 'source-reader');
    await assert.rejects(createV3Task(sql, runId, 'evidence_extraction', 'batch:overflow', 'fixture', 'source-reader'), /logical batch budget exhausted/);
  } finally {
    await sql`DELETE FROM agent_sessions WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM agent_output_staging WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM model_budget_ledger WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM model_call_logs WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM model_budget_reservations WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_tasks WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_stages WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql.end();
    if (provider === undefined) delete process.env.RESEARCH_MODEL_PROVIDER;
    else process.env.RESEARCH_MODEL_PROVIDER = provider;
  }
});

test("JSONB task-style outputs survive object and legacy-string persistence and group merging", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  loadLocalEnv();
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    await sql`CREATE TEMP TABLE harness_output_test (id serial PRIMARY KEY, output_json jsonb)`;
    const objectOutput = { analysis_sections: [{ section_key: "commerce" }], confidence: 0.9 };
    const legacyOutput = JSON.stringify({ analysis_sections: [{ section_key: "fintech" }], confidence: 0.8 });
    await sql`INSERT INTO harness_output_test (output_json) VALUES (${sql.json(objectOutput as any)}), (${legacyOutput}::jsonb)`;
    const rows = await sql`SELECT output_json FROM harness_output_test ORDER BY id`;
    const merged = mergeGroupOutputs(rows.map((row) => row.output_json as any));
    assert.deepEqual(merged.analysis_sections.map((section: any) => section.section_key), ["commerce", "fintech"]);
    assert.equal(merged.confidence, 0.85);
  } finally { await sql.end(); }
});

test("model-call attempts persist structured audit metadata", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  loadLocalEnv();
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const sql = postgres(process.env.DATABASE_URL!);
  let callId: string | undefined;
  try {
    callId = await recordModelCall({
      modelProvider: "integration-fixture", modelName: "fixture-model", modelTier: "mid", status: "success",
      inputTokens: 7, outputTokens: 11, costUsd: 0, latencyMs: 13,
      requestMetadata: { attempt: 2, fallback: true, compaction_occurred: true },
      responseMetadata: {
        request_id: "fixture-request", repair_attempted: true, timeout_type: null,
        validation_errors: [], raw_response_excerpt: "{\"ok\":true}", tool_calls: [],
      },
    });
    const [row] = await sql`SELECT request_metadata_json, response_metadata_json FROM model_call_logs WHERE id = ${callId}`;
    assert.equal(row.request_metadata_json.attempt, 2);
    assert.equal(row.request_metadata_json.fallback, true);
    assert.equal(row.response_metadata_json.request_id, "fixture-request");
    assert.equal(row.response_metadata_json.repair_attempted, true);
    assert.deepEqual(row.response_metadata_json.validation_errors, []);
  } finally {
    if (callId) {
      await sql`DELETE FROM model_budget_ledger WHERE model_call_log_id = ${callId}`;
      await sql`DELETE FROM model_call_logs WHERE id = ${callId}`;
    }
    await sql.end();
  }
});

test("idempotent task resume and terminal failure leave no running work or valuation stage", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  loadLocalEnv();
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const sql = postgres(process.env.DATABASE_URL!);
  const runId = crypto.randomUUID();
  let taskId: string | undefined;
  try {
    const [asset] = await sql`SELECT id FROM assets ORDER BY created_at LIMIT 1`;
    assert.ok(asset?.id, "At least one seeded asset is required");
    await sql`
      INSERT INTO research_runs (id, asset_id, run_type, status, pipeline_version)
      VALUES (${runId}, ${asset.id}, 'deep_dive', 'running', 2)
    `;
    const [analysis] = await sql`
      INSERT INTO research_stages (research_run_id, stage_key, stage_order, status)
      VALUES (${runId}, 'asset_analysis', 1, 'running') RETURNING id
    `;
    await sql`
      INSERT INTO research_stages (research_run_id, stage_key, stage_order, status)
      VALUES (${runId}, 'asset_valuation', 2, 'pending')
    `;
    const auditTask = await createV3Task(sql, runId, "asset_analysis", "v3-json-fixture", "analysis", "asset-analyst");
    const [persistedInput] = await sql`SELECT input_json, jsonb_typeof(input_json) AS input_type FROM research_tasks WHERE id = ${auditTask.id}`;
    assert.equal(persistedInput.input_type, "object");
    assert.deepEqual(persistedInput.input_json, { system_generated: true, pipeline_version: 4 });
    taskId = await enqueueTask({
      runId, stageId: analysis.id, taskKey: "analysis-fixture", taskType: "analysis",
      agentName: "asset-analyst", inputJson: { packet: "fixture" },
    });
    const resumedTaskId = await enqueueTask({
      runId, stageId: analysis.id, taskKey: "analysis-fixture", taskType: "analysis",
      agentName: "asset-analyst", inputJson: { packet: "fixture" },
    });
    assert.equal(resumedTaskId, taskId);
    await sql`UPDATE research_tasks SET status = 'running', started_at = NOW() WHERE id = ${taskId}`;

    await failRun(runId, "integration analysis failure");

    const [running] = await sql`SELECT count(*)::int count FROM research_tasks WHERE research_run_id = ${runId} AND status = 'running'`;
    const [valuation] = await sql`SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'asset_valuation'`;
    const [task] = await sql`SELECT status, completed_at FROM research_tasks WHERE id = ${taskId}`;
    assert.equal(running.count, 0);
    assert.equal(valuation.status, "cancelled");
    assert.equal(task.status, "failed");
    assert.ok(task.completed_at);
  } finally {
    await sql`DELETE FROM research_tasks WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_stages WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql.end();
  }
});

test("Postgres agent sessions replay ordered messages, events, permissions, and tool settlement", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  loadLocalEnv();
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const sql = postgres(process.env.DATABASE_URL!);
  const runId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  let stageId: string | undefined;
  let taskId: string | undefined;
  try {
    const [asset] = await sql`SELECT id FROM assets ORDER BY created_at LIMIT 1`;
    assert.ok(asset?.id, "At least one seeded asset is required");
    await sql`
      INSERT INTO research_runs (id, asset_id, run_type, status, pipeline_version)
      VALUES (${runId}, ${asset.id}, 'deep_dive', 'running', 4)
    `;
    const [stage] = await sql`
      INSERT INTO research_stages (research_run_id, stage_key, stage_order, status)
      VALUES (${runId}, 'agent-session-fixture', 1, 'running') RETURNING id
    `;
    const fixtureStageId = String(stage.id);
    stageId = fixtureStageId;
    const [task] = await sql`
      INSERT INTO research_tasks (research_run_id, stage_id, task_key, task_type, agent_name, status)
      VALUES (${runId}, ${fixtureStageId}, 'agent-session-fixture', 'analysis', 'research-assistant', 'running') RETURNING id
    `;
    taskId = task.id;

    const store = new PostgresAgentSessionStore(sql);
    const created = await store.createSession({
      id: sessionId, researchRunId: runId, stageId, taskId,
      agentName: "research-assistant", metadata: { fixture: true },
    });
    const message = createMessage("user", [{ type: "text", text: "fixture" }], `message-${crypto.randomUUID()}`);
    const firstMessage = await store.appendMessage(created.id, message);
    const replayedMessage = await store.appendMessage(created.id, { ...message, parts: [{ text: "fixture", type: "text" } as any] });
    assert.equal(replayedMessage.sequence, firstMessage.sequence);

    const firstEvent = await store.appendEvent(created.id, "fixture.event", { alpha: 1, nested: { beta: 2 } }, { idempotencyKey: "fixture-event" });
    const replayedEvent = await store.appendEvent(created.id, "fixture.event", { nested: { beta: 2 }, alpha: 1 }, { idempotencyKey: "fixture-event" });
    assert.equal(replayedEvent.id, firstEvent.id);
    await store.recordPermission?.({
      id: crypto.randomUUID(), sessionId: created.id, agentName: "research-assistant",
      toolCallId: "fixture-call", toolName: "fixture-tool", action: "tool:fixture-tool",
      resource: "fixture", input: { value: 1 },
    }, "allow_always");
    await store.recordToolTrace?.({
      sessionId: created.id, researchRunId: runId, taskId,
      agentName: "research-assistant", toolCallId: "fixture-call", toolName: "fixture-tool",
      input: { value: 1 }, status: "running",
    });
    await store.recordToolTrace?.({
      sessionId: created.id, researchRunId: runId, taskId,
      agentName: "research-assistant", toolCallId: "fixture-call", toolName: "fixture-tool",
      input: { value: 1 }, output: { ok: true }, status: "completed", durationMs: 3,
    });
    await store.updateSession(created.id, { status: "completed", result: { structured: { ok: true } } });
    await store.appendEvent(created.id, "session.completed", { ok: true }, { idempotencyKey: "fixture-completed" });

    const resumed = await store.createSession({
      id: sessionId, researchRunId: runId, stageId, taskId, agentName: "research-assistant",
    });
    assert.deepEqual(resumed.result, { structured: { ok: true } });
    assert.equal((await store.listMessages(created.id)).length, 1);
    assert.deepEqual((await store.listEvents(created.id)).map((event) => event.sequence), [1, 2]);
    const [permission] = await sql`SELECT status, decision FROM agent_permission_requests WHERE session_id = ${sessionId}`;
    const [trace] = await sql`SELECT status, tool_output_json FROM agent_traces WHERE session_id = ${sessionId}`;
    assert.deepEqual(permission, { status: "resolved", decision: "allow_always" });
    assert.equal(trace.status, "completed");
    assert.deepEqual(trace.tool_output_json, { ok: true });
  } finally {
    await sql`DELETE FROM agent_sessions WHERE id = ${sessionId}`;
    if (taskId) await sql`DELETE FROM research_tasks WHERE id = ${taskId}`;
    if (stageId) await sql`DELETE FROM research_stages WHERE id = ${stageId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql.end();
  }
});
