import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { createReport, assertReportApproval } from "../../../src/lib/research/reporting/report";
import { loadReportInputs, saveReportArtifact, getReportState } from "../../../src/lib/research/reporting/store";
import { NextRequest } from "next/server";
import { POST as reviewReport } from "../../../src/app/api/research-runs/[id]/review/route";

test("AC-5/8: restart reads immutable report revisions and rejects changed upstream input", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const assetId = randomUUID(), runId = randomUUID();
  const ctx = { assetId, runId, assetSlug: `adaptive-qa-${assetId.slice(0, 8)}` };
  try {
    await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind, status, base_currency)
      VALUES (${assetId}, 'Adaptive report QA retailer', ${ctx.assetSlug}, 'equity', 'active', 'USD')`;
    await sql`INSERT INTO research_runs (id, asset_id, run_type, status, source_cutoff_at, pipeline_version)
      VALUES (${runId}, ${assetId}, 'deep_dive', 'waiting_for_human', '2026-09-01', 3)`;
    await sql`INSERT INTO research_stages (research_run_id, stage_key, stage_order, status)
      VALUES (${runId}, 'human_review', 22, 'waiting_for_human')`;
    await saveReportArtifact(sql, ctx, "research_plan", "plan", { report_standard: { version: "test" } });
    const model = await saveReportArtifact(sql, ctx, "operating_model", "model", { rows: [
      { year: 2024, core_operating_cash: 120, expansion_spending: 45, residual_cash: 75 },
      { year: 2025, core_operating_cash: 140, expansion_spending: 85, residual_cash: 55 },
    ] });
    const inputs = await loadReportInputs(sql, runId, "2026-09-01");
    const section = { id: "cash", title: "Why stronger retail economics can leave less cash for shareholders", purpose: "Test capital allocation",
      coverage: ["management"], artifact_ids: [model.id],
      paragraphs: [{ kind: "analysis" as const, text: "The core operation generates more cash in the second year, but expansion absorbs more than the improvement. The investment question is whether those commitments create a durable new source of earnings or become a recurring claim on retail cash.", evidence_ids: [], artifact_ids: [model.id] },
        { kind: "assumption" as const, text: "A recovery in shareholder cash depends on expansion spending moderating without damaging the core operation. This assumption needs customer retention and contribution-margin evidence. Revenue growth alone would not establish that the investment is working.", evidence_ids: [], artifact_ids: [model.id] }],
      counterevidence: "Lower near-term cash can be consistent with valuable investment. The available fixture has no cohort data to distinguish investment from recurring subsidies.",
      implication: "Track the incremental return on expansion separately from the strength of the core business.",
      gaps: ["Customer retention after promotions is unavailable.", "All numbers are synthetic QA fixtures, not company disclosures."],
      tables: [{ title: "Cash allocation, illustrative USD millions", artifact_id: model.id, path: "rows" }] };
    const input = { asset_name: "Adaptive report QA retailer", cutoff: "2026-09-01", is_test: true,
      artifacts: inputs.artifacts, evidence: inputs.evidence, required_coverage: ["management"],
      coverage: [{ key: "management", status: "qualified" as const, rationale: "The fixture shows cash allocation but cannot establish investment returns.", section_ids: ["cash"] }],
      questions: [{ id: "retention", question: "Do customers stay when subsidies fall?", materiality: "material" as const, status: "qualified" as const,
        answer: "The disclosed fixture does not establish retention.", evidence_ids: [], artifact_ids: [model.id], follow_up: "Obtain retention cohorts and order contribution margins." }], sections: [section] };
    const document = createReport(input);
    const first = await saveReportArtifact(sql, ctx, "report_document", "report", document);
    const same = await saveReportArtifact(sql, ctx, "report_document", "report", document);
    assert.equal(first.id, same.id, "same input and output must not create another version");
    const changed = createReport({ ...input, sections: [{ ...section, implication: "Monitor expansion losses alongside core cash generation and the evidence gaps." }] });
    const second = await saveReportArtifact(sql, ctx, "report_document", "report", changed);
    assert.equal(Number(second.artifact_version), 2);
    const [prior] = await sql`SELECT content_json, status FROM research_artifacts WHERE id = ${first.id}`;
    assert.equal(prior.status, "superseded"); assert.equal(prior.content_json.markdown, document.markdown);
    const reloaded = await getReportState(sql, runId);
    assert.equal(reloaded.document?.content_hash, changed.content_hash);
    await sql`UPDATE research_artifacts SET content_json = '{"changed": true}'::jsonb WHERE id = ${model.id}`;
    const current = await loadReportInputs(sql, runId, "2026-09-01");
    assert.throws(() => assertReportApproval(changed, { report_hash: changed.content_hash, input_hash: changed.input_hash }, current.input_hash), /stale/);
    // Restore this isolated fixture for visual inspection when explicitly requested by the test command.
    await sql`UPDATE research_artifacts SET content_json = ${sql.json(model.content_json)} WHERE id = ${model.id}`;
    if (process.env.KEEP_ADAPTIVE_QA !== "1") {
      await saveReportArtifact(sql, ctx, "report_review", "review", { report_hash: changed.content_hash, review_verdict: "conditional_pass" });
      await sql`INSERT INTO research_stages (research_run_id, stage_key, stage_order, status)
        VALUES (${runId}, 'export', 23, 'pending'), (${runId}, 'refresh_schedule', 24, 'pending')`;
      const submit = (hash: string) => reviewReport(new NextRequest("http://localhost/api/review", { method: "POST",
        body: JSON.stringify({ status: "approved_for_tracking", reportHash: hash, reviewed_by: "verification" }) }), { params: Promise.resolve({ id: runId }) });
      assert.equal((await submit(document.content_hash)).status, 409, "superseded report cannot be approved");
      assert.equal((await submit(changed.content_hash)).status, 201, "current report can be approved");
      assert.equal((await submit(changed.content_hash)).status, 200, "duplicate approval is idempotent");
      const [decisionCount] = await sql`SELECT count(*)::int AS count FROM review_decisions WHERE research_run_id = ${runId}`;
      assert.equal(decisionCount.count, 1);
      await sql`UPDATE research_artifacts SET content_json = '{"changed": true}'::jsonb WHERE id = ${model.id}`;
      assert.equal((await submit(changed.content_hash)).status, 409, "changed research invalidates even an earlier approval");
    }
    if (process.env.KEEP_ADAPTIVE_QA === "1") console.log(`QA_FIXTURE asset=${assetId} run=${runId}`);
  } finally {
    if (process.env.KEEP_ADAPTIVE_QA !== "1") {
      await sql`DELETE FROM research_run_jobs WHERE research_run_id = ${runId}`;
      await sql`DELETE FROM review_decisions WHERE research_run_id = ${runId}`;
      await sql`DELETE FROM research_stages WHERE research_run_id = ${runId}`;
      await sql`UPDATE research_artifacts SET supersedes_artifact_id = NULL WHERE research_run_id = ${runId}`;
      await sql`DELETE FROM research_artifacts WHERE research_run_id = ${runId}`;
      await sql`DELETE FROM research_runs WHERE id = ${runId}`;
      await sql`DELETE FROM assets WHERE id = ${assetId}`;
    }
    await sql.end();
  }
});
