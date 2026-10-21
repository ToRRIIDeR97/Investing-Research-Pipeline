import postgres from "postgres";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalResearchKey } from "@/lib/research/v2-contracts";
import { canonicalMetricPlan, normalizeSourceGap, positiveFiniteNumber, selectLatestFact } from "@/lib/research/pipeline-helpers";
import { ensureDocumentIndexed, evidenceNeeds, rolePassageCounts, evidencePassageBudget, FOUNDER_NEED_KEYS, getEmbeddingProvider, indexDocumentContent, openingPassages, recordContradictions,
  retrievePassages, runDocuments, type RetrievedPassage } from "@/lib/research/memory";
import { getAgentConfig } from "@/lib/agent-harness/registry";
import { discoverRoleSources } from "@/lib/research/sources/role-discovery";
import { fetchCapped } from "@/lib/net";
import { SourceRole } from "@/lib/research/sources/roles";
import { syncAssetPriceHistory, syncBenchmarkPriceHistory, type PriceHistorySync } from "@/lib/market-data/price-history";

type Sql = ReturnType<typeof postgres>;
export interface RunContext {
  runId: string;
  runType: string;
  assetId: string;
  assetName: string;
  assetSlug: string;
  symbol: string;
  profileId: string;
  profileKey: string;
  requiredModules: string[];
  requiredLenses: string[];
  marketDataCutoffAt: string | null;
  pipelineVersion: number;
}

interface SourcePayload {
  sourceType: string;
  title: string;
  publisher: string;
  url: string;
  content: string;
  mimeType: string;
  qualityScore: string;
  publishedAt?: string | null;
  periodEnd?: string | null;
  metadata: Record<string, unknown>;
  chunkTitle: string;
}

