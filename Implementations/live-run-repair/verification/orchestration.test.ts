import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { STAGE_CONFIGS } from "../../../src/lib/workflow/stages";
import { startNextStage } from "../../../src/lib/workflow/orchestrator";
import { processResearchRequests } from "../../../src/lib/research/team";
import { saveReportArtifact } from "../../../src/lib/research/reporting/store";
import { withLinkedRunSources } from "../../../src/lib/research/handlers/source-discovery";
import { openSourceGap } from "../../../src/lib/research/sources/corpus";
import { captureFilingStatements } from "../../../src/lib/research/history/filing-store";

const skip = process.env.RUN_DB_INTEGRATION !== "1";

async function run(sql: postgres.Sql, statuses: Record<string, string>, fallback: string, reason = "Failed after 3 retries: Missing moat evidence") {
  const assetId = randomUUID(), runId = randomUUID();
  const ctx = { assetId, runId, assetSlug: `verify-repair-${assetId.slice(0, 8)}`, cutoffAt: new Date("2025-12-31T00:00:00Z"), assetName: "Verify", symbol: "VRFY" };
  await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind, status, base_currency) VALUES (${assetId}, 'Verify repair', ${ctx.assetSlug}, 'equity', 'active', 'USD')`;
  await sql`INSERT INTO research_runs (id, asset_id, run_type, status, source_cutoff_at, pipeline_version) VALUES (${runId}, ${assetId}, 'deep_dive', 'running', '2025-12-31', 3)`;
  for (const [order, stage] of STAGE_CONFIGS.entries()) {
    const status = statuses[stage.key] || fallback;
    await sql`INSERT INTO research_stages (research_run_id, stage_key, stage_order, status, failure_reason)
      VALUES (${runId}, ${stage.key}, ${order}, ${status}, ${status === "failed" ? reason : null})`;
  }
  return ctx;
}
async function clean(sql: postgres.Sql, ctx: { runId: string; assetId: string }, docs: string[] = []) {
  const tables = (await sql`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'research_run_id'`).map(r => String(r.table_name));
  for (let pass = 0; pass < 4; pass++) for (const name of [...tables, "research_runs"]) {
    try { await sql`DELETE FROM ${sql(name)} WHERE ${sql(name === "research_runs" ? "id" : "research_run_id")} = ${ctx.runId}`; } catch { /* retry */ }
  }
  if (docs.length) await sql`DELETE FROM source_documents WHERE id = ANY(${docs}::uuid[])`;
  await sql`DELETE FROM assets WHERE id = ${ctx.assetId}`;
}
const early = ["intake", "asset_identity", "archetype_composition", "research_plan", "source_discovery", "source_ingestion", "evidence_extraction"];
const completed = (keys: string[]) => Object.fromEntries(keys.map(k => [k, "completed"]));

test("AC-4: with nothing newly fetched, earlier linked documents still provide coverage", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const ctx = await run(sql, {}, "completed");
  const docs: string[] = [];
  try {
    const [doc] = await sql`INSERT INTO source_documents (source_type, title, url, file_hash, storage_path)
      VALUES ('peer_company_primary', 'Peer 10-K', 'https://www.sec.gov/peer', ${randomUUID()}, 'storage/sources/x.html') RETURNING id`;
    docs.push(String(doc.id));
    await sql`INSERT INTO research_run_sources (research_run_id, source_document_id) VALUES (${ctx.runId}, ${doc.id})`;
    const merged = await withLinkedRunSources(sql, ctx.runId, []);
    assert.deepEqual(merged.map(s => [s.sourceId, s.sourceType, s.url]), [[String(doc.id), "peer_company_primary", "https://www.sec.gov/peer"]]);
    assert.deepEqual(await withLinkedRunSources(sql, randomUUID(), []), []);
  } finally { await clean(sql, ctx, docs); await sql.end(); }
});

test("AC-5: a request needing sources supersedes collector and downstream gaps, not unrelated ones", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const ctx = await run(sql, {}, "completed");
  try {
    const gap = (gapKey: string, owner: string) => openSourceGap(sql, { assetId: ctx.assetId, runId: ctx.runId, gapKey, owner, severity: "high", description: `${gapKey} gap` });
    await gap("missing_company_investor_relations", "system:source-reader");
    await gap("metric_lineage_margin", "metric-normalizer");
    await gap("manual_reviewer_note", "research-reviewer");
    await saveReportArtifact(sql, ctx, "team_requests", "requests", { round: 1, state: "queued", requests: [{ id: "request-1-1", role: "data",
      question: "Find the investor day presentation with segment KPIs", material: true, needs_sources: true, source_role: "company_investor_relations" }] });
    await processResearchRequests(sql, ctx as any);
    const rows = await sql`SELECT gap_key, status FROM source_gaps WHERE research_run_id = ${ctx.runId} ORDER BY gap_key`;
    assert.deepEqual(rows.map(r => [r.gap_key, r.status]), [["manual_reviewer_note", "open"], ["metric_lineage_margin", "resolved"],
      ["missing_company_investor_relations", "resolved"]]);
    await gap("missing_company_investor_relations", "system:source-reader");
    const [count] = await sql`SELECT count(*)::int AS n FROM source_gaps WHERE research_run_id = ${ctx.runId} AND gap_key = 'missing_company_investor_relations' AND status = 'open'`;
    assert.equal(count.n, 1);
  } finally { await clean(sql, ctx); await sql.end(); }
});

test("AC-6: a failure in the business branch names that stage once no other stage can run", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const ctx = await run(sql, { ...completed([...early, "historical_record", "historical_diagnosis", "company_genesis", "business_process_analysis"]),
    moat_analysis: "failed" }, "pending");
  try {
    await startNextStage(ctx.runId);
    const [state] = await sql`SELECT status, failure_reason FROM research_runs WHERE id = ${ctx.runId}`;
    assert.equal(state.status, "needs_more_work");
    assert.match(String(state.failure_reason), /moat_analysis/);
    assert.match(String(state.failure_reason), /Missing moat evidence/);
    assert.doesNotMatch(String(state.failure_reason), /^Pending research stages have unsatisfied dependencies$/);
  } finally { await clean(sql, ctx); await sql.end(); }
});

test("AC-6: a failed stage does not stop a run while an independent stage can still start", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const ctx = await run(sql, { ...completed(early), company_genesis: "failed" }, "pending");
  try {
    await startNextStage(ctx.runId);
    const [state] = await sql`SELECT status FROM research_runs WHERE id = ${ctx.runId}`;
    assert.equal(state.status, "running");
  } finally { await clean(sql, ctx); await sql.end(); }
});

test("AC-8/11: no module writer means no repair; an unresolved repair is still saved with its attempts", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const ctx = await run(sql, {}, "completed");
  const file = `storage/sources/verify-repair-${ctx.runId}.html`;
  const docs: string[] = [];
  try {
    await mkdir("storage/sources", { recursive: true });
    await writeFile(file, `<ix:nonNumeric name="dei:DocumentFiscalYearFocus">2025</ix:nonNumeric><ix:nonNumeric name="dei:DocumentFiscalPeriodFocus">Q3</ix:nonNumeric><ix:nonNumeric name="dei:DocumentPeriodEndDate">2025-09-30</ix:nonNumeric><xbrli:unit id="u"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit><xbrli:context id="i"><xbrli:period><xbrli:instant>2025-09-30</xbrli:instant></xbrli:period></xbrli:context><p>Stato patrimoniale</p><table><tr><td>Attivo</td><td><ix:nonFraction name="it:Attivo" contextRef="i" unitRef="u">5</ix:nonFraction></td></tr></table>`);
    const [doc] = await sql`INSERT INTO source_documents (source_type, title, file_hash, storage_path, published_at, period_end, metadata_json)
      VALUES ('regulatory_filing', 'Verify 10-Q', ${randomUUID()}, ${file}, '2025-11-01', '2025-09-30', ${sql.json({ form: "10-Q" })}) RETURNING id`;
    docs.push(String(doc.id));
    await sql`INSERT INTO research_run_sources (research_run_id, source_document_id) VALUES (${ctx.runId}, ${doc.id})`;
    const plain = await captureFilingStatements(sql, ctx);
    assert.equal(plain.coverage[0].status, "incomplete");
    const [none] = await sql`SELECT count(*)::int AS n FROM research_artifacts WHERE research_run_id = ${ctx.runId} AND artifact_type = 'statement_repair'`;
    assert.equal(none.n, 0);
    const repaired = await captureFilingStatements(sql, ctx, { writeModule: async () => ({ module_source: "function locateStatements() { return []; }", rationale: "none" }) });
    assert.equal(repaired.coverage[0].status, "incomplete");
    const [artifact] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${ctx.runId}
      AND artifact_type = 'statement_repair' AND status = 'validated'`;
    assert.equal(artifact.content_json.status, "unresolved");
    assert.equal(artifact.content_json.attempts.length, 3);
    assert.deepEqual(artifact.content_json.repaired_document_ids, []);
  } finally { await rm(file, { force: true }); await clean(sql, ctx, docs); await sql.end(); }
});
