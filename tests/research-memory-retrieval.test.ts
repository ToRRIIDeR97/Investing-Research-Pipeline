// Research-memory retrieval fixes from the 2026-10-11 audit: period hints and recency (RMEM1), the stored
// search vector (RMEM2), the passage scope (RMEM4), text-table parsing (RMEM5) and per-run metadata (RMEM10).
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { coversPeriod, htmlToStructuredText, parseDocument, periodHints, retrievePassages, runDocuments } from "../src/lib/research/memory";
import { storeDiscoveredSources } from "../src/lib/research/sources/corpus";

const skip = process.env.RUN_DB_INTEGRATION !== "1";
delete process.env.RESEARCH_EMBEDDING_PROVIDER;
if (!process.env.DATABASE_URL && existsSync(".env.local")) {
  const line = readFileSync(".env.local", "utf8").split(/\r?\n/).find(l => l.startsWith("DATABASE_URL="));
  if (line) process.env.DATABASE_URL = line.slice("DATABASE_URL=".length).trim().replace(/^['"]|['"]$/g, "");
}

test("period hints read ISO dates, quarters and years, and a document covers a period it ends in or reports on shortly after", () => {
  assert.deepEqual(periodHints("Restate the bridge with 2026-06-30 current debt from the Q2 2026 10-Q").map(h => [h.label, h.start, h.end]),
    [["2026-06-30", "2026-06-30", "2026-06-30"], ["Q2 2026", "2026-04-01", "2026-06-30"]], "a year inside a date or quarter is not read again");
  assert.deepEqual(periodHints("Q3'25 and 4Q24 versus FY2023").map(h => [h.start, h.end]),
    [["2025-07-01", "2025-09-30"], ["2024-10-01", "2024-12-31"], ["2023-01-01", "2023-12-31"]]);
  assert.deepEqual(periodHints("Revenue of 12,019 and 10-K segment notes"), [], "numbers that are not years name no period");
  assert.deepEqual(periodHints("Take current debt from the Q2 10-Q and the 4Q 10-K"), [], "a form number after a quarter is not a year");
  const [q2] = periodHints("Q2 2026");
  assert.equal(coversPeriod({ periodEnd: "2026-06-30", publishedAt: "2026-07-30" }, q2), true, "the quarter's 10-Q");
  assert.equal(coversPeriod({ periodEnd: "2026-07-29", publishedAt: "2026-07-29" }, q2), true, "an earnings release filed after the quarter");
  assert.equal(coversPeriod({ periodEnd: "2026-03-31", publishedAt: "2026-04-30" }, q2), false, "the prior quarter's 10-Q");
  assert.equal(coversPeriod({ periodEnd: "2026-09-30", publishedAt: null }, q2), false, "the next quarter");
  assert.equal(coversPeriod({ periodEnd: null, publishedAt: "2026-05-02" }, q2), true, "a dated page without a period end");
  assert.equal(coversPeriod({ periodEnd: null, publishedAt: null }, q2), false);
});

const priceRows = Array.from({ length: 60 }, (_, i) => `<tr><td>Aug ${i + 1}, 2026</td><td>1,${700 + i}.00</td><td>${709_200 + i}</td></tr>`).join("");
const priceTable = `<h2>Historical Prices</h2><table><tr><th>Date</th><th>Close</th><th>Volume</th></tr>${priceRows}</table>`;

test("a table stored as structured text keeps its rows, and every split piece starts with the header row", () => {
  const text = htmlToStructuredText(`<html><body>${priceTable}</body></html>`);
  for (const [label, parsed] of [["text/plain", parseDocument(text, "text/plain", { maxChars: 400 })],
    ["text/html", parseDocument(`<html><body>${priceTable}</body></html>`, "text/html", { maxChars: 400 })]] as const) {
    const pieces = parsed.passages.filter(p => p.sectionPath.at(-1) === "Historical Prices");
    assert.ok(pieces.length >= 3, `${label}: the table is split`);
    assert.ok(pieces.every(p => p.blockTypes.includes("table")), `${label}: pieces are typed as a table`);
    for (const piece of pieces) {
      assert.ok(piece.text.length <= 400, `${label}: maxChars is kept`);
      const rows = piece.text.split("\n").filter(line => line !== "Historical Prices");
      assert.equal(rows[0], "Date | Close | Volume", `${label}: each piece starts with the column headers`);
      for (const row of rows.slice(1)) assert.match(row, /^Aug \d+, 2026 \| 1,\d{3}\.00 \| \d{6}$/, `${label}: no row is cut or joined to the next`);
    }
  }
});

type Run = { runId: string; assetId: string; ctx: Record<string, unknown> };

async function newRun(sql: postgres.Sql, assetName = "Retrieval Fixture Co"): Promise<Run> {
  const assetId = randomUUID(), runId = randomUUID();
  const ctx = { runId, runType: "deep_dive", assetId, assetName, assetSlug: `retrieval-${assetId.slice(0, 8)}`, symbol: "RTRV",
    profileId: "", profileKey: "", requiredModules: [], requiredLenses: [], marketDataCutoffAt: null, pipelineVersion: 3 };
  await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind, status, base_currency) VALUES (${assetId}, ${assetName}, ${ctx.assetSlug}, 'equity', 'active', 'USD')`;
  await sql`INSERT INTO research_runs (id, asset_id, run_type, status, source_cutoff_at, pipeline_version, budget_limit_usd)
    VALUES (${runId}, ${assetId}, 'deep_dive', 'running', '2026-10-01', 3, 10)`;
  return { runId, assetId, ctx };
}

async function store(sql: postgres.Sql, run: Run, doc: { title: string; content: string; role?: string; sourceType?: string; url?: string;
  periodEnd?: string | null; publishedAt?: string | null; mimeType?: string; metadata?: Record<string, unknown> }) {
  const [stored] = await storeDiscoveredSources(sql, run.ctx as any, [{ sourceType: doc.sourceType || `web_${doc.role}`, title: doc.title,
    publisher: "retrieval.example", url: doc.url || `https://retrieval.example/${randomUUID()}`, content: doc.content, mimeType: doc.mimeType || "text/plain",
    qualityScore: "0.9", publishedAt: doc.publishedAt ?? null, periodEnd: doc.periodEnd ?? null,
    metadata: doc.metadata || { source_role: doc.role, system_generated: true }, chunkTitle: doc.title }] as any);
  return String(stored.sourceId);
}