// No document text: source discovery keeps these for its whole stage, and a slice of a filing body would keep the
// full body alive. Readers fetch passages or chunks by id.
export interface StoredSource {
  sourceId: string;
  parseId: string;
  chunkId: string;
  title: string;
  sourceType: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface StoredSourceCorpus {
  sources: StoredSource[];
  deterministicMetrics: Record<string, unknown>;
  priceHistory: PriceHistorySync;
  /** The S&P 500 bars behind the regression beta; null in test mode, which fetches no benchmark. */
  benchmarkPriceHistory: PriceHistorySync | null;
}

function textValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function nullableText(value: unknown) {
  const text = textValue(value, "");
  return text || null;
}

function nullableDate(value: unknown) {
  const text = textValue(value, "");
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  if (!match) return null;
  const date = new Date(`${match[0]}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : match[0];
}

function numberValue(value: unknown, fallback = 0.7) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") as Record<string, unknown>[] : [];
}

function objectValue(value: unknown): Record<string, unknown> {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current && typeof current === "object" && !Array.isArray(current)) return current as Record<string, unknown>;
    if (typeof current !== "string") return {};
    try { current = JSON.parse(current); } catch { return {}; }
  }
  return {};
}

export function mergeGroupOutputs(groups: Array<Record<string, any> | string>): Record<string, any> {
  const merged: Record<string, any> = {
    analysis_sections: [],
    key_drivers: [],
    metric_interpretation: [],
    contradictions_or_tensions: [],
    missing_modules: [],
    source_gaps: [],
    analyst_questions: [],
    confidence: 0,
  };

  let totalConfidence = 0;
  let count = 0;

  for (const rawGroup of groups) {
    const group = objectValue(rawGroup);
    if (!Object.keys(group).length) continue;
    if (Array.isArray(group.analysis_sections)) {
      merged.analysis_sections.push(...group.analysis_sections);
    }
    if (Array.isArray(group.key_drivers)) {
      merged.key_drivers.push(...group.key_drivers);
    }
    if (Array.isArray(group.metric_interpretation)) {
      merged.metric_interpretation.push(...group.metric_interpretation);
    }
    if (Array.isArray(group.contradictions_or_tensions)) {
      merged.contradictions_or_tensions.push(...group.contradictions_or_tensions);
    }
    if (Array.isArray(group.missing_modules)) {
      merged.missing_modules.push(...group.missing_modules);
    }
    if (Array.isArray(group.source_gaps)) {
      merged.source_gaps.push(...group.source_gaps);
    }
    if (Array.isArray(group.analyst_questions)) {
      merged.analyst_questions.push(...group.analyst_questions);
    }
    if (typeof group.confidence === "number") {
      totalConfidence += group.confidence;
      count++;
    }
  }

  merged.confidence = count > 0 ? Number((totalConfidence / count).toFixed(2)) : 0.5;
  return merged;
}

/** One source-reader packet chunk: a retrieved passage with its provenance and the need that selected it. */
function packetChunk(passage: RetrievedPassage, sourceType: string, need: string) {
  return {
    source_id: passage.source_id, document_parse_id: passage.parse_id, document_chunk_id: passage.passage_id,
    source_type: sourceType, source_role: passage.source_role || "", title: passage.title,
    section_title: passage.section_path.at(-1) || passage.title, section_path: passage.section_path,
    chunk_index: passage.chunk_index, char_start: passage.char_start, char_end: passage.char_end,
    content_excerpt: passage.text, need,
  };
}

/**
 * The source-reader corpus: each source role present asks the research memory for its own
 * need, so long documents contribute the sections that answer it, not their opening pages.
 * A role whose need matches nothing contributes its documents' first passages instead,
 * except founder history, which reports the gap rather than reading a cover page.
 * The passage budget grows with the number of documents; `kpis` adds a headline-KPI need over filings and earnings material.
 */
export async function buildSourcePacket(sql: Sql, ctx: RunContext, sources: StoredSource[], options: { kpis?: string[] } = {}) {
  const sourceIds = [...new Set(sources.filter((source) => !source.sourceId.startsWith("candidate-")).map((source) => source.sourceId))];
  if (!sourceIds.length) return [];
  const documents = (await runDocuments(sql, ctx.runId)).filter((doc) => sourceIds.includes(doc.id));
  const typeOf = new Map(documents.map((doc) => [doc.id, doc.sourceType]));
  const roles = [...new Set(documents.map((doc) => doc.role).filter((role): role is string => Boolean(role)))];
  const needs = evidenceNeeds(roles, { name: ctx.assetName }, { passageBudget: evidencePassageBudget(documents.length), kpis: options.kpis,
    rolePassages: await rolePassageCounts(sql, ctx.runId, documents) });
  const roleless = documents.filter((doc) => !doc.role).map((doc) => doc.id);
  if (roleless.length) needs.push({ key: "general", query: `${ctx.assetName} business revenue growth risk strategy`, sourceIds: roleless, maxPassages: 4 });
  // With embeddings configured, every passage the packet can draw on gets a vector first. Only run documents
  // are retrieved from, so the companyfacts context (left out of them) is not indexed into XBRL fragments here.
  const embeddings = getEmbeddingProvider();
  if (embeddings) for (const sourceId of sourceIds) {
    if (typeOf.has(sourceId)) await ensureDocumentIndexed(sql, { sourceId, runId: ctx.runId, embeddings });
  }
  const chunks: ReturnType<typeof packetChunk>[] = [];
  const seen = new Set<string>();
  const add = (passage: RetrievedPassage, need: string) => {
    if (seen.has(passage.passage_id)) return;
    seen.add(passage.passage_id);
    chunks.push(packetChunk(passage, typeOf.get(passage.source_id) || "", need));
  };
  for (const need of needs) {
    const result = await retrievePassages(sql, { runId: ctx.runId, need: { ...need, sourceIds: need.sourceIds || sourceIds }, embeddings });
    for (const passage of result.passages) add(passage, need.key);
    if (!result.passages.length && !FOUNDER_NEED_KEYS.includes(need.key)) {
      const ids = documents.filter((doc) => need.sourceIds ? need.sourceIds.includes(doc.id) : need.sourceRoles?.includes(doc.role || "")).map((doc) => doc.id);
      for (const passage of await openingPassages(sql, { runId: ctx.runId, sourceIds: ids, perDocument: 2 })) add(passage, `${need.key}:opening`);
    }
  }
  return chunks;
}

function factRows(companyFacts: Record<string, unknown>, taxonomy: string, conceptNames: string[], unit = "USD"): Record<string, unknown>[] {
  const facts = objectValue(companyFacts.facts);
  const taxonomyFacts = objectValue(facts[taxonomy]);
  return conceptNames.flatMap((conceptName) => {
    const concept = objectValue(taxonomyFacts[conceptName]);
    const units = objectValue(concept.units);
    const rows = Array.isArray(units[unit]) ? units[unit] as Record<string, unknown>[] : [];
    return rows.map((row) => ({ ...row, conceptName, unit }) as Record<string, unknown>);
  });
}

function latestFact(
  companyFacts: Record<string, unknown>,
  taxonomy: string,
  conceptNames: string[],
  unit = "USD",
  preferAnnual = false
) {
  return selectLatestFact(factRows(companyFacts, taxonomy, conceptNames, unit), preferAnnual);
}

function financialObservation(
  metricKey: string,
  displayName: string,
  category: string,
  fact: Record<string, unknown> | null,
  unitType = "currency"
) {
  if (!fact) return null;
  return {
    metric_key: metricKey,
    display_name: displayName,
    metric_category: category,
    unit_type: unitType,
    value_numeric: Number(fact.val),
    unit: fact.unit || (unitType === "shares" ? "shares" : "USD"),
    currency: fact.unit === "shares" ? null : "USD",
    period_start: fact.start || null,
    period_end: fact.end || null,
    as_of_date: fact.end || null,
    available_at: fact.filed ? `${fact.filed} 00:00:00+00` : null,
    confidence: 0.92,
    description: `${displayName} from SEC companyfacts concept ${fact.conceptName}`,
    source: "sec_companyfacts",
    accession_number: fact.accn || null,
    fiscal_period: fact.fp || null,
    form: fact.form || null,
  };
}

function buildFinancialObservations(ctx: RunContext, secContext: Record<string, unknown>) {
  const companyFacts = objectValue(secContext.companyFacts);
  if (!Object.keys(companyFacts).length) return [];

  const observations = [
    financialObservation(
      "revenue",
      "Revenue",
      "income_statement",
      latestFact(companyFacts, "us-gaap", [
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "Revenues",
        "SalesRevenueNet",
      ], "USD", true)
    ),
    financialObservation(
      "gross_profit",
      "Gross Profit",
      "income_statement",
      latestFact(companyFacts, "us-gaap", ["GrossProfit"], "USD", true)
    ),
    financialObservation(
      "operating_income",
      "Operating Income",
      "income_statement",
      latestFact(companyFacts, "us-gaap", ["OperatingIncomeLoss"], "USD", true)
    ),
    financialObservation(
      "net_income",
      "Net Income",
      "income_statement",
      latestFact(companyFacts, "us-gaap", ["NetIncomeLoss", "ProfitLoss"], "USD", true)
    ),
    financialObservation(
      "operating_cash_flow",
      "Operating Cash Flow",
      "cash_flow",
      latestFact(companyFacts, "us-gaap", ["NetCashProvidedByUsedInOperatingActivities"], "USD", true)
    ),
    financialObservation(
      "capex",
      "Capital Expenditures",
      "cash_flow",
      latestFact(companyFacts, "us-gaap", [
        "PaymentsToAcquirePropertyPlantAndEquipment",
        "PaymentsToAcquireProductiveAssets",
      ], "USD", true)
    ),
    financialObservation(
      "cash_and_equivalents",
      "Cash And Equivalents",
      "balance_sheet",
      latestFact(companyFacts, "us-gaap", [
        "CashAndCashEquivalentsAtCarryingValue",
        "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
      ])
    ),
    financialObservation(
      "total_debt",
      "Total Debt",
      "balance_sheet",
      latestFact(companyFacts, "us-gaap", [
        "LongTermDebtAndFinanceLeaseObligations",
        "LongTermDebtAndFinanceLeaseObligationsCurrent",
        "LongTermDebt",
      ])
    ),
    financialObservation(
      "diluted_eps",
      "Diluted EPS",
      "per_share",
      latestFact(companyFacts, "us-gaap", ["EarningsPerShareDiluted"], "USD/shares", true),
      "per_share"
    ),
    financialObservation(
      "diluted_shares",
      "Diluted Weighted Average Shares",
      "share_count",
      latestFact(companyFacts, "us-gaap", ["WeightedAverageNumberOfDilutedSharesOutstanding"], "shares", true),
      "shares"
    ),
    financialObservation(
      "shares_outstanding",
      "Common Shares Outstanding",
      "share_count",
      latestFact(companyFacts, "dei", ["EntityCommonStockSharesOutstanding"], "shares"),
      "shares"
    ),
  ].filter(Boolean) as Record<string, unknown>[];

  const capex = observations.find((obs) => obs.metric_key === "capex");
  if (capex && Number(capex.value_numeric) < 0) {
    capex.value_numeric = Math.abs(Number(capex.value_numeric));
    capex.description = `${capex.description}; normalized to positive outflow.`;
  }

  const ocf = observations.find((obs) => obs.metric_key === "operating_cash_flow");
  if (ocf && capex) {
    observations.push({
      metric_key: "free_cash_flow",
      display_name: "Free Cash Flow",
      metric_category: "cash_flow",
      unit_type: "currency",
      value_numeric: Number(ocf.value_numeric) - Math.abs(Number(capex.value_numeric)),
      unit: "USD",
      currency: "USD",
      period_start: ocf.period_start || capex.period_start || null,
      period_end: ocf.period_end || capex.period_end || null,
      as_of_date: ocf.as_of_date || capex.as_of_date || null,
      available_at: ocf.available_at || capex.available_at || null,
      confidence: 0.86,
      description: "Free cash flow computed as operating cash flow minus capital expenditures.",
      source: "sec_companyfacts_computed",
    });
  }

  return observations.map((obs) => ({
    ...obs,
    applicable_profile_key: ctx.profileKey,
  }));
}

async function fetchMarketSnapshot(ctx: RunContext) {
  const yahooSymbol = ctx.symbol.includes(".") ? ctx.symbol : ctx.symbol.toUpperCase();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=5d&interval=1d`;
  const response = await fetchCapped(url, { headers: { "User-Agent": "ResearchOS/0.1 market-data@example.com" } });
  if (!response.ok) throw new Error(`Yahoo chart request failed: ${response.status}`);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  if (!result?.meta) throw new Error("Yahoo chart response missing meta");
  return {
    provider: "Yahoo Finance chart API",
    url,
    retrieved_at: new Date().toISOString(),
    symbol: yahooSymbol,
    meta: result.meta,
    timestamps: result.timestamp || [],
    quote: result.indicators?.quote?.[0] || {},
  };
}

async function marketSourcePayload(ctx: RunContext): Promise<SourcePayload | null> {
  try {
    const snapshot = await fetchMarketSnapshot(ctx);
    return {
      sourceType: "market_data_snapshot",
      title: `${ctx.symbol.toUpperCase()} market data snapshot`,
      publisher: "Yahoo Finance",
      url: snapshot.url,
      content: JSON.stringify(snapshot, null, 2),
      mimeType: "application/json",
      qualityScore: "0.86",
      publishedAt: snapshot.retrieved_at,
      metadata: {
        system_generated: true,
        source: "yahoo_finance_chart",
        retrieved_at: snapshot.retrieved_at,
      },
      chunkTitle: "Market data snapshot",
    };
  } catch (error) {
    return {
      sourceType: "market_data_snapshot",
      title: `${ctx.symbol.toUpperCase()} market data snapshot fetch failed`,
      publisher: "Yahoo Finance",
      url: `https://finance.yahoo.com/quote/${encodeURIComponent(ctx.symbol.toUpperCase())}`,
      content: JSON.stringify({
        provider: "Yahoo Finance",
        symbol: ctx.symbol,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }, null, 2),
      mimeType: "application/json",
      qualityScore: "0.30",
      metadata: {
        system_generated: true,
        source: "yahoo_finance_chart",
        fetch_status: "failed",
      },
      chunkTitle: "Market data fetch failure",
    };
  }
}
function marketObservations(ctx: RunContext, marketPayload: SourcePayload | null, financialObservations: Record<string, unknown>[]) {
  if (!marketPayload) return [];
  const snapshot = objectValue(JSON.parse(marketPayload.content));
  const meta = objectValue(snapshot.meta);
  const timestamps = Array.isArray(snapshot.timestamps) ? snapshot.timestamps.map(Number) : [];
  const quote = objectValue(snapshot.quote);
  const closes = Array.isArray(quote.close) ? quote.close.map(Number) : [];
  const cutoffSeconds = ctx.marketDataCutoffAt ? Math.floor(new Date(ctx.marketDataCutoffAt).getTime() / 1000) : null;
  let historicalIndex = -1;
  for (let index = 0; index < timestamps.length; index += 1) {
    if (Number.isFinite(timestamps[index]) && (cutoffSeconds === null || timestamps[index] <= cutoffSeconds)) {
      historicalIndex = index;
    }
  }
  const historicalPrice = historicalIndex >= 0 ? positiveFiniteNumber(closes[historicalIndex]) : null;
  const price = historicalPrice ?? (cutoffSeconds === null ? positiveFiniteNumber(meta.regularMarketPrice) : null);
  const currency = textValue(meta.currency, "USD");
  const observedAt = historicalIndex >= 0
    ? new Date(timestamps[historicalIndex] * 1000).toISOString()
    : snapshot.retrieved_at || new Date().toISOString();
  const observations: Record<string, unknown>[] = [];
  if (price !== null) {
    observations.push({
      metric_key: "market_price",
      display_name: "Market Price",
      metric_category: "market_data",
      unit_type: "per_share",
      value_numeric: price,
      unit: `${currency}/share`,
      currency,
      period_end: String(observedAt).slice(0, 10),
      as_of_date: String(observedAt).slice(0, 10),
      available_at: observedAt,
      confidence: 0.82,
      description: `Regular market price from ${snapshot.provider}.`,
      source: "market_data_snapshot",
    });
  }
  for (const [metricKey, displayName, value] of (cutoffSeconds === null ? [
    ["fifty_two_week_high", "52 Week High", meta.fiftyTwoWeekHigh],
    ["fifty_two_week_low", "52 Week Low", meta.fiftyTwoWeekLow],
    ["market_volume", "Market Volume", meta.regularMarketVolume],
  ] as const : [])) {
    const numericValue = positiveFiniteNumber(value);
    if (numericValue !== null) {
      observations.push({
        metric_key: metricKey,
        display_name: displayName,
        metric_category: "market_data",
        unit_type: metricKey === "market_volume" ? "shares" : "per_share",
        value_numeric: numericValue,
        unit: metricKey === "market_volume" ? "shares" : `${currency}/share`,
        currency,
        period_end: String(observedAt).slice(0, 10),
        as_of_date: String(observedAt).slice(0, 10),
        available_at: observedAt,
        confidence: 0.80,
        description: `${displayName} from ${snapshot.provider}.`,
        source: "market_data_snapshot",
      });
    }
  }

  const shares =
    financialObservations.find((obs) => obs.metric_key === "shares_outstanding") ||
    financialObservations.find((obs) => obs.metric_key === "diluted_shares");
  const shareCount = positiveFiniteNumber(shares?.value_numeric);
  if (price !== null && shareCount !== null) {
    observations.push({
      metric_key: "market_cap",
      display_name: "Market Capitalization",
      metric_category: "market_data",
      unit_type: "currency",
      value_numeric: price * shareCount,
      unit: currency,
      currency,
      period_end: String(observedAt).slice(0, 10),
      as_of_date: String(observedAt).slice(0, 10),
      available_at: observedAt,
      confidence: 0.76,
      description: "Market capitalization computed from market price and latest available share count.",
      source: "market_data_snapshot_computed",
    });
  }

  return observations.map((obs) => ({
    ...obs,
    applicable_profile_key: ctx.profileKey,
  }));
}

function deterministicMetricOutput(ctx: RunContext, secContext: Record<string, unknown>, marketPayload: SourcePayload | null) {
  const financial = buildFinancialObservations(ctx, secContext);
  const market = marketObservations(ctx, marketPayload, financial);
  return {
    normalized_observations: [...financial, ...market],
    definition_mappings: [],
    conversion_notes: [
      "SEC companyfacts concepts were selected with deterministic fallback lists.",
      "Free cash flow is computed as operating cash flow minus capital expenditures when both facts are available.",
      "Market capitalization is computed from market price and latest share count when both are available.",
    ],
    unresolved_ambiguities: [],
    quality_flags: [],
    source_gaps: [],
  };
}

/** Record a gap as open, reopening it when an earlier pass resolved or superseded it. */
export async function openSourceGap(sql: Sql, gap: { assetId: string; runId: string; gapKey: string; description: string; severity: string; owner: string }) {
  const reopened = await sql`UPDATE source_gaps SET description = ${gap.description}, severity = ${gap.severity}, status = 'open',
      resolved_at = NULL, resolution_note = NULL
    WHERE research_run_id = ${gap.runId} AND gap_key = ${gap.gapKey} RETURNING id`;
  if (!reopened.length) await sql`INSERT INTO source_gaps (asset_id, research_run_id, gap_key, description, severity, status, owner)
    VALUES (${gap.assetId}, ${gap.runId}, ${gap.gapKey}, ${gap.description}, ${gap.severity}, 'open', ${gap.owner})`;
}

export async function reconcileSourceGaps(sql: Sql, ctx: RunContext, output: Record<string, unknown>, owner: string) {
  if (!owner.startsWith("system:")) throw new Error(`System gap owner must use the system: prefix: ${owner}`);
  const normalized = arrayValue(output.source_gaps).slice(0, 48).map((gap) => normalizeSourceGap(gap, owner));
  const emittedKeys = [...new Set(normalized.map((gap) => gap.gapKey))];
  await sql.begin(async (tx) => {
    for (const gap of normalized) {
      const updated = await tx`
        UPDATE source_gaps SET description = ${gap.description}, severity = ${gap.severity}, status = 'open',
          resolved_at = NULL, resolution_note = NULL
        WHERE research_run_id = ${ctx.runId} AND gap_key = ${gap.gapKey} AND owner = ${owner}
        RETURNING id
      `;
      if (!updated.length) await tx`
        INSERT INTO source_gaps (asset_id, research_run_id, gap_key, description, severity, status, owner)
        VALUES (${ctx.assetId}, ${ctx.runId}, ${gap.gapKey}, ${gap.description}, ${gap.severity}, 'open', ${owner})
      `;
    }
    if (emittedKeys.length) await tx`
      UPDATE source_gaps SET status = 'resolved', resolved_at = NOW(),
        resolution_note = 'Resolved automatically because the owning stage no longer emitted this gap.'
      WHERE research_run_id = ${ctx.runId} AND owner = ${owner} AND status = 'open'
        AND NOT (gap_key = ANY(${emittedKeys}::text[]))
    `;
    else await tx`
      UPDATE source_gaps SET status = 'resolved', resolved_at = NOW(),
        resolution_note = 'Resolved automatically because the owning stage emitted no current gaps.'
      WHERE research_run_id = ${ctx.runId} AND owner = ${owner} AND status = 'open'
    `;
  });
}

type SecFiling = {
  form: string;
  filingDate?: string;
  accessionNumber?: string;
  reportDate?: string;
  primaryDocument?: string;
  primaryDocDescription?: string;
  items?: string;
  semanticRole?: string;
  filingFamily?: string;
};

/** Quarters of history the historical record covers; the 10-Qs selected cover this window. */
const HISTORY_QUARTERS = 20;
const OWNERSHIP_FORM = /^(SC 13[DG]|SCHEDULE 13[DG])(\/A)?$/;

/** The 10-Qs whose period ends inside the HISTORY_QUARTERS window ending at the newest 10-K or 10-Q period (filing dates when no period is given). */
function windowQuarterlyReports(periodic: SecFiling[], quarterly: SecFiling[]) {
  const end = (filing: SecFiling) => String(filing.reportDate || filing.filingDate || "").slice(0, 10);
  const newest = periodic.map(end).filter(Boolean).sort().at(-1);
  if (!newest) return quarterly.slice(0, HISTORY_QUARTERS);
  // A 52/53-week fiscal quarter can end a few days off the calendar date, so the boundary moves forward 15 days.
  const start = new Date(`${newest}T00:00:00Z`);
  start.setUTCMonth(start.getUTCMonth() - HISTORY_QUARTERS * 3);
  start.setUTCDate(start.getUTCDate() + 15);
  const from = start.toISOString().slice(0, 10);
  return quarterly.filter((filing) => end(filing) >= from);
}

export function selectResearchFilings(filings: SecFiling[], earliestDate: string, cutoffDate: string) {
  const eligible = filings.filter((filing) => {
    const filed = String(filing.filingDate || "").slice(0, 10);
    return filed >= earliestDate && filed <= cutoffDate;
  });
  const newestAnnual = eligible.find((filing) => ["10-K", "20-F", "40-F"].includes(filing.form));
  const filingFamily = newestAnnual?.form === "40-F"
    ? "canadian_mjds"
    : newestAnnual?.form === "20-F"
      ? "foreign_private_issuer"
      : "domestic_issuer";
  const annualForm = filingFamily === "canadian_mjds" ? "40-F" : filingFamily === "foreign_private_issuer" ? "20-F" : "10-K";
  const annual = eligible
    .filter((filing) => filing.form === annualForm)
    .slice(0, 5)
    .map((filing) => ({ ...filing, filingFamily, semanticRole: "annual_report" }));

  if (filingFamily === "domestic_issuer") {
    const tenQs = eligible.filter((filing) => filing.form === "10-Q");
    const quarterly = windowQuarterlyReports([...annual, ...tenQs], tenQs)
      .map((filing) => ({ ...filing, filingFamily, semanticRole: "quarterly_report" }));
    const earningsUpdates = eligible
      .filter((filing) => filing.form === "8-K" && /(^|,)2\.02(,|$)/.test(String(filing.items || "")))
      .slice(0, 4)
      .map((filing) => ({ ...filing, filingFamily, semanticRole: "earnings_release" }));
    // Governance: the newest proxy statement and up to three beneficial-ownership schedules (SC 13D/G, renamed
    // SCHEDULE 13D/G in December 2024). Foreign issuers report the same in 20-F Items 6-7.
    const governance = [
      ...eligible.filter((filing) => filing.form === "DEF 14A").slice(0, 1),
      ...eligible.filter((filing) => OWNERSHIP_FORM.test(filing.form)).slice(0, 3),
    ].map((filing) => ({ ...filing, filingFamily, semanticRole: "proxy_and_governance" }));
    return [...annual, ...quarterly, ...earningsUpdates, ...governance];
  }

  const resultTerms = /results|earnings|financial statements|interim|quarter|six months|nine months|press release/i;
  const sixKs = eligible.filter((filing) => filing.form === "6-K");
  const likelyResults = sixKs.filter((filing) => resultTerms.test([
    filing.primaryDocDescription,
    filing.primaryDocument,
    filing.items,
  ].filter(Boolean).join(" ")) || Boolean(filing.reportDate));
  const selectedSixKs = (likelyResults.length ? likelyResults : sixKs).slice(0, 8).map((filing) => ({
    ...filing,
    filingFamily,
    semanticRole: likelyResults.length ? "interim_results_or_update" : "recent_foreign_issuer_update",
  }));
  return [...annual, ...selectedSixKs];
}

const SEC_USER_AGENT = "ResearchOS/0.1 research-pipeline-test@example.com";
const SUBMISSIONS_PAGE_NAME = /^CIK\d{10}-submissions-\d{3}\.json$/;

/** Turn one columnar submissions block (`filings.recent` or an older page) into rows. */
function submissionRows(block: Record<string, any> | undefined): SecFiling[] {
  return (block?.form || []).map((form: string, index: number) => ({
    form,
    filingDate: block!.filingDate?.[index],
    accessionNumber: block!.accessionNumber?.[index],
    reportDate: block!.reportDate?.[index],
    primaryDocument: block!.primaryDocument?.[index],
    primaryDocDescription: block!.primaryDocDescription?.[index],
    items: block!.items?.[index],
  }));
}

/**
 * `filings.recent` holds only the latest ~1,000 filings, which for issuers with heavy Form 4
 * traffic can be under two years. Older filings sit in pages listed in `filings.files`. Fetch the
 * pages that overlap the research window, newest first and one at a time, until the rows reach
 * back to `earliestDate`. Rows are returned newest first without duplicate accessions.
 */
export async function loadSubmissionFilings(
  submissions: Record<string, any>, earliestDate: string, cutoffDate: string, fetchImpl: typeof fetch = fetch,
): Promise<SecFiling[]> {
  const rows = submissionRows(submissions.filings?.recent);
  const oldest = () => rows.reduce((min, row) => {
    const filed = String(row.filingDate || "").slice(0, 10);
    return filed && filed < min ? filed : min;
  }, "9999-12-31");
  const pages = (Array.isArray(submissions.filings?.files) ? submissions.filings.files : [])
    .filter((page: Record<string, unknown>) => SUBMISSIONS_PAGE_NAME.test(String(page?.name || ""))
      && String(page.filingTo || "9999-12-31") >= earliestDate && String(page.filingFrom || "0000-01-01") <= cutoffDate)
    .sort((a: Record<string, unknown>, b: Record<string, unknown>) => String(b.filingTo || "").localeCompare(String(a.filingTo || "")));
  for (const page of pages) {
    if (oldest() <= earliestDate) break;
    const response = await fetchImpl(`https://data.sec.gov/submissions/${page.name}`, { headers: { "User-Agent": SEC_USER_AGENT } });
    if (!response.ok) throw new Error(`SEC submissions page ${page.name} failed: ${response.status}`);
    rows.push(...submissionRows(await response.json()));
  }
  const seen = new Set<string>();
  return rows
    .filter((row) => !row.accessionNumber || (!seen.has(row.accessionNumber) && !!seen.add(row.accessionNumber)))
    .sort((a, b) => String(b.filingDate || "").localeCompare(String(a.filingDate || "")));
}

async function fetchSecContext(ctx: RunContext) {
  if (process.env.RESEARCH_ACCEPTANCE_PROVIDER === "mock" || process.env.RESEARCH_TEST_MODE === "1") {
    return {
      cik: "0001418091",
      source: "Mock SEC companyfacts and submissions APIs",
      entityName: "SoFi Technologies, Inc.",
      companyFacts: { facts: { "us-gaap": {} } },
      revenue: [],
      netIncome: [],
      operatingCashFlow: [],
      recentFilings: [
        { form: "10-K", filingDate: "2026-02-15", accessionNumber: "0001418091-26-000001", primaryDocument: "sofi-10k.htm", semanticRole: "regulatory_filing" },
      ],
      filingFamily: "domestic_issuer",
      supplementalSources: [
        {
          sourceType: "investor_relations",
          title: "SoFi Investor Presentation",
          publisher: "SoFi IR",
          url: "https://investors.sofi.com/presentation",
          content: "Mock investor relations data",
          qualityScore: "0.90",
          metadata: {},
          chunkTitle: "Investor Presentation",
        },
        {
          sourceType: "founder_history",
          title: "SoFi Corporate History and Founder Background",
          publisher: "Funding Circle",
          url: "https://sofi.com/history",
          content: "Mock founder and company history data",
          qualityScore: "0.90",
          metadata: {},
          chunkTitle: "Corporate History",
        },
        {
          sourceType: "peer_company_primary",
          title: "Mock peer company annual report",
          publisher: "Mock peer issuer",
          url: "https://peer.example/investors/annual-report",
          content: "Mock peer issuer annual report disclosure for acceptance testing",
          qualityScore: "0.90",
          metadata: { source_role: "peer_company_primary" },
          chunkTitle: "Peer annual report",
        },
        {
          sourceType: "industry_report",
          title: "Digital Banking Industry Outlook",
          publisher: "McKinsey",
          url: "https://mckinsey.com/banking-report",
          content: "Mock industry primary data",
          qualityScore: "0.90",
          metadata: {},
          chunkTitle: "Industry Report",
        },
        {
          sourceType: "regulatory_or_government",
          title: "Mock FDIC banking regulation context",
          publisher: "FDIC",
          url: "https://www.fdic.gov/quarterly-banking-profile",
          content: "Mock regulator context for banking capital and deposits",
          qualityScore: "0.90",
          metadata: { source_role: "regulatory_or_government" },
          chunkTitle: "Banking regulation context",
        },
        {
          sourceType: "earnings_release",
          title: "SoFi Earnings Release Q4 2025",
          publisher: "SoFi PR",
          url: "https://sofi.com/press",
          content: "Mock earnings release data",
          qualityScore: "0.90",
          metadata: {},
          chunkTitle: "Earnings Release",
        }
      ]
    };
  }

  const cik = await resolveSecCik(ctx.symbol).catch((error) => {
    if (ctx.symbol.toUpperCase() === "EXO.AS" || ctx.assetSlug === "exor-nv") {
      return null;
    }
    throw error;
  });
  if (!cik) return fetchExorIssuerContext(ctx);

  const [companyFactsRes, submissionsRes] = await Promise.all([
    fetchCapped(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: { "User-Agent": SEC_USER_AGENT } }),
    fetchCapped(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { "User-Agent": SEC_USER_AGENT } }),
  ]);
  if (!companyFactsRes.ok) throw new Error(`SEC companyfacts failed: ${companyFactsRes.status}`);
  if (!submissionsRes.ok) throw new Error(`SEC submissions failed: ${submissionsRes.status}`);

