import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { storeDiscoveredSources } from "../../../src/lib/research/sources/corpus";
import { evidenceExtractionHandler } from "../../../src/lib/research/handlers/evidence-extraction";
import { getStageSourceRequests, saveStageSourceRequests, SourceRequestsPending } from "../../../src/lib/research/sources/source-requests";
import { cleanup, corpusCtx, createRun, earningsText, loadEnv, payload, prospectusHtml, skipDb as skip, stageCtx } from "./fixtures";

loadEnv();
process.env.RESEARCH_MODEL_PROVIDER = "mock";

const sourceReaderPackets = async (sql: postgres.Sql, runId: string) =>
  (await sql`SELECT task_key, input_json FROM research_tasks WHERE research_run_id = ${runId} AND agent_name = 'source-reader' ORDER BY created_at`)
    .map(row => ({ taskKey: String(row.task_key), corpus: (row.input_json?.packet?.source_corpus || []) as any[] }));

test("AC-6: evidence extraction reads the founding story from a long prospectus, never the cover page", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    await storeDiscoveredSources(sql, corpusCtx(run) as any, [
      payload({ title: "Final Prospectus", content: prospectusHtml(run.runId), mimeType: "text/html", role: "founder_and_company_history" }),
      payload({ title: "Q3 results", content: earningsText(run.runId), mimeType: "text/plain", role: "earnings_release" }),
    ]);
    await evidenceExtractionHandler.execute(stageCtx(run));
    const packets = await sourceReaderPackets(sql, run.runId);
    assert.ok(packets.length > 0, "source-reader tasks ran");
    const chunks = packets.flatMap(p => p.corpus);
    const history = chunks.find(c => String(c.content_excerpt).includes("co-founder"));
    assert.ok(history, "a source-reader packet contains the founding story");
    assert.deepEqual(history.section_path.slice(-1), ["History of MercadoLibre"]);
    assert.equal(history.source_role, "founder_and_company_history");
    assert.ok(history.need, "packet chunks name the need that selected them");
    for (const key of ["source_id", "document_parse_id", "document_chunk_id", "source_type", "title", "section_title", "chunk_index", "char_start", "char_end"]) {
      assert.ok(history[key] !== undefined, `chunk keeps ${key}`);
    }
    const founderPass = packets.filter(p => p.taskKey.startsWith("source-reader:role:founder-origin"));
    for (const pass of founderPass) {
      assert.ok(pass.corpus.every(c => !/TABLE OF CONTENTS|16,077,185 shares/.test(String(c.content_excerpt))), "the founder pass never gets the cover page");
    }
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-14: a founder need with no passages asks the collector before any model call, then fails naming the need", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    await storeDiscoveredSources(sql, corpusCtx(run) as any, [
      payload({ title: "Brand guidelines", content: "Logo usage\n\nUse the yellow logo on dark backgrounds only.", mimeType: "text/plain", role: "founder_and_company_history" }),
      payload({ title: "Q3 results", content: earningsText(run.runId), mimeType: "text/plain", role: "earnings_release" }),
    ]);
    await assert.rejects(() => evidenceExtractionHandler.execute(stageCtx(run)), (error: unknown) => error instanceof SourceRequestsPending);
    const [{ calls }] = await sql`SELECT COUNT(*)::int AS calls FROM model_call_logs WHERE research_run_id = ${run.runId}`;
    assert.equal(calls, 0, "no model call before the collector round");
    const ledger = await getStageSourceRequests(sql, run.runId, "evidence_extraction");
    assert.ok(ledger);
    assert.equal(ledger!.role, "data");
    const queued = ledger!.rounds.find(r => r.state === "queued");
    assert.ok(queued);
    assert.equal(queued!.requests[0].source_role, "founder_and_company_history");
    assert.match(queued!.requests[0].query, /MercadoLibre Fixture/);

    // The collector rounds are used and still found nothing.
    await saveStageSourceRequests(sql, run, { ...ledger!, rounds: [1, 2].map(round => ({ round, task_key: `fixture-${round}`, state: "fetched" as const,
      requests: [{ ...queued!.requests[0], id: `evidence_extraction-${round}-1`, status: "unavailable" as const, documents: [] }] })) });
    await assert.rejects(() => evidenceExtractionHandler.execute(stageCtx(run)), (error: unknown) =>
      !(error instanceof SourceRequestsPending) && /founder_origin/.test(String((error as Error).message)) && /no_matching_passages/.test(String((error as Error).message)));
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});