async function removeRuns(sql: postgres.Sql, runs: Run[]) {
  const runIds = runs.map(r => r.runId), assetIds = runs.map(r => r.assetId);
  const docs = sql`SELECT id FROM source_documents WHERE research_run_id = ANY(${runIds}::uuid[])
    OR id IN (SELECT source_document_id FROM research_run_sources WHERE research_run_id = ANY(${runIds}::uuid[]))`;
  const ids = (await docs).map(row => String(row.id));
  await sql`DELETE FROM research_run_sources WHERE research_run_id = ANY(${runIds}::uuid[]) OR source_document_id = ANY(${ids}::uuid[])`;
  for (const table of ["source_locations", "document_chunks", "document_parses", "source_role_assignments"]) {
    await sql`DELETE FROM ${sql(table)} WHERE source_document_id = ANY(${ids}::uuid[])`;
  }
  await sql`DELETE FROM source_documents WHERE id = ANY(${ids}::uuid[])`;
  await sql`DELETE FROM research_runs WHERE id = ANY(${runIds}::uuid[])`;
  await sql`DELETE FROM assets WHERE id = ANY(${assetIds}::uuid[])`;
}

const LEASE_NOTE = "We have entered into various non-cancelable operating lease agreements for certain of our offices, data centers, land and colocations. We have also entered into finance lease agreements for certain network infrastructure.";
const tenQ = (note: number, quarterEnd: string, nonce: string, balance = "") => [
  `Note ${note}. Leases`, "", LEASE_NOTE, "",
  "CONDENSED CONSOLIDATED BALANCE SHEETS", "", `Balance sheet as of ${quarterEnd}. Current debt and finance lease liabilities, current ${balance} ${nonce}.`,
].join("\n");

