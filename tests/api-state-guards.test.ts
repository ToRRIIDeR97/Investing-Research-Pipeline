import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import postgres from "postgres";
import { NextRequest } from "next/server";

function loadLocalEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

const post = (url: string, body?: unknown) => new NextRequest(`http://localhost${url}`, {
  method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });

test("the /advance route that bypassed the run lock, handlers and job lease is gone (#16)", () => {
  assert.equal(existsSync("src/app/api/research-runs/[id]/advance/route.ts"), false);
});

test("only a valid, unreviewed staged output is promoted, and only once (S5)", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  loadLocalEnv();
  const { stageOutput, rejectStagedOutput } = await import("../src/lib/agents/staging");
  const { POST } = await import("../src/app/api/staging/[id]/accept/route");
  const sql = postgres(process.env.DATABASE_URL!);
  const runId = crypto.randomUUID(), stageId = crypto.randomUUID(), taskId = crypto.randomUUID();
  try {
    const [asset] = await sql`SELECT id FROM assets ORDER BY created_at LIMIT 1`;
    await sql`INSERT INTO research_runs (id, asset_id, run_type, status, pipeline_version) VALUES (${runId}, ${asset.id}, 'deep_dive', 'running', 3)`;
    await sql`INSERT INTO research_stages (id, research_run_id, stage_key, stage_order) VALUES (${stageId}, ${runId}, 'evidence_extraction', 1)`;
    await sql`INSERT INTO research_tasks (id, research_run_id, stage_id, task_key, task_type) VALUES (${taskId}, ${runId}, ${stageId}, 'staging-fixture', 'fixture')`;
    const stage = (payload: Record<string, unknown>) => stageOutput({ runId, stageId, taskId, targetTable: "evidence_claims",
      outputSchemaKey: "evidence_claim", outputSchemaVersion: 1, payload, createdByAgent: "fixture" });
    const claim = { claim_text: "Fixture assumption", claim_type: "operating", claim_category: "assumption" };
    const claims = async () => Number((await sql`SELECT count(*) FROM evidence_claims WHERE research_run_id = ${runId}`)[0].count);

    const invalid = await stage({ ...claim, confidence: 7 });
    assert.equal(invalid.validationStatus, "invalid");
    assert.equal((await POST(post(`/api/staging/${invalid.stagingId}/accept`), params(invalid.stagingId))).status, 409);

    const rejected = await stage(claim);
    await rejectStagedOutput(rejected.stagingId, "fixture");
    assert.equal((await POST(post(`/api/staging/${rejected.stagingId}/accept`), params(rejected.stagingId))).status, 409);
    assert.equal(await claims(), 0);

    const valid = await stage(claim);
    const accepted = await POST(post(`/api/staging/${valid.stagingId}/accept`), params(valid.stagingId));
    assert.equal(accepted.status, 200);
    assert.equal((await POST(post(`/api/staging/${valid.stagingId}/accept`), params(valid.stagingId))).status, 409);
    assert.equal(await claims(), 1);

    // Two accepts racing on one row promote it once.
    const raced = await stage(claim);
    const statuses = (await Promise.all([1, 2].map(() => POST(post(`/api/staging/${raced.stagingId}/accept`), params(raced.stagingId)))))
      .map((response) => response.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(await claims(), 2);
    const [row] = await sql`SELECT review_status, target_record_id FROM agent_output_staging WHERE id = ${raced.stagingId}`;
    assert.equal(row.review_status, "accepted");
    assert.ok(row.target_record_id);

    assert.equal((await POST(post("/api/staging/not-a-uuid/accept"), params("not-a-uuid"))).status, 400);
  } finally {
    await sql`DELETE FROM agent_output_staging WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM evidence_claims WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_tasks WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_stages WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql.end();
  }
});

test("evidence review accepts only known statuses and never trusts reviewed_by from the body (#13)", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  loadLocalEnv();
  const { PATCH } = await import("../src/app/api/evidence/[id]/review/route");
  const { db } = await import("../src/db");
  const sql = postgres(process.env.DATABASE_URL!);
  const runId = crypto.randomUUID(), claimId = crypto.randomUUID();
  const patch = (body: unknown) => PATCH(new NextRequest(`http://localhost/api/evidence/${claimId}/review`, {
    method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }), params(claimId));
  try {
    const [asset] = await sql`SELECT id FROM assets ORDER BY created_at LIMIT 1`;
    await sql`INSERT INTO research_runs (id, asset_id, run_type, status, pipeline_version) VALUES (${runId}, ${asset.id}, 'deep_dive', 'running', 3)`;
    await sql`INSERT INTO evidence_claims (id, asset_id, research_run_id, claim_text, claim_type, claim_category, generated_by)
      VALUES (${claimId}, ${asset.id}, ${runId}, 'Review fixture', 'operating', 'fact', 'fixture')`;

    for (const body of [{ review_status: "approved_by_admin" }, { review_status: "" }, {}, { reviewed_by: "ceo" }]) {
      assert.equal((await patch(body)).status, 400, JSON.stringify(body));
    }
    const [unchanged] = await sql`SELECT review_status, reviewed_by FROM evidence_claims WHERE id = ${claimId}`;
    assert.equal(unchanged.review_status, "pending");

    const response = await patch({ review_status: "accepted", reviewed_by: "ceo" });
    assert.equal(response.status, 200);
    const [reviewed] = await sql`SELECT review_status, reviewed_by FROM evidence_claims WHERE id = ${claimId}`;
    assert.equal(reviewed.review_status, "accepted");
    assert.equal(reviewed.reviewed_by, "api:unauthenticated");
  } finally {
    await sql`DELETE FROM evidence_claims WHERE id = ${claimId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql.end();
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  }
});
