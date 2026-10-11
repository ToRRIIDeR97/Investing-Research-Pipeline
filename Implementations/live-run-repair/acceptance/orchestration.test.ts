import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { STAGE_CONFIGS } from "../../../src/lib/workflow/stages";
import { approveRequestReset, startNextStage } from "../../../src/lib/workflow/orchestrator";
import { MockProvider } from "../../../src/lib/agent-harness/providers/mock";
import { processResearchRequests } from "../../../src/lib/research/team";
import { saveReportArtifact } from "../../../src/lib/research/reporting/store";
import { withLinkedRunSources } from "../../../src/lib/research/handlers/source-discovery";
import { openSourceGap } from "../../../src/lib/research/sources/corpus";
import { captureFilingStatements } from "../../../src/lib/research/history/filing-store";
import { context, fact, header, row, table, text } from "./fixtures";

const skip = process.env.RUN_DB_INTEGRATION !== "1";

async function createRun(sql: postgres.Sql, statuses: Record<string, string> = {}, fallback = "completed") {
  const assetId = randomUUID(), runId = randomUUID();
  const ctx = { assetId, runId, assetSlug: `live-repair-${assetId.slice(0, 8)}`, cutoffAt: new Date("2026-09-01T00:00:00Z"),
    assetName: "Live repair QA", symbol: "LRQA" };
  await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind, status, base_currency)
    VALUES (${assetId}, ${ctx.assetName}, ${ctx.assetSlug}, 'equity', 'active', 'USD')`;
  await sql`INSERT INTO research_runs (id, asset_id, run_type, status, source_cutoff_at, pipeline_version)
    VALUES (${runId}, ${assetId}, 'deep_dive', 'running', '2026-09-01', 3)`;
  for (const [order, stage] of STAGE_CONFIGS.entries()) {
    await sql`INSERT INTO research_stages (research_run_id, stage_key, stage_order, status, failure_reason)
      VALUES (${runId}, ${stage.key}, ${order}, ${statuses[stage.key] || fallback},
        ${statuses[stage.key] === "failed" ? "Failed after 3 retries: Required source role 'peer_company_primary' is not covered by any fetched documents" : null})`;
  }
  return ctx;
}

async function cleanup(sql: postgres.Sql, runIds: string[], assetIds: string[], documentIds: string[] = []) {
  const tables = (await sql`SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'research_run_id'`).map(r => String(r.table_name));
  for (let pass = 0; pass < 4; pass++) for (const name of [...tables, "research_runs"]) {
    const column = name === "research_runs" ? "id" : "research_run_id";
    try { await sql`DELETE FROM ${sql(name)} WHERE ${sql(column)} = ANY(${runIds}::uuid[])`; } catch { /* FK order; retry next pass */ }
  }
  if (documentIds.length) await sql`DELETE FROM source_documents WHERE id = ANY(${documentIds}::uuid[])`;
  await sql`DELETE FROM assets WHERE id = ANY(${assetIds}::uuid[])`;
}

async function linkDocument(sql: postgres.Sql, runId: string, title: string, sourceType = "company_investor_relations") {
  const [doc] = await sql`INSERT INTO source_documents (source_type, title, url, file_hash, storage_path, metadata_json)
    VALUES (${sourceType}, ${title}, ${`https://investor.example.com/${randomUUID()}`}, ${randomUUID()}, 'storage/sources/none.html', '{}'::jsonb)
    RETURNING id`;
  await sql`INSERT INTO research_run_sources (research_run_id, source_document_id) VALUES (${runId}, ${doc.id})`;
  return String(doc.id);
}

test("AC-4: documents linked in an earlier discovery pass count with newly fetched ones", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql), other = await createRun(sql);
  const documents: string[] = [];
  try {
    const earlier = await linkDocument(sql, run.runId, "Investor relations overview");
    const refetched = await linkDocument(sql, run.runId, "Founder history");
    const foreign = await linkDocument(sql, other.runId, "Other run document");
    documents.push(earlier, refetched, foreign);
    const merged = await withLinkedRunSources(sql, run.runId, [
      { sourceId: refetched, sourceType: "founder_and_company_history", title: "Founder history (refetched)", url: "https://example.com/f", metadata: {} },
    ]);
    assert.deepEqual(merged.map(s => s.sourceId).sort(), [earlier, refetched].sort());
    assert.equal(merged.find(s => s.sourceId === refetched)?.title, "Founder history (refetched)");
    assert.equal(merged.find(s => s.sourceId === earlier)?.sourceType, "company_investor_relations");
  } finally { await cleanup(sql, [run.runId, other.runId], [run.assetId, other.assetId], documents); await sql.end(); }
});

/** Script the mock provider's team answers; nothing reaches a paid provider. */
function scriptTeamAnswers(answer: (packet: any) => Record<string, unknown>) {
  const provider = process.env.RESEARCH_MODEL_PROVIDER;
  process.env.RESEARCH_MODEL_PROVIDER = "mock";
  const original = MockProvider.prototype.stream;
  MockProvider.prototype.stream = async function* (this: any, request: any, signal: AbortSignal) {
    const packet = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("Task packet:") + 12).trim());
    if (packet.output_contract !== "team_answer") { yield* original.call(this, request, signal); return; }
    yield { type: "response.started", requestId: "live-repair-team-answer" };
    yield { type: "text.delta", text: JSON.stringify(answer(packet)) };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    yield { type: "response.completed", finishReason: "stop" };
  } as any;
  return () => {
    MockProvider.prototype.stream = original;
    if (provider === undefined) delete process.env.RESEARCH_MODEL_PROVIDER; else process.env.RESEARCH_MODEL_PROVIDER = provider;
  };
}

// Updated for research-request-routing AC-5 to AC-7: an arriving request no longer reopens stages or
// supersedes gaps. The reset now comes from the owner's requires_rerun answer; a financials re-run reopens
// 10 analysis stages, above the automatic limit, so it runs after a reviewer approves it.
test("AC-5: reopening a stage supersedes its open gaps, and a re-emitted gap opens again", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  let recordId = "";
  const restore = scriptTeamAnswers(() => ({ status: "answered", answer: "FY2023 revenue must be recaptured from the recast filing.",
    evidence_ids: [], artifact_ids: [recordId], requires_rerun: true }));
  try {
    const gap = { assetId: run.assetId, runId: run.runId, gapKey: "metric_lineage_revenue_growth_yoy", severity: "high",
      description: "Excluded revenue_growth_yoy: its reporting period could not be verified.", owner: "metric-normalizer" };
    await openSourceGap(sql, gap);
    await openSourceGap(sql, { ...gap, gapKey: "missing_peer_company_primary", owner: "system:source-reader", description: "Peer filings missing" });
    recordId = String((await saveReportArtifact(sql, run, "historical_record", `${run.assetSlug}-historical-record`,
      { artifact_type: "historical_record", summary: `Revenue history. Fixture ${run.runId}.` })).id);
    await saveReportArtifact(sql, run, "team_requests", "requests", { round: 1, state: "queued", requests: [{ id: "request-1-1", role: "financials",
      question: "Reconcile FY2023 revenue across the recast filings", material: true, needs_sources: false, source_role: "regulatory_filing" }] });
    assert.equal(await processResearchRequests(sql, run as any), true);
    const paused = await sql`SELECT gap_key, status FROM source_gaps WHERE research_run_id = ${run.runId} ORDER BY gap_key`;
    assert.deepEqual(paused.map(g => g.status), ["open", "open"], "nothing is superseded before the re-run is approved");
    await approveRequestReset(run.runId, { decision: "rerun", actor: "live-repair-test" });
    const gaps = await sql`SELECT gap_key, status, resolution_note FROM source_gaps WHERE research_run_id = ${run.runId} ORDER BY gap_key`;
    assert.deepEqual(gaps.map(g => [g.gap_key, g.status]), [["metric_lineage_revenue_growth_yoy", "resolved"], ["missing_peer_company_primary", "open"]]);
    assert.match(String(gaps[0].resolution_note), /superseded/i);
    await openSourceGap(sql, gap);
    const reopened = await sql`SELECT status FROM source_gaps WHERE research_run_id = ${run.runId} AND gap_key = ${gap.gapKey}`;
    assert.deepEqual(reopened.map(r => r.status), ["open"]);
  } finally { restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-6: a run blocked by a failed stage names that stage and its reason", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const done = ["intake", "asset_identity", "archetype_composition", "research_plan"];
  const run = await createRun(sql, { ...Object.fromEntries(done.map(k => [k, "completed"])), source_discovery: "failed" }, "pending");
  try {
    await startNextStage(run.runId);
    const [state] = await sql`SELECT status, failure_reason FROM research_runs WHERE id = ${run.runId}`;
    assert.equal(state.status, "needs_more_work");
    assert.match(String(state.failure_reason), /source_discovery/);
    assert.match(String(state.failure_reason), /Required source role 'peer_company_primary'/);
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-11: a repaired capture saves the module, its hash and the repaired tables with the run", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const file = `storage/sources/live-repair-${run.runId}.html`;
  const documents: string[] = [];
  try {
    await mkdir("storage/sources", { recursive: true });
    await writeFile(file, header(2026, "Q2", "2026-06-30", context("i", "", "2026-06-30") + context("q", "2026-04-01", "2026-06-30")) +
      text("Balance general") + table(row("Activos", fact("i", "acme:Activos", "5"))) +
      text("Estado de resultados") + table(row("Ingresos", fact("q", "acme:Ingresos", "9"))) +
      text("Flujos de efectivo") + table(row("Operativo", fact("q", "acme:Operativo", "2"))));
    const [doc] = await sql`INSERT INTO source_documents (source_type, title, file_hash, storage_path, published_at, period_end, metadata_json)
      VALUES ('regulatory_filing', 'Acme 10-Q', ${randomUUID()}, ${file}, '2026-08-01', '2026-06-30', ${sql.json({ form: "10-Q" })}) RETURNING id`;
    documents.push(String(doc.id));
    await sql`INSERT INTO research_run_sources (research_run_id, source_document_id) VALUES (${run.runId}, ${doc.id})`;
    const moduleSource = `function locateStatements(filings) {
      const words = { balance: /balance/i, income: /resultados/i, cashflow: /flujos/i };
      return filings.flatMap(f => f.missing.map(s => ({ source_document_id: f.source_document_id, statement: s,
        table_index: f.candidates.find(c => words[s].test(c.preceding_text.join(" "))).table_index })));
    }`;
    const content = await captureFilingStatements(sql, run, { writeModule: async () => ({ module_source: moduleSource, rationale: "Spanish headings" }) });
    assert.ok(content.coverage.every(c => c.status === "extracted"));
    const [set] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${run.runId}
      AND artifact_type = 'financial_statement_set' AND status = 'validated'`;
    assert.deepEqual(set.content_json.tables.map((t: any) => t.identified_by), ["repair", "repair", "repair"]);
    const [repair] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${run.runId}
      AND artifact_type = 'statement_repair' AND status = 'validated'`;
    assert.equal(repair.content_json.status, "repaired");
    assert.equal(repair.content_json.attempts[0].module_source, moduleSource);
    assert.match(repair.content_json.attempts[0].sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(repair.content_json.repaired_document_ids, [String(doc.id)]);
  } finally { await rm(file, { force: true }); await cleanup(sql, [run.runId], [run.assetId], documents); await sql.end(); }
});