  const companyFacts = await companyFactsRes.json();
  const submissions = await submissionsRes.json();
  const cutoffDate = ctx.marketDataCutoffAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  // Five years and a half: the oldest 10-Q of the 20-quarter window can be filed up to a quarter before cutoff - 5 years.
  const earliestDate = new Date(cutoffDate);
  earliestDate.setMonth(earliestDate.getMonth() - 66);
  const earliestDateText = Number.isNaN(earliestDate.getTime())
    ? "0000-01-01"
    : earliestDate.toISOString().slice(0, 10);
  const beforeCutoff = (value: unknown) => !value || String(value).slice(0, 10) <= cutoffDate;
  const withinFilingWindow = (value: unknown) => beforeCutoff(value) && String(value || "0000-01-01").slice(0, 10) >= earliestDateText;
  const factBeforeCutoff = (fact: Record<string, unknown>) =>
    beforeCutoff(fact.filed) && beforeCutoff(fact.end);
  const usGaap = companyFacts.facts?.["us-gaap"] || {};
  const revenue = (usGaap.Revenues?.units?.USD || []).filter(factBeforeCutoff).slice(-8);
  const netIncome = (usGaap.NetIncomeLoss?.units?.USD || []).filter(factBeforeCutoff).slice(-8);
  const operatingCashFlow = (usGaap.NetCashProvidedByUsedInOperatingActivities?.units?.USD || [])
    .filter(factBeforeCutoff)
    .slice(-8);
  const filingRows = await loadSubmissionFilings(submissions, earliestDateText, cutoffDate);
  const recentFilings = selectResearchFilings(filingRows, earliestDateText, cutoffDate)
    .filter((filing) => withinFilingWindow(filing.filingDate));

