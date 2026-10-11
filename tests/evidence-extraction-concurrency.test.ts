import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { MockProvider } from "../src/lib/agent-harness/providers/mock";
import { storeDiscoveredSources } from "../src/lib/research/sources/corpus";
import { evidenceExtractionHandler, extractEvidenceForSources } from "../src/lib/research/handlers/evidence-extraction";
import { cleanup, corpusCtx, createRun, earningsText, loadEnv, payload, prospectusHtml, skipDb as skip, stageCtx } from "../Implementations/research-memory/acceptance/fixtures";

loadEnv();
process.env.RESEARCH_MODEL_PROVIDER = "mock";

/** Counts source-reader calls in flight; each one waits briefly so overlapping calls are visible. */
function trackSourceReader() {
  const original = MockProvider.prototype.stream;
  const state = { inFlight: 0, peak: 0, calls: 0 };
  MockProvider.prototype.stream = async function* (this: any, request: any, signal: AbortSignal) {
    if (request.agentName !== "source-reader") { yield* original.call(this, request, signal); return; }
    state.calls++;
    state.peak = Math.max(state.peak, ++state.inFlight);
    try {
      await new Promise(resolve => setTimeout(resolve, 40));
      yield* original.call(this, request, signal);
    } finally { state.inFlight--; }
  } as any;
  return { state, restore() { MockProvider.prototype.stream = original; } };
}

test("source-reader batches run four at a time, in the extraction stage and for requested documents", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const priorChunks = process.env.RESEARCH_SOURCE_READER_BATCH_MAX_CHUNKS;
  process.env.RESEARCH_SOURCE_READER_BATCH_MAX_CHUNKS = "1";
  const model = trackSourceReader();
  try {
    await storeDiscoveredSources(sql, corpusCtx(run) as any, [
      payload({ title: "Final Prospectus", content: prospectusHtml(run.runId), mimeType: "text/html", role: "founder_and_company_history" }),
      payload({ title: "Q3 results", content: earningsText(run.runId), mimeType: "text/plain", role: "company_investor_relations" }),
    ]);
    await evidenceExtractionHandler.execute(stageCtx(run));
    const batches = await sql`SELECT task_key FROM research_tasks WHERE research_run_id = ${run.runId} AND task_key LIKE 'source-reader:batch:%'`;
    assert.ok(batches.length >= 2, `fixture yields several batches (${batches.length})`);
    assert.equal(model.state.peak, Math.min(4, batches.length), "batches overlap up to the pool size");

    model.state.peak = 0;
    const sources = await sql`SELECT id FROM source_documents WHERE research_run_id = ${run.runId}`;
    await extractEvidenceForSources(sql, stageCtx(run), sources.map(s => String(s.id)));
    const requested = await sql`SELECT task_key FROM research_tasks WHERE research_run_id = ${run.runId} AND task_key LIKE 'source-reader:requested:%'`;
    assert.ok(requested.length >= 2);
    assert.equal(model.state.peak, Math.min(4, requested.length), "requested-document batches overlap too");
  } finally {
    model.restore();
    if (priorChunks === undefined) delete process.env.RESEARCH_SOURCE_READER_BATCH_MAX_CHUNKS;
    else process.env.RESEARCH_SOURCE_READER_BATCH_MAX_CHUNKS = priorChunks;
    await cleanup(sql, [run.runId], [run.assetId]); await sql.end();
  }
});
