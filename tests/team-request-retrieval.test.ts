// Team requests retrieve their passages once, and search first when the question names a period the run lacks (RMEM9).
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { processResearchRequests } from "../src/lib/research/team";
import { storeDiscoveredSources } from "../src/lib/research/sources/corpus";
import { cleanup, createRun, loadEnv, saveBatch, scriptModel, skipDb as skip, stageCtx } from "../Implementations/research-request-routing/acceptance/fixtures";

loadEnv();
process.env.RESEARCH_ACCEPTANCE_PROVIDER = "mock";

/** Counts keyword retrievals (one websearch_to_tsquery query per retrievePassages call) made through this connection. */
function countingRetrievals(sql: postgres.Sql) {
  const state = { retrievals: 0 };
  const counted = new Proxy(sql, { apply(target, thisArg, args) {
    if (Array.isArray(args[0]) && (args[0] as string[]).join("").includes("websearch_to_tsquery")) state.retrievals += 1;
    return Reflect.apply(target as any, thisArg, args);
  } });
  return { sql: counted, state };
}

test("a team request retrieves its passages once, and searches first when it names a period no document covers", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const model = scriptModel(packet => packet.output_contract !== "team_answer" ? undefined : { status: "answered",
    answer: "Current debt and finance lease liabilities are stated in the quarter's balance sheet.", evidence_ids: [], artifact_ids: [],
    source_ids: (packet.passages || []).slice(0, 1).map((p: any) => p.source_id) });
  try {
    await storeDiscoveredSources(sql, { runId: run.runId, runType: "deep_dive", assetId: run.assetId, assetName: run.assetName, assetSlug: run.assetSlug,
      symbol: run.symbol, profileId: "", profileKey: "", requiredModules: [], requiredLenses: [], marketDataCutoffAt: null, pipelineVersion: 3 } as any, [{
      sourceType: "sec_filing_10-q", title: "10-Q report 2026-03-31", publisher: "sec.gov", url: `https://fixture.example/${randomUUID()}`,
      content: `CONDENSED CONSOLIDATED BALANCE SHEETS\n\nCurrent debt was 1,200 million and finance lease liabilities, current were 308 million at March 31, 2026. ${run.runId}`,
      mimeType: "text/plain", qualityScore: "0.9", publishedAt: "2026-04-30", periodEnd: "2026-03-31",
      metadata: { source_role: "regulatory_filing", system_generated: true }, chunkTitle: "10-Q",
    }] as any);
    const ask = (id: string, period: string) => ({ id, role: "valuation", material: true, needs_sources: true, source_role: "regulatory_filing",
      question: `What were current debt and finance lease liabilities in the ${period} 10-Q balance sheet?` });
    await saveBatch(sql, run, [ask("request-1-1", "Q1 2026"), ask("request-1-2", "Q2 2026")]);

    const counted = countingRetrievals(sql);
    await processResearchRequests(counted.sql, stageCtx(run));

    const packets = Object.fromEntries(model.answers().map(call => [call.packet.request.id, call.packet]));
    assert.equal(packets["request-1-1"].source_search_attempted, false, "the run holds the Q1 2026 filing, so no search runs");
    assert.ok(packets["request-1-1"].passages.length > 0);
    assert.equal(packets["request-1-2"].source_search_attempted, true,
      "Q2 2026 is searched before the owner answers, although the Q1 filing's passages match the question's words");
    const searched = await sql`SELECT attempt_metadata_json->>'request_id' AS id FROM source_retrieval_attempts WHERE research_run_id = ${run.runId}`;
    assert.deepEqual(searched.map(row => row.id), ["request-1-2"]);
    assert.equal(counted.state.retrievals, 3, "request-1-1 retrieves once; request-1-2 before and after its search");
  } finally { model.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});
