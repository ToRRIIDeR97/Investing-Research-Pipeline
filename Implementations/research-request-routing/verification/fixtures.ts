// Fixtures for the research-request-routing verification tests. Self-contained: they do not import the
// acceptance fixtures, so this folder can be kept outside a worker's checkout.
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
import { setPublicFetchForTests } from "../../../src/lib/net";

export const skipDb = process.env.RUN_DB_INTEGRATION !== "1";
export const TEAM = "../../../src/lib/research/team";
export const ORCHESTRATOR = "../../../src/lib/workflow/orchestrator";
export const RESET_ROUTE = "../../../src/app/api/research-runs/[id]/request-reset/route";
export const SOURCE_REQUESTS = "../../../src/lib/research/sources/source-requests";
export const TAIL = ["ai_reviewer", "human_review", "export", "refresh_schedule"];

export function loadEnv() {
  process.env.RESEARCH_MODEL_PROVIDER = "mock";
  delete process.env.RESEARCH_EMBEDDING_PROVIDER;
  delete process.env.RESEARCH_OCR_URL;
  delete process.env.RESEARCH_MAX_AUTO_RESET_STAGES;
  if (process.env.DATABASE_URL || !existsSync(".env.local")) return;
  const line = readFileSync(".env.local", "utf8").split(/\r?\n/).find(l => /^DATABASE_URL=/.test(l.trim()));
  if (line) process.env.DATABASE_URL = line.trim().slice("DATABASE_URL=".length).replace(/^['"]|['"]$/g, "");
}

export function exported<T = any>(modulePath: string, name: string): T {
  let mod: any;
  try { mod = require(resolve(__dirname, modulePath)); }
  catch (error) { assert.fail(`${modulePath} is missing or failed to load: ${String((error as Error).message).split("\n")[0]}`); }
  const value = mod?.[name] ?? mod?.default?.[name];
  if (value === undefined) assert.fail(`export ${name} is missing from ${modulePath}`);
  return value as T;
}

/** A verified price history: every period cross-checked, quarter-end last trading day. */
export const VERIFIED_HISTORY = {
  artifact_type: "market_price_history", provider: "yahoo", provider_symbol: "VHQA", market_data_cutoff: "2026-09-30T23:59:59.000Z",
  bars_available: 1012, first_trading_day: "2022-09-30", last_trading_day: "2026-09-30", splits: [],
  cross_check: { provider: "stooq", tolerance_pct: 0.5, verified_periods: 20, unverified_periods: 0 },
  valuation_price: { price: 41.3, currency: "USD", provider: "yahoo", verified: true, trading_date: "2026-09-30", verification_status: "verified" },
  observations: [], method: [],
};

/** FRED rows ending in a holiday blank (2026-10-12, Columbus Day): the latest value is 4.12 on 2026-10-09. */
export const fredWithTrailingBlank = (nonce: string) => ["observation_date,DGS10",
  `2026-09-${String(10 + (parseInt(nonce.slice(0, 2), 16) % 18)).padStart(2, "0")},4.0${parseInt(nonce.slice(2, 3), 16) % 10}`,
  `2026-09-29,4.${String(parseInt(nonce.slice(3, 5), 16) % 90 + 10)}`,
  "2026-10-07,4.18", "2026-10-08,4.15", "2026-10-09,4.12", "2026-10-12,"].join("\n");

export type Run = { runId: string; assetId: string; assetSlug: string; assetName: string; symbol: string; cutoffAt: Date };
export const REPORT_STAGE = Object.fromEntries(STAGE_CONFIGS.map(s => [s.key,
  s.key === "ai_reviewer" ? "running" : TAIL.slice(1).includes(s.key) ? "pending" : "completed"]));

export async function createRun(sql: postgres.Sql, statuses: Record<string, string> = REPORT_STAGE, runStatus = "running"): Promise<Run> {
  const assetId = randomUUID(), runId = randomUUID();
  const run = { assetId, runId, assetSlug: `verify-routing-${assetId.slice(0, 8)}`, assetName: "Harbor Verification Systems",
    symbol: "VHQA", cutoffAt: new Date("2026-10-15T00:00:00Z") };
  await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind, status, base_currency)
    VALUES (${assetId}, ${run.assetName}, ${run.assetSlug}, 'equity', 'active', 'USD')`;
  await sql`INSERT INTO research_runs (id, asset_id, run_type, status, source_cutoff_at, pipeline_version, budget_limit_usd)
    VALUES (${runId}, ${assetId}, 'deep_dive', ${runStatus}, '2026-10-15', 3, 10)`;
  for (const [order, stage] of STAGE_CONFIGS.entries()) {
    await sql`INSERT INTO research_stages (research_run_id, stage_key, stage_order, status)
      VALUES (${runId}, ${stage.key}, ${order}, ${statuses[stage.key] || "completed"})`;
  }
  return run;
}

export const stageCtx = (run: Run) => ({ ...run, runType: "deep_dive", pipelineVersion: 3, marketDataCutoffAt: null,
  profileId: null, profileKey: null, researchQuestion: "Evaluate the company.", budgetLimitUsd: 10, budgetSpentUsd: 0,
  budgetRemainingUsd: 10, testMode: true, syntheticFixtureId: null, composedProfile: null, archetypeKeys: [], overlayKeys: [],
  timingHypothesis: null }) as any;

export async function storeDoc(sql: postgres.Sql, run: Run, input: { title: string; content: string; role?: string;
  mimeType?: string; sourceType?: string; metadata?: Record<string, unknown> }) {
  const ctx = { runId: run.runId, runType: "deep_dive", assetId: run.assetId, assetName: run.assetName, assetSlug: run.assetSlug,
    symbol: run.symbol, profileId: "", profileKey: "", requiredModules: [], requiredLenses: [], marketDataCutoffAt: null, pipelineVersion: 3 };
  const [stored] = await storeDiscoveredSources(sql, ctx as any, [{
    sourceType: input.sourceType || `web_${input.role}`, title: input.title, publisher: "verify.example",
    url: `https://verify.example/${randomUUID()}`, content: input.content, mimeType: input.mimeType || "text/plain",
    qualityScore: "0.9", publishedAt: "2026-09-15", periodEnd: null,
    metadata: input.metadata || { source_role: input.role, system_generated: true }, chunkTitle: input.title,
  } as any]);
  return String(stored.sourceId);
}

