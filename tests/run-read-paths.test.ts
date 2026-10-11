// Polled run read paths must not load the stored task packets or send artifact bodies more than once.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { NextRequest } from "next/server";

const skip = process.env.RUN_DB_INTEGRATION !== "1";
if (!process.env.DATABASE_URL && existsSync(".env.local")) {
  const line = readFileSync(".env.local", "utf8").split(/\r?\n/).find(l => l.startsWith("DATABASE_URL="));
  if (line) process.env.DATABASE_URL = line.slice("DATABASE_URL=".length).trim().replace(/^['"]|['"]$/g, "");
}

// The run route uses the app's shared client; close it so the test process can exit.
after(async () => {
  if (!skip) await (await import("../src/db")).db.$client.end();
});

const packet = { packet: { filler: "x".repeat(10_000) }, prompt: "y".repeat(10_000) };
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function fixture(sql: postgres.Sql, pipelineVersion: number) {
  const assetId = randomUUID(), runId = randomUUID();
  await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind, status, base_currency)
    VALUES (${assetId}, 'Read Path Co', ${`read-path-${assetId.slice(0, 8)}`}, 'equity', 'active', 'USD')`;
  await sql`INSERT INTO research_runs (id, asset_id, run_type, status, source_cutoff_at, pipeline_version)
    VALUES (${runId}, ${assetId}, 'deep_dive', 'waiting_for_human', '2026-10-01', ${pipelineVersion})`;
  const [stage] = await sql`INSERT INTO research_stages (research_run_id, stage_key, stage_order, status)
    VALUES (${runId}, 'ai_reviewer', 21, 'completed') RETURNING id`;
  const task = (key: string, type: string, status: string, at: string, output: unknown) => sql`INSERT INTO research_tasks
    (research_run_id, stage_id, task_key, task_type, agent_name, status, input_json, output_json, created_at)
    VALUES (${runId}, ${stage.id}, ${key}, ${type}, 'research-reviewer', ${status}, ${sql.json(packet)}, ${sql.json(output as any)}, ${at})`;
  await task("review:old", "ai_review", "completed", "2026-10-01T00:00:00Z", { pass_fail: "fail" });
  await task("review:new", "ai_review", "completed", "2026-10-02T00:00:00Z", { pass_fail: "pass" });
  await task("review:running", "ai_review", "running", "2026-10-03T00:00:00Z", null);
  await task("brief:data", "team_brief", "completed", "2026-10-01T00:00:00Z", { brief: "plan" });
  const cleanup = async () => {
    await sql`DELETE FROM research_artifacts WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_tasks WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_stages WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql`DELETE FROM assets WHERE id = ${assetId}`;
  };
  return { assetId, runId, cleanup };
}

test("the run route returns task metadata without the stored packets or outputs", { skip }, async () => {
  const { GET } = await import("../src/app/api/research-runs/[id]/route");
  const sql = postgres(process.env.DATABASE_URL!);
  const f = await fixture(sql, 3);
  try {
    const response = await GET(new NextRequest("http://localhost/api/test"), params(f.runId));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.tasks.length, 4);
    for (const task of body.tasks) {
      assert.equal("input_json" in task, false);
      assert.equal("output_json" in task, false);
      assert.ok(task.task_key && task.status && task.stage_id);
    }
  } finally { await f.cleanup(); await sql.end(); }
});

test("v3 quality data loads only the latest completed AI review task; earlier pipelines keep every task's output", { skip }, async () => {
  const { loadRunQualityData } = await import("../src/lib/workflow/quality-gates");
  const sql = postgres(process.env.DATABASE_URL!);
  const v3 = await fixture(sql, 3), v2 = await fixture(sql, 2);
  try {
    const current = await loadRunQualityData(sql, v3.runId);
    assert.equal(current.tasks.length, 1);
    assert.equal(current.tasks[0].task_key, "review:new");
    assert.deepEqual(current.tasks[0].output_json, { pass_fail: "pass" });
    assert.equal("input_json" in current.tasks[0], false);
    const legacy = await loadRunQualityData(sql, v2.runId);
    assert.equal(legacy.tasks.length, 4);
    assert.ok(legacy.tasks.every(task => !("input_json" in task) && "output_json" in task && "validation_result_json" in task));
  } finally { await v3.cleanup(); await v2.cleanup(); await sql.end(); }
});
