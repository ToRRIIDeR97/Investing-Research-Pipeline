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

test("staging applies the provenance check and refuses unknown schema keys (#122)", async () => {
  const { stagedOutputErrors, stageOutput, UnknownSchemaKeyError } = await import("../src/lib/agents/staging");
  const claim = { claim_text: "Revenue grew", claim_type: "operating" };
  assert.equal(stagedOutputErrors("evidence_claim", { ...claim, claim_category: "fact" })?.length, 1, "an unsourced fact");
  assert.deepEqual(stagedOutputErrors("evidence_claim", { ...claim, claim_category: "fact", no_source_reason: "management call" }), []);
  assert.deepEqual(stagedOutputErrors("evidence_claim", { ...claim, claim_category: "assumption" }), []);
  assert.ok(stagedOutputErrors("evidence_claim", { ...claim, claim_category: "fact", confidence: 7 })!.length > 0);
  for (const key of ["thesis", "toString", "__proto__", ""]) assert.equal(stagedOutputErrors(key, {}), null, key);
  await assert.rejects(stageOutput({ runId: "r", stageId: "s", taskId: "t", targetTable: "x", outputSchemaKey: "thesis",
    outputSchemaVersion: 1, payload: {}, createdByAgent: "fixture" }), UnknownSchemaKeyError);

  const { POST } = await import("../src/app/api/research-runs/[id]/stage-output/route");
  for (const body of [null, { output_schema_key: "thesis", payload: {} }, { output_schema_key: "evidence_claim" }, { output_schema_key: "evidence_claim", payload: [] }]) {
    assert.equal((await POST(post("/api/research-runs/x/stage-output", body), params(crypto.randomUUID()))).status, 400, JSON.stringify(body));
  }
  const accept = await import("../src/app/api/staging/[id]/accept/route");
  const id = crypto.randomUUID();
  assert.equal((await accept.POST(post(`/api/staging/${id}/accept`, { action: "reject" }), params(id))).status, 400);
});

test("routes answer 400, not 500, to a null body or a bad query value (#135)", async () => {
  const id = crypto.randomUUID();
  const review = await import("../src/app/api/research-runs/[id]/review/route");
  const approvePlan = await import("../src/app/api/research-runs/[id]/approve-plan/route");
  const thesis = await import("../src/app/api/thesis/[id]/route");
  for (const body of [null, [1]]) {
    assert.equal((await review.POST(post(`/api/research-runs/${id}/review`, body), params(id))).status, 400);
    assert.equal((await approvePlan.POST(post(`/api/research-runs/${id}/approve-plan`, body), params(id))).status, 400);
    const patch = new NextRequest(`http://localhost/api/thesis/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    assert.equal((await thesis.PATCH(patch, params(id))).status, 400);
  }
  // reviewed_by alone is no longer an updatable thesis field.
  const reviewerOnly = new NextRequest(`http://localhost/api/thesis/${id}`, { method: "PATCH", body: JSON.stringify({ reviewed_by: "ceo" }), headers: { "content-type": "application/json" } });
  assert.equal((await thesis.PATCH(reviewerOnly, params(id))).status, 400);

  const search = await import("../src/app/api/search/route");
  for (const query of ["limit=abc", "limit=0", "limit=2.5", "confidence_min=high", "confidence_min=2", "claim_category=fact&confidence_min=-1"]) {
    assert.equal((await search.GET(new NextRequest(`http://localhost/api/search?${query}`)))?.status, 400, query);
  }
  const traces = await import("../src/app/api/research-runs/[id]/agent-traces/route");
  for (const limit of ["abc", "0", "1001", "1.5"]) {
    assert.equal((await traces.GET(new NextRequest(`http://localhost/api/research-runs/${id}/agent-traces?limit=${limit}`), params(id))).status, 400, limit);
  }
});

test("the pipeline's export stage updates only its own memo record, never a user export (#115)", () => {
  const handler = readFileSync("src/lib/research/handlers/export.ts", "utf8");
  const update = handler.slice(handler.indexOf("UPDATE exports"), handler.indexOf("INSERT INTO exports"));
  assert.match(update, /generated_by = 'system-research-os'/);
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

    // Reject leaves an accepted row alone and answers 404 for a missing one (#122).
    const reject = (id: string) => POST(post(`/api/staging/${id}/accept`, { action: "reject", reason: "fixture" }), params(id));
    assert.equal((await reject(valid.stagingId)).status, 409);
    assert.equal((await sql`SELECT review_status FROM agent_output_staging WHERE id = ${valid.stagingId}`)[0].review_status, "accepted");
    assert.equal((await reject(crypto.randomUUID())).status, 404);
    // An unsourced fact is staged as invalid, so it can't be accepted (#122).
    const unsourced = await stage({ ...claim, claim_category: "fact" });
    assert.equal(unsourced.validationStatus, "invalid");
    assert.equal((await POST(post(`/api/staging/${unsourced.stagingId}/accept`), params(unsourced.stagingId))).status, 409);

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
