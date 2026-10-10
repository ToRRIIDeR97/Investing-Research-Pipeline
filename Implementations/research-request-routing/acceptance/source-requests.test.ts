// Specialist source requests check the run corpus before fetching (AC-9). Database tests skip unless RUN_DB_INTEGRATION=1.
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { processSourceRequests } from "../../../src/lib/research/sources/collector";
import { getStageSourceRequests, queueSourceRequests } from "../../../src/lib/research/sources/source-requests";
import { cleanup, createRun, exported, loadEnv, skipDb as skip, SOURCE_REQUESTS, stageCtx, storeDoc, stubWeb } from "./fixtures";

loadEnv();

test("AC-9: queryTermCoverage is the share of the query's significant terms found in a passage", () => {
  const queryTermCoverage = exported(SOURCE_REQUESTS, "queryTermCoverage");
  // The sofi-v3 peer query against the mock corpus's only peer document: annual, report of 6 terms.
  const sofi = queryTermCoverage("Upstart Holdings 2025 annual report 10-K", "Mock peer issuer annual report disclosure for acceptance testing");
  assert.ok(Math.abs(sofi - 2 / 6) < 1e-9, `coverage ${sofi}`);
  assert.equal(queryTermCoverage("Sea Limited 2025 annual report 20-F", "Sea Limited annual report 2025 on Form 20-F. Shopee marketplace take rates."), 1);
});

test("AC-9: a specialist search the run corpus already answers is recorded in_corpus without fetching", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const web = stubWeb();
  try {
    const peerId = await storeDoc(sql, run, { title: "Sea Limited 2025 annual report (Form 20-F)", role: "peer_company_primary",
      content: `Sea Limited annual report 2025 on Form 20-F\n\nShopee marketplace take rates and Monee credit growth. Fixture ${run.runId}.` });
    const peerQuery = "Sea Limited 2025 annual report 20-F";
    const industryQuery = "Bank Indonesia payment system statistics 2025";
    const otherPeerQuery = "Upstart Holdings 2025 annual report 10-K";  // shares 2025, annual, report: 3 of 6 terms
    await queueSourceRequests(sql, run, "moat_analysis", "business", "moat:analysis:routing-fixture", [
      { source_role: "peer_company_primary", query: peerQuery, reason: "Compare marketplace take rates with a named peer" },
      { source_role: "industry_primary", query: industryQuery, reason: "Payments market share in Indonesia" },
      { source_role: "peer_company_primary", query: otherPeerQuery, reason: "Compare lending economics with another named peer" },
    ]);
    await processSourceRequests(sql, stageCtx(run));
    const ledger = await getStageSourceRequests(sql, run.runId, "moat_analysis");
    assert.equal(ledger?.rounds[0].state, "fetched");
    const [peer, industry, otherPeer] = ledger!.rounds[0].requests as any[];
    assert.equal(peer.status, "in_corpus");
    assert.deepEqual(peer.documents.map((d: any) => d.source_id), [peerId]);
    assert.ok(!web.searches().includes(peerQuery), "the in-corpus query is not searched");
    assert.ok(web.searches().includes(industryQuery), "a query with no document of its role still goes to the collector");
    assert.equal(industry.status, "unavailable");
    assert.ok(web.searches().includes(otherPeerQuery), "a peer document sharing only generic terms does not count");
    assert.equal(otherPeer.status, "unavailable");
  } finally { web.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});