  return {
    cik,
    source: "SEC companyfacts and submissions APIs",
    entityName: companyFacts.entityName,
    website: submissions.website || null,
    investorWebsite: submissions.investorWebsite || null,
    sic: submissions.sic || null,
    sicDescription: submissions.sicDescription || null,
    companyFacts,
    revenue,
    netIncome,
    operatingCashFlow,
    recentFilings,
    filingFamily: recentFilings[0]?.filingFamily || "domestic_issuer",
  };
}

function secArchiveUrl(cik: string, accessionNumber: string, primaryDocument: string) {
  const cikNumber = String(Number(cik));
  const accessionPath = accessionNumber.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikNumber}/${accessionPath}/${primaryDocument}`;
}

function filingSourcePayload(ctx: RunContext, cik: string, filing: Record<string, unknown>, content: string): SourcePayload {
  const form = textValue(filing.form, "SEC filing");
  const semanticRole = textValue(filing.semanticRole, "");
  const reportDate = textValue(filing.reportDate, "");
  const filingDate = textValue(filing.filingDate, "");
  return {
    sourceType: `sec_filing_${form.toLowerCase().replace(/\s+/g, "_")}`,
    title: `${ctx.assetName} ${form}${semanticRole === "earnings_release" ? " earnings release" : ""}${reportDate ? ` report ${reportDate}` : ""}`,
    publisher: "SEC EDGAR",
    url: secArchiveUrl(cik, textValue(filing.accessionNumber), textValue(filing.primaryDocument)),
    content,
    mimeType: "text/html",
    qualityScore: "0.98",
    publishedAt: filingDate || null,
    periodEnd: reportDate || null,
    metadata: {
      system_generated: true,
      source: "sec_edgar_filing",
      form,
      filingDate,
      accessionNumber: filing.accessionNumber,
      primaryDocument: filing.primaryDocument,
      primaryDocDescription: filing.primaryDocDescription,
      filingFamily: filing.filingFamily,
      semanticRole: filing.semanticRole,
      attachmentType: filing.attachmentType,
      // Proxy statements and ownership schedules are read as governance sources, not as financial filings.
      ...(semanticRole === "proxy_and_governance" ? { source_role: "proxy_and_governance" } : {}),
    },
    chunkTitle: `${form} filing ${reportDate || filingDate}`,
  };
}

const MACRO_RECENT_ROWS = 260;

/** FRED returns the whole series from 1962. Keep the latest year of observations up to the cutoff. */
export function recentFredObservations(csv: string, cutoffDate: string, rows = MACRO_RECENT_ROWS): string {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  const kept = lines.filter((line) => line.slice(0, 10) <= cutoffDate).slice(-rows);
  return [header, ...kept].join("\n");
}

async function macroSourcePayload(ctx: RunContext): Promise<SourcePayload | null> {
  const url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10";
  try {
    const response = await fetchCapped(url, { headers: { "User-Agent": "ResearchOS/0.1 research-pipeline@example.com" } });
    if (!response.ok) return null;
    const raw = await response.text();
    if (!raw.includes("observation_date") || raw.length < 100) return null;
    const content = recentFredObservations(raw, ctx.marketDataCutoffAt?.slice(0, 10) || new Date().toISOString().slice(0, 10));
    const retrievedAt = new Date().toISOString();
    return {
      sourceType: "macro_context",
      // Asset-neutral: identical FRED content is one document shared by every asset's runs.
      title: "US 10-year Treasury yield (FRED DGS10)",
      publisher: "Federal Reserve Bank of St. Louis (FRED)",
      url,
      content,
      mimeType: "text/csv",
      qualityScore: "0.94",
      publishedAt: retrievedAt,
      metadata: { system_generated: true, source: "fred", series_id: "DGS10", retrieved_at: retrievedAt },
      chunkTitle: "FRED DGS10 macro series",
    };
  } catch {
    return null;
  }
}

/**
 * EDGAR Archives documents (accession path and file name) never change, so a filing an earlier run stored is read
 * back instead of downloaded. SEC appends a randomised bot-manager script to each response, so a new download
 * hashes differently and was stored as another full copy on every run. Only rows this fetcher wrote are reused:
 * uploads can set source_type, url and MIME type but not metadata_json, so they never stand in for a download.
 */
export async function storedSecFiling(sql: Sql, url: string): Promise<string | null> {
  const rows = await sql`SELECT storage_path, file_hash FROM source_documents
    WHERE url = ${url} AND source_type LIKE 'sec\\_filing\\_%' AND mime_type = 'text/html'
      AND metadata_json->>'source' = 'sec_edgar_filing' AND storage_path LIKE 'storage/sources/%'
    ORDER BY created_at, id`;
  for (const row of rows) {
    try {
      const bytes = await readFile(join(process.cwd(), String(row.storage_path)));
      // A missing or truncated file falls through to the next copy, then to a download.
      if (createHash("sha256").update(bytes).digest("hex") === row.file_hash) return bytes.toString("utf8");
    } catch {
      // As above.
    }
  }
  return null;
}

export async function fetchSecFilingPayloads(sql: Sql, ctx: RunContext, secContext: Record<string, unknown>): Promise<SourcePayload[]> {
  const cik = textValue(secContext.cik);
  if (!cik) return [];

  const filings = arrayValue(secContext.recentFilings);
  const payloads: SourcePayload[] = [];
  for (const filing of filings) {
    const accessionNumber = textValue(filing.accessionNumber);
    const primaryDocument = textValue(filing.primaryDocument);
    if (!accessionNumber || !primaryDocument) continue;

    const documents = [
      {
        document: primaryDocument,
        semanticRole: textValue(filing.semanticRole, "filing_primary_document"),
        attachmentType: "primary_document",
      },
    ];
    if (textValue(filing.form).toUpperCase() === "8-K") {
      const attachmentNames = await fetchSecEarningsAttachments(cik, accessionNumber, primaryDocument);
      for (const document of attachmentNames) {
        documents.push({ document, semanticRole: "earnings_exhibit", attachmentType: "earnings_exhibit" });
      }
    }

    for (const documentInfo of documents) {
    const documentFiling = {
      ...filing,
      primaryDocument: documentInfo.document,
      semanticRole: documentInfo.semanticRole,
      attachmentType: documentInfo.attachmentType,
    };
    const url = secArchiveUrl(cik, accessionNumber, documentInfo.document);
    const stored = await storedSecFiling(sql, url);
    if (stored !== null) {
      payloads.push(filingSourcePayload(ctx, cik, documentFiling, stored));
      continue;
    }
    try {
      let content = "";
      if (process.env.RESEARCH_ACCEPTANCE_PROVIDER === "mock" || process.env.RESEARCH_TEST_MODE === "1") {
        content = "Mock SEC filing content";
      } else {
        const response = await fetchCapped(url, {
          headers: { "User-Agent": "ResearchOS/0.1 research-pipeline@example.com" },
        });
        if (!response.ok) {
          payloads.push({
            sourceType: `sec_filing_${textValue(filing.form, "unknown").toLowerCase().replace(/\s+/g, "_")}`,
            title: `${ctx.assetName} ${textValue(filing.form, "SEC filing")} ${documentInfo.attachmentType} download failed`,
            publisher: "SEC EDGAR",
            url,
            content: JSON.stringify({ filing: documentFiling, url, fetch_status: "failed", status_code: response.status }, null, 2),
            mimeType: "application/json",
            qualityScore: "0.20",
            publishedAt: textValue(filing.filingDate, "") || null,
            periodEnd: textValue(filing.reportDate, "") || null,
            metadata: { system_generated: true, source: "sec_edgar_filing", fetch_status: "failed", status_code: response.status, filing: documentFiling },
            chunkTitle: "SEC filing download failure",
          });
          continue;
        }
        content = await response.text();
      }
      payloads.push(filingSourcePayload(ctx, cik, documentFiling, content));
    } catch {
      payloads.push({
        sourceType: `sec_filing_${textValue(filing.form, "unknown").toLowerCase().replace(/\s+/g, "_")}`,
        title: `${ctx.assetName} ${textValue(filing.form, "SEC filing")} ${documentInfo.attachmentType} ${textValue(filing.reportDate, "")}`.trim(),
        publisher: "SEC EDGAR",
        url,
        content: JSON.stringify({ filing: documentFiling, url, fetch_status: "failed" }, null, 2),
        mimeType: "application/json",
        qualityScore: "0.75",
        publishedAt: textValue(filing.filingDate, "") || null,
        periodEnd: textValue(filing.reportDate, "") || null,
        metadata: { system_generated: true, source: "sec_edgar_filing", fetch_status: "failed", filing: documentFiling },
        chunkTitle: "SEC filing metadata",
      });
    }
    }
  }
  return payloads;
}

/**
 * A source-plan search result is not evidence.  For MELI, collect a small,
 * primary regional-demand dataset instead: internet adoption is an observable
 * input to e-commerce and fintech addressable-market assumptions.  This is
 * deliberately separate from company filings so an analyst can distinguish
 * company-reported KPIs from the external context that frames them.
 */
async function industrySourcePayload(ctx: RunContext): Promise<SourcePayload | null> {
  const isMeli = ctx.symbol.toUpperCase() === "MELI" || /mercado\s+libre/i.test(ctx.assetName);
  if (ctx.profileKey === "financials") {
    const url = "https://www.fdic.gov/quarterly-banking-profile";
    try {
      const response = await fetchCapped(url, {
        headers: { "User-Agent": "ResearchOS/0.2 research-pipeline@example.com" },
      });
      if (!response.ok) return null;
      const content = await response.text();
      if (
        content.length < 1_000 ||
        !/Quarterly Banking Profile/i.test(content) ||
        !/(net interest margin|asset quality|loan|deposit)/i.test(content)
      ) {
        return null;
      }
      const retrievedAt = new Date().toISOString();
      return {
        sourceType: "peer_industry_context",
        title: "U.S. banking industry context: FDIC Quarterly Banking Profile",
        publisher: "Federal Deposit Insurance Corporation",
        url,
        content,
        mimeType: "text/html",
        qualityScore: "0.96",
        metadata: {
          system_generated: true,
          source: "fdic_quarterly_banking_profile",
          source_family: "industry",
          source_role: "industry_primary",
          additional_source_role: "regulatory",
          retrieved_at: retrievedAt,
        },
        chunkTitle: "FDIC Quarterly Banking Profile",
      };
    } catch {
      return null;
    }
  }

  if (!isMeli) return null;

  const url = "https://api.worldbank.org/v2/country/ARG;BRA;MEX/indicator/IT.NET.USER.ZS?format=json&per_page=100&date=2020:2025";
  try {
    const response = await fetchCapped(url, {
      headers: { "User-Agent": "ResearchOS/0.2 research-pipeline@example.com" },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const observations = Array.isArray(payload) && Array.isArray(payload[1]) ? payload[1] : [];
    const relevant = observations
      .filter((row) => row && typeof row === "object" && Number.isFinite(Number((row as Record<string, unknown>).value)))
      .slice(0, 30);
    if (!relevant.length) return null;
    const retrievedAt = new Date().toISOString();
    return {
      sourceType: "peer_industry_context",
      title: "Latin American digital-commerce and fintech demand context",
      publisher: "World Bank Open Data",
      url,
      content: JSON.stringify({
        indicator: "Individuals using the Internet (% of population)",
        countries: ["Argentina", "Brazil", "Mexico"],
        retrieved_at: retrievedAt,
        observations: relevant,
        interpretation: "External regional adoption context; not a Mercado Libre operating KPI or peer-comparable valuation dataset.",
      }, null, 2),
      mimeType: "application/json",
      qualityScore: "0.90",
      publishedAt: retrievedAt,
      metadata: {
        system_generated: true,
        source: "world_bank_open_data",
        source_family: "peer_industry",
        indicator_id: "IT.NET.USER.ZS",
        retrieved_at: retrievedAt,
      },
      chunkTitle: "Latin America internet-adoption context",
    };
  } catch {
    return null;
  }
}

export async function fetchProfileResearchContext(ctx: RunContext) {
  if (ctx.profileKey === "bitcoin") return fetchBitcoinResearchContext(ctx);
  if (ctx.profileKey === "commodity_energy") return fetchEnergyResearchContext(ctx);
  try {
    return await fetchSecContext(ctx);
  } catch (error) {
    if (ctx.profileKey === "etf_fund") return fetchFundResearchContext(ctx);
    throw error;
  }
}

function supplementalSource(
  sourceType: string,
  title: string,
  publisher: string,
  url: string,
  content: string,
  metadata: Record<string, unknown>
) {
  return {
    sourceType,
    title,
    publisher,
    url,
    content,
    mimeType: "application/json",
    qualityScore: "0.90",
    metadata: { system_generated: true, ...metadata },
    chunkTitle: title,
  };
}

async function fetchJsonSource(url: string) {
  const response = await fetchCapped(url, {
    headers: { "User-Agent": "ResearchOS/0.2 research-pipeline@example.com" },
  });
  if (!response.ok) throw new Error(`Public source failed: ${response.status}`);
  return response.json();
}

async function fetchBitcoinResearchContext(ctx: RunContext) {
  const supplementalSources: Record<string, unknown>[] = [];
  const tasks = [
    fetchJsonSource("https://api.blockchain.info/charts/hash-rate?timespan=5years&format=json")
      .then((data) => supplementalSources.push(supplementalSource(
        "bitcoin_onchain_data",
        "Bitcoin network hash rate",
        "Blockchain.com",
        "https://api.blockchain.info/charts/hash-rate?timespan=5years&format=json",
        JSON.stringify(data),
        { source_family: "onchain_data", metric: "hash_rate" }
      )))
      .catch(() => undefined),
    fetchJsonSource("https://api.coinbase.com/v2/prices/BTC-USD/spot")
      .then((data) => supplementalSources.push(supplementalSource(
        "bitcoin_market_data",
        "Bitcoin spot price",
        "Coinbase",
        "https://api.coinbase.com/v2/prices/BTC-USD/spot",
        JSON.stringify(data),
        { source_family: "market_data", metric: "spot_price" }
      )))
      .catch(() => undefined),
    fetchCapped("https://www.sec.gov/crypto", { headers: { "User-Agent": "ResearchOS/0.2 research-pipeline@example.com" } })
      .then(async (response) => response.ok ? response.text() : "")
      .then((content) => {
        if (!content) return;
        supplementalSources.push(supplementalSource(
          "bitcoin_regulatory_context",
          "SEC crypto regulatory context",
          "U.S. Securities and Exchange Commission",
          "https://www.sec.gov/crypto",
          content,
          { source_family: "regulatory" }
        ));
      })
      .catch(() => undefined),
  ];
  await Promise.all(tasks);
  return {
    source: "Public Bitcoin market, network, and regulatory sources",
    entityName: ctx.assetName,
    profile_context: { profile_key: "bitcoin", valuation_frame: "cycle, realized-value, network-security, and liquidity analysis" },
    supplementalSources,
    recentFilings: [],
    companyFacts: {},
  };
}

async function fetchEnergyResearchContext(ctx: RunContext) {
  const supplementalSources: Record<string, unknown>[] = [];
  const urls = [
    {
      url: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILWTICO",
      title: "WTI spot price history",
      sourceType: "energy_market_data",
      publisher: "Federal Reserve Bank of St. Louis",
      family: "market_data",
    },
    {
      url: "https://www.eia.gov/petroleum/",
      title: "EIA petroleum supply and demand context",
      sourceType: "energy_supply_demand",
      publisher: "U.S. Energy Information Administration",
      family: "supply_demand",
    },
  ];
  await Promise.all(urls.map(async (item) => {
    try {
      const response = await fetchCapped(item.url, { headers: { "User-Agent": "ResearchOS/0.2 research-pipeline@example.com" } });
      if (!response.ok) return;
      const content = await response.text();
      supplementalSources.push(supplementalSource(
        item.sourceType, item.title, item.publisher, item.url, content,
        { source_family: item.family }
      ));
    } catch {
      // Missing public data remains a source gap; it is not converted into a fake observation.
    }
  }));
  return {
    source: "Public energy market and supply-demand sources",
    entityName: ctx.assetName,
    profile_context: { profile_key: "commodity_energy", valuation_frame: "supply-demand balance, curve, real-price, and marginal-cost analysis" },
    supplementalSources,
    recentFilings: [],
    companyFacts: {},
  };
}

async function fetchFundResearchContext(ctx: RunContext) {
  const url = `https://www.sec.gov/cgi-bin/browse-edgar?CIK=${encodeURIComponent(ctx.symbol)}&owner=exclude&action=getcompany`;
  let content = "";
  try {
    const response = await fetchCapped(url, { headers: { "User-Agent": "ResearchOS/0.2 research-pipeline@example.com" } });
    if (response.ok) content = await response.text();
  } catch {
    // The market snapshot and explicit gap are still persisted below.
  }
  return {
    source: "Public fund issuer and market sources",
    entityName: ctx.assetName,
    profile_context: { profile_key: "etf_fund", valuation_frame: "NAV, holdings, concentration, flows, and tracking analysis" },
    supplementalSources: content ? [supplementalSource(
      "fund_issuer_report", `${ctx.assetName} SEC issuer index`, "U.S. Securities and Exchange Commission", url, content,
      { source_family: "issuer_report" }
    )] : [],
    recentFilings: [],
    companyFacts: {},
  };
}