test("retrieval reads the period a question names first, gives ties to the newest filing and keeps one copy of a restated note", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    const filing = (title: string, periodEnd: string, publishedAt: string, content: string) =>
      store(sql, run, { title, content, role: "regulatory_filing", sourceType: "sec_filing_10-q", periodEnd, publishedAt });
    const old = await filing("10-Q report 2025-06-30", "2025-06-30", "2025-07-31", tenQ(8, "June 30, 2025", run.runId));
    const q3 = await filing("10-Q report 2025-09-30", "2025-09-30", "2025-10-30", tenQ(8, "September 30, 2025", run.runId));
    const latest = await filing("10-Q report 2026-06-30", "2026-06-30", "2026-07-30", tenQ(7, "June 30, 2026", run.runId, "of 308 million"));
    await store(sql, run, { title: "10-K report 2021-12-31", role: "regulatory_filing", sourceType: "sec_filing_10-k", periodEnd: "2021-12-31",
      publishedAt: "2022-02-03", content: ["Lease Obligations", "", `Our lease obligations, finance lease liabilities and current debt are described below. ${LEASE_NOTE}`].join("\n") });

    const bridge = await retrievePassages(sql, { runId: run.runId, need: { key: "bridge", sourceRoles: ["regulatory_filing"], maxPassages: 3,
      query: "Restate the equity bridge with 2026-06-30 current debt and finance lease liabilities from the Q2 2026 10-Q balance sheet" } });
    assert.equal(bridge.passages[0].source_id, latest, "the Q2 2026 10-Q is read first");
    assert.ok(bridge.passages.slice(0, 2).every(p => p.source_id === latest), "its passages fill the first slots");
    assert.ok(bridge.passages.some(p => p.text.includes("308 million")), "the balance-sheet passage is returned");
    assert.equal(bridge.passages.filter(p => p.text.includes(LEASE_NOTE.slice(0, 60)) && p.section_path.at(-1)?.endsWith("Leases")).length, 1,
      "the lease note restated in each 10-Q takes one slot");
    assert.deepEqual(bridge.gaps, []);

    const leases = await retrievePassages(sql, { runId: run.runId, need: { key: "leases", query: "operating lease agreements colocations", sourceRoles: ["regulatory_filing"] } });
    const notes = leases.passages.filter(p => p.section_path.at(-1)?.endsWith("Leases"));
    assert.deepEqual(notes.map(p => p.source_id), [latest], "without a period, the newest copy of the note is kept");
    assert.ok(!leases.passages.some(p => p.source_id === old && p.section_path.at(-1)?.endsWith("Leases")));

    const third = await retrievePassages(sql, { runId: run.runId, need: { key: "q3", query: "Q3 2025 lease agreements", sourceRoles: ["regulatory_filing"] } });
    assert.equal(third.passages[0].source_id, q3, "the copy from the period asked for wins over the newest");

    const missing = await retrievePassages(sql, { runId: run.runId, need: { key: "missing", query: "Q4 2023 lease agreements", sourceRoles: ["regulatory_filing"] } });
    assert.ok(missing.passages.length > 0, "other periods still answer");
    assert.deepEqual(missing.gaps.map(g => [g.reason, g.detail]), [["no_documents_for_period", "No document in scope covers Q4 2023."]]);
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});

test("a question naming two periods gets each period's copy of a statement, and an older restatement still collapses", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    const balanceSheet = (asOf: string, debt: string, lease: string) => ["CONDENSED CONSOLIDATED BALANCE SHEETS", "",
      `Current portion of long-term debt ${debt}. Finance lease liabilities, current ${lease}. Accrued expenses and other current liabilities. Total current liabilities. As of ${asOf}. ${run.runId}`].join("\n");
    const filing = (title: string, sourceType: string, periodEnd: string, publishedAt: string, content: string) =>
      store(sql, run, { title, content, role: "regulatory_filing", sourceType, periodEnd, publishedAt });
    const annual = await filing("10-K report 2025-12-31", "sec_filing_10-k", "2025-12-31", "2026-02-01", balanceSheet("December 31, 2025", "1,000", "270"));
    const q1 = await filing("10-Q report 2026-03-31", "sec_filing_10-q", "2026-03-31", "2026-04-30", balanceSheet("March 31, 2026", "1,100", "290"));
    const q2 = await filing("10-Q report 2026-06-30", "sec_filing_10-q", "2026-06-30", "2026-07-30", balanceSheet("June 30, 2026", "1,250", "308"));
    const result = await retrievePassages(sql, { runId: run.runId, need: { key: "compare", sourceRoles: ["regulatory_filing"], maxPassages: 4,
      query: "Compare current debt and finance lease liabilities at 2026-03-31 and 2026-06-30 from the balance sheets" } });
    assert.deepEqual(result.passages.map(p => p.source_id), [q2, q1], "each period asked for keeps its own balance sheet, newest first");
    assert.ok(!result.passages.some(p => p.source_id === annual), "the 10-K's copy, from no period asked for, collapses");
    assert.deepEqual(result.gaps, []);
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});

