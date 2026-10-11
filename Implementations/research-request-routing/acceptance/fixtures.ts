// Fixtures for the research-request-routing acceptance tests.
// Requests and the market-history header are copied from META run 1d427f3f (2026-10-10).
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { STAGE_CONFIGS } from "../../../src/lib/workflow/stages";
import { MockProvider } from "../../../src/lib/agent-harness/providers/mock";
import { storeDiscoveredSources } from "../../../src/lib/research/sources/corpus";
import { saveReportArtifact } from "../../../src/lib/research/reporting/store";
import { getTeamRequests, processResearchRequests } from "../../../src/lib/research/team";

export const skipDb = process.env.RUN_DB_INTEGRATION !== "1";
export const TEAM = "../../../src/lib/research/team";
export const ORCHESTRATOR = "../../../src/lib/workflow/orchestrator";
export const RESET_ROUTE = "../../../src/app/api/research-runs/[id]/request-reset/route";
export const SOURCE_REQUESTS = "../../../src/lib/research/sources/source-requests";
export const TAIL = ["ai_reviewer", "human_review", "export", "refresh_schedule"];

/** Never a paid provider, embedding endpoint or OCR service. Only DATABASE_URL is read from .env.local. */
export function loadEnv() {
  process.env.RESEARCH_MODEL_PROVIDER = "mock";
  delete process.env.RESEARCH_EMBEDDING_PROVIDER;
  delete process.env.RESEARCH_OCR_URL;
  delete process.env.RESEARCH_MAX_AUTO_RESET_STAGES;
  if (process.env.DATABASE_URL || !existsSync(".env.local")) return;
  const line = readFileSync(".env.local", "utf8").split(/\r?\n/).find(l => /^DATABASE_URL=/.test(l.trim()));
  if (line) process.env.DATABASE_URL = line.trim().slice("DATABASE_URL=".length).replace(/^['"]|['"]$/g, "");
}

/** A new export fails its test with "export X is missing", not an import crash for the whole file. */
export function exported<T = any>(modulePath: string, name: string): T {
  let mod: any;
  try {
    mod = require(resolve(__dirname, modulePath));
  } catch (error) {
    assert.fail(`${modulePath} is missing or failed to load: ${String((error as Error).message).split("\n")[0]}`);
  }
  const value = mod?.[name] ?? mod?.default?.[name];
  if (value === undefined) assert.fail(`export ${name} is missing from ${modulePath}`);
  return value as T;
}

export const REQUEST_1_2 = { id: "request-1-2", role: "financials" as const, material: true, needs_sources: false, source_role: "regulatory_filing" as const,
  question: "Verify the Q1 2026 purchases of property and equipment ($18,997m), which is derived as H1 2026 year-to-date less the Q2 three-month figure, against the Q1 2026 10-Q cash flow statement. Also verify the derived Q3 and Q4 2025 cash flow quarters, which come from year-to-date reporting, because quarterly capex and free cash flow anchor the monitoring thresholds and reinvestment argument." };
export const REQUEST_1_3 = { id: "request-1-3", role: "data" as const, material: true, needs_sources: true, source_role: "market_data" as const,
  question: "Obtain a dated, verified META price history through 2026-10-09, since the $718.67 price is unverified, together with a dated FRED DGS10 risk-free rate series and a documented beta source, so the 9.5% discount rate can be checked. Every expected return, the reverse valuation and the investment stance depend on these inputs." };
export const REQUEST_1_4 = { id: "request-1-4", role: "valuation" as const, material: true, needs_sources: false, source_role: "regulatory_filing" as const,
  question: "Reconcile the valuation schedule's value_per_share fields with the source-note DCF values and the annual_price_target_path values, and confirm whether discounting runs end-of-period from 2026-06-30 or from 2025-12-31." };
export const REQUEST_1_5 = { id: "request-1-5", role: "business" as const, material: true, needs_sources: true, source_role: "proxy_and_governance" as const,
  question: "Provide sourced management inputs for the management chapter: officer names, roles, effective dates and documented reporting lines from the 10-K executive officer list and proxy, so an organization chart can be built." };
export const RISK_FREE = { id: "request-1-6", role: "valuation" as const, material: true, needs_sources: false, source_role: "macro_dataset" as const,
  question: "Which 10-year Treasury yield should anchor the discount rate, and as of which date?" };

/** The header of 1d427f3f's validated market_price_history artifact (version 4). */
export const MARKET_HISTORY = {
  artifact_type: "market_price_history", provider: "yahoo", provider_symbol: "META", market_data_cutoff: "2026-10-10T11:04:48.258Z",
  bars_available: 1506, first_trading_day: "2020-10-12", last_trading_day: "2026-10-09", splits: [],
  cross_check: { provider: "stooq", tolerance_pct: 0.5, verified_periods: 0, unverified_periods: 27 },
  valuation_price: { price: 718.67, currency: "USD", provider: "yahoo", verified: false, trading_date: "2026-10-09", verification_status: "unverified" },
  observations: [], method: [],
};

/** FRED DGS10 as corpus.ts stores it (header, then observation rows). The latest value is 5.22 on 2026-10-08. */
export function fredCsv(nonce: string = randomUUID()) {
  const seed = parseInt(nonce.replace(/-/g, "").slice(0, 8), 16);
  const history = Array.from({ length: 20 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")},${(4 + ((seed >>> (i % 24)) % 90) / 100).toFixed(2)}`);
  return ["observation_date,DGS10", ...history, "2026-10-05,5.31", "2026-10-06,5.27", "2026-10-07,5.28", "2026-10-08,5.22"].join("\n");
}

export type Run = { runId: string; assetId: string; assetSlug: string; assetName: string; symbol: string; cutoffAt: Date };

/** Every stage completed, the report stage running, the tail pending: the moment team requests are processed. */
export const REPORT_STAGE = Object.fromEntries(STAGE_CONFIGS.map(s => [s.key,
  s.key === "ai_reviewer" ? "running" : ["human_review", "export", "refresh_schedule"].includes(s.key) ? "pending" : "completed"]));

export async function createRun(sql: postgres.Sql, statuses: Record<string, string> = REPORT_STAGE, runStatus = "running"): Promise<Run> {
  const assetId = randomUUID(), runId = randomUUID();
  const run = { assetId, runId, assetSlug: `routing-${assetId.slice(0, 8)}`, assetName: "Routing Fixture Platforms",
    symbol: "RFPQA", cutoffAt: new Date("2026-10-01T00:00:00Z") };
  await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind, status, base_currency)
    VALUES (${assetId}, ${run.assetName}, ${run.assetSlug}, 'equity', 'active', 'USD')`;
  await sql`INSERT INTO research_runs (id, asset_id, run_type, status, source_cutoff_at, pipeline_version, budget_limit_usd)
    VALUES (${runId}, ${assetId}, 'deep_dive', ${runStatus}, '2026-10-01', 3, 10)`;
  for (const [order, stage] of STAGE_CONFIGS.entries()) {
    await sql`INSERT INTO research_stages (research_run_id, stage_key, stage_order, status)
      VALUES (${runId}, ${stage.key}, ${order}, ${statuses[stage.key] || "completed"})`;
  }
  return run;
}

/** The stage context handlers and processResearchRequests receive. */
export const stageCtx = (run: Run) => ({ ...run, runType: "deep_dive", pipelineVersion: 3, marketDataCutoffAt: null,
  profileId: null, profileKey: null, researchQuestion: "Evaluate the company.", budgetLimitUsd: 10, budgetSpentUsd: 0,
  budgetRemainingUsd: 10, testMode: true, syntheticFixtureId: null, composedProfile: null, archetypeKeys: [], overlayKeys: [],
  timingHypothesis: null }) as any;

const corpusCtx = (run: Run) => ({ runId: run.runId, runType: "deep_dive", assetId: run.assetId, assetName: run.assetName,
  assetSlug: run.assetSlug, symbol: run.symbol, profileId: "", profileKey: "", requiredModules: [], requiredLenses: [],
  marketDataCutoffAt: null, pipelineVersion: 3 });

/** Store one document for the run through the normal path (raw file, chunks and research-memory passages). */
export async function storeDoc(sql: postgres.Sql, run: Run, input: { title: string; content: string; role?: string;
  mimeType?: string; sourceType?: string; metadata?: Record<string, unknown> }) {
  const [stored] = await storeDiscoveredSources(sql, corpusCtx(run) as any, [{
    sourceType: input.sourceType || `web_${input.role}`, title: input.title, publisher: "fixture.example",
    url: `https://fixture.example/${randomUUID()}`, content: input.content, mimeType: input.mimeType || "text/plain",
    qualityScore: "0.9", publishedAt: "2026-09-01", periodEnd: null,
    metadata: input.metadata || { source_role: input.role, system_generated: true }, chunkTitle: input.title,
  } as any]);
  return String(stored.sourceId);
}