async function fetchSecEarningsAttachments(cik: string, accessionNumber: string, primaryDocument: string) {
  const cikNumber = String(Number(cik));
  const accessionPath = accessionNumber.replace(/-/g, "");
  const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikNumber}/${accessionPath}/index.json`;
  try {
    const response = await fetchCapped(indexUrl, {
      headers: { "User-Agent": "ResearchOS/0.2 research-pipeline@example.com" },
    });
    if (!response.ok) return [];
    const index = objectValue(await response.json());
    const directory = objectValue(index.directory);
    const items = Array.isArray(directory.item) ? directory.item : [];
    return items
      .map((item) => objectValue(item))
      .map((item) => textValue(item.name))
      .filter((name) => name && name !== primaryDocument)
      .filter((name) => /(?:ex[-_]?99|exhibit[-_]?99|earnings|shareholder|results|press)/i.test(name))
      .filter((name) => /\.(?:htm|html|txt|pdf)$/i.test(name))
      .slice(0, 4);
  } catch {
    return [];
  }
}

function externalSourcePayloads(ctx: RunContext): SourcePayload[] {
  const ticker = ctx.symbol.toUpperCase();
  const encodedName = encodeURIComponent(ctx.assetName);
  const isMeli = ticker === "MELI" || /mercado\s+libre/i.test(ctx.assetName);
  const investorUrl =
    ticker === "MSFT"
      ? "https://www.microsoft.com/en-us/Investor"
      : `https://www.bing.com/search?q=${encodedName}+investor+relations+earnings+annual+report`;
  const entries = [
    {
      sourceType: "investor_relations",
      title: `${ctx.assetName} investor relations and earnings materials`,
      publisher: ctx.assetName,
      url: investorUrl,
      area: "company investor relations",
      why: "Earnings releases, presentations, annual reports, guidance, segment commentary, and capital allocation disclosures.",
    },
    {
      sourceType: "industry_context",
      title: isMeli ? `${ctx.assetName} Latin American e-commerce and fintech industry context` : `${ctx.assetName} industry and peer context`,
      publisher: "Public industry and competitor sources",
      url: isMeli
        ? `https://www.bing.com/search?q=${encodedName}+Latin+America+ecommerce+fintech+peers+valuation`
        : `https://www.bing.com/search?q=${encodedName}+industry+market+share+valuation+peers`,
      area: "industry and peer context",
      why: isMeli
        ? "Peer set, regional e-commerce penetration, payments adoption, credit economics, and competitive positioning."
        : "Peer set, industry growth, valuation multiples, and competitive positioning.",
    },
    {
      sourceType: "macro_context",
      title: `${ctx.assetName} discount-rate and macro context`,
      publisher: "FRED / Federal Reserve",
      url: "https://fred.stlouisfed.org/series/DGS10",
      area: "macro context",
      why: "Long-term Treasury yields and discount-rate backdrop for DCF and equity duration analysis.",
    },
  ];

  return entries.map((entry) => ({
    ...entry,
    content: JSON.stringify(
      {
        asset: ctx.assetName,
        ticker,
        source_area: entry.area,
        recommended_url: entry.url,
        why_helpful_for_valuation: entry.why,
        collection_status: "candidate_external_source",
      },
      null,
      2
    ),
    mimeType: "application/json",
    qualityScore: entry.sourceType === "market_data_snapshot" ? "0.80" : "0.85",
    metadata: {
      system_generated: true,
      source: "external_source_plan",
      area: entry.area,
      collection_status: "candidate_external_source",
    },
    chunkTitle: entry.area,
  }));
}