test("research-memory passages store their search vector; raw payload chunks do not", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    const id = await store(sql, run, { title: "Industry review", role: "industry_primary", content: `Market Structure\n\nAcquirers compete on merchant pricing. ${run.runId}` });
    const rows = await sql`SELECT dp.parser_name, dc.search_tsv IS NOT NULL AS indexed, ts_filter(dc.search_tsv, '{a}') AS section
      FROM document_chunks dc JOIN document_parses dp ON dp.id = dc.document_parse_id WHERE dc.source_document_id = ${id} ORDER BY dp.parser_name`;
    assert.deepEqual(rows.map(r => [r.parser_name, r.indexed]), [["research-memory", true], ["system-source-payload", false]]);
    assert.match(String(rows[0].section), /'market':\d+A/, "the section path is weighted A");
    const result = await retrievePassages(sql, { runId: run.runId, need: { key: "pricing", query: "merchant pricing", sourceRoles: ["industry_primary"] } });
    assert.equal(result.passages.length, 1);
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});

test("companyfacts JSON gets no passages and stays out of scope, and only the newest document per URL is retrieved", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    const facts = await store(sql, run, { title: "Primary source context", sourceType: "primary_source_context", mimeType: "application/json",
      url: `https://data.sec.gov/${randomUUID()}`, metadata: { system_generated: true },
      content: JSON.stringify({ facts: { "us-gaap": { Revenues: { description: `Amount of revenue recognized from goods sold. ${run.runId}` } } } }) });
    await sql`INSERT INTO source_role_assignments (source_document_id, role, confidence, rationale) VALUES (${facts}, 'regulatory_filing', 100, 'Mapped from document metadata')`;
    const [{ parses }] = await sql`SELECT COUNT(*)::int AS parses FROM document_parses WHERE source_document_id = ${facts} AND parser_name = 'research-memory'`;
    assert.equal(parses, 0, "the companyfacts payload is not indexed");

    const url = `https://retrieval.example/${randomUUID()}`;
    const first = await store(sql, run, { title: "Annual report", role: "regulatory_filing", url, content: `Revenue Recognition\n\nRevenue is recognized when goods are sold. First copy ${run.runId}` });
    await sql`UPDATE source_documents SET created_at = created_at - INTERVAL '1 day' WHERE id = ${first}`;
    const second = await store(sql, run, { title: "Annual report", role: "regulatory_filing", url, content: `Revenue Recognition\n\nRevenue is recognized when goods are sold. Second copy ${run.runId}` });

    const ids = (await runDocuments(sql, run.runId)).map(doc => doc.id);
    assert.deepEqual(ids, [second], "neither the companyfacts context nor the older copy of the URL is in scope");
    const result = await retrievePassages(sql, { runId: run.runId, need: { key: "revenue", query: "revenue recognized goods sold", sourceRoles: ["regulatory_filing"] } });
    assert.deepEqual([...new Set(result.passages.map(p => p.source_id))], [second]);
    const [{ lazily }] = await sql`SELECT COUNT(*)::int AS lazily FROM document_parses WHERE source_document_id = ${facts} AND parser_name = 'research-memory'`;
    assert.equal(lazily, 0, "retrieval does not index it on demand either");
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});

test("a document shared by two runs carries each run's own title and source role", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const alpha = await newRun(sql, "Alpha Fixture Co"), beta = await newRun(sql, "Beta Fixture Co");
  try {
    const content = `observation_date,DGS10\n2026-09-01,4.21\n2026-09-02,4.25\n${randomUUID()}`;
    const first = await store(sql, alpha, { title: "Alpha Fixture Co macro context: US 10-year Treasury yield", content, mimeType: "text/csv",
      sourceType: "macro_context", metadata: { system_generated: true, source: "fred", source_role: "industry_primary" } });
    const shared = await store(sql, beta, { title: "US 10-year Treasury yield (FRED DGS10)", content, mimeType: "text/csv",
      sourceType: "macro_context", metadata: { system_generated: true, source: "fred", source_role: "macro_dataset" } });
    assert.equal(shared, first, "identical content is one document");
    const [doc] = await runDocuments(sql, beta.runId);
    assert.deepEqual([doc.title, doc.role], ["US 10-year Treasury yield (FRED DGS10)", "macro_dataset"]);
    const [own] = await runDocuments(sql, alpha.runId);
    assert.deepEqual([own.title, own.role], ["Alpha Fixture Co macro context: US 10-year Treasury yield", "industry_primary"]);
    const { passages } = await retrievePassages(sql, { runId: beta.runId, need: { key: "rates", query: "DGS10 observation", sourceRoles: ["macro_dataset"] } });
    assert.ok(passages.length > 0);
    assert.ok(passages.every(p => !p.title.includes("Alpha")), "another asset's name never reaches the packet");
  } finally { await removeRuns(sql, [alpha, beta]); await sql.end(); }
});
