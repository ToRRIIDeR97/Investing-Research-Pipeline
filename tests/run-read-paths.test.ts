// Polled run read paths must not load the stored task packets or send artifact bodies more than once.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { NextRequest } from "next/server";

const skip = process.env.RUN_DB_INTEGRATION !== "1";
if (!process.env.DATABASE_URL && existsSync(".env.local")) {
  const line = readFileSync(".env.local", "utf8").split(/\r?\n/).find(l => l.startsWith("DATABASE_URL="));
  if (line) process.env.DATABASE_URL = line.slice("DATABASE_URL=".length).trim().replace(/^['"]|['"]$/g, "");
}

// The run route uses the app's shared clients; close them so the test process can exit.
after(async () => {
  if (skip) return;
  const { db, sqlClient } = await import("../src/db");
  await Promise.all([db.$client.end(), sqlClient.end()]);
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

test("analysis coverage matches artifact names first and serialises bodies only while a module is uncovered", async () => {
  const { evaluateQualityGates } = await import("../src/lib/workflow/quality-gates");
  let serialised = 0;
  const body = (text: string) => ({ toJSON() { serialised += 1; return { text }; } });
  const result = (modules: string[], artifacts: { artifact_type: string; status: string; text: string }[]) => evaluateQualityGates({
    run: { run_type: "deep_dive", pipeline_version: 3 },
    profile: { required_modules_json: modules },
    artifacts: artifacts.map(({ artifact_type, status, text }) => ({ artifact_type, status, content_json: body(text) })),
  });
  const artifacts = [
    { artifact_type: "moat_assessment", status: "validated", text: "switching costs" },
    { artifact_type: "operating_model", status: "validated", text: "unit_economics by cohort" },
    { artifact_type: "decision_record", status: "validated", text: "hold" },
    { artifact_type: "company_genesis", status: "draft", text: "founder_story" },
  ];
  result(["moat_assessment"], artifacts);
  assert.equal(serialised, 0, "a module named by an artifact type needs no body");
  const missing = (r: ReturnType<typeof result>) => r.missingCoverage.filter(item => item.area === "analysis coverage").map(item => item.key);
  serialised = 0;
  assert.deepEqual(missing(result(["moat_assessment", "unit_economics"], artifacts)), []);
  assert.equal(serialised, 2, "serialisation stops once every module is covered");
  assert.deepEqual(missing(result(["founder_story", "unit_economics"], artifacts)), ["analysis_founder_story"],
    "draft artifacts do not count as coverage");
});

test("the artifacts route honours ?type= and sends each body once; the report sends report_document once", { skip }, async () => {
  const { GET } = await import("../src/app/api/research-runs/[id]/artifacts/route");
  const { getResearchRunReport } = await import("../src/lib/research/artifacts/read-model");
  const sql = postgres(process.env.DATABASE_URL!);
  const f = await fixture(sql, 3);
  try {
    const artifact = (type: string, content: unknown) => sql`INSERT INTO research_artifacts
      (research_run_id, asset_id, artifact_type, scope_key, status, content_json, validation_result_json, created_by)
      VALUES (${f.runId}, ${f.assetId}, ${type}, 'run', 'validated', ${sql.json(content as any)}, ${sql.json({ ok: true })}, 'test')`;
    await artifact("research_plan", { research_question: "Plan question" });
    await artifact("financial_statement_set", { tables: ["t".repeat(1000)] });
    await artifact("report_document", { title: "Report", markdown: "m".repeat(1000) });
    const response = await GET(new NextRequest("http://localhost/api/test?type=research_plan"), params(f.runId));
    const { artifacts } = await response.json();
    assert.deepEqual(artifacts.map((a: any) => a.type), ["research_plan"]);
    assert.deepEqual(artifacts[0].content_json, { research_question: "Plan question" });
    assert.equal("content" in artifacts[0], false);
    assert.equal("validation_result" in artifacts[0], false);
    const report = await getResearchRunReport(f.runId);
    assert.ok(report);
    assert.equal("artifacts_by_type" in report, false);
    assert.equal(report.report_document?.title, "Report");
    assert.deepEqual(report.artifacts.find(a => a.type === "report_document")?.content_json, {});
    const serialised = JSON.stringify(report);
    assert.equal(serialised.split("m".repeat(1000)).length - 1, 1, "the report markdown is sent once");
    assert.equal(serialised.split("t".repeat(1000)).length - 1, 1, "an artifact body is sent once");
  } finally { await f.cleanup(); await sql.end(); }
});

test("a summary report leaves out large bodies and the report document's artifact copies", { skip }, async () => {
  const { getResearchRunReport } = await import("../src/lib/research/artifacts/read-model");
  const sql = postgres(process.env.DATABASE_URL!);
  const f = await fixture(sql, 3);
  try {
    const artifact = (type: string, content: unknown) => sql`INSERT INTO research_artifacts
      (research_run_id, asset_id, artifact_type, scope_key, status, content_json, validation_result_json, created_by)
      VALUES (${f.runId}, ${f.assetId}, ${type}, 'run', 'validated', ${sql.json(content as any)}, ${sql.json({ ok: true })}, 'test')`;
    // Random hex barely compresses, so these bodies stay over the stored-size limit.
    const large = () => randomBytes(100_000).toString("hex");
    await artifact("financial_statement_set", { tables: [large()] });
    await artifact("investment_thesis", { thesis: large() });
    await artifact("research_plan", { research_question: "Plan question" });
    await artifact("report_document", { title: "Report", evidence: [{ id: "e1" }], artifacts: [{ id: "a1", content_json: { tables: [large()] } }] });

    const summary = await getResearchRunReport(f.runId, undefined, { summary: true });
    assert.ok(summary);
    assert.equal(summary.summary, true);
    const byType = Object.fromEntries(summary.artifacts.map((a) => [a.type, a]));
    assert.equal(byType.financial_statement_set.content_omitted, true);
    assert.deepEqual(byType.financial_statement_set.content_json, {});
    assert.equal(byType.investment_thesis.content_omitted, undefined, "the overview's own types are always sent");
    assert.equal(String(byType.investment_thesis.content_json.thesis).length, 200_000);
    assert.deepEqual(byType.research_plan.content_json, { research_question: "Plan question" });
    assert.deepEqual(summary.report_document, { title: "Report", evidence: [{ id: "e1" }] });

    const full = await getResearchRunReport(f.runId);
    assert.ok(full);
    assert.equal(full.summary, false);
    assert.equal(full.artifacts.some((a) => a.content_omitted), false);
    assert.equal((full.report_document?.artifacts as unknown[] | undefined)?.length, 1);
    assert.equal(String(full.artifacts.find((a) => a.type === "financial_statement_set")?.content_json.tables).length, 200_000);
  } finally { await f.cleanup(); await sql.end(); }
});