async function fetchExorIssuerContext(ctx: RunContext) {
  return {
    source: "EXOR issuer investor-relations materials",
    entityName: "Exor N.V.",
    retrievalDate: new Date().toISOString(),
    urls: [
      "https://www.exor.com/press-releases/2026-03-23/exor-reports-eu371-billion-gross-asset-value-end-2025",
      "https://www.exor.com/system/files/2026/document-documents/EXOR%202025%20Annual%20Report.pdf",
      "https://www.exor.com/pages/investors-media/financial-results",
    ],
    profile: {
      company: ctx.assetName,
      listing: ctx.symbol,
      domicile: "Netherlands",
      business_model: "Listed investment holding company controlled by the Agnelli family.",
      valuation_frame:
        "Primary valuation should focus on NAV per share, market discount/premium to NAV, portfolio composition, leverage, buybacks, and capital allocation.",
    },
    recentFacts: [
      {
        claim_text:
          "At 31 December 2025, Exor reported gross asset value of EUR 37.1 billion and net asset value of EUR 33.2 billion.",
        claim_type: "issuer_reported_nav",
        claim_category: "fact",
        as_of_date: "2025-12-31",
        confidence: 0.95,
        source_url:
          "https://www.exor.com/press-releases/2026-03-23/exor-reports-eu371-billion-gross-asset-value-end-2025",
      },
      {
        claim_text:
          "Exor reported that NAV per share decreased by 8.1% in 2025 while the MSCI World Index increased by 5.4%.",
        claim_type: "issuer_reported_performance",
        claim_category: "fact",
        as_of_date: "2025-12-31",
        confidence: 0.95,
        source_url:
          "https://www.exor.com/press-releases/2026-03-23/exor-reports-eu371-billion-gross-asset-value-end-2025",
      },
      {
        claim_text:
          "Exor reported a loan-to-value ratio of 6.9% at 31 December 2025, below its 15% target.",
        claim_type: "issuer_reported_leverage",
        claim_category: "fact",
        as_of_date: "2025-12-31",
        confidence: 0.95,
        source_url:
          "https://www.exor.com/press-releases/2026-03-23/exor-reports-eu371-billion-gross-asset-value-end-2025",
      },
      {
        claim_text:
          "Exor reported EUR 4.2 billion of inflows in 2025 and said expected additional monetisations would support investment flexibility.",
        claim_type: "issuer_reported_capital_allocation",
        claim_category: "fact",
        as_of_date: "2025-12-31",
        confidence: 0.9,
        source_url:
          "https://www.exor.com/press-releases/2026-03-23/exor-reports-eu371-billion-gross-asset-value-end-2025",
      },
      {
        claim_text:
          "Exor reported that Lingotto reached over USD 10 billion of assets under management and delivered strong 2025 returns to Exor.",
        claim_type: "issuer_reported_portfolio_driver",
        claim_category: "fact",
        as_of_date: "2025-12-31",
        confidence: 0.9,
        source_url:
          "https://www.exor.com/press-releases/2026-03-23/exor-reports-eu371-billion-gross-asset-value-end-2025",
      },
    ],
    normalizedMetrics: [
      {
        metric_key: "gross_asset_value",
        display_name: "Gross Asset Value",
        value_numeric: 37100000000,
        unit: "EUR",
        currency: "EUR",
        period_end: "2025-12-31",
        as_of_date: "2025-12-31",
        available_at: "2026-03-23 00:00:00+00",
        confidence: 0.95,
      },
      {
        metric_key: "net_asset_value",
        display_name: "Net Asset Value",
        value_numeric: 33200000000,
        unit: "EUR",
        currency: "EUR",
        period_end: "2025-12-31",
        as_of_date: "2025-12-31",
        available_at: "2026-03-23 00:00:00+00",
        confidence: 0.95,
      },
      {
        metric_key: "nav_per_share",
        display_name: "NAV Per Share",
        value_numeric: 164.4,
        unit: "EUR/share",
        currency: "EUR",
        period_end: "2025-12-31",
        as_of_date: "2025-12-31",
        available_at: "2026-03-23 00:00:00+00",
        confidence: 0.9,
      },
      {
        metric_key: "loan_to_value_ratio",
        display_name: "Loan-to-Value Ratio",
        value_numeric: 6.9,
        unit: "%",
        currency: "EUR",
        period_end: "2025-12-31",
        as_of_date: "2025-12-31",
        available_at: "2026-03-23 00:00:00+00",
        confidence: 0.95,
      },
    ],
    source_gaps: [
      {
        gap_key: "current_market_price",
        description:
          "The source packet does not include the current EXO.AS market price, so NAV discount must be calculated after market data is ingested.",
        severity: "high",
      },
      {
        gap_key: "portfolio_mark_to_market_refresh",
        description:
          "The latest issuer NAV is dated 31 December 2025; portfolio holdings need mark-to-market refresh to the run cutoff.",
        severity: "high",
      },
      {
        gap_key: "lookthrough_private_assets",
        description:
          "Private holdings and Lingotto assets require additional source work to independently verify fair values.",
        severity: "medium",
      },
    ],
  };
}

async function resolveSecCik(symbol: string) {
  const upper = symbol.toUpperCase();
  const baseSymbol = upper.includes("_TEST") ? upper.split("_TEST")[0] : upper.split("_")[0];
  const response = await fetchCapped("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": "ResearchOS/0.1 research-pipeline@example.com" },
  });
  if (!response.ok) {
    throw new Error(`SEC ticker map failed: ${response.status}`);
  }

  const tickerMap = await response.json() as Record<
    string,
    { cik_str?: number; ticker?: string; title?: string }
  >;
  const match = Object.values(tickerMap).find(
    (entry) => entry.ticker?.toUpperCase() === upper || entry.ticker?.toUpperCase() === baseSymbol
  );
  if (!match?.cik_str) {
    throw new Error(`SEC CIK not found for ticker ${symbol}`);
  }
  return String(match.cik_str).padStart(10, "0");
}