export const storeFred = (sql: postgres.Sql, run: Run, csv: string) => storeDoc(sql, run, {
  title: `${run.assetName} macro context: US 10-year Treasury yield`, content: csv, mimeType: "text/csv", sourceType: "macro_context",
  metadata: { system_generated: true, source: "fred", series_id: "DGS10", retrieved_at: "2026-10-13T09:00:00.000Z" } });

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
    SELECT ${runId}, id, 'verify-agent', 'fixture', 'fixture-model', 'mid', ${costUsd}, 'success'
    FROM research_stages WHERE research_run_id = ${runId} AND stage_key = ${stageKey}`;
}

/** Simulate the worker finishing the reopened stages: they complete and the report stage runs again. */
export async function finishReopenedStages(sql: postgres.Sql, runId: string) {
  await sql`UPDATE research_stages SET status = 'completed', completed_at = NOW()
    WHERE research_run_id = ${runId} AND status = 'pending' AND stage_key != ALL(${TAIL}::text[])`;
  await sql`UPDATE research_stages SET status = 'running', started_at = NOW() WHERE research_run_id = ${runId} AND stage_key = 'ai_reviewer'`;
}

export type ModelCall = { agent: string; contract: string; packet: any; prompt: string };
export function scriptModel(respond: (packet: any, call: number) => Record<string, unknown> | Error | undefined) {
  const original = MockProvider.prototype.stream;
  const calls: ModelCall[] = [];
  MockProvider.prototype.stream = async function* (this: any, request: any, signal: AbortSignal) {
    let packet: any = {};
    try { packet = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("Task packet:") + 12).trim()); } catch { /* not a research packet */ }
    calls.push({ agent: String(request.agentName || ""), contract: String(packet.output_contract || ""), packet, prompt: request.prompt });
    const response = respond(packet, calls.length);
    if (response === undefined) { yield* original.call(this, request, signal); return; }
    if (response instanceof Error) throw response;
    yield { type: "response.started", requestId: `verify-routing-${calls.length}` };
    yield { type: "text.delta", text: JSON.stringify(response) };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    yield { type: "response.completed", finishReason: "stop" };
  } as any;
  return { calls, answers: () => calls.filter(c => c.contract === "team_answer"), restore() { MockProvider.prototype.stream = original; } };
}

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
  setPublicFetchForTests(globalThis.fetch);
  return {
    searches: () => calls.filter(href => new URL(href).hostname === "search.example").map(href => new URL(href).searchParams.get("q") || ""),
    restore() {
      globalThis.fetch = original;
      setPublicFetchForTests(undefined);
      for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    },
  };
}

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
    ]) { try { await statement(); } catch { /* retry next pass */ } }
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