/** The FRED document exactly as macroSourcePayload stores it. */
export const storeFred = (sql: postgres.Sql, run: Run, csv: string) => storeDoc(sql, run, {
  title: `${run.assetName} macro context: US 10-year Treasury yield`, content: csv, mimeType: "text/csv", sourceType: "macro_context",
  metadata: { system_generated: true, source: "fred", series_id: "DGS10", retrieved_at: "2026-10-10T11:00:00.000Z" } });

export const saveBatch = (sql: postgres.Sql, run: Run, requests: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  saveReportArtifact(sql, run, "team_requests", "requests", { round: 1, state: "queued", requests, ...extra });

export async function stageStatuses(sql: postgres.Sql, runId: string): Promise<Record<string, string>> {
  const rows = await sql`SELECT stage_key, status FROM research_stages WHERE research_run_id = ${runId} ORDER BY stage_order`;
  return Object.fromEntries(rows.map(r => [String(r.stage_key), String(r.status)]));
}

export async function runState(sql: postgres.Sql, runId: string) {
  const [row] = await sql`SELECT status, metadata_json FROM research_runs WHERE id = ${runId}`;
  return { status: String(row.status), metadata: (row.metadata_json || {}) as Record<string, any> };
}

/** Call processResearchRequests as the runner loop would, until the batch is answered or the run leaves running. */
export async function drain(sql: postgres.Sql, run: Run, rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    if ((await runState(sql, run.runId)).status !== "running") return;
    const batch = await getTeamRequests(sql, run.runId);
    if (!batch || batch.state === "answered") return;
    await processResearchRequests(sql, stageCtx(run));
  }
}

