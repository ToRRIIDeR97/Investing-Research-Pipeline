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

  it("C1-T2: Accept an artifact without validation metadata", async () => {
    const artifact = await repo.upsertArtifact({
      research_run_id: runId,
      asset_id: assetId,
      artifact_type: "historical_diagnosis",
      scope_key: "default",
      status: "draft",
      content_json: {},
      schema_version: "3.0.0",
      validator_version: "1.0.0",
      prompt_version: "1.0.0",
      created_by: "test",
    });
    const check = await repo.acceptArtifact(artifact.id, {});
    assert.equal(check.canAccept, false);
    assert.ok(check.errors.some((e) => e.includes("Validation metadata is missing")));
  });

  it("C1-T3: Accept two current artifacts with the same type and scope", async () => {
    const a1 = await repo.upsertArtifact({
      research_run_id: runId,
      asset_id: assetId,
      artifact_type: "segment_model",
      scope_key: "default",
      status: "draft",
      content_json: { version: 1 },
      schema_version: "3.0.0",
      validator_version: "1.0.0",
      prompt_version: "1.0.0",
      created_by: "test",
    });
    await repo.acceptArtifact(a1.id, { valid: true, errors: [], warnings: [] });

    let threw = false;
    try {
      const a2 = await repo.upsertArtifact({
        research_run_id: runId,
        asset_id: assetId,
        artifact_type: "segment_model",
        scope_key: "default",
        status: "draft",
        content_json: { version: 2 },
        schema_version: "3.0.0",
        validator_version: "1.0.0",
        prompt_version: "1.0.0",
        created_by: "test",
      });
      await repo.acceptArtifact(a2.id, { valid: true, errors: [], warnings: [] });
    } catch (err) {
      threw = true;
    }
    assert.ok(threw, "Duplicate accepted artifact should be blocked by unique partial index");
  });

  it("C1-T4: Supersede an accepted artifact", async () => {
    const a1 = await repo.upsertArtifact({
      research_run_id: runId,
      asset_id: assetId,
      artifact_type: "moat_assessment",
      scope_key: "default",
      status: "draft",
      content_json: { version: 1 },
      schema_version: "3.0.0",
      validator_version: "1.0.0",
      prompt_version: "1.0.0",
      created_by: "test",
    });
    await repo.acceptArtifact(a1.id, { valid: true, errors: [], warnings: [] });

    await repo.supersedeArtifact(a1.id, a1.id); // mark itself as superseded for test simplicity
    const [updated] = await db
      .select()
      .from(researchArtifactsSchema.research_artifacts)
      .where(eq(researchArtifactsSchema.research_artifacts.id, a1.id))
      .limit(1);
    assert.equal(updated.status, "superseded");
  });

  it("C1-T7: Retry the same idempotency key", async () => {
    const key = "idem-test-1";
    const a1 = await repo.upsertArtifact({
      research_run_id: runId,
      asset_id: assetId,
      artifact_type: "driver_tree",
      scope_key: "default",
      status: "draft",
      content_json: { a: 1 },
      schema_version: "3.0.0",
      validator_version: "1.0.0",
      prompt_version: "1.0.0",
      created_by: "test",
      idempotency_key: key,
    });
    const a2 = await repo.upsertArtifact({
      research_run_id: runId,
      asset_id: assetId,
      artifact_type: "driver_tree",
      scope_key: "default",
      status: "draft",
      content_json: { a: 2 },
      schema_version: "3.0.0",
      validator_version: "1.0.0",
      prompt_version: "1.0.0",
      created_by: "test",
      idempotency_key: key,
    });
    assert.equal(a1.id, a2.id);
  });

  it("revalidates the same artifact after a rejected attempt", async () => {
    const rejected = await repo.upsertArtifact({
      research_run_id: runId,
      asset_id: assetId,
      artifact_type: "historical_record",
      scope_key: "retryable",
      status: "rejected",
      content_json: { version: 1 },
      schema_version: "3.0.0",
      validator_version: "1.0.0",
      prompt_version: "1.0.0",
      created_by: "test",
      idempotency_key: "retryable-artifact",
    });
    const retried = await repo.upsertArtifact({
      research_run_id: runId,
      asset_id: assetId,
      artifact_type: "historical_record",
      scope_key: "retryable",
      status: "validated",
      content_json: { version: 2 },
      schema_version: "3.0.0",
      validator_version: "1.0.0",
      prompt_version: "1.0.0",
      created_by: "test",
      idempotency_key: "retryable-artifact",
    });
    assert.equal(retried.id, rejected.id);
    assert.equal(retried.status, "validated");
    assert.deepEqual(retried.content_json, { version: 2 });
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
