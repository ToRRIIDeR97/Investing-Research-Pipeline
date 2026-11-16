// ai_reviewer reopens report_draft when the stored draft no longer matches the run's report inputs (architecture-9 P4).
// Skipped unless RUN_DB_INTEGRATION=1. No model call: the draft is composed with code-built actions.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, describe } from "node:test";
import postgres from "postgres";
import { createStagesForRun } from "../src/lib/workflow/orchestrator";
import { readyStages } from "../src/lib/research/team-plan";
import { STAGE_CONFIGS } from "../src/lib/workflow/stages";
import { ReportDraftReopened, loadCurrentDraft, saveDraftState } from "../src/lib/research/reporting/runtime";
import { composeDraft, REQUIRED_COVERAGE, type CompositionActions } from "../src/lib/research/reporting/compose";
import { loadReportInputs, saveReportArtifact } from "../src/lib/research/reporting/store";

describe("report draft reopen", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, () => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const assetId = crypto.randomUUID();
  const slug = `reopen-${assetId.slice(0, 8)}`;
  const runIds: string[] = [];
  const cutoffAt = new Date("2026-01-01T00:00:00Z");
  const ctxFor = (runId: string) => ({ runId, assetId, assetSlug: slug, assetName: "Reopen Co", symbol: "RPN", cutoffAt, testMode: true,
    researchQuestion: "Reopen?", profileKey: null, researchFraming: null }) as any;

  before(async () => {
    await sql`INSERT INTO assets (id, canonical_name, slug, status, asset_kind, base_currency) VALUES (${assetId}, 'Reopen Co', ${slug}, 'active', 'equity', 'USD')`;
  });
  after(async () => {
    await sql`DELETE FROM research_artifacts WHERE research_run_id = ANY(${runIds}::uuid[])`;
    await sql`DELETE FROM research_stages WHERE research_run_id = ANY(${runIds}::uuid[])`;
    await sql`DELETE FROM research_runs WHERE id = ANY(${runIds}::uuid[])`;
    await sql`DELETE FROM assets WHERE id = ${assetId}`;
    await sql.end({ timeout: 5 });
  });

  /** A run at ai_reviewer: every earlier stage done, report_draft completed, the review running. */
  async function runAtReview(runStatus = "running") {
    const runId = crypto.randomUUID();
    runIds.push(runId);
    await sql`INSERT INTO research_runs (id, asset_id, run_type, status, pipeline_version, source_cutoff_at)
      VALUES (${runId}, ${assetId}, 'deep_dive', ${runStatus}, 3, ${cutoffAt.toISOString()})`;
    await createStagesForRun(runId);
    await sql`UPDATE research_stages SET status = 'completed' WHERE research_run_id = ${runId} AND stage_order <= 21`;
    await sql`UPDATE research_stages SET status = 'running', transient_failures = 1, last_transient_error = 'HTTP 529',
      validation_result_json = ${sql.json({ retryCount: 1 })} WHERE research_run_id = ${runId} AND stage_key = 'ai_reviewer'`;
    return runId;
  }
  const stages = async (runId: string) => Object.fromEntries((await sql`SELECT stage_key, status, transient_failures, validation_result_json
    FROM research_stages WHERE research_run_id = ${runId} AND stage_key IN ('report_draft', 'ai_reviewer')`).map(r => [r.stage_key, r]));
  const ledger = async (runId: string) => (await sql`SELECT stage_key, status FROM research_stages WHERE research_run_id = ${runId} ORDER BY stage_order`)
    .map(r => ({ stage_key: String(r.stage_key), status: String(r.status) }));

  /** Writes a real draft (code-built outline and one conclusion section) and its stage-row state, as draftReport does. */
  async function draftFor(runId: string, inputHash?: string) {
    const ctx = ctxFor(runId);
    const inputs = await loadReportInputs(sql as any, runId, cutoffAt.toISOString());
    const input = { asset_name: ctx.assetName, cutoff: cutoffAt.toISOString(), is_test: true, required_coverage: REQUIRED_COVERAGE, artifacts: inputs.artifacts, evidence: inputs.evidence };
    const plan = { id: "summary", title: "Summary", purpose: "Judge", coverage: REQUIRED_COVERAGE, artifact_ids: [] };
    const ids = new Map<string, string>();
    const actions: CompositionActions = {
      plan: async () => ({ sections: [plan], questions: [], coverage: REQUIRED_COVERAGE.map(key => ({ key, status: "qualified", rationale: "Limited.", section_ids: ["summary"] })) }) as any,
      write: async p => ({ ...p, paragraphs: [{ kind: "analysis", text: "Revenue grew 12% in FY2024.", evidence_ids: [], artifact_ids: [] }],
        counterevidence: "Competition.", implication: "Hold.", gaps: [], tables: [] }) as any,
      review: async () => { throw new Error("not reviewed here"); },
      save: async (type, scope, value) => { const row = await saveReportArtifact(sql as any, ctx, type, `${slug}-${scope}`, value); ids.set(`${type}:${scope}`, String(row.id)); return row; },
    };
    const draft = await composeDraft(input as any, actions);
    await saveDraftState(sql as any, runId, { outline_id: ids.get("report_outline:outline")!, section_ids: [ids.get("report_section:summary")!],
      document_id: ids.get("report_document:document")!, input_hash: inputHash ?? draft.document.input_hash, content_hash: draft.document.content_hash,
      final_coverage: draft.finalCoverage ?? null, dropped_citations: [] });
  }

  const reopens = (runId: string, reopened: boolean) => assert.rejects(loadCurrentDraft(sql as any, ctxFor(runId)),
    (error: unknown) => error instanceof ReportDraftReopened && error.reopened === reopened);

  test("a completed legacy report_draft without draft state is reopened, and the draft runs before the review", async () => {
    const runId = await runAtReview();
    await reopens(runId, true);
    const after = await stages(runId);
    assert.equal(after.report_draft.status, "pending");
    assert.equal(after.ai_reviewer.status, "pending");
    assert.equal(Number(after.ai_reviewer.transient_failures), 0, "the transient counter is cleared, not incremented");
    assert.equal(after.ai_reviewer.validation_result_json, null, "no validation retry is counted");
    assert.deepEqual(readyStages(await ledger(runId)), ["report_draft"], "the draft reruns first");
  });

  test("a changed input hash reopens once; the redrafted state then loads without reopening", async () => {
    const runId = await runAtReview();
    await draftFor(runId, "stale-input-hash");
    await reopens(runId, true);
    assert.deepEqual(readyStages(await ledger(runId)), ["report_draft"]);
    // The runner redrafts: report_draft completes with a state for the current inputs, then ai_reviewer runs.
    await draftFor(runId);
    await sql`UPDATE research_stages SET status = 'completed' WHERE research_run_id = ${runId} AND stage_key = 'report_draft'`;
    await sql`UPDATE research_stages SET status = 'running' WHERE research_run_id = ${runId} AND stage_key = 'ai_reviewer'`;
    const { draft } = await loadCurrentDraft(sql as any, ctxFor(runId));
    assert.equal(draft.sections.length, 1);
    assert.equal((await stages(runId)).report_draft.status, "completed", "no further reopen without an input change");
  });

  test("a run that stopped running, or a review that is not running, is left alone", async () => {
    for (const setup of ["cancelled", "waiting_for_human", "review-pending"]) {
      const runId = await runAtReview(setup === "review-pending" ? "running" : setup);
      if (setup === "review-pending") await sql`UPDATE research_stages SET status = 'pending' WHERE research_run_id = ${runId} AND stage_key = 'ai_reviewer'`;
      const before = await stages(runId);
      await reopens(runId, false);
      const after = await stages(runId);
      assert.equal(after.report_draft.status, before.report_draft.status, `${setup}: report_draft unchanged`);
      assert.equal(after.ai_reviewer.status, before.ai_reviewer.status, `${setup}: ai_reviewer unchanged`);
      assert.equal(Number(after.ai_reviewer.transient_failures), Number(before.ai_reviewer.transient_failures));
    }
  });

  test("the stage list still has report_draft at 21 and ai_reviewer at 22", () => {
    assert.deepEqual(STAGE_CONFIGS.slice(20, 22).map(s => [s.key, s.order]), [["report_draft", 21], ["ai_reviewer", 22]]);
  });
});