export async function seedCost(sql: postgres.Sql, runId: string, stageKey: string, costUsd: number) {
  await sql`INSERT INTO model_call_logs (research_run_id, stage_id, agent_name, model_provider, model_name, model_tier, cost_usd, status)
    SELECT ${runId}, id, 'fixture-agent', 'fixture', 'fixture-model', 'mid', ${costUsd}, 'success'
    FROM research_stages WHERE research_run_id = ${runId} AND stage_key = ${stageKey}`;
}

export type ModelCall = { agent: string; contract: string; packet: any; prompt: string };
/**
 * Script the mock provider. `respond` returns the JSON output, an Error to fail the call, or undefined
 * to fall through to the normal mock. Every call is recorded with its parsed task packet.
 */
export function scriptModel(respond: (packet: any, call: number) => Record<string, unknown> | Error | undefined) {
  const original = MockProvider.prototype.stream;
  const calls: ModelCall[] = [];
  MockProvider.prototype.stream = async function* (this: any, request: any, signal: AbortSignal) {
    const at = request.prompt.lastIndexOf("Task packet:");
    let packet: any = {};
    try { packet = JSON.parse(request.prompt.slice(at + 12).trim()); } catch { /* not a research packet */ }
    calls.push({ agent: String(request.agentName || ""), contract: String(packet.output_contract || ""), packet, prompt: request.prompt });
    const response = respond(packet, calls.length);
    if (response === undefined) { yield* original.call(this, request, signal); return; }
    if (response instanceof Error) throw response;
    yield { type: "response.started", requestId: `routing-fixture-${calls.length}` };
    yield { type: "text.delta", text: JSON.stringify(response) };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    yield { type: "response.completed", finishReason: "stop" };
  } as any;
  return { calls, answers: () => calls.filter(c => c.contract === "team_answer"), restore() { MockProvider.prototype.stream = original; } };
}

/**
 * Replace global fetch for web discovery. Search requests go to search.example and return `results(query)`;
 * other URLs return the matching fixture page or 404. Nothing reaches the network.
 */