async function storeSourcePayload(sql: Sql, ctx: RunContext, payload: SourcePayload): Promise<StoredSource> {
  const content = payload.content;
  const hash = createHash("sha256").update(content).digest("hex");
  const storageDir = join(process.cwd(), "storage", "sources");
  await mkdir(storageDir, { recursive: true });
  const extension = payload.mimeType.includes("html") ? "html" : payload.mimeType.includes("csv") ? "csv" : "json";
  const storagePath = `storage/sources/${hash}.${extension}`;
  // The file is named by its content hash, so an existing file already holds these bytes.
  await writeFile(join(process.cwd(), storagePath), content, { encoding: "utf8", flag: "wx" }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });

  const rows = await sql`
    INSERT INTO source_documents (
      asset_id, research_run_id, source_type, title, publisher, url,
      published_at, period_end, file_hash, mime_type, language,
      storage_path, source_quality_score, metadata_json
    ) VALUES (
      ${ctx.assetId}, ${ctx.runId}, ${payload.sourceType}, ${payload.title},
      ${payload.publisher}, ${payload.url || null},
      ${payload.publishedAt || null}, ${payload.periodEnd || null},
      ${hash}, ${payload.mimeType}, 'en',
      ${storagePath}, ${payload.qualityScore}, ${sql.json(payload.metadata as any)}
    )
    ON CONFLICT (file_hash) DO UPDATE
    SET retrieved_at = NOW()
    RETURNING id, source_type, title, url, metadata_json
  `;
  const sourceId = rows[0].id as string;

  await sql`
    INSERT INTO research_run_sources (
      research_run_id, source_document_id, role, discovery_metadata_json
    ) VALUES (
      ${ctx.runId}, ${sourceId},
      ${textValue(payload.metadata.semanticRole || payload.metadata.attachmentType, "supporting_source")},
      ${sql.json({ ...payload.metadata, title: payload.title } as any)}
    )
    ON CONFLICT (research_run_id, source_document_id) DO NOTHING
  `;

  const parseRows = await sql`
    INSERT INTO document_parses (
      source_document_id, parser_name, parser_version,
      status, warnings_json, output_storage_path, completed_at
    ) VALUES (
      ${sourceId}, 'system-source-payload', '2', 'completed',
      ${sql.json([])}, ${storagePath}, NOW()
    )
    ON CONFLICT (source_document_id, parser_name, parser_version, parse_config_json) DO UPDATE
    SET status = 'completed', completed_at = NOW()
    RETURNING id
  `;
  const parseId = parseRows[0].id as string;

  const existingChunks = await sql`
    SELECT id FROM document_chunks
    WHERE source_document_id = ${sourceId} AND document_parse_id = ${parseId}
    ORDER BY chunk_index ASC
  `;
  let chunkId = existingChunks[0]?.id as string | undefined;
  if (!chunkId) {
    const chunkSize = 9000;
    for (let start = 0, chunkIndex = 0; start < content.length; start += chunkSize, chunkIndex += 1) {
      const end = Math.min(content.length, start + chunkSize);
      const chunkRows = await sql`
        INSERT INTO document_chunks (
          source_document_id, document_parse_id, chunk_index, section_title,
          char_start, char_end, text, token_count, metadata_json
        ) VALUES (
          ${sourceId}, ${parseId}, ${chunkIndex}, ${payload.chunkTitle},
          ${start}, ${end}, ${content.slice(start, end)}, ${Math.ceil((end - start) / 4)},
          ${sql.json({ system_generated: true, source_payload: true })}
        )
        RETURNING id
      `;
      if (!chunkId) chunkId = chunkRows[0].id as string;
    }
  }

  // Passages for retrieval sit next to the raw chunks, which valuation reads verbatim. The companyfacts
  // context is read only from its raw payload, so it gets no passages.
  if (payload.sourceType !== "primary_source_context") try {
    await indexDocumentContent(sql, { sourceId, content, mimeType: payload.mimeType, title: payload.title });
  } catch (error) {
    console.warn(`Research memory indexing deferred for ${sourceId}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    sourceId,
    parseId,
    chunkId: chunkId || "",
    title: String(rows[0].title),
    sourceType: String(rows[0].source_type),
    url: rows[0].url ? String(rows[0].url) : undefined,
    metadata: objectValue(rows[0].metadata_json),
  };
}

/** Store follow-up documents without re-collecting the run's base corpus. */
export async function storeDiscoveredSources(sql: Sql, ctx: RunContext, discovered: SourcePayload[]): Promise<StoredSource[]> {
  const stored: StoredSource[] = [];
  for (const payload of discovered) stored.push(await storeSourcePayload(sql, ctx, payload));
  return stored;
}

export async function storeSourceCorpus(sql: Sql, ctx: RunContext, secContext: unknown): Promise<StoredSourceCorpus> {
  const context = objectValue(secContext);
  const publisher = textValue(context.source, "Primary source context");
  const discoveryRoles: SourceRole[] = [
    "company_investor_relations",
    "earnings_release",
    "founder_and_company_history",
    "peer_company_primary",
    "industry_primary",
    "customer_or_channel",
    "supplier_or_partner",
    "regulatory_or_government",
  ];
  const configuredSeedUrls = String(process.env.RESEARCH_SOURCE_SEED_URLS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  let roleSeedUrls: Partial<Record<SourceRole, string[]>> = {};
  try {
    const configuredRoleSeeds = JSON.parse(process.env.RESEARCH_SOURCE_ROLE_SEEDS || "{}");
    if (configuredRoleSeeds && typeof configuredRoleSeeds === "object" && !Array.isArray(configuredRoleSeeds)) {
      roleSeedUrls = configuredRoleSeeds;
    }
  } catch {
    throw new Error("RESEARCH_SOURCE_ROLE_SEEDS must be a JSON object of source-role URL arrays");
  }
  const seedUrls = [
    textValue(context.investorWebsite),
    textValue(context.website),
    ...configuredSeedUrls,
  ].filter(Boolean);
  const marketCutoff = ctx.marketDataCutoffAt ? new Date(ctx.marketDataCutoffAt) : null;
  const testMode = process.env.RESEARCH_ACCEPTANCE_PROVIDER === "mock" || process.env.RESEARCH_TEST_MODE === "1";
  const [marketPayload, priceHistory, benchmarkPriceHistory, macroPayload, industryPayload, discoveredRolePayloads] = await Promise.all([
    marketSourcePayload(ctx),
    syncAssetPriceHistory(sql, { assetId: ctx.assetId, assetName: ctx.assetName, symbol: ctx.symbol, cutoffAt: marketCutoff }),
    testMode ? null : syncBenchmarkPriceHistory(sql, marketCutoff),
    macroSourcePayload(ctx),
    industrySourcePayload(ctx),
    discoverRoleSources({
      assetName: ctx.assetName,
      symbol: ctx.symbol,
      cutoffAt: ctx.marketDataCutoffAt,
      seedUrls,
      roleSeedUrls,
    }, discoveryRoles),
  ]);
  const basePayload: SourcePayload = {
    sourceType: "primary_source_context",
    title: `${ctx.assetName} primary source context`,
    publisher,
    url: "https://data.sec.gov/",
    content: JSON.stringify(secContext, null, 2),
    mimeType: "application/json",
    qualityScore: "0.95",
    // The SIC code selects the run's headline KPIs (`kpiArchetypes`).
    metadata: { system_generated: true, source: publisher, ...(context.sic ? { sic: String(context.sic), sic_description: nullableText(context.sicDescription) } : {}) },
    chunkTitle: "SEC API context",
  };

  const filingPayloads = await fetchSecFilingPayloads(sql, ctx, context);
  const supplementalPayloads: SourcePayload[] = arrayValue(context.supplementalSources).map((source) => ({
    sourceType: textValue(source.sourceType, "profile_context"),
    title: textValue(source.title, `${ctx.assetName} profile source`),
    publisher: textValue(source.publisher, "Public source"),
    url: textValue(source.url, ""),
    content: textValue(source.content, "{}"),
    mimeType: textValue(source.mimeType, "application/json"),
    qualityScore: textValue(source.qualityScore, "0.80"),
    publishedAt: nullableText(source.publishedAt),
    periodEnd: nullableText(source.periodEnd),
    metadata: objectValue(source.metadata),
    chunkTitle: textValue(source.chunkTitle, "Profile source"),
  }));
  // Search/source-plan candidates are useful agent context, but are not source documents
  // and must never satisfy source-depth quality gates.
  const externalCandidates = externalSourcePayloads(ctx);
  const payloads = [
    basePayload,
    ...filingPayloads,
    ...supplementalPayloads,
    ...discoveredRolePayloads,
    ...(marketPayload ? [marketPayload] : []),
    ...(macroPayload ? [macroPayload] : []),
    ...(industryPayload ? [industryPayload] : []),
  ];
  const stored: StoredSource[] = [];
  for (const payload of payloads) {
    stored.push(await storeSourcePayload(sql, ctx, payload));
  }
  for (const attachment of stored.filter(
    (source) => textValue(source.metadata?.attachmentType) === "earnings_exhibit"
  )) {
    const accession = textValue(attachment.metadata?.accessionNumber);
    const parent = stored.find(
      (source) =>
        textValue(source.metadata?.accessionNumber) === accession &&
        textValue(source.metadata?.attachmentType) === "primary_document"
    );
    if (!parent) continue;
    await sql`
      INSERT INTO source_document_relations (
        parent_source_document_id, child_source_document_id, relationship_type, metadata_json
      ) VALUES (
        ${parent.sourceId}, ${attachment.sourceId}, 'filing_attachment',
        ${sql.json({ accession_number: accession, semantic_role: "earnings_exhibit" })}
      )
      ON CONFLICT (parent_source_document_id, child_source_document_id, relationship_type) DO NOTHING
    `;
  }
  return {
    sources: [
      ...stored,
      ...externalCandidates.map((candidate, index) => ({
        sourceId: `candidate-${index}`,
        parseId: "",
        chunkId: "",
        title: candidate.title,
        sourceType: `source_candidate_${candidate.sourceType}`,
      })),
    ],
    deterministicMetrics: deterministicMetricOutput(ctx, context, marketPayload),
    priceHistory,
    benchmarkPriceHistory,
  };
}

export async function persistEvidence(
  sql: Sql,
  ctx: RunContext,
  sources: StoredSource[],
  output: Record<string, unknown>,
  /** Raised by evidence extraction to its target, so a large corpus is not cut at the default. */
  minCap = 0,
) {
  const evidenceCap = Math.max(25, minCap, Number(process.env.RESEARCH_PIPELINE_EVIDENCE_CAP || 40));
  const claims = usableEvidenceClaims(output).slice(0, evidenceCap);
  return sql.begin(async (tx) => {
    let persisted = 0;
    for (const claim of claims) {
    const claimText = textValue(claim.claim_text || claim.text || claim.claim, "");
    if (!claimText) continue;
    const duplicate = await tx`
      SELECT id FROM evidence_claims
      WHERE research_run_id = ${ctx.runId} AND claim_text = ${claimText}
      LIMIT 1
    `;
    if (duplicate.length) continue;
    const requestedSourceId = textValue(claim.source_id || claim.source_document_id, "");
    const source = sources.find((item) => item.sourceId === requestedSourceId);
    if (!source || source.sourceId.startsWith("candidate-")) continue;
    const requestedChunkId = textValue(claim.document_chunk_id || claim.chunk_id, "");
    if (!requestedChunkId) continue;
    const sourceChunk = await tx`
      SELECT id, document_parse_id, char_start, char_end FROM document_chunks
      WHERE id = ${requestedChunkId} AND source_document_id = ${source.sourceId} LIMIT 1
    `;
    const locatedChunk = sourceChunk[0];
    if (!locatedChunk) continue;
    const rows = await tx`
      INSERT INTO evidence_claims (
        asset_id, research_run_id, claim_text, claim_type, claim_category,
        polarity, as_of_date, confidence, generated_by, review_status,
        no_source_reason, metadata_json
      ) VALUES (
        ${ctx.assetId}, ${ctx.runId}, ${claimText},
        ${textValue(claim.claim_type, "sec_fact")},
        ${textValue(claim.claim_category, "fact")},
        ${textValue(claim.polarity, "neutral")},
        ${nullableDate(claim.as_of_date || claim.period_end)},
        ${numberValue(claim.confidence, 0.75).toString()},
        ${textValue(claim.generated_by, "source-reader")}, 'accepted', NULL,
        ${tx.json({ system_generated: true, agent_output: claim } as any)}
      )
      RETURNING id
    `;
    const locationRows = await tx`
      INSERT INTO source_locations (
        source_document_id, document_parse_id, document_chunk_id,
        char_start, char_end, locator_json
      ) VALUES (
        ${source.sourceId}, ${locatedChunk?.document_parse_id || source.parseId || null}, ${locatedChunk?.id || source.chunkId || null},
        ${Number.isInteger(Number(claim.char_start)) ? Number(claim.char_start) : locatedChunk?.char_start || null},
        ${Number.isInteger(Number(claim.char_end)) ? Number(claim.char_end) : locatedChunk?.char_end || null},
        ${tx.json({
          system_generated: true,
          source_id: source.sourceId,
          source_type: source.sourceType,
          agent_locator: textValue(claim.source_locator || claim.section || claim.table_reference, ""),
        })}
      )
      RETURNING id
    `;
    await tx`
      INSERT INTO evidence_links (
        evidence_claim_id, source_location_id, support_type, quoted_text, confidence
      ) VALUES (
        ${rows[0].id}, ${locationRows[0].id}, ${textValue(claim.support_type, "supports")},
        ${textValue(claim.quoted_text || claim.quote, claimText).slice(0, 1000)}, ${numberValue(claim.confidence, 0.75).toString()}
      )
    `;
      persisted += 1;
    }
    // Contradictions name claims by text; only pairs from this output that are stored become edges.
    await recordContradictions(tx, {
      runId: ctx.runId,
      claimTexts: claims.map((claim) => textValue(claim.claim_text || claim.text || claim.claim, "")).filter(Boolean),
      contradictions: output.contradictions,
      extractor: "source-reader",
      extractorVersion: getAgentConfig("source-reader").promptVersion,
    });
    return persisted;
  });
}

/** Longest supporting quote an evidence packet carries per claim. */
export const EVIDENCE_QUOTE_CHARS = 280;
const RECENCY_WINDOW_MS = 5 * 365 * 86_400_000;

/**
 * Orders claims for an analysis packet. Each claim scores its confidence plus up to 0.2 for recency (its period, or
 * its source's date, against the newest such date in the set, over five years). Claims are then taken round-robin
 * across claim types, best first, so one topic cannot fill the packet; source-inventory claims come last.
 * `evidence_date` is read for ranking only. The reference date is capped at `asOf` (the run's cutoff), so a far-future
 * period end can't push every other claim down. Ties break on id, so the same claims give the same order.
 */
export function rankEvidencePacket<T extends Record<string, any>>(rows: T[], limit: number, asOf: number | null = null): T[] {
  const time = (row: T) => {
    const value = row.evidence_date instanceof Date ? row.evidence_date.getTime() : Date.parse(String(row.evidence_date ?? ""));
    return Number.isFinite(value) ? value : null;
  };
  const latest = Math.max(0, ...rows.map(time).filter((value): value is number => value !== null));
  const newest = asOf !== null && Number.isFinite(asOf) ? Math.min(latest, asOf) : latest;
  const score = (row: T) => {
    const at = time(row);
    return (Number(row.confidence) || 0) + (at === null ? 0 : 0.2 * Math.min(1, Math.max(0, 1 - (newest - at) / RECENCY_WINDOW_MS)));
  };
  const sorted = rows.map((row) => ({ row, score: score(row) }))
    .sort((a, b) => b.score - a.score || String(a.row.id).localeCompare(String(b.row.id)))
    .map((item) => item.row);
  const inventory = sorted.filter((row) => row.claim_type === "source_inventory_fact");
  const byType = new Map<string, T[]>();
  for (const row of sorted) {
    if (row.claim_type === "source_inventory_fact") continue;
    const type = String(row.claim_type || "").trim().toLowerCase();
    byType.set(type, [...(byType.get(type) || []), row]);
  }
  const ranked: T[] = [];
  for (let round = 0; ranked.length < limit; round += 1) {
    const taken = [...byType.values()].map((bucket) => bucket[round]).filter(Boolean);
    if (!taken.length) break;
    ranked.push(...taken);
  }
  return [...ranked, ...inventory].slice(0, limit);
}

/** The supporting quote, bounded; none when the stored quote only repeats the claim. */
export function evidenceQuote(quote: unknown, claimText: unknown): string | null {
  const text = String(quote ?? "").replace(/\s+/g, " ").trim();
  if (!text || text === String(claimText ?? "").replace(/\s+/g, " ").trim()) return null;
  return text.length > EVIDENCE_QUOTE_CHARS ? `${text.slice(0, EVIDENCE_QUOTE_CHARS - 1)}…` : text;
}

/** Accepted claims for analysis stages, ranked by `rankEvidencePacket`, each with its best-supported location and quote. */
export async function loadAcceptedEvidencePacket(sql: Sql, ctx: RunContext) {
  const limit = Math.max(1, Number(process.env.RESEARCH_EVIDENCE_PACKET_LIMIT || 120));
  const rows = await sql`
    SELECT DISTINCT ON (ec.id)
      ec.id, ec.claim_text, ec.claim_type, ec.claim_category,
      ec.period_start, ec.period_end, ec.as_of_date, ec.confidence,
      sl.source_document_id AS source_id, sl.document_chunk_id,
      sl.char_start, sl.char_end, el.quoted_text,
      COALESCE(ec.period_end, ec.as_of_date, sd.period_end, sd.published_at) AS evidence_date
    FROM evidence_claims ec
    LEFT JOIN evidence_links el ON el.evidence_claim_id = ec.id
    LEFT JOIN source_locations sl ON sl.id = el.source_location_id
    LEFT JOIN source_documents sd ON sd.id = sl.source_document_id
    WHERE ec.research_run_id = ${ctx.runId} AND ec.review_status != 'rejected'
    ORDER BY ec.id, el.confidence DESC NULLS LAST, el.id
  `;
  const asOf = ctx.marketDataCutoffAt ? Date.parse(ctx.marketDataCutoffAt) : Date.now();
  return rankEvidencePacket([...rows], limit, asOf).map(({ evidence_date: _date, quoted_text, ...row }) => ({
    ...row, quote: evidenceQuote(quoted_text, row.claim_text),
  }));
}

export function deterministicEvidenceFallback(
  ctx: RunContext,
  sources: StoredSource[],
  metrics: Record<string, unknown>,
  target: number
) {
  const usableSources = sources.filter((source) => !source.sourceId.startsWith("candidate-"));
  const observations = arrayValue(metrics.normalized_observations);
  const claims: Record<string, unknown>[] = [];
  for (let index = 0; index < observations.length && claims.length < target; index += 1) {
    const observation = observations[index];
    const source = usableSources[index % usableSources.length];
    if (!source) break;
    const metricKey = textValue(observation.metric_key || observation.metric_name, "reported metric");
    const value = observation.value_numeric ?? observation.value ?? observation.value_text;
    if (value === null || value === undefined || value === "") continue;
    claims.push({
      claim_text: `${ctx.assetName} reported ${metricKey.replace(/_/g, " ")} of ${value}.`,
      claim_type: "deterministic_metric_observation",
      claim_category: "fact",
      source_id: source.sourceId,
      document_chunk_id: source.chunkId,
      as_of_date: observation.as_of_date || observation.period_end,
      confidence: Number(observation.confidence || 0.8),
      source_locator: `normalized metric ${metricKey}`,
      quoted_text: `${metricKey}: ${value}`,
    });
  }
  for (const source of usableSources) {
    if (claims.length >= target) break;
    claims.push({
      claim_text: `${source.title} was retrieved as a ${source.sourceType} primary research document for ${ctx.assetName}.`,
      claim_type: "source_inventory_fact",
      claim_category: "fact",
      source_id: source.sourceId,
      document_chunk_id: source.chunkId,
      confidence: 0.95,
      source_locator: "Research OS source corpus",
      quoted_text: source.title,
    });
  }
  return {
    evidence_claims: claims,
    contradictions: [],
    source_gaps: [],
    low_confidence_items: [],
    rejected_candidates: [],
  };
}

/**
 * Statements about the supplied excerpt itself ("The supplied passage does not name the founder")
 * describe what the reader saw, not the company; they belong in source gaps, never in evidence.
 */
export const SOURCE_META_CLAIM = /\b(?:supplied|provided)\s+(?:source\s+)?(?:chunk|passage|excerpt|corpus|document|text)s?\b|\b(?:the|this)\s+(?:source\s+)?(?:chunk|excerpt)s?\b/i;

function usableEvidenceClaims(output: Record<string, unknown>) {
  const placeholders = new Set(["string", "claim", "claim text", "n/a", "none", "null"]);
  return arrayValue(output.evidence_claims).filter((claim) => {
    const claimText = textValue(claim.claim_text || claim.text || claim.claim, "");
    return claimText.length >= 20 && !placeholders.has(claimText.toLowerCase()) && !SOURCE_META_CLAIM.test(claimText);
  });
}

export function metricObservationRows(value: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(value) ? value : objectValue(value).observations;
  return arrayValue(rows).flatMap(row => Array.isArray(row.observations) ? arrayValue(row.observations) : [row])
    .filter(row => Boolean(textValue(row.metric_key || row.metric || row.label)));
}

export async function persistMetrics(sql: Sql, ctx: RunContext, sourceId: string, output: Record<string, unknown>, maxObservations = 60) {
  const observations = metricObservationRows(output.normalized_observations).slice(0, maxObservations);
  await sql.begin(async (tx) => {
    for (const obs of observations) {
      const metricKey = canonicalResearchKey(textValue(obs.metric_key || obs.metric || obs.label, "agent_metric").toLowerCase().replace(/[^a-z0-9_]+/g, "_"));
      const claimId = textValue(obs.evidence_claim_id || obs.source_claim_id);
      const [claim] = claimId ? await tx`
        SELECT ec.id, ec.period_start, ec.period_end, ec.as_of_date, sl.source_document_id
        FROM evidence_claims ec
        JOIN evidence_links el ON el.evidence_claim_id = ec.id
        JOIN source_locations sl ON sl.id = el.source_location_id
        WHERE ec.id::text = ${claimId} AND ec.research_run_id = ${ctx.runId}
          AND ec.review_status != 'rejected' AND el.support_type = 'supports'
        ORDER BY el.confidence DESC NULLS LAST, el.id LIMIT 1
      ` : [];
      const requestedSourceId = textValue(obs.source_id || claim?.source_document_id, sourceId);
      const sourceRows = await tx`
        SELECT d.id, d.published_at, d.retrieved_at FROM source_documents d
        JOIN research_run_sources r ON r.source_document_id = d.id
        WHERE d.id::text = ${requestedSourceId} AND r.research_run_id = ${ctx.runId} LIMIT 1
      `;
      const observationSourceId = sourceRows[0]?.id || sourceId;
      const periodStartValue = obs.period_start || claim?.period_start;
      const periodEndValue = obs.period_end || obs.as_of_date || claim?.period_end || claim?.as_of_date;
      const availableValue = sourceRows[0]?.published_at || obs.available_at || sourceRows[0]?.retrieved_at;
      const availableAt = availableValue ? new Date(availableValue).toISOString() : null;
      // A reporting period is not a publication date. Keep unverified or out-of-window
      // observations in the task audit, and expose the exclusion as a source gap.
      if (!sourceRows.length || !periodEndValue || !availableAt ||
          (ctx.marketDataCutoffAt && new Date(availableAt) > new Date(ctx.marketDataCutoffAt))) {
        const gapKey = `metric_lineage_${metricKey}_${textValue(obs.period || periodEndValue)}`.slice(0, 96);
        await openSourceGap(tx as unknown as Sql, { assetId: ctx.assetId, runId: ctx.runId, gapKey, severity: "high", owner: "metric-normalizer",
          description: `Excluded ${metricKey}: its reporting period, source, or availability before the run cutoff could not be verified.` });
        continue;
      }
      const metricRows = await tx`
        INSERT INTO metric_definitions (metric_key, display_name, metric_category, unit_type, default_unit,
          default_currency, description, applicable_profile_keys, metadata_json)
        VALUES (${metricKey}, ${textValue(obs.display_name || obs.metric_name || metricKey, metricKey)},
          ${textValue(obs.metric_category, "financial")}, ${textValue(obs.unit_type, "number")},
          ${textValue(obs.unit || obs.default_unit, "") || null}, ${textValue(obs.currency || obs.default_currency, "USD")},
          ${textValue(obs.description, "Reconciled metric")}, ARRAY[${ctx.profileKey}], ${tx.unsafe(`'${JSON.stringify({ system_generated: true }).replace(/'/g, "''")}'::jsonb`)})
        ON CONFLICT (metric_key) DO UPDATE SET updated_at = NOW() RETURNING id
      `;
      const periodStart = periodStartValue ? new Date(periodStartValue).toISOString().slice(0, 10) : null;
      const periodEnd = new Date(periodEndValue).toISOString().slice(0, 10);
      const asOfDate = obs.as_of_date ? new Date(String(obs.as_of_date)).toISOString().slice(0, 10) : periodEnd;
      const unit = textValue(obs.unit, "");
      const currency = textValue(obs.currency, "USD");
      const rawValue = obs.value_numeric ?? obs.value;
      const valueNumeric = rawValue === null || rawValue === undefined || rawValue === "" ? null
        : Number.isFinite(Number(rawValue)) ? String(rawValue) : null;
      const existing = await tx`
        SELECT id, value_numeric, review_status FROM metric_observations
        WHERE research_run_id = ${ctx.runId} AND metric_definition_id = ${metricRows[0].id}
          AND COALESCE(period_start::text, '') = ${periodStart || ''}
          AND COALESCE(period_end::text, '') = ${periodEnd}
          AND COALESCE(unit, '') = ${unit} AND COALESCE(currency, '') = ${currency}
        ORDER BY created_at ASC FOR UPDATE
      `;
      const plan = canonicalMetricPlan(existing.map((row) => ({ id: String(row.id), value_numeric: row.value_numeric, review_status: row.review_status })), valueNumeric);
      let canonicalId = plan.promoteId;
      if (plan.insert) {
        const inserted = await tx`
          INSERT INTO metric_observations (asset_id, research_run_id, metric_definition_id, period_start, period_end,
            as_of_date, available_at, value_numeric, value_text, unit, currency, data_provider, source_document_id,
            evidence_claim_id, confidence, review_status, metadata_json)
          VALUES (${ctx.assetId}, ${ctx.runId}, ${metricRows[0].id}, ${periodStart}, ${periodEnd}, ${asOfDate},
            ${availableAt}, ${valueNumeric}, ${textValue(obs.value_text, "") || null},
            ${unit || null}, ${currency}, ${textValue(obs.source, "metric-reconciler")}, ${observationSourceId},
            ${claim?.id || null}, ${numberValue(obs.confidence, 0.7).toString()}, 'accepted',
            ${tx.unsafe(`'${JSON.stringify({ system_generated: true, reconciliation: "canonical_revision", supersedes_observation_ids: existing.map((row) => String(row.id)), agent_output: obs } as any).replace(/'/g, "''")}'::jsonb`)})
          RETURNING id
        `;
        canonicalId = String(inserted[0].id);
      } else if (canonicalId) {
        await tx`
          UPDATE metric_observations SET review_status = 'accepted',
            metadata_json = (CASE WHEN jsonb_typeof(metadata_json) = 'object' THEN metadata_json ELSE '{}'::jsonb END)
              || ${tx.unsafe(`'${JSON.stringify({ reconciliation: "canonical_promoted", reconciled_at: new Date().toISOString() }).replace(/'/g, "''")}'::jsonb`)}
          WHERE id = ${canonicalId}
        `;
      }
      await tx`
        UPDATE metric_observations SET review_status = 'rejected',
          metadata_json = (CASE WHEN jsonb_typeof(metadata_json) = 'object' THEN metadata_json ELSE '{}'::jsonb END)
            || ${tx.unsafe(`'${JSON.stringify({ reconciliation: "superseded_conflict", canonical_observation_id: canonicalId, reconciled_at: new Date().toISOString() }).replace(/'/g, "''")}'::jsonb`)}
        WHERE research_run_id = ${ctx.runId} AND metric_definition_id = ${metricRows[0].id}
          AND COALESCE(period_start::text, '') = ${periodStart || ''} AND COALESCE(period_end::text, '') = ${periodEnd}
          AND COALESCE(unit, '') = ${unit} AND COALESCE(currency, '') = ${currency}
          AND id != ${canonicalId}
      `;
    }
  });
}
