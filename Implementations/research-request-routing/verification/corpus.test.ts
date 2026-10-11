// Independent checks of the in-corpus check for specialist source requests (AC-9). Database tests skip unless RUN_DB_INTEGRATION=1.
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { processSourceRequests } from "../../../src/lib/research/sources/collector";
import { getStageSourceRequests, queueSourceRequests } from "../../../src/lib/research/sources/source-requests";
import { cleanup, createRun, exported, loadEnv, skipDb as skip, SOURCE_REQUESTS, stageCtx, storeDoc, stubWeb } from "./fixtures";

loadEnv();
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `coverage ${actual}, expected ${expected}`);

test("AC-9: coverage counts distinct significant terms; exactly 60% is reached at 3 of 5", () => {
  const queryTermCoverage = exported(SOURCE_REQUESTS, "queryTermCoverage");
  near(queryTermCoverage("StoneCo 2025 annual report 20-F", "PagSeguro 2025 annual report on Form 20-F"), 4 / 5);
  near(queryTermCoverage("StoneCo 2025 annual report 20-F", "PagSeguro 2025 annual report"), 3 / 5);
  near(queryTermCoverage("StoneCo 2025 annual report 20-F", "PagSeguro annual report"), 2 / 5);
  near(queryTermCoverage("REPORT report Report 2025", "The annual REPORT"), 1 / 2);
});

test("AC-9: stop words and tokens under three characters are not terms; years and form names are", () => {
  const queryTermCoverage = exported(SOURCE_REQUESTS, "queryTermCoverage");
  near(queryTermCoverage("The annual report of the Bank of Japan for 2025", "Bank of Japan annual report 2025"), 1);
  near(queryTermCoverage("8-K 2026", "Current report on Form 8-K filed in 2026"), 1);
  near(queryTermCoverage("10-K 2025", "Annual report for 2025"), 1 / 2);
  near(queryTermCoverage("of the a", "of the a"), 0);
});

test("AC-9: a same-role document sharing only generic terms leaves the query to the collector", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const web = stubWeb();
  try {
    // The sofi-v3 mock corpus peer document, scoped to this run.
    await storeDoc(sql, run, { title: "Mock peer company annual report", role: "peer_company_primary",
      content: `Mock peer issuer annual report disclosure for acceptance testing. ${run.runId}` });
    const query = "Upstart Holdings 2025 annual report 10-K";
    await queueSourceRequests(sql, run, "moat_analysis", "business", "moat:analysis:verify-generic", [
      { source_role: "peer_company_primary", query, reason: "Compare origination economics with a named lending peer" },
    ]);
    await processSourceRequests(sql, stageCtx(run));
    const request = (await getStageSourceRequests(sql, run.runId, "moat_analysis"))!.rounds[0].requests[0] as any;
    assert.ok(web.searches().includes(query));
    assert.equal(request.status, "unavailable");
  } finally { web.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-9: a document of another role does not make a query in_corpus; the search still fetches", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const query = "Nu Holdings 2025 annual report 20-F";
  const url = "https://nu-peer.example/investors/annual-report-2025";
  const page = `<html><head><title>Nu Holdings annual report</title><meta property="article:published_time" content="2026-03-20"></head><body>
    ${`<p>Nu Holdings annual report 2025: investor results, credit card receivables and filing disclosures. ${run.runId}</p>`.repeat(10)}</body></html>`;
  const web = stubWeb({ [url]: page }, () => [{ url, title: "Nu Holdings annual report 2025" }]);
  try {
    await storeDoc(sql, run, { title: "Nu Holdings 2025 annual report coverage note", role: "industry_primary",
      content: `Nu Holdings 2025 annual report 20-F summary by an industry analyst. ${run.runId}` });
    await queueSourceRequests(sql, run, "operating_model", "business", "operating:model:verify", [
      { source_role: "peer_company_primary", query, reason: "Compare credit loss rates with a named peer" },
    ]);
    await processSourceRequests(sql, stageCtx(run));
    const request = (await getStageSourceRequests(sql, run.runId, "operating_model"))!.rounds[0].requests[0] as any;
    assert.ok(web.searches().includes(query), "the role scope excludes the industry document");
    assert.equal(request.status, "fetched");
    const [doc] = await sql`SELECT id FROM source_documents WHERE research_run_id = ${run.runId} AND url = ${url}`;
    assert.deepEqual(request.documents.map((d: any) => d.source_id), [String(doc.id)]);
  } finally { web.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-9: with an empty corpus every query goes to the collector", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const web = stubWeb();
  try {
    const queries = ["StoneCo 2025 annual report 20-F", "PagSeguro 2025 annual report 20-F"];
    await queueSourceRequests(sql, run, "moat_analysis", "business", "moat:analysis:verify", queries.map(query =>
      ({ source_role: "peer_company_primary" as const, query, reason: "Compare acquiring economics" })));
    await processSourceRequests(sql, stageCtx(run));
    const round = (await getStageSourceRequests(sql, run.runId, "moat_analysis"))!.rounds[0];
    assert.deepEqual(round.requests.map((r: any) => r.status), ["unavailable", "unavailable"]);
    for (const query of queries) assert.ok(web.searches().includes(query), query);
  } finally { web.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});
