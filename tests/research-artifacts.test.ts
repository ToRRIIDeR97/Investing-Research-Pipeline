import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as coreSchema from "@/db/schema/core";
import * as workflowSchema from "@/db/schema/workflow";
import * as evidenceSchema from "@/db/schema/evidence";
import * as profilesSchema from "@/db/schema/profiles";
import * as researchArtifactsSchema from "@/db/schema/research-artifacts";
import { createArtifactRepository } from "@/lib/research/artifacts/repository";
import { acceptCurrentArtifacts } from "@/lib/research/reporting/store";

const schema = {
  ...coreSchema,
  ...workflowSchema,
  ...evidenceSchema,
  ...profilesSchema,
  ...researchArtifactsSchema,
};

describe("research-artifact registry", { skip: !process.env.RUN_DB_INTEGRATION }, () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let repo: ReturnType<typeof createArtifactRepository>;
  let assetId: string;
  let runId: string;
  const testSlug = `test-co-artifacts-${crypto.randomUUID()}`;

  before(async () => {
    const url = process.env.DATABASE_URL!;
    sql = postgres(url);
    db = drizzle(sql, { schema });
    repo = createArtifactRepository(db as any);

    const [asset] = await db
      .insert(coreSchema.assets)
      .values({
        canonical_name: "Test Co",
        slug: testSlug,
        asset_kind: "equity",
        base_currency: "USD",
      })
      .returning();
    assetId = asset.id;

    const [run] = await db
      .insert(workflowSchema.research_runs)
      .values({
        asset_id: assetId,
        run_type: "deep_dive",
        pipeline_version: 3,
        research_question: "test",
      })
      .returning();
    runId = run.id;
  });

  after(async () => {
    await sql`DELETE FROM research_artifacts WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_assumptions WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql`DELETE FROM assets WHERE slug = ${testSlug}`;
    await sql.end();
  });

  it("C1-T1: Insert a valid draft artifact", async () => {
    const artifact = await repo.upsertArtifact({
      research_run_id: runId,
      asset_id: assetId,
      artifact_type: "company_genesis",
      scope_key: "default",
      status: "draft",
      content_json: { test: true },
      schema_version: "3.0.0",
      validator_version: "1.0.0",
      prompt_version: "1.0.0",
      created_by: "test",
    });
    assert.equal(artifact.status, "draft");
    assert.equal(artifact.schema_version, "3.0.0");
  });

  const save = (artifact_type: string, content_json: Record<string, unknown>, status: "draft" | "validated" = "draft") =>
    repo.upsertArtifact({
      research_run_id: runId, asset_id: assetId, artifact_type, scope_key: "default", status, content_json,
      schema_version: "3.0.0", validator_version: "1.0.0", prompt_version: "1.0.0", created_by: "test",
    });
  const statusOf = async (id: string) => (await sql`SELECT status FROM research_artifacts WHERE id = ${id}`)[0].status;

  it("C1-T2: A retry with unchanged content keeps the current artifact", async () => {
    const a1 = await save("driver_tree", { a: 1 });
    const a2 = await save("driver_tree", { a: 1 });
    assert.equal(a2.id, a1.id);
    assert.equal(a2.artifact_version, 1);
  });

  it("C1-T3: A retry with changed content supersedes the previous version", async () => {
    const a1 = await save("segment_model", { version: 1 });
    const a2 = await save("segment_model", { version: 2 });
    assert.notEqual(a2.id, a1.id);
    assert.equal(a2.artifact_version, 2);
    assert.equal(a2.supersedes_artifact_id, a1.id);
    assert.equal(await statusOf(a1.id), "superseded");
    const current = await sql`SELECT id FROM research_artifacts WHERE research_run_id = ${runId}
      AND artifact_type = 'segment_model' AND status <> 'superseded'`;
    assert.deepEqual(current.map((r) => r.id), [a2.id]);
  });

  it("C1-T4: A human gate accepts the current version; a later change supersedes the accepted one", async () => {
    await save("gate_fixture", { version: 1 }, "validated");
    const a2 = await save("gate_fixture", { version: 2 }, "validated");
    const accepted = await acceptCurrentArtifacts(sql as any, runId, ["gate_fixture"]);
    assert.deepEqual(accepted.map((r) => r.id), [a2.id]);
    assert.equal(await statusOf(a2.id), "accepted");
    assert.equal((await repo.getCurrentArtifact(runId, "gate_fixture", "default"))?.id, a2.id);

    const unchanged = await save("gate_fixture", { version: 2 }, "validated");
    assert.equal(unchanged.id, a2.id, "re-saving accepted content keeps the accepted row");
    assert.equal(unchanged.status, "accepted");

    const a3 = await save("gate_fixture", { version: 3 }, "validated");
    assert.equal(a3.status, "validated");
    assert.equal(a3.supersedes_artifact_id, a2.id);
    assert.equal(await statusOf(a2.id), "superseded");
    await acceptCurrentArtifacts(sql as any, runId, ["gate_fixture"]);
    assert.equal(await statusOf(a3.id), "accepted");
  });

  it("C1-T5: Two accepted artifacts with the same type and scope are blocked", async () => {
    const a1 = await save("moat_assessment", { version: 1 }, "draft");
    await sql`UPDATE research_artifacts SET status = 'accepted' WHERE id = ${a1.id}`;
    await assert.rejects(sql`INSERT INTO research_artifacts (research_run_id, asset_id, artifact_type, scope_key, status, created_by)
      VALUES (${runId}, ${assetId}, 'moat_assessment', 'default', 'accepted', 'test')`);
  });

  it("C1-T8: Query an existing v2 run", async () => {
    const [v2run] = await db
      .insert(workflowSchema.research_runs)
      .values({
        asset_id: assetId,
        run_type: "deep_dive",
        pipeline_version: 2,
        research_question: "v2 test",
      })
      .returning();
    const artifacts = await repo.getCurrentArtifact(v2run.id, "company_genesis", "default");
    assert.equal(artifacts, null);
    await sql`DELETE FROM research_runs WHERE id = ${v2run.id}`;
  });
});
