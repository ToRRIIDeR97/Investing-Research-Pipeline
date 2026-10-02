import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { persistEvidence, storeDiscoveredSources } from "../../../src/lib/research/sources/corpus";
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

const tenQ = (nonce: string) => [
  "Organization", "",
  `MercadoLibre Fixture is a financial services platform that was founded in 2011 to offer student loan refinancing. Fixture ${nonce}.`, "",
  "Liquidity", "", "Cash and equivalents were 3.1 billion dollars at quarter end.",
].join("\n");

test("AC-6: when founder documents lack the story, a filing that states the founding feeds the founder pass", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    await storeDiscoveredSources(sql, corpusCtx(run) as any, [
      payload({ title: "SPAC profile", content: "Sponsor Overview\n\nThe sponsor completed the merger in 2021.", mimeType: "text/plain", role: "founder_and_company_history" }),
      payload({ title: "10-Q", content: tenQ(run.runId), mimeType: "text/plain", role: "regulatory_filing" }),
    ]);
    await evidenceExtractionHandler.execute(stageCtx(run));
    const founderPass = (await sourceReaderPackets(sql, run.runId)).filter(p => p.taskKey.startsWith("source-reader:role:founder-origin"));
    assert.equal(founderPass.length, 1, "the founder pass ran");
    const filing = founderPass[0].corpus.find(c => String(c.content_excerpt).includes("founded in 2011"));
    assert.equal(filing?.need, "founder_origin_filings");
    assert.equal((await evidenceExtractionHandler.validate!(stageCtx(run), {})).valid, true);
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-6: absence statements, excerpt descriptions and inventory claims do not satisfy the founder check", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    const [stored] = await storeDiscoveredSources(sql, corpusCtx(run) as any, [
      payload({ title: "Founder history", content: `Background\n\nA page about the company. ${run.runId}`, mimeType: "text/plain", role: "founder_and_company_history" }),
    ]);
    const [chunk] = await sql`SELECT id FROM document_chunks WHERE source_document_id = ${stored.sourceId} ORDER BY chunk_index LIMIT 1`;
    const claim = (claim_text: string, claim_type = "company_history") => ({ claim_text, claim_type, claim_category: "fact", confidence: 0.8, source_id: stored.sourceId, document_chunk_id: chunk.id });
    await persistEvidence(sql, corpusCtx(run) as any, [stored], { evidence_claims: [
      claim("The filing does not name the company's founders or why it was started."),
      claim("The supplied passage names a SPAC sponsor rather than the founder of the company."),
      claim("Founder history was retrieved as a web_founder_and_company_history primary research document.", "source_inventory_fact"),
    ] });
    const stored_ = await sql`SELECT claim_text FROM evidence_claims WHERE research_run_id = ${run.runId}`;
    assert.ok(!stored_.some(r => /supplied passage/.test(String(r.claim_text))), "claims about the excerpt are not stored as evidence");
    const failing = await evidenceExtractionHandler.validate!(stageCtx(run), {});
    assert.equal(failing.valid, false);
    assert.ok(failing.errors.some(e => /affirms the founder/.test(e)));
    await persistEvidence(sql, corpusCtx(run) as any, [stored], { evidence_claims: [claim("MercadoLibre Fixture was founded in 2011 by four graduate students.")] });
    assert.equal((await evidenceExtractionHandler.validate!(stageCtx(run), {})).valid, true);
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});