export function stubWeb(pages: Record<string, string> = {}, results: (query: string) => { url: string; title: string }[] = () => []) {
  const settings: Record<string, string | undefined> = { RESEARCH_WEB_SEARCH_ENDPOINT: "https://search.example/api", RESEARCH_WEB_DISCOVERY_ENABLED: "1",
    RESEARCH_ACCEPTANCE_PROVIDER: undefined, RESEARCH_TEST_MODE: undefined, RESEARCH_WEB_SEARCH_API_KEY: undefined };
  const prior = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(settings)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.href);
    if (url.hostname === "search.example") return Response.json({ results: results(url.searchParams.get("q") || "") });
    const page = pages[url.href];
    return page ? new Response(page, { headers: { "content-type": "text/html" } }) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return {
    calls,
    searches: () => calls.filter(href => new URL(href).hostname === "search.example").map(href => new URL(href).searchParams.get("q") || ""),
    restore() {
      globalThis.fetch = original;
      for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    },
  };
}

/** A fetched proxy-statement page that passes discovery's identity, role and cutoff checks. */
export const PROXY_URL = "https://governance.example/investors/proxy-statement-2026";
export const proxyPage = (run: Run) => `<html><head><title>${run.assetName} 2026 proxy statement</title>
<meta property="article:published_time" content="2026-04-15"></head><body><h1>Executive officers and board governance</h1>
${`<p>${run.assetName} executive officers: Jane Example, Chief Executive Officer since 2019, reports to the board of directors; Omar Sample, Chief Financial Officer since 2021, reports to the Chief Executive Officer. Proxy statement fixture ${run.runId}.</p>`.repeat(8)}
</body></html>`;

/** Remove the fixture runs, the documents they created, and those documents' stored files. */
export async function cleanup(sql: postgres.Sql, runIds: string[], assetIds: string[]) {
  const documents = await sql`SELECT id, storage_path FROM source_documents WHERE research_run_id = ANY(${runIds}::uuid[])`;
  const ids = documents.map(d => String(d.id));
  const tables = (await sql`SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'research_run_id'`).map(r => String(r.table_name)).filter(t => t !== "source_documents");
  for (let pass = 0; pass < 5; pass++) {
    for (const statement of [
      () => sql`DELETE FROM research_artifact_claim_links WHERE artifact_id IN (SELECT id FROM research_artifacts WHERE research_run_id = ANY(${runIds}::uuid[]))`,
      () => sql`DELETE FROM claim_relationships WHERE from_claim_id IN (SELECT id FROM evidence_claims WHERE research_run_id = ANY(${runIds}::uuid[]))`,
      () => sql`DELETE FROM evidence_links WHERE evidence_claim_id IN (SELECT id FROM evidence_claims WHERE research_run_id = ANY(${runIds}::uuid[]))`,
    ]) { try { await statement(); } catch { /* FK order; retry next pass */ } }
    for (const name of tables) {
      try { await sql`DELETE FROM ${sql(name)} WHERE research_run_id = ANY(${runIds}::uuid[])`; } catch { /* retry */ }
    }
    if (ids.length) for (const name of ["document_embeddings", "evidence_links", "source_locations", "document_chunks", "document_parses", "source_role_assignments", "research_run_sources"]) {
      try {
        if (name === "document_embeddings") await sql`DELETE FROM document_embeddings WHERE document_chunk_id IN (SELECT id FROM document_chunks WHERE source_document_id = ANY(${ids}::uuid[]))`;
        else if (name === "evidence_links") await sql`DELETE FROM evidence_links WHERE source_location_id IN (SELECT id FROM source_locations WHERE source_document_id = ANY(${ids}::uuid[]))`;
        else await sql`DELETE FROM ${sql(name)} WHERE source_document_id = ANY(${ids}::uuid[])`;
      } catch { /* retry */ }
    }
    if (ids.length) { try { await sql`DELETE FROM source_documents WHERE id = ANY(${ids}::uuid[])`; } catch { /* retry */ } }
    try { await sql`DELETE FROM research_runs WHERE id = ANY(${runIds}::uuid[])`; } catch { /* retry */ }
  }
  await sql`DELETE FROM assets WHERE id = ANY(${assetIds}::uuid[])`.catch(() => undefined);
  for (const doc of documents) {
    const path = String(doc.storage_path || "");
    if (/^storage\/sources\/[0-9a-f]{64}\.\w+$/.test(path)) await rm(path, { force: true });
  }
}
