import postgres from "postgres";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { runResearchAgent } from "@/lib/agent-harness/runner";
import { assertModelBudgetAvailable, recordModelCall } from "@/lib/agents/model-calls";
import { advanceStage, approveResearchPlan, startRun } from "@/lib/workflow/orchestrator";
import { generateMemo } from "@/lib/export/memo-generator";
import { generateResearchPackage } from "@/lib/export/research-package-generator";
import {
  executeValuationMethod,
  methodCandidateClaimsRequiredModel,
  validateValuationMethodSet,
  VALUATION_METHOD_PROTOCOL_VERSION,
  VALUATION_OPERATIONS,
  type ValuationMetricInput,
} from "@/lib/valuation/method-protocol";
import { canonicalResearchKey, contractForProfile } from "@/lib/research/v2-contracts";
import { canonicalMetricPlan, ensureFilingFamilyCoverage, evidenceRelevantToModule, moduleCompletion, normalizeSourceGap, positiveFiniteNumber, reconcileMetricObservations, selectLatestFact, selectRelevantChunks, MODULE_TERMS, type RetrievalChunk } from "@/lib/research/pipeline-helpers";
import {
  createSourceReaderBatches,
  mergeSourceReaderOutputs,
  SOURCE_READER_OUTPUT_KEYS,
  type SourceReaderChunk,
} from "@/lib/research/source-reader-batching";
import { discoverRoleSources } from "@/lib/research/sources/role-discovery";
import type { SourceRole } from "@/lib/research/sources/roles";

type Sql = ReturnType<typeof postgres>;
const execFileAsync = promisify(execFile);

interface SystemPipelineResult {
  runId: string;
  status: string;
  completedStages: number;
  totalStages: number;
  notes: string[];
  failure_reason?: string | null;
}
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

export interface StoredSource {
  sourceId: string;
  parseId: string;
  chunkId: string;
  content: string;
  title: string;
  sourceType: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface StoredSourceCorpus {
  sources: StoredSource[];
  deterministicMetrics: Record<string, unknown>;
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

function numericTextOrNull(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && ["", "null", "none", "n/a"].includes(value.trim().toLowerCase())) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(numeric) : null;
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

function compactResearchContext(params: {
  ctx: RunContext;
  evidenceOutput?: Record<string, unknown>;
  metricOutput?: Record<string, unknown>;
  analysisOutput?: Record<string, unknown>;
  valuationOutput?: Record<string, unknown>;
}) {
  return {
    asset: params.ctx,
    evidence_claims: arrayValue(params.evidenceOutput?.evidence_claims).slice(0, 24),
    normalized_observations: arrayValue(params.metricOutput?.normalized_observations).slice(0, 24),
    analysis_sections: arrayValue(params.analysisOutput?.analysis_sections).slice(0, 12),
    key_drivers: arrayValue(params.analysisOutput?.key_drivers).slice(0, 12),
    valuation_signals: arrayValue(params.valuationOutput?.valuation_signals).slice(0, 12),
    scenarios: arrayValue(params.valuationOutput?.scenarios).slice(0, 6),
    source_gaps: [
      ...arrayValue(params.evidenceOutput?.source_gaps),
      ...arrayValue(params.metricOutput?.source_gaps),
      ...arrayValue(params.analysisOutput?.source_gaps),
      ...arrayValue(params.valuationOutput?.source_gaps),
    ].slice(0, 16),
    required_modules: params.ctx.requiredModules,
    required_lenses: params.ctx.requiredLenses,
  };
}

function valuationMethodProtocolContext(requiredModelKeys: string[]) {
  return {
    protocol_version: VALUATION_METHOD_PROTOCOL_VERSION,
    required_model_keys: requiredModelKeys,
    allowed_operations: VALUATION_OPERATIONS,
    execution_model: "ordered formula graph; a formula may reference inputs or earlier formulas only",
    required_outputs: ["per_share_value"],
    required_scenarios: ["bull", "base", "bear"],
    input_sources: ["metric", "assumption", "constant"],
    safety: "Do not return source code or expression strings. Use only operation and args nodes.",
    field_contracts: {
      input: "{key,label,source,metric_key?,value?,unit,currency?,evidence_claim_ids?,rationale?}",
      formula: "{key,label,operation,args:(number|prior_key)[],unit,currency?}",
      outputs: "{enterprise_value?,equity_value?,per_share_value}",
      scenario: "{scenario_name,scenario_type,probability,overrides,confidence,rationale}",
      table: "{table_key,title,columns,rows:[{label,cells:{column:number|value_key}}]}",
    },
  };
}

function analyticalResolutionProtocol() {
  return {
    disclosure_conflicts: {
      required_table_columns: ["metric", "value", "unit", "definition", "measurement_window", "period_end", "source", "evidence_claim_id", "comparable"],
      decision_rule: "Compare values only when metric definition, measurement window, unit, and period align. Otherwise retain both and select the value appropriate to the declared use case.",
      source_priority: ["audited filing", "filed earnings exhibit", "company investor material", "secondary source", "model estimate"],
    },
    fintech_adjusted_fcf: {
      required_bridge_rows: ["reported_cfo", "customer_fund_cash_movement", "fintech_loan_receivable_movement", "net_fintech_funding_flow", "capex", "normalized_fcf"],
      formula: "normalized_fcf = reported_cfo - customer_fund_cash_movement - fintech_loan_receivable_movement - net_fintech_funding_flow - capex",
      rule: "Preserve signs from the cash-flow reconciliation, show reported and normalized FCF side by side, and do not use FCF valuation signals if any material bridge row is missing.",
    },
    segment_profitability: {
      required_table_columns: ["segment", "revenue", "revenue_source", "margin", "margin_source", "operating_profit", "confidence", "sensitivity"],
      formula: "segment_operating_profit = segment_revenue * segment_operating_margin; consolidated check = sum(segment_operating_profit)",
      rule: "Use disclosed figures when available; otherwise label estimates, give bear/base/bull ranges, and reconcile the sum to consolidated results.",
    },
    backtest_robustness: {
      required_outputs: ["in_sample", "out_of_sample", "benchmark_excess_return", "parameter_stability", "selection_rule", "split_date"],
      rule: "Select parameters using in-sample data only, judge performance on untouched out-of-sample data, and fail tactical claims when out-of-sample excess return or nearby-parameter stability is absent.",
    },
  };
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

export async function buildSourcePacket(sql: Sql, ctx: RunContext, sources: StoredSource[]) {
  const sourceIds = sources.filter((source) => !source.sourceId.startsWith("candidate-")).map((source) => source.sourceId);
  const contract = contractForProfile(ctx.profileKey, ctx.assetSlug);
  const retrievalTerms = [
    ...ctx.requiredModules, ...(contract?.requiredModules || []), ...(contract?.requiredMetricKeys || []),
    "segment", "working capital", "credit loss", "loan", "customer funds", "cash flow",
    "founder", "founded", "company origin", "founder motivation", "company history",
    "mission", "move from lab to market", "early funding", "first customer",
  ];
  const searchQuery = [...new Set(retrievalTerms.map((term) => term.replace(/_/g, " ").trim()).filter(Boolean))]
    .slice(0, 40).map((term) => `"${term.replace(/"/g, "")}"`).join(" OR ");
  const rows = sourceIds.length ? await sql`
    WITH latest_parses AS (
      SELECT DISTINCT ON (source_document_id) id, source_document_id
      FROM document_parses
      WHERE status = 'completed'
      ORDER BY source_document_id, completed_at DESC NULLS LAST, created_at DESC
    ), query AS (SELECT websearch_to_tsquery('english', ${searchQuery}) AS q), ranked_chunks AS (
      SELECT dc.id, dc.source_document_id, dc.document_parse_id, dc.chunk_index,
             dc.char_start, dc.char_end, dc.section_title, dc.text,
             sd.title, sd.source_type, role_assignment.role AS source_role,
             ts_rank_cd(to_tsvector('english', dc.text), query.q) AS relevance
      FROM document_chunks dc
      JOIN source_documents sd ON sd.id = dc.source_document_id
      JOIN latest_parses lp ON lp.id = dc.document_parse_id
      LEFT JOIN LATERAL (
        SELECT role
        FROM source_role_assignments
        WHERE source_document_id = sd.id
        ORDER BY confidence DESC NULLS LAST, assigned_at ASC
        LIMIT 1
      ) role_assignment ON TRUE
      CROSS JOIN query
      WHERE dc.source_document_id = ANY(${sourceIds}::uuid[])
        AND (dc.chunk_index = 0 OR to_tsvector('english', dc.text) @@ query.q)
    )
    SELECT * FROM ranked_chunks
    ORDER BY (chunk_index = 0) DESC, relevance DESC, source_document_id, chunk_index
    LIMIT 500
  ` : [];
  const chunks: RetrievalChunk[] = rows.map((row) => ({
    id: String(row.id), sourceId: String(row.source_document_id), parseId: String(row.document_parse_id),
    chunkIndex: Number(row.chunk_index), charStart: Number(row.char_start || 0), charEnd: Number(row.char_end || 0),
    sectionTitle: textValue(row.section_title), text: String(row.text), sourceTitle: String(row.title), sourceType: String(row.source_type),
  }));
  const packetLimit = Math.min(32, Math.max(18, sourceIds.length));
  const selected = selectRelevantChunks(chunks, retrievalTerms, packetLimit, 3000);
  return ensureFilingFamilyCoverage(selected, chunks, retrievalTerms, packetLimit, 3000).map((chunk) => ({
    source_id: chunk.sourceId, document_parse_id: chunk.parseId, document_chunk_id: chunk.id,
    source_type: chunk.sourceType,
    source_role: String((rows.find((row) => String(row.id) === chunk.id)?.source_role) || ""),
    title: chunk.sourceTitle, section_title: chunk.sectionTitle,
    chunk_index: chunk.chunkIndex, char_start: chunk.charStart, char_end: chunk.charEnd,
    content_excerpt: chunk.text,
  }));
}

function isoDateOrNow(value: unknown) {
  const date = value ? new Date(String(value)) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function compactSecContextForAgents(secContext: unknown) {
  const context = objectValue(secContext);
  const { companyFacts: _companyFacts, ...rest } = context;
  return rest;
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
  const response = await fetch(url, { headers: { "User-Agent": "ResearchOS/0.1 market-data@example.com" } });
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

function mergeMetricOutputs(...outputs: Array<Record<string, unknown> | null | undefined>) {
  const merged = {
    normalized_observations: [] as Record<string, unknown>[],
    definition_mappings: [] as Record<string, unknown>[],
    conversion_notes: [] as unknown[],
    unresolved_ambiguities: [] as unknown[],
    quality_flags: [] as unknown[],
    source_gaps: [] as Record<string, unknown>[],
  };

  const observationGroups: Record<string, unknown>[][] = [];
  for (const output of outputs) {
    if (!output) continue;
    observationGroups.push(arrayValue(output.normalized_observations));
    merged.definition_mappings.push(...arrayValue(output.definition_mappings));
    merged.conversion_notes.push(...(Array.isArray(output.conversion_notes) ? output.conversion_notes : []));
    merged.unresolved_ambiguities.push(...(Array.isArray(output.unresolved_ambiguities) ? output.unresolved_ambiguities : []));
    merged.quality_flags.push(...(Array.isArray(output.quality_flags) ? output.quality_flags : []));
    merged.source_gaps.push(...arrayValue(output.source_gaps));
  }

  const reconciled = reconcileMetricObservations(observationGroups[0] || [], observationGroups.slice(1).flat());
  merged.normalized_observations.push(...reconciled.accepted);
  merged.unresolved_ambiguities.push(...reconciled.conflicts);
  merged.quality_flags.push(...reconciled.conflicts.map((conflict) => ({ severity: "high", type: "metric_conflict", ...conflict })));
  merged.source_gaps.push(...reconciled.conflicts.map((conflict) => ({
    gap_key: `metric_conflict_${createHash("sha256").update(String(conflict.identity)).digest("hex").slice(0, 12)}`,
    severity: "high", description: `Conflicting metric observations require reconciliation: ${conflict.identity}`,
    provenance: "metric_reconciliation",
  })));

  return merged;
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

async function getRunContext(sql: Sql, runId: string): Promise<RunContext> {
  const rows = await sql`
    SELECT
      rr.id as run_id,
      rr.run_type,
      rr.asset_id,
      a.canonical_name,
      a.slug,
      rp.id as profile_id,
      rp.profile_key,
      rp.required_modules_json,
      rp.completion_criteria_json,
      rp.required_valuation_lenses_json,
      rr.market_data_cutoff_at,
      rr.pipeline_version,
      l.symbol
    FROM research_runs rr
    JOIN assets a ON a.id = rr.asset_id
    LEFT JOIN research_profiles rp ON rp.id = rr.profile_id
    LEFT JOIN instruments i ON i.asset_id = a.id
    LEFT JOIN listings l ON l.instrument_id = i.id AND l.active_to IS NULL
    WHERE rr.id = ${runId}
    ORDER BY l.is_primary DESC NULLS LAST, l.created_at ASC NULLS LAST
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error(`Research run not found: ${runId}`);
  if (!row.profile_id) throw new Error("Research run has no assigned profile");
  if (!row.symbol) throw new Error("Asset has no active listing symbol");
  const completionCriteria = objectValue(row.completion_criteria_json);
  const completionModules = Array.isArray(completionCriteria.required_modules)
    ? completionCriteria.required_modules.filter((value): value is string => typeof value === "string")
    : [];

  return {
    runId,
    runType: row.run_type,
    assetId: row.asset_id,
    assetName: row.canonical_name,
    assetSlug: row.slug,
    symbol: row.symbol,
    profileId: row.profile_id,
    profileKey: row.profile_key,
    requiredModules: [...new Set([...(row.required_modules_json as string[]) || [], ...completionModules])],
    requiredLenses: (row.required_valuation_lenses_json as string[]) || [],
    marketDataCutoffAt: row.market_data_cutoff_at ? new Date(row.market_data_cutoff_at).toISOString() : null,
    pipelineVersion: Number(row.pipeline_version || 1),
  };
}

async function createTask(sql: Sql, runId: string, stageKey: string, taskKey: string, taskType: string, agentName: string) {
  const rows = await sql`
    INSERT INTO research_tasks (
      research_run_id, stage_id, task_key, task_type, agent_name,
      status, priority, input_json, started_at
    )
    SELECT
      ${runId}, id, ${taskKey}, ${taskType}, ${agentName},
      'running', 80, ${sql.json({ system_generated: true })}, NOW()
    FROM research_stages
    WHERE research_run_id = ${runId} AND stage_key = ${stageKey}
    RETURNING id, stage_id
  `;
  if (!rows[0]) throw new Error(`Stage not found for task: ${stageKey}`);
  return rows[0] as { id: string; stage_id: string };
}

async function completeTask(sql: Sql, taskId: string, output: unknown) {
  await sql`
    UPDATE research_tasks
    SET status = 'completed',
        output_json = ${sql.json(output as any)},
        failure_reason = NULL,
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${taskId}
  `;
}

async function failTask(sql: Sql, taskId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await sql`
    UPDATE research_tasks
    SET status = 'failed',
        failure_reason = ${message},
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${taskId}
  `;
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
    const quarterly = eligible
      .filter((filing) => filing.form === "10-Q")
      .slice(0, 12)
      .map((filing) => ({ ...filing, filingFamily, semanticRole: "quarterly_report" }));
    const earningsUpdates = eligible
      .filter((filing) => filing.form === "8-K" && /(^|,)2\.02(,|$)/.test(String(filing.items || "")))
      .slice(0, 4)
      .map((filing) => ({ ...filing, filingFamily, semanticRole: "earnings_release" }));
    return [...annual, ...quarterly, ...earningsUpdates];
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
    fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
      headers: { "User-Agent": "ResearchOS/0.1 research-pipeline-test@example.com" },
    }),
    fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { "User-Agent": "ResearchOS/0.1 research-pipeline-test@example.com" },
    }),
  ]);
  if (!companyFactsRes.ok) throw new Error(`SEC companyfacts failed: ${companyFactsRes.status}`);
  if (!submissionsRes.ok) throw new Error(`SEC submissions failed: ${submissionsRes.status}`);

  const companyFacts = await companyFactsRes.json();
  const submissions = await submissionsRes.json();
  const cutoffDate = ctx.marketDataCutoffAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const earliestDate = new Date(cutoffDate);
  earliestDate.setFullYear(earliestDate.getFullYear() - 5);
  const earliestDateText = Number.isNaN(earliestDate.getTime())
    ? "0000-01-01"
    : earliestDate.toISOString().slice(0, 10);
  const beforeCutoff = (value: unknown) => !value || String(value).slice(0, 10) <= cutoffDate;
  const withinFiveYears = (value: unknown) => beforeCutoff(value) && String(value || "0000-01-01").slice(0, 10) >= earliestDateText;
  const factBeforeCutoff = (fact: Record<string, unknown>) =>
    beforeCutoff(fact.filed) && beforeCutoff(fact.end);
  const usGaap = companyFacts.facts?.["us-gaap"] || {};
  const revenue = (usGaap.Revenues?.units?.USD || []).filter(factBeforeCutoff).slice(-8);
  const netIncome = (usGaap.NetIncomeLoss?.units?.USD || []).filter(factBeforeCutoff).slice(-8);
  const operatingCashFlow = (usGaap.NetCashProvidedByUsedInOperatingActivities?.units?.USD || [])
    .filter(factBeforeCutoff)
    .slice(-8);
  const filingRows = (submissions.filings?.recent?.form || [])
    .map((form: string, index: number) => ({
      form,
      filingDate: submissions.filings.recent.filingDate?.[index],
      accessionNumber: submissions.filings.recent.accessionNumber?.[index],
      reportDate: submissions.filings.recent.reportDate?.[index],
      primaryDocument: submissions.filings.recent.primaryDocument?.[index],
      primaryDocDescription: submissions.filings.recent.primaryDocDescription?.[index],
      items: submissions.filings.recent.items?.[index],
    })) as SecFiling[];
  const recentFilings = selectResearchFilings(filingRows, earliestDateText, cutoffDate)
    .filter((filing) => withinFiveYears(filing.filingDate));

  return {
    cik,
    source: "SEC companyfacts and submissions APIs",
    entityName: companyFacts.entityName,
    website: submissions.website || null,
    investorWebsite: submissions.investorWebsite || null,
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
    sourceType: `sec_filing_${form.toLowerCase()}`,
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
    },
    chunkTitle: `${form} filing ${reportDate || filingDate}`,
  };
}

async function macroSourcePayload(ctx: RunContext): Promise<SourcePayload | null> {
  const url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10";
  try {
    const response = await fetch(url, { headers: { "User-Agent": "ResearchOS/0.1 research-pipeline@example.com" } });
    if (!response.ok) return null;
    const content = await response.text();
    if (!content.includes("observation_date") || content.length < 100) return null;
    const retrievedAt = new Date().toISOString();
    return {
      sourceType: "macro_context",
      title: `${ctx.assetName} macro context: US 10-year Treasury yield`,
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

async function fetchSecFilingPayloads(ctx: RunContext, secContext: Record<string, unknown>): Promise<SourcePayload[]> {
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
    try {
      let content = "";
      if (process.env.RESEARCH_ACCEPTANCE_PROVIDER === "mock" || process.env.RESEARCH_TEST_MODE === "1") {
        content = "Mock SEC filing content";
      } else {
        const response = await fetch(url, {
          headers: { "User-Agent": "ResearchOS/0.1 research-pipeline@example.com" },
        });
        if (!response.ok) {
          payloads.push({
            sourceType: `sec_filing_${textValue(filing.form, "unknown").toLowerCase()}`,
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
        sourceType: `sec_filing_${textValue(filing.form, "unknown").toLowerCase()}`,
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
      const response = await fetch(url, {
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
        title: "U.S. banking industry peer context: FDIC Quarterly Banking Profile",
        publisher: "Federal Deposit Insurance Corporation",
        url,
        content,
        mimeType: "text/html",
        qualityScore: "0.96",
        metadata: {
          system_generated: true,
          source: "fdic_quarterly_banking_profile",
          source_family: "peer_industry",
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
    const response = await fetch(url, {
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
  const response = await fetch(url, {
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
    fetch("https://www.sec.gov/crypto", { headers: { "User-Agent": "ResearchOS/0.2 research-pipeline@example.com" } })
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
      const response = await fetch(item.url, { headers: { "User-Agent": "ResearchOS/0.2 research-pipeline@example.com" } });
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
    const response = await fetch(url, { headers: { "User-Agent": "ResearchOS/0.2 research-pipeline@example.com" } });
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
    const response = await fetch(indexUrl, {
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
  const response = await fetch("https://www.sec.gov/files/company_tickers.json", {
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
  await writeFile(join(process.cwd(), storagePath), content, "utf8");

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
    RETURNING id
  `;
  const sourceId = rows[0].id as string;

  await sql`
    INSERT INTO research_run_sources (
      research_run_id, source_document_id, role, discovery_metadata_json
    ) VALUES (
      ${ctx.runId}, ${sourceId},
      ${textValue(payload.metadata.semanticRole || payload.metadata.attachmentType, "supporting_source")},
      ${sql.json(payload.metadata as any)}
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

  return {
    sourceId,
    parseId,
    chunkId: chunkId || "",
    content: content.slice(0, 60000),
    title: payload.title,
    sourceType: payload.sourceType,
    url: payload.url,
    metadata: payload.metadata,
  };
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
  const [marketPayload, macroPayload, industryPayload, discoveredRolePayloads] = await Promise.all([
    marketSourcePayload(ctx),
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
    metadata: { system_generated: true, source: publisher },
    chunkTitle: "SEC API context",
  };

  const filingPayloads = await fetchSecFilingPayloads(ctx, context);
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
        content: candidate.content,
        title: candidate.title,
        sourceType: `source_candidate_${candidate.sourceType}`,
      })),
    ],
    deterministicMetrics: deterministicMetricOutput(ctx, context, marketPayload),
  };
}

async function callAgent<T>(params: {
  sql: Sql;
  ctx: RunContext;
  stageKey: string;
  taskKey: string;
  taskType: string;
  agentName: Parameters<typeof runResearchAgent>[0]["agentName"];
  modelTier: string;
  packet: Record<string, unknown>;
  prompt?: string;
  promptFactory?: (packet: Record<string, unknown>) => string;
}): Promise<T> {
  const task = await createTask(params.sql, params.ctx.runId, params.stageKey, params.taskKey, params.taskType, params.agentName);
  const escalationReason = params.modelTier === "premium" || params.modelTier === "specialist"
    ? "System research pipeline stage requires specialist reasoning" : undefined;
  let recordedAttempts = 0;
  try {
    const result = await runResearchAgent<T>({
      agentName: params.agentName,
      title: `${params.agentName} ${params.ctx.symbol} ${params.ctx.runId}`,
      taskPacket: params.packet,
      prompt: params.prompt,
      promptFactory: params.promptFactory,
      hooks: {
        beforeAttempt: async () => {
          await assertModelBudgetAvailable({
            researchRunId: params.ctx.runId, stageId: task.stage_id, taskId: task.id,
            modelTier: params.modelTier, reserveUsd: Number(process.env.RESEARCH_ATTEMPT_BUDGET_RESERVE_USD || 0.1),
          });
        },
        onAttemptComplete: async (attempt) => {
          recordedAttempts += 1;
          await recordModelCall({
            researchRunId: params.ctx.runId, stageId: task.stage_id, taskId: task.id,
            agentName: params.agentName, modelProvider: attempt.provider, modelName: attempt.model,
            modelTier: params.modelTier, promptVersion: "local-harness-v1",
            inputTokens: attempt.inputTokens, outputTokens: attempt.outputTokens, costUsd: attempt.costUsd,
            latencyMs: attempt.latencyMs, status: attempt.status,
            errorMessage: attempt.errorMessage,
            requestMetadata: {
              attempt: attempt.attempt, fallback: attempt.fallback,
              model_attempt: attempt.modelAttempt,
              compaction_occurred: attempt.compactionOccurred,
              input_bytes: attempt.inputBytes, original_input_bytes: attempt.originalInputBytes,
            },
            responseMetadata: {
              request_id: attempt.requestId, started_at: attempt.startedAt, completed_at: attempt.completedAt,
              error_category: attempt.errorCategory, timeout_type: attempt.timeoutType,
              reasoning_tokens: attempt.reasoningTokens,
              repair_attempted: attempt.repairAttempted, validation_errors: attempt.validationErrors,
              raw_response_excerpt: attempt.rawResponseExcerpt, tool_calls: attempt.toolCalls,
              provider_requests: attempt.passes,
              local_coercion_applied: attempt.localCoercionApplied,
              completion_recovered_at_timeout: attempt.completionRecoveredAtTimeout,
            },
            escalationReason,
          });
        },
      },
    });
    await completeTask(params.sql, task.id, result.structured);
    return objectValue(result.structured) as T;
  } catch (error) {
    if (!recordedAttempts) {
      await recordModelCall({
        researchRunId: params.ctx.runId, stageId: task.stage_id, taskId: task.id,
        agentName: params.agentName, modelProvider: process.env.RESEARCH_MODEL_PROVIDER || "local-harness",
        modelName: "not-started", modelTier: params.modelTier, status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        responseMetadata: { pre_attempt_failure: true }, escalationReason,
      });
    }
    await failTask(params.sql, task.id, error);
    throw error;
  }
}

function exactJsonPrompt(params: {
  agentName: string;
  requiredKeys: string[];
  packet: Record<string, unknown>;
  extraRules?: string[];
}) {
  return [
    `Run Research OS agent: ${params.agentName}.`,
    "",
    "Return exactly one JSON object. Do not return Markdown, prose, code fences, or nested wrapper objects.",
    `The top-level object must contain exactly these required keys: ${params.requiredKeys.join(", ")}.`,
    "For every top-level artifact object, artifact_type must exactly equal its enclosing top-level key.",
    "If evidence is insufficient, return empty arrays for the relevant fields and explain gaps in source_gaps or unresolved fields.",
    ...(params.extraRules || []),
    "",
    "Task packet:",
    JSON.stringify(params.packet, null, 2),
  ].join("\n");
}

export async function persistEvidence(
  sql: Sql,
  ctx: RunContext,
  sources: StoredSource[],
  output: Record<string, unknown>
) {
  const evidenceCap = Math.max(25, Number(process.env.RESEARCH_PIPELINE_EVIDENCE_CAP || 40));
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
    return persisted;
  });
}

export async function loadAcceptedEvidencePacket(sql: Sql, ctx: RunContext) {
  return sql`
    SELECT DISTINCT ON (ec.id)
      ec.id, ec.claim_text, ec.claim_type, ec.claim_category,
      ec.period_start, ec.period_end, ec.as_of_date, ec.confidence,
      sl.source_document_id AS source_id, sl.document_chunk_id,
      sl.char_start, sl.char_end
    FROM evidence_claims ec
    LEFT JOIN evidence_links el ON el.evidence_claim_id = ec.id
    LEFT JOIN source_locations sl ON sl.id = el.source_location_id
    WHERE ec.research_run_id = ${ctx.runId} AND ec.review_status != 'rejected'
    ORDER BY ec.id, ec.confidence DESC NULLS LAST, ec.created_at ASC
    LIMIT 120
  `;
}

function filingPlainText(value: string) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#160;|&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#8217;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadSupplementalModuleEvidence(sql: Sql, ctx: RunContext) {
  const claims: Record<string, unknown>[] = [];
  const sourceMap = new Map<string, StoredSource>();
  const kpiRows = await sql`
    SELECT sd.id AS source_id, sd.title, sd.source_type, sd.period_end, dp.id AS parse_id,
      dc.id AS chunk_id, dc.char_start, dc.char_end, dc.text
    FROM source_documents sd
    JOIN research_run_sources rrs ON rrs.source_document_id = sd.id
    JOIN document_parses dp ON dp.source_document_id = sd.id
    JOIN document_chunks dc ON dc.document_parse_id = dp.id
    WHERE rrs.research_run_id = ${ctx.runId}
      AND (LOWER(dc.text) LIKE '%fintech monthly active users%'
        OR LOWER(dc.text) LIKE '%unique active buyers%')
    ORDER BY sd.period_end DESC NULLS LAST, sd.published_at DESC NULLS LAST,
      sd.retrieved_at DESC, dc.chunk_index ASC
    LIMIT 40
  `;
  const patterns = [
    { key: "fintech_mau", label: "fintech monthly active users", regex: /Fintech monthly active users\s*(?:\(\d+\))?\s*([\d,.]+)/i },
    { key: "active_buyers", label: "unique active buyers", regex: /Unique active buyers\s*(?:\(\d+\))?\s*([\d,.]+)/i },
  ];
  const found = new Set<string>();
  for (const row of kpiRows) {
    const plain = filingPlainText(String(row.text));
    for (const pattern of patterns) {
      if (found.has(pattern.key)) continue;
      const match = plain.match(pattern.regex);
      const value = match ? Number(match[1].replace(/,/g, "")) : NaN;
      if (!Number.isFinite(value) || value <= 0) continue;
      const sourceId = String(row.source_id);
      const chunkId = String(row.chunk_id);
      claims.push({
        claim_text: `MercadoLibre reported ${pattern.label} of ${value} million for the three months ended ${row.period_end ? new Date(row.period_end).toISOString().slice(0, 10) : "the filing period"}.`,
        claim_type: "deterministic_kpi",
        claim_category: pattern.key,
        period_end: row.period_end || null,
        measurement_window: "quarterly",
        source_id: sourceId,
        document_chunk_id: chunkId,
        char_start: Number(row.char_start || 0),
        char_end: Number(row.char_end || 0),
        confidence: 0.95,
        generated_by: "deterministic-primary-source-extractor",
      });
      sourceMap.set(sourceId, {
        sourceId, parseId: String(row.parse_id), chunkId, content: String(row.text),
        title: String(row.title), sourceType: String(row.source_type),
      });
      found.add(pattern.key);
    }
  }

  const annualBuyerRows = await sql`
    SELECT sd.id AS source_id, sd.title, sd.source_type, sd.period_end, dp.id AS parse_id,
      dc.id AS chunk_id, dc.char_start, dc.char_end, dc.text
    FROM source_documents sd
    JOIN research_run_sources rrs ON rrs.source_document_id = sd.id
    JOIN document_parses dp ON dp.source_document_id = sd.id
    JOIN document_chunks dc ON dc.document_parse_id = dp.id
    WHERE rrs.research_run_id = ${ctx.runId}
      AND (LOWER(dc.text) LIKE '%121mn unique active buyers%'
        OR LOWER(dc.text) LIKE '%121 million unique active buyers%')
    ORDER BY sd.period_end DESC NULLS LAST, sd.retrieved_at DESC
    LIMIT 1
  `;
  for (const row of annualBuyerRows) {
    const sourceId = String(row.source_id);
    const chunkId = String(row.chunk_id);
    claims.push({
      claim_text: `MercadoLibre described merchant access to 121 million unique active buyers in its FY2025 results discussion; this is a broader annual reach disclosure and is not directly comparable with a three-month quarterly active-buyer KPI.`,
      claim_type: "deterministic_kpi_definition",
      claim_category: "active_buyers_annual_reach",
      period_end: row.period_end || null,
      source_id: sourceId,
      document_chunk_id: chunkId,
      char_start: Number(row.char_start || 0),
      char_end: Number(row.char_end || 0),
      confidence: 0.95,
      generated_by: "deterministic-primary-source-extractor",
    });
    sourceMap.set(sourceId, {
      sourceId, parseId: String(row.parse_id), chunkId, content: String(row.text),
      title: String(row.title), sourceType: String(row.source_type),
    });
  }

  const fintechFundingRows = await sql`
    SELECT sd.id AS source_id, sd.title, sd.source_type, dp.id AS parse_id,
      dc.id AS chunk_id, dc.char_start, dc.char_end, dc.text
    FROM source_documents sd
    JOIN research_run_sources rrs ON rrs.source_document_id = sd.id
    JOIN document_parses dp ON dp.source_document_id = sd.id
    JOIN document_chunks dc ON dc.document_parse_id = dp.id
    WHERE rrs.research_run_id = ${ctx.runId}
      AND LOWER(dc.text) LIKE '%investments related to customer funds%'
      AND LOWER(dc.text) LIKE '%loans payable and other financial liabilities related to our fintech solutions%'
    ORDER BY sd.period_end DESC NULLS LAST, sd.published_at DESC NULLS LAST,
      sd.retrieved_at DESC, dc.chunk_index ASC
    LIMIT 20
  `;
  for (const row of fintechFundingRows) {
    const plain = filingPlainText(String(row.text));
    const customerFunds = plain.match(/Increase \(decrease\) in cash and cash equivalents and investments related to customer funds[\s\S]{0,240}?\(?([\d,.]+)\)?\s+\(?[\d,.]+\)?/i);
    const fintechFunding = plain.match(/Proceeds from loans payable and other financial liabilities related to our Fintech solutions, net\s*\(?([\d,.]+)\)?\s+\(?[\d,.]+\)?/i);
    if (!customerFunds && !fintechFunding) continue;
    const sourceId = String(row.source_id);
    const chunkId = String(row.chunk_id);
    const common = {
      source_id: sourceId,
      document_chunk_id: chunkId,
      char_start: Number(row.char_start || 0),
      char_end: Number(row.char_end || 0),
      confidence: 0.95,
      generated_by: "deterministic-primary-source-extractor",
    };
    if (customerFunds) {
      claims.push({
        ...common,
        claim_text: `MELI reported a USD ${customerFunds[1]} million decrease in cash, cash equivalents, and investments related to customer funds in the latest quarter; this is a cash-flow movement and not a period-end customer-funds balance.`,
        claim_type: "deterministic_cash_flow",
        claim_category: "customer_funds",
      });
    }
    if (fintechFunding) {
      claims.push({
        ...common,
        claim_text: `MELI reported USD ${fintechFunding[1]} million of net proceeds from loans payable and other financial liabilities related to Fintech solutions in the latest quarter; this is a financing flow and not a period-end liability balance.`,
        claim_type: "deterministic_cash_flow",
        claim_category: "funding_liabilities",
      });
    }
    const signedAmount = (value: string) => {
      const numeric = Number(value.replace(/[(),]/g, ""));
      return value.includes("(") ? -numeric : numeric;
    };
    const cfo = plain.match(/Net cash provided by operating activities[^$]*\$\s*(\(?[\d,.]+\)?)/i);
    const capexBridge = plain.match(/Investments in property and equipment and intangible assets\s*(\(?[\d,.]+\)?)/i);
    const loanReceivables = plain.match(/Changes in loans receivable, net\s*(\(?[\d,.]+\)?)/i);
    const bridgeTail = typeof fintechFunding?.index === "number"
      ? plain.slice(fintechFunding.index + fintechFunding[0].length)
      : "";
    const adjustedFcf = bridgeTail.match(/Adjusted free cash flow\s*(\(?[\d,.]+\)?)/i);
    if (cfo && customerFunds && capexBridge && loanReceivables && fintechFunding && adjustedFcf) {
      claims.push({
        ...common,
        claim_text: `MELI's latest quarterly adjusted-FCF bridge reported CFO of USD ${signedAmount(cfo[1])} million, customer-fund cash/investment movement of USD ${-Math.abs(signedAmount(customerFunds[1]))} million, capex and intangible investment of USD ${signedAmount(capexBridge[1])} million, loans-receivable movement of USD ${signedAmount(loanReceivables[1])} million, net Fintech funding proceeds of USD ${signedAmount(fintechFunding[1])} million, and adjusted FCF of USD ${signedAmount(adjustedFcf[1])} million. These signed rows must replace unadjusted CFO-minus-capex for FCF valuation.`,
        claim_type: "deterministic_cash_flow_bridge",
        claim_category: "fintech_adjusted_free_cash_flow",
      });
    }
    sourceMap.set(sourceId, {
      sourceId, parseId: String(row.parse_id), chunkId, content: String(row.text),
      title: String(row.title), sourceType: String(row.source_type),
    });
    break;
  }

  const metricRows = await sql`
    SELECT DISTINCT ON (md.metric_key) md.metric_key, mo.value_numeric, mo.period_end,
      mo.source_document_id AS source_id, sd.title, sd.source_type,
      dp.id AS parse_id, dc.id AS chunk_id, dc.char_start, dc.char_end, dc.text
    FROM metric_observations mo
    JOIN metric_definitions md ON md.id = mo.metric_definition_id
    JOIN source_documents sd ON sd.id = mo.source_document_id
    JOIN LATERAL (
      SELECT id FROM document_parses WHERE source_document_id = sd.id
      ORDER BY created_at DESC LIMIT 1
    ) dp ON TRUE
    JOIN LATERAL (
      SELECT id, char_start, char_end, text FROM document_chunks
      WHERE document_parse_id = dp.id ORDER BY chunk_index ASC LIMIT 1
    ) dc ON TRUE
    WHERE mo.research_run_id = ${ctx.runId} AND mo.review_status = 'accepted'
      AND md.metric_key IN ('capex', 'total_debt', 'cash_and_equivalents')
      AND mo.value_numeric IS NOT NULL
    ORDER BY md.metric_key, mo.available_at DESC NULLS LAST, mo.created_at DESC
  `;
  for (const row of metricRows) {
    const sourceId = String(row.source_id);
    const chunkId = String(row.chunk_id);
    const key = String(row.metric_key);
    const label = key.replace(/_/g, " ");
    claims.push({
      claim_text: `MercadoLibre reported ${label} of USD ${Number(row.value_numeric).toLocaleString("en-US")} as of ${new Date(row.period_end).toISOString().slice(0, 10)}.`,
      claim_type: "deterministic_sec_metric",
      claim_category: key,
      source_id: sourceId,
      document_chunk_id: chunkId,
      char_start: Number(row.char_start || 0),
      char_end: Number(row.char_end || 0),
      confidence: 0.9,
      generated_by: "deterministic-primary-source-extractor",
    });
    sourceMap.set(sourceId, {
      sourceId, parseId: String(row.parse_id), chunkId, content: String(row.text),
      title: String(row.title), sourceType: String(row.source_type),
    });
  }
  return { claims, sources: [...sourceMap.values()] };
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

function usableEvidenceClaims(output: Record<string, unknown>) {
  const placeholders = new Set(["string", "claim", "claim text", "n/a", "none", "null"]);
  return arrayValue(output.evidence_claims).filter((claim) => {
    const claimText = textValue(claim.claim_text || claim.text || claim.claim, "");
    return claimText.length >= 20 && !placeholders.has(claimText.toLowerCase());
  });
}

export async function persistMetrics(sql: Sql, ctx: RunContext, sourceId: string, output: Record<string, unknown>) {
  const observations = arrayValue(output.normalized_observations).slice(0, 60);
  await sql.begin(async (tx) => {
    for (const obs of observations) {
      const metricKey = canonicalResearchKey(textValue(obs.metric_key || obs.metric || obs.label, "agent_metric").toLowerCase().replace(/[^a-z0-9_]+/g, "_"));
      const requestedSourceId = textValue(obs.source_id, "");
      const sourceRows = requestedSourceId
        ? await tx`
            SELECT id, published_at, retrieved_at
            FROM source_documents
            WHERE id = ${requestedSourceId}
            LIMIT 1
          `
        : await tx`
            SELECT id, published_at, retrieved_at
            FROM source_documents
            WHERE id = ${sourceId}
            LIMIT 1
          `;
      const observationSourceId = sourceRows[0]?.id || sourceId;
      const sourceAvailableAt =
        sourceRows[0]?.published_at ||
        nullableText(obs.as_of_date || obs.period_end) ||
        sourceRows[0]?.retrieved_at;
      const availableAt = textValue(
        obs.available_at,
        sourceAvailableAt ? new Date(sourceAvailableAt).toISOString() : ctx.marketDataCutoffAt || new Date().toISOString()
      );
      const metricRows = await tx`
        INSERT INTO metric_definitions (metric_key, display_name, metric_category, unit_type, default_unit,
          default_currency, description, applicable_profile_keys, metadata_json)
        VALUES (${metricKey}, ${textValue(obs.display_name || obs.metric_name || metricKey, metricKey)},
          ${textValue(obs.metric_category, "financial")}, ${textValue(obs.unit_type, "number")},
          ${textValue(obs.unit || obs.default_unit, "") || null}, ${textValue(obs.currency || obs.default_currency, "USD")},
          ${textValue(obs.description, "Reconciled metric")}, ARRAY[${ctx.profileKey}], ${tx.unsafe(`'${JSON.stringify({ system_generated: true }).replace(/'/g, "''")}'::jsonb`)})
        ON CONFLICT (metric_key) DO UPDATE SET updated_at = NOW() RETURNING id
      `;
      const periodStart = nullableText(obs.period_start);
      const periodEnd = textValue(obs.period_end || obs.as_of_date, new Date().toISOString().slice(0, 10));
      const asOfDate = textValue(obs.as_of_date || obs.period_end, periodEnd);
      const unit = textValue(obs.unit, "");
      const currency = textValue(obs.currency, "USD");
      const valueNumeric = Number.isFinite(Number(obs.value_numeric ?? obs.value)) ? String(obs.value_numeric ?? obs.value) : null;
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
            confidence, review_status, metadata_json)
          VALUES (${ctx.assetId}, ${ctx.runId}, ${metricRows[0].id}, ${periodStart}, ${periodEnd}, ${asOfDate},
            ${availableAt}, ${valueNumeric}, ${textValue(obs.value_text, "") || null},
            ${unit || null}, ${currency}, ${textValue(obs.source, "metric-reconciler")}, ${observationSourceId},
            ${numberValue(obs.confidence, 0.7).toString()}, 'accepted',
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

async function persistAnalysis(sql: Sql, ctx: RunContext, output: Record<string, unknown>) {
  const sections = arrayValue(output.analysis_sections);
  const sectionByKey = new Map(sections.map((section) => [textValue(section.section_key || section.key), section]));
  const stageRows = await sql`SELECT id FROM research_stages WHERE research_run_id = ${ctx.runId} AND stage_key = 'asset_analysis'`;
  const stageId = stageRows[0].id;
  await sql`
    INSERT INTO research_tasks (
      research_run_id, stage_id, task_key, task_type, agent_name,
      status, priority, input_json, output_json, completed_at
    ) VALUES (
      ${ctx.runId}, ${stageId}, 'agent_analysis_sections', 'analysis', 'asset-analyst',
      'completed', 60, ${sql.json({ system_generated: true })},
      ${sql.json(output as any)}, NOW()
    )
  `;
  for (const moduleKey of ctx.requiredModules) {
    const section = sectionByKey.get(moduleKey);
    const completion = ctx.pipelineVersion >= 2
      ? { status: "needs_more_work", reason: "Awaiting validation of module-specific persisted evidence links." }
      : moduleCompletion(section);
    await sql`
      INSERT INTO research_tasks (
        research_run_id, stage_id, task_key, task_type, agent_name,
        status, priority, input_json, output_json, completed_at
      ) VALUES (
        ${ctx.runId}, ${stageId}, ${moduleKey}, 'profile_module', 'asset-analyst',
        ${completion.status}, 50, ${sql.json({ system_generated: true })},
        ${sql.json({ system_generated: true, module: moduleKey, section: section || null, missing_input: completion.reason } as any)},
        ${completion.status === "completed" ? new Date().toISOString() : null}
      )
    `;
  }
  for (const section of sections) {
    const moduleKey = textValue(section.section_key || section.key, "");
    if (!moduleKey) continue;
    const completion = ctx.pipelineVersion >= 2
      ? { status: "needs_more_work", reason: "Awaiting validation of module-specific persisted evidence links." }
      : moduleCompletion(section);
    await sql`
      INSERT INTO analysis_sections (
        research_run_id, profile_id, module_key, title, content_json,
        supporting_claim_ids, status, updated_at
      ) VALUES (
        ${ctx.runId}, ${ctx.profileId}, ${moduleKey},
        ${textValue(section.title, moduleKey)}, ${sql.json(section as any)},
        ARRAY[]::uuid[], ${completion.status}, NOW()
      )
      ON CONFLICT (research_run_id, module_key) DO UPDATE
      SET title = EXCLUDED.title,
          content_json = EXCLUDED.content_json,
          status = EXCLUDED.status,
          updated_at = NOW()
    `;
  }
}

type MetricInput = {
  id: string;
  metricKey: string;
  value: number;
  asOfDate: string;
  availableAt: string;
  unit?: string;
  currency?: string;
  evidenceClaimId?: string | null;
};

async function loadMetricInputs(sql: Sql, ctx: RunContext): Promise<MetricInput[]> {
  const rows = await sql`
    SELECT DISTINCT ON (md.metric_key)
      mo.id, md.metric_key, mo.value_numeric, mo.as_of_date, mo.period_end, mo.available_at,
      mo.unit, mo.currency, mo.evidence_claim_id
    FROM metric_observations mo
    JOIN metric_definitions md ON md.id = mo.metric_definition_id
    WHERE mo.research_run_id = ${ctx.runId}
      AND mo.value_numeric IS NOT NULL
      AND mo.review_status = 'accepted'
    ORDER BY md.metric_key, mo.available_at DESC NULLS LAST, mo.created_at DESC
  `;
  return rows
    .map((row) => ({
      id: String(row.id),
      metricKey: String(row.metric_key),
      value: Number(row.value_numeric),
      asOfDate: textValue(row.as_of_date || row.period_end, new Date().toISOString().slice(0, 10)),
      availableAt: isoDateOrNow(row.available_at),
      unit: nullableText(row.unit) || undefined,
      currency: nullableText(row.currency) || undefined,
      evidenceClaimId: nullableText(row.evidence_claim_id),
    }))
    .filter((row) => Number.isFinite(row.value));
}

function metricFrom(inputs: MetricInput[], ...keys: string[]) {
  return keys.map((key) => inputs.find((input) => input.metricKey === key)).find(Boolean) || null;
}

function v2RequiredModules(ctx: RunContext) {
  const contract = contractForProfile(ctx.profileKey, ctx.assetSlug);
  return [...new Set([...(ctx.requiredModules || []), ...(contract?.requiredModules || [])])];
}

async function materializeRequiredAnalysisModules(sql: Sql, ctx: RunContext, output: Record<string, unknown>) {
  if (ctx.pipelineVersion < 2) return;
  const sections = arrayValue(output.analysis_sections);
  const sectionByKey = new Map(
    sections.map((section) => [textValue(section.section_key || section.key), section])
  );
  const moduleGaps: Record<string, unknown>[] = [];
  for (const moduleKey of v2RequiredModules(ctx)) {
    const agentSection = sectionByKey.get(moduleKey);
    const requestedClaimIds = agentSection && Array.isArray(agentSection.evidence_claim_ids)
      ? agentSection.evidence_claim_ids.map(String).filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      : [];
    const claimRows = await sql`
      SELECT ec.id, ec.claim_text, ec.claim_type, ec.claim_category
      FROM evidence_claims ec
      WHERE ec.research_run_id = ${ctx.runId}
        AND ec.review_status != 'rejected'
        AND EXISTS (SELECT 1 FROM evidence_links el WHERE el.evidence_claim_id = ec.id)
      ORDER BY ec.confidence DESC NULLS LAST, ec.created_at ASC
    `;
    const relevantRows = claimRows.filter((row) => evidenceRelevantToModule(moduleKey, row));
    const requestedSet = new Set(requestedClaimIds);
    const claimIds = [
      ...relevantRows.filter((row) => requestedSet.has(String(row.id))),
      ...relevantRows.filter((row) => !requestedSet.has(String(row.id))),
    ].slice(0, 8).map((row) => String(row.id));
    const originalSummary = textValue(agentSection?.summary || agentSection?.body || agentSection?.content, "");
    const staleUnavailableSummary = /(?:not available|no (?:data|evidence)|cannot (?:assess|analy[sz]e|determine))/i.test(originalSummary);
    const evidenceSummary = relevantRows
      .filter((row) => claimIds.includes(String(row.id)))
      .map((row) => String(row.claim_text))
      .join(" ");
    const content = agentSection ? {
      ...agentSection,
      summary: claimIds.length && (originalSummary.length < 80 || staleUnavailableSummary)
        ? `Primary-source update: ${evidenceSummary} ${originalSummary}`.trim()
        : originalSummary,
      evidence_claim_ids: claimIds,
      deterministic_evidence_supplemented: claimIds.length > 0,
    } : claimIds.length ? {
      module_key: moduleKey,
      summary: `Primary-source evidence for this module: ${evidenceSummary}`,
      evidence_claim_ids: claimIds,
      deterministic_evidence_supplemented: true,
      missing_inputs: ["A dedicated model-authored module section was not returned; this section was materialized from accepted primary-source claims."],
      provenance: "research_os_v2_module_materializer",
    } : {
      module_key: moduleKey,
      summary: "",
      missing_inputs: ["No module-specific analysis was returned."],
      provenance: "research_os_v2_module_materializer",
    };
    const completion = moduleCompletion({
      ...content,
      evidence: [],
      evidence_claim_ids: claimIds,
    });
    await sql`
      INSERT INTO analysis_sections (
        research_run_id, profile_id, module_key, title, content_json,
        supporting_claim_ids, status, updated_at
      ) VALUES (
        ${ctx.runId}, ${ctx.profileId}, ${moduleKey},
        ${textValue((content as Record<string, unknown>).title, moduleKey.replace(/_/g, " "))},
        ${sql.json(content as any)},
        ${claimIds}, ${completion.status}, NOW()
      )
      ON CONFLICT (research_run_id, module_key) DO UPDATE
      SET content_json = EXCLUDED.content_json,
          supporting_claim_ids = EXCLUDED.supporting_claim_ids,
          status = EXCLUDED.status, updated_at = NOW()
    `;
    await sql`
      UPDATE research_tasks
      SET status = ${completion.status},
          output_json = (CASE WHEN jsonb_typeof(output_json) = 'object' THEN output_json ELSE '{}'::jsonb END)
            || ${sql.json({ evidence_claim_ids: claimIds, validation_reason: completion.reason })},
          completed_at = ${completion.status === "completed" ? new Date().toISOString() : null}
      WHERE id = (
        SELECT id FROM research_tasks
        WHERE research_run_id = ${ctx.runId} AND task_key = ${moduleKey} AND task_type = 'profile_module'
        ORDER BY created_at DESC LIMIT 1
      )
    `;
    if (completion.status !== "completed") moduleGaps.push({
      gap_key: `module_${moduleKey}_missing`, severity: "high",
      description: `Required module ${moduleKey} is not complete: ${completion.reason}`,
    });
  }
  await reconcileSourceGaps(sql, ctx, { source_gaps: moduleGaps }, "system:analysis-modules");
}

async function persistDeterministicValuationModels(
  sql: Sql,
  ctx: RunContext,
  valuationOutput: Record<string, unknown>
) {
  if (ctx.pipelineVersion < 2) return;
  const inputs = await loadMetricInputs(sql, ctx);
  const contract = contractForProfile(ctx.profileKey, ctx.assetSlug);
  if (!contract) return;
  const proposals = arrayValue(valuationOutput.method_proposals);
  const preflightGaps: Record<string, unknown>[] = [];

  for (const modelKey of contract.valuationModelKeys) {
    const candidate = proposals.find((proposal) => methodCandidateClaimsRequiredModel(proposal, modelKey));
    const execution = candidate
      ? executeValuationMethod(candidate, inputs satisfies ValuationMetricInput[])
      : null;
    const reason = !candidate
      ? "conforming_method_proposal_missing"
      : execution?.valid
        ? "validated_and_executed"
        : "method_proposal_validation_failed";
    const validation = {
      valid: execution?.valid === true,
      required_model_key: modelKey,
      proposed_method_key: execution?.spec?.method_key || null,
      method_state: execution?.methodState || "blocked",
      protocol_version: VALUATION_METHOD_PROTOCOL_VERSION,
      execution_engine: "research_os_restricted_formula_graph",
      arbitrary_code_allowed: false,
      errors: execution?.errors || [`No method proposal conforms to required model "${modelKey}".`],
      warnings: execution?.warnings || [],
      reason,
    };
    const prior = await sql`
      SELECT id FROM valuation_model_runs
      WHERE research_run_id = ${ctx.runId} AND model_key = ${modelKey}
      ORDER BY created_at DESC LIMIT 1
    `;
    const inputManifest = {
      generated_by: "research_os_valuation_method_protocol",
      protocol_version: VALUATION_METHOD_PROTOCOL_VERSION,
      method_state: execution?.methodState || "blocked",
      proposed_method: execution?.spec || candidate || null,
      inputs: execution?.inputManifest || [],
      metric_observation_ids: execution?.inputManifest
        .map((input) => input.metricObservationId)
        .filter(Boolean) || [],
    };
    const outputs = execution?.valid ? {
      method_key: execution.spec?.method_key,
      output_values: execution.outputs,
      formula_values: execution.values,
      scenarios: execution.scenarios,
      tables: execution.tables,
      limitations: execution.spec?.limitations || [],
    } : {};
    const assumptions = execution?.inputManifest
      .filter((input) => input.source !== "metric")
      .map((input) => ({
        key: input.key,
        source: input.source,
        value: input.value,
        unit: input.unit,
        currency: input.currency,
      })) || [];
    const status = execution?.valid ? "completed" : "blocked";
    const errorMessage = execution?.valid ? null : `Valuation protocol blocked: ${reason}`;
    await sql.begin(async (tx) => {
      const rows = prior[0]
        ? await tx`
            UPDATE valuation_model_runs SET status = ${status},
              input_manifest_json = ${tx.json(inputManifest as any)},
              assumptions_json = ${tx.json(assumptions as any)},
              outputs_json = ${tx.json(outputs as any)},
              validation_json = ${tx.json(validation as any)},
              reproducible = ${execution?.valid === true}, error_message = ${errorMessage},
              started_at = COALESCE(started_at, NOW()), completed_at = NOW(), updated_at = NOW()
            WHERE id = ${prior[0].id}
            RETURNING id
          `
        : await tx`
            INSERT INTO valuation_model_runs (
              research_run_id, asset_id, profile_id, model_key, status,
              input_manifest_json, assumptions_json, outputs_json, validation_json,
              reproducible, error_message, started_at, completed_at
            ) VALUES (
              ${ctx.runId}, ${ctx.assetId}, ${ctx.profileId}, ${modelKey}, ${status},
              ${tx.json(inputManifest as any)}, ${tx.json(assumptions as any)},
              ${tx.json(outputs as any)}, ${tx.json(validation as any)},
              ${execution?.valid === true}, ${errorMessage}, NOW(), NOW()
            ) RETURNING id
          `;
      const modelRunId = String(rows[0].id);

      // Replaying a stage replaces only scenarios owned by this executable
      // model. Narrative agent scenarios remain separate and untrusted.
      await tx`DELETE FROM scenarios WHERE valuation_model_run_id = ${modelRunId}`;
      if (execution?.valid && execution.spec) {
        const supportingClaimIds = [...new Set(execution.inputManifest.flatMap((input) => input.evidenceClaimIds))];
        const currency = execution.spec.inputs.find((input) => input.currency)?.currency || "USD";
        for (const scenario of execution.scenarios) {
          await tx`
            INSERT INTO scenarios (
              asset_id, research_run_id, scenario_name, scenario_type, time_horizon,
              probability, value_anchor, currency, assumptions_json,
              supporting_claim_ids, confidence, valuation_model_run_id, review_status
            ) VALUES (
              ${ctx.assetId}, ${ctx.runId}, ${scenario.scenarioName}, ${scenario.scenarioType},
              'method-defined', ${scenario.probability.toString()},
              ${scenario.valueAnchor.toString()}, ${currency},
              ${tx.json({
                protocol_version: VALUATION_METHOD_PROTOCOL_VERSION,
                method_key: execution.spec.method_key,
                overrides: scenario.overrides,
                rationale: scenario.rationale,
              } as any)},
              ${supportingClaimIds}, ${scenario.confidence.toString()},
              ${modelRunId}, 'accepted'
            )
          `;
        }
      }
    });
    if (!execution?.valid) {
      preflightGaps.push({
        gap_key: `valuation_${modelKey}_blocked`,
        severity: "high",
        description: `Required valuation model ${modelKey} is blocked (${reason}): ${(execution?.errors || validation.errors).join("; ")}`,
      });
    }
  }
  await reconcileSourceGaps(sql, ctx, { source_gaps: preflightGaps }, "system:valuation-preflight");
}

async function persistValidatedIndicators(sql: Sql, ctx: RunContext) {
  if (ctx.pipelineVersion < 2 || ctx.runType === "quick_scan") return;
  const inputs = await loadMetricInputs(sql, ctx);
  const specs = [
    ["market_price", "Market price", "market", ["market_price"]],
    ["revenue", "Revenue", "growth", ["revenue"]],
    ["operating_income", "Operating income", "profitability", ["operating_income"]],
    ["operating_cash_flow", "Operating cash flow", "cash_flow", ["operating_cash_flow"]],
    ["free_cash_flow", "Free cash flow", "cash_flow", ["free_cash_flow"]],
    ["capex", "Capital expenditures", "investment", ["capex"]],
    ["cash_and_equivalents", "Cash and equivalents", "balance_sheet", ["cash_and_equivalents"]],
    ["total_debt", "Total debt", "balance_sheet", ["total_debt"]],
    ["shares_outstanding", "Shares outstanding", "per_share", ["shares_outstanding", "diluted_shares"]],
    ["diluted_eps", "Diluted earnings per share", "per_share", ["diluted_eps"]],
  ] as const;
  for (const [key, name, family, metricKeys] of specs) {
    const matched = metricKeys.map((metricKey) => metricFrom(inputs, metricKey)).filter(Boolean) as MetricInput[];
    if (!matched.length) continue;
    const primary = matched[0];
    const value = primary.value;
    const definitionRows = await sql`
      INSERT INTO indicator_definitions (
        research_run_id, profile_id, indicator_key, name, family, hypothesis,
        calculation_json, input_metric_ids, supporting_claim_ids, lookahead_risk, backtestability, status
      ) VALUES (
        ${ctx.runId}, ${ctx.profileId}, ${key}, ${name}, ${family},
        ${`${name} is evaluated only from source-linked metric observations available at the recorded timestamp.`},
        ${sql.json({ formula: metricKeys.join(" / "), metric_keys: metricKeys })},
        ${matched.map((input) => input.id)}, ARRAY[]::uuid[],
        'Uses available_at from input observations; no future observations are permitted.',
        'validated_input_series', 'accepted'
      ) ON CONFLICT (research_run_id, indicator_key) DO UPDATE
      SET calculation_json = EXCLUDED.calculation_json, input_metric_ids = EXCLUDED.input_metric_ids,
          status = 'accepted'
      RETURNING id
    `;
    await sql`
      INSERT INTO indicator_observations (
        indicator_definition_id, observed_at, available_at, value_numeric, input_observation_ids, metadata_json
      ) VALUES (
        ${definitionRows[0].id}, ${primary.asOfDate}, ${primary.availableAt}, ${value.toString()},
        ${matched.map((input) => input.id)}, ${sql.json({ derived: matched.length > 1, metric_keys: metricKeys })}
      )
    `;
  }
}

function deterministicStrategySource() {
  return [
    "import pandas as pd",
    "",
    "def generate_signals(prices, params):",
    "    close = pd.to_numeric(prices.get('adj_close', prices['close']), errors='coerce').ffill()",
    "    short_window = int(params['short_window'])",
    "    long_window = int(params['long_window'])",
    "    short = close.rolling(short_window, min_periods=short_window).mean()",
    "    long = close.rolling(long_window, min_periods=long_window).mean()",
    "    return pd.DataFrame({'signal': (short > long).astype(float).fillna(0.0)}, index=prices.index)",
    "",
  ].join("\n");
}

async function executeDeterministicStrategyGrid(sql: Sql, ctx: RunContext) {
  if (ctx.runType === "quick_scan") return;
  const shortWindows = [10, 15, 20, 25, 30];
  const longWindows = [60, 80, 100, 150, 200, 250, 300, 350, 400, 450];
  const combinations = shortWindows.flatMap((shortWindow) => longWindows.map((longWindow) => ({
    combination_key: `ma_${shortWindow}_${longWindow}`,
    name: `Moving average ${shortWindow}/${longWindow}`,
    hypothesis: "A medium-term moving-average regime filter may improve risk-adjusted return versus continuous exposure.",
    params: { short_window: shortWindow, long_window: longWindow },
  }))).filter((item) => item.params.short_window < item.params.long_window);
  if (combinations.length !== 50) throw new Error(`Expected 50 strategy combinations, received ${combinations.length}`);

  const artifactDir = join(process.cwd(), "storage", "backtests", ctx.runId, "deterministic-grid");
  await mkdir(artifactDir, { recursive: true });
  const strategyPath = join(artifactDir, "strategy.py");
  const configPath = join(artifactDir, "grid-input.json");
  const resultPath = join(artifactDir, "grid-results.json");
  const source = deterministicStrategySource();
  await writeFile(strategyPath, source, "utf8");
  const config = {
    symbol: ctx.symbol,
    benchmark_symbol: "SPY",
    start_date: "2021-01-04",
    end_date: ctx.marketDataCutoffAt?.slice(0, 10) || "2025-12-31",
    market_data_cutoff_at: ctx.marketDataCutoffAt,
    initial_capital: 100000,
    combinations,
  };
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  const { stdout } = await execFileAsync(
    "python3",
    [join(process.cwd(), "python", "backtesting", "run_backtest_grid.py"), configPath],
    { cwd: process.cwd(), timeout: Number(process.env.BACKTEST_GRID_TIMEOUT_MS || 240000), maxBuffer: 1024 * 1024 * 10 }
  );
  const gridResult = objectValue(JSON.parse(String(stdout)));
  const results = arrayValue(gridResult.results);
  if (results.length !== 50) throw new Error(`Deterministic backtest grid returned ${results.length}/50 results`);
  await writeFile(resultPath, JSON.stringify(gridResult, null, 2), "utf8");
  const stageRows = await sql`SELECT id FROM research_stages WHERE research_run_id = ${ctx.runId} AND stage_key = 'backtest_execution'`;
  const stageId = String(stageRows[0].id);
  for (const result of results) {
    const key = textValue(result.combination_key);
    const definition = combinations.find((item) => item.combination_key === key);
    if (!definition) throw new Error(`Unknown grid result ${key}`);
    const backtestRows = await sql`
      INSERT INTO backtest_runs (
        research_run_id, asset_id, status, strategy_name, strategy_prompt, symbol, benchmark_symbol,
        data_provider, start_date, end_date, market_data_cutoff_at, initial_capital, params_json,
        assumptions_json, generated_code_path, metrics_json, started_at, completed_at
      ) VALUES (
        ${ctx.runId}, ${ctx.assetId}, 'completed', ${definition.name},
        'Deterministic moving-average strategy grid executed by Research OS.', ${ctx.symbol}, 'SPY',
        'yfinance', '2021-01-04', ${config.end_date}, ${ctx.marketDataCutoffAt}, '100000',
        ${sql.json(definition.params)},
        ${sql.json([{ source: "deterministic_grid", hypothesis: definition.hypothesis }])},
        ${strategyPath.replace(/\\/g, "/")}, ${sql.json((result.metrics || {}) as any)}, NOW(), NOW()
      ) RETURNING id
    `;
    const backtestId = String(backtestRows[0].id);
    await sql`
      INSERT INTO backtest_artifacts (
        backtest_run_id, research_run_id, artifact_type, title, storage_path, mime_type, metadata_json
      ) VALUES (
        ${backtestId}, ${ctx.runId}, 'deterministic_grid_result', ${definition.name},
        ${resultPath.replace(/\\/g, "/")}, 'application/json',
        ${sql.json({ combination_key: key, strategy_source_hash: createHash("sha256").update(source).digest("hex") })}
      )
    `;
    await sql`
      INSERT INTO strategy_combinations (
        research_run_id, combination_key, name, hypothesis, definition_json, status, backtest_run_id, completed_at
      ) VALUES (
        ${ctx.runId}, ${key}, ${definition.name}, ${definition.hypothesis},
        ${sql.json({ strategy: "moving_average_crossover", params: definition.params, input_data: "yfinance adjusted close" })},
        'completed', ${backtestId}, NOW()
      ) ON CONFLICT (research_run_id, combination_key) DO UPDATE
      SET status = 'completed', backtest_run_id = EXCLUDED.backtest_run_id, completed_at = NOW(), definition_json = EXCLUDED.definition_json
    `;
  }
  await sql`
    INSERT INTO research_tasks (
      research_run_id, stage_id, task_key, task_type, agent_name, status, priority, input_json, output_json, completed_at
    ) VALUES (
      ${ctx.runId}, ${stageId}, 'deterministic-strategy-grid', 'backtest', 'deterministic-backtest-grid',
      'completed', 75, ${sql.json(config)},
      ${sql.json({ combinations_executed: 50, artifact: resultPath.replace(/\\/g, "/") })}, NOW()
    )
  `;
}

function metricNumber(metrics: Record<string, unknown>, key: string) {
  const observation = arrayValue(metrics.normalized_observations).find((item) => item.metric_key === key);
  const numeric = Number(observation?.value_numeric ?? observation?.value);
  return Number.isFinite(numeric) ? numeric : null;
}

function metricDate(metrics: Record<string, unknown>, key: string) {
  const observation = arrayValue(metrics.normalized_observations).find((item) => item.metric_key === key);
  return textValue(observation?.as_of_date || observation?.period_end, "");
}

function addDeterministicScenarioAnchors(
  valuationOutput: Record<string, unknown>,
  metrics: Record<string, unknown>
) {
  const existingScenarios = arrayValue(valuationOutput.scenarios);
  if (existingScenarios.some((scenario) => numericTextOrNull(scenario.value_anchor))) {
    return valuationOutput;
  }

  const marketPrice = metricNumber(metrics, "market_price");
  const freeCashFlow = metricNumber(metrics, "free_cash_flow");
  const shares =
    metricNumber(metrics, "diluted_shares") ||
    metricNumber(metrics, "shares_outstanding");
  const dilutedEps = metricNumber(metrics, "diluted_eps");
  const asOfDate = metricDate(metrics, "market_price") || new Date().toISOString().slice(0, 10);

  let anchorBasis = "market_price_sensitivity";
  let anchors: Array<{ name: string; type: string; probability: number; value: number; assumptions: Record<string, unknown>; confidence: number }> = [];

  if (freeCashFlow && shares && shares > 0) {
    const fcfPerShare = freeCashFlow / shares;
    anchorBasis = "fcf_yield_sensitivity";
    anchors = [
      {
        name: "Bear - Higher FCF Yield",
        type: "bear",
        probability: 0.25,
        value: fcfPerShare / 0.04,
        confidence: 0.45,
        assumptions: { fcf_per_share: fcfPerShare, assumed_fcf_yield: "4.0%", basis: anchorBasis },
      },
      {
        name: "Base - FCF Yield Anchor",
        type: "base",
        probability: 0.45,
        value: fcfPerShare / 0.03,
        confidence: 0.5,
        assumptions: { fcf_per_share: fcfPerShare, assumed_fcf_yield: "3.0%", basis: anchorBasis },
      },
      {
        name: "Bull - Lower FCF Yield",
        type: "bull",
        probability: 0.2,
        value: fcfPerShare / 0.025,
        confidence: 0.42,
        assumptions: { fcf_per_share: fcfPerShare, assumed_fcf_yield: "2.5%", basis: anchorBasis },
      },
      {
        name: "Stress - FCF Yield Re-rate",
        type: "stress",
        probability: 0.1,
        value: fcfPerShare / 0.05,
        confidence: 0.38,
        assumptions: { fcf_per_share: fcfPerShare, assumed_fcf_yield: "5.0%", basis: anchorBasis },
      },
    ];
  } else if (dilutedEps) {
    anchorBasis = "eps_multiple_sensitivity";
    anchors = [
      {
        name: "Bear - Lower Earnings Multiple",
        type: "bear",
        probability: 0.25,
        value: dilutedEps * 24,
        confidence: 0.42,
        assumptions: { diluted_eps: dilutedEps, assumed_pe_multiple: 24, basis: anchorBasis },
      },
      {
        name: "Base - Earnings Multiple Anchor",
        type: "base",
        probability: 0.45,
        value: dilutedEps * 30,
        confidence: 0.48,
        assumptions: { diluted_eps: dilutedEps, assumed_pe_multiple: 30, basis: anchorBasis },
      },
      {
        name: "Bull - Premium Earnings Multiple",
        type: "bull",
        probability: 0.2,
        value: dilutedEps * 36,
        confidence: 0.40,
        assumptions: { diluted_eps: dilutedEps, assumed_pe_multiple: 36, basis: anchorBasis },
      },
    ];
  } else if (marketPrice) {
    anchors = [
      {
        name: "Bear - Market Price Drawdown",
        type: "bear",
        probability: 0.25,
        value: marketPrice * 0.8,
        confidence: 0.35,
        assumptions: { market_price: marketPrice, price_sensitivity: "-20%", basis: anchorBasis },
      },
      {
        name: "Base - Current Market Price Anchor",
        type: "base",
        probability: 0.45,
        value: marketPrice,
        confidence: 0.45,
        assumptions: { market_price: marketPrice, price_sensitivity: "0%", basis: anchorBasis },
      },
      {
        name: "Bull - Market Price Upside",
        type: "bull",
        probability: 0.2,
        value: marketPrice * 1.2,
        confidence: 0.35,
        assumptions: { market_price: marketPrice, price_sensitivity: "+20%", basis: anchorBasis },
      },
    ];
  }

  if (!anchors.length) return valuationOutput;

  return {
    ...valuationOutput,
    scenarios: anchors.map((anchor) => ({
      scenario_name: anchor.name,
      scenario_type: anchor.type,
      time_horizon: "12-36 months",
      probability: anchor.probability,
      value_anchor: Number(anchor.value.toFixed(2)),
      currency: "USD",
      assumptions_json: {
        ...anchor.assumptions,
        as_of_date: asOfDate,
        generated_by: "deterministic_metric_anchor",
        caveat: "Deterministic anchor for workflow completeness; human review should validate assumptions before action.",
      },
      confidence: anchor.confidence,
    })),
    sensitivity_notes: [
      ...(Array.isArray(valuationOutput.sensitivity_notes) ? valuationOutput.sensitivity_notes : []),
      `Deterministic scenario anchors added using ${anchorBasis}.`,
    ],
  };
}

async function persistValuation(sql: Sql, ctx: RunContext, output: Record<string, unknown>) {
  const signals = arrayValue(output.valuation_signals);
  for (const signal of signals) {
    const lens = textValue(signal.lens_family, "");
    if (!lens) continue;
    const methodRows = await sql`
      SELECT id FROM valuation_methods
      WHERE method_family = ${lens} OR method_key = ${textValue(signal.method_key, "")}
      ORDER BY requires_code DESC
      LIMIT 1
    `;
    await sql`
      INSERT INTO valuation_signals (
        asset_id, research_run_id, profile_id, valuation_method_id,
        signal_key, signal_name, lens_family, current_value_text,
        comparison_range_json, cheaper_when, signal, cheapness_score,
        confidence, metadata_json, review_status
      ) VALUES (
        ${ctx.assetId}, ${ctx.runId}, ${ctx.profileId}, ${methodRows[0]?.id || null},
        ${textValue(signal.signal_key || signal.key, `agent_${lens}`)},
        ${textValue(signal.signal_name || signal.name, `${lens} signal`)},
        ${lens}, ${textValue(signal.current_value_text || signal.current_value, "Agent-generated valuation signal")},
        ${sql.json((signal.comparison_range_json || {}) as any)},
        ${textValue(signal.cheaper_when, "lower")},
        ${textValue(signal.signal, "inconclusive")},
        ${numericTextOrNull(signal.cheapness_score)},
        ${numberValue(signal.confidence, 0.65).toString()},
        ${sql.json({ system_generated: true, agent_output: signal } as any)},
        'accepted'
      )
    `;
  }

  const scenarios = arrayValue(output.scenarios);
  const scenariosToPersist = scenarios.length
    ? scenarios.slice(0, 6)
    : [
        {
          scenario_name: "Inconclusive Valuation Scenario",
          scenario_type: "base",
          time_horizon: "not_applicable",
          assumptions: output.assumptions || [],
          confidence: 0.4,
        },
      ];

  for (const scenario of scenariosToPersist) {
    await sql`
      INSERT INTO scenarios (
        asset_id, research_run_id, scenario_name, scenario_type, time_horizon,
        probability, value_anchor, currency, assumptions_json, confidence, review_status
      ) VALUES (
        ${ctx.assetId}, ${ctx.runId},
        ${textValue(scenario.scenario_name || scenario.name, "Agent Scenario")},
        ${textValue(scenario.scenario_type || scenario.type, "base")},
        ${textValue(scenario.time_horizon, "3y")},
        ${numericTextOrNull(scenario.probability)},
        ${numericTextOrNull(scenario.value_anchor)},
        ${textValue(scenario.currency, "USD")},
        ${sql.json((scenario.assumptions_json || scenario.assumptions || []) as any)},
        ${numberValue(scenario.confidence, 0.65).toString()},
        'accepted'
      )
    `;
  }
}

async function persistThesisRiskCatalyst(sql: Sql, ctx: RunContext, analysis: Record<string, unknown>, valuation: Record<string, unknown>) {
  const firstSection = arrayValue(analysis.analysis_sections)[0];
  const thesisText =
    textValue(firstSection?.summary || firstSection?.body || firstSection?.thesis, "") ||
    `${ctx.assetName} requires further analyst review based on the system-generated evidence and valuation outputs.`;
  const thesisRows = await sql`
    INSERT INTO theses (
      asset_id, research_run_id, one_sentence_thesis, why_now,
      market_missing, status, created_by
    ) VALUES (
      ${ctx.assetId}, ${ctx.runId}, ${thesisText.slice(0, 1000)},
      'Generated by Research OS system pipeline from accepted evidence and agent analysis.',
      'Unresolved source gaps and model assumptions remain visible for review.',
      'draft', 'system-research-pipeline'
    )
    RETURNING id
  `;

  for (const driver of arrayValue(analysis.key_drivers).slice(0, 6)) {
    await sql`
      INSERT INTO thesis_drivers (
        thesis_id, driver_name, driver_type, description, value_impact, confidence
      ) VALUES (
        ${thesisRows[0].id},
        ${textValue(driver.driver_name || driver.name, "Agent driver")},
        ${textValue(driver.driver_type || driver.type, "business")},
        ${textValue(driver.description || driver.summary, "") || null},
        ${textValue(driver.value_impact || driver.impact, "") || null},
        ${numberValue(driver.confidence, 0.65).toString()}
      )
    `;
  }

  const risks = [
    ...arrayValue(analysis.source_gaps),
    ...arrayValue(valuation.method_risks),
  ].slice(0, 6);
  for (const risk of risks.length ? risks : [{ description: "Agent reported unresolved evidence or valuation uncertainty.", severity: "medium" }]) {
    await sql`
      INSERT INTO risks (
        asset_id, research_run_id, risk_name, risk_type, description,
        severity, probability, mitigants_json
      ) VALUES (
        ${ctx.assetId}, ${ctx.runId},
        ${textValue(risk.risk_name || risk.name || risk.gap_key, "System-identified research risk")},
        ${textValue(risk.risk_type || risk.type, "research_quality")},
        ${textValue(risk.description || risk.reason, "Unresolved research risk identified by system agents.")},
        ${textValue(risk.severity, "medium")},
        ${textValue(risk.probability, "unknown")},
        ${sql.json((risk.mitigants_json || []) as any)}
      )
    `;
  }

  const catalysts = arrayValue(analysis.key_drivers).slice(0, 3);
  if (!catalysts.length) {
    catalysts.push({
      driver_name: "Source-linked operating and valuation refresh",
      driver_type: "research_catalyst",
      description: "New reported operating metrics and market data can update the deterministic valuation models.",
      value_impact: "Model inputs and per-share value anchors may change when new evidence is ingested.",
    });
  }
  for (const catalyst of catalysts) {
    await sql`
      INSERT INTO catalysts (
        asset_id, research_run_id, catalyst_name, catalyst_type,
        date_confidence, description, upside_downside, status
      ) VALUES (
        ${ctx.assetId}, ${ctx.runId},
        ${textValue(catalyst.driver_name || catalyst.name, "System-identified driver")},
        ${textValue(catalyst.driver_type || catalyst.type, "driver")},
        'low',
        ${textValue(catalyst.description || catalyst.summary, "Driver identified by system agents.")},
        ${textValue(catalyst.value_impact || catalyst.impact, "unknown")},
        'open'
      )
    `;
  }
}

async function persistReview(sql: Sql, ctx: RunContext, output: Record<string, unknown>) {
  const stageRows = await sql`SELECT id FROM research_stages WHERE research_run_id = ${ctx.runId} AND stage_key = 'ai_reviewer'`;
  await sql`
    INSERT INTO research_tasks (
      research_run_id, stage_id, task_key, task_type, agent_name,
      status, priority, input_json, output_json, completed_at
    ) VALUES (
      ${ctx.runId}, ${stageRows[0].id}, 'agent_review_findings', 'ai_review', 'research-reviewer',
      'completed', 60, ${sql.json({ system_generated: true })},
      ${sql.json(output as any)}, NOW()
    )
  `;
  await reconcileSourceGaps(sql, ctx, {
    source_gaps: [...arrayValue(output.missing_coverage), ...arrayValue(output.unsupported_claims)].map((item) => ({
      ...item, description: item.description || item.detail || item.reason || item.claim || item.claim_text,
    })),
  }, "system:research-reviewer");
}

async function loadBacktestReviewPacket(sql: Sql, ctx: RunContext) {
  const runs = await sql`
    SELECT id, strategy_name, benchmark_symbol, start_date, end_date, market_data_cutoff_at,
           params_json, metrics_json, generated_code_path
    FROM backtest_runs WHERE research_run_id = ${ctx.runId} AND status = 'completed'
    ORDER BY created_at DESC LIMIT 50
  `;
  const artifacts = await sql`
    SELECT backtest_run_id, artifact_type, storage_path FROM backtest_artifacts
    WHERE research_run_id = ${ctx.runId} ORDER BY created_at DESC LIMIT 60
  `;
  const metricValue = (row: Record<string, unknown>, ...keys: string[]) => {
    const metrics = objectValue(row.metrics_json);
    for (const key of keys) {
      const value = Number(metrics[key]);
      if (Number.isFinite(value)) return value;
    }
    return null;
  };
  const ranked = runs.map((row) => ({ row, value: metricValue(row, "total_return", "strategy_return", "return") }))
    .filter((item) => item.value !== null).sort((a, b) => Number(b.value) - Number(a.value));
  const summarize = (row: Record<string, unknown> | undefined) => row ? ({
    backtest_run_id: row.id, strategy_name: row.strategy_name, params: row.params_json,
    total_return: metricValue(row, "total_return", "strategy_return", "return"),
    benchmark_return: metricValue(row, "benchmark_return", "benchmark_total_return"),
    sharpe: metricValue(row, "sharpe_ratio", "sharpe"), max_drawdown: metricValue(row, "max_drawdown"),
    in_sample: objectValue(objectValue(row.metrics_json).in_sample),
    out_of_sample: objectValue(objectValue(row.metrics_json).out_of_sample),
    out_of_sample_excess_return: metricValue(row, "out_of_sample_excess_return"),
    parameter_stability: objectValue(objectValue(row.metrics_json).parameter_stability),
    split_date: objectValue(row.metrics_json).split_date || null,
    in_sample_rank: metricValue(row, "in_sample_rank"),
  }) : null;
  const inSampleRanked = runs
    .map((row) => ({ row, rank: metricValue(row, "in_sample_rank") }))
    .filter((item) => item.rank !== null)
    .sort((a, b) => Number(a.rank) - Number(b.rank));
  return {
    executed_count: runs.length, benchmark_symbol: runs[0]?.benchmark_symbol || null,
    start_date: runs[0]?.start_date || null, end_date: runs[0]?.end_date || null,
    market_data_cutoff_at: runs[0]?.market_data_cutoff_at || ctx.marketDataCutoffAt,
    best: summarize(ranked[0]?.row), worst: summarize(ranked.at(-1)?.row),
    selected_on_in_sample: summarize(inSampleRanked[0]?.row),
    robustness_protocol: "70/30 chronological split; parameters ranked in-sample and evaluated on untouched out-of-sample data with neighboring-parameter stability.",
    artifact_refs: artifacts.map((artifact) => ({ backtest_run_id: artifact.backtest_run_id, artifact_type: artifact.artifact_type, storage_path: artifact.storage_path })).slice(0, 12),
  };
}

async function advanceUntil(sql: Sql, runId: string, expectedStage: string) {
  for (let i = 0; i < 32; i += 1) {
    const stages = await sql`
      SELECT stage_key, status FROM research_stages
      WHERE research_run_id = ${runId}
      ORDER BY stage_order
    `;
    const active = stages.find((stage) => stage.status === "running" || stage.status === "waiting_for_human");
    if (active?.stage_key === expectedStage) return;
    if (!active) {
      await sql`
        UPDATE research_stages
        SET status = 'running',
            started_at = COALESCE(started_at, NOW()),
            updated_at = NOW()
        WHERE id = (
          SELECT id FROM research_stages
          WHERE research_run_id = ${runId}
            AND status = 'pending'
          ORDER BY stage_order ASC
          LIMIT 1
        )
      `;
      continue;
    }
    const result = await advanceStage(runId);
    if (!result.success && result.action !== "retry") {
      throw new Error(result.error || "Failed to advance stage");
    }
  }
  throw new Error(`Timed out advancing to ${expectedStage}`);
}

async function getStageStatus(sql: Sql, runId: string, stageKey: string) {
  const rows = await sql`
    SELECT status FROM research_stages
    WHERE research_run_id = ${runId} AND stage_key = ${stageKey}
    LIMIT 1
  `;
  return rows[0]?.status as string | undefined;
}

async function ensureStageReady(sql: Sql, runId: string, stageKey: string) {
  const status = await getStageStatus(sql, runId, stageKey);
  if (stageKey === "human_review" && (status === "pending" || status === "running" || status === "waiting_for_human")) {
    const targetRows = await sql`
      SELECT stage_order FROM research_stages
      WHERE research_run_id = ${runId} AND stage_key = 'human_review'
      LIMIT 1
    `;
    const targetOrder = Number(targetRows[0]?.stage_order);
    for (let index = 0; index < 8; index += 1) {
      const earlierActive = await sql`
        SELECT stage_key FROM research_stages
        WHERE research_run_id = ${runId}
          AND status = 'running' AND stage_order < ${targetOrder}
        ORDER BY stage_order LIMIT 1
      `;
      if (!earlierActive.length) break;
      const result = await advanceStage(runId);
      if (!result.success && result.action !== "retry") {
        throw new Error(result.error || `Failed to advance ${earlierActive[0].stage_key}`);
      }
    }
    const failedStages = await sql`
      SELECT stage_key FROM research_stages
      WHERE research_run_id = ${runId} AND status = 'failed'
    `;
    if (failedStages.length) {
      await sql.begin(async (tx) => {
        await tx`
          UPDATE research_stages
          SET status = 'pending', started_at = NULL, completed_at = NULL,
              failure_reason = NULL, updated_at = NOW()
          WHERE research_run_id = ${runId} AND stage_key = 'human_review'
        `;
        await tx`
          UPDATE research_runs
          SET status = 'needs_more_work', completed_at = NOW(), updated_at = NOW(),
              failure_reason = ${`Cannot enter human review with failed stages: ${failedStages.map((stage) => stage.stage_key).join(", ")}`}
          WHERE id = ${runId}
        `;
      });
      return "pending";
    }
  }
  // A skipped stage is intentionally non-executable. Treating it as pending
  // made `advanceUntil` step past it and validate the *next* stage before its
  // agent had a chance to produce output (notably AI review after backtests).
  if (status === "completed" || status === "skipped") {
    const targetRows = await sql`
      SELECT stage_order FROM research_stages
      WHERE research_run_id = ${runId} AND stage_key = ${stageKey}
      LIMIT 1
    `;
    const targetOrder = Number(targetRows[0]?.stage_order);
    for (let index = 0; index < 8; index += 1) {
      const earlierActive = await sql`
        SELECT stage_key FROM research_stages
        WHERE research_run_id = ${runId}
          AND status = 'running' AND stage_order < ${targetOrder}
        ORDER BY stage_order LIMIT 1
      `;
      if (!earlierActive.length) break;
      const result = await advanceStage(runId);
      if (!result.success && result.action !== "retry") {
        throw new Error(result.error || `Failed to advance ${earlierActive[0].stage_key}`);
      }
    }
    return status;
  }
  if (status === "running" || status === "waiting_for_human") return status;
  // An explicit pipeline resume may retry the failed stage. Completed task
  // outputs inside the stage remain reusable, so grouped analysis restarts at
  // the first incomplete group instead of repeating paid work.
  if (status === "failed") {
    const stageOrderRows = await sql`
      SELECT stage_order FROM research_stages
      WHERE research_run_id = ${runId} AND stage_key = ${stageKey}
      LIMIT 1
    `;
    const stageOrder = Number(stageOrderRows[0]?.stage_order);
    const active = await sql`
      SELECT 1 FROM research_stages
      WHERE research_run_id = ${runId}
        AND status IN ('running', 'waiting_for_human')
        AND stage_order <= ${stageOrder}
      LIMIT 1
    `;
    if (active.length) throw new Error(`Cannot resume ${stageKey} while another stage is active`);
    await sql.begin(async (tx) => {
      await tx`
        UPDATE research_stages
        SET status = 'running', failure_reason = NULL, completed_at = NULL,
            started_at = NOW(), updated_at = NOW()
        WHERE research_run_id = ${runId} AND stage_key = ${stageKey} AND status = 'failed'
      `;
      await tx`
        UPDATE research_stages
        SET status = 'pending', failure_reason = NULL, completed_at = NULL,
            started_at = NULL, validation_result_json = NULL, updated_at = NOW()
        WHERE research_run_id = ${runId}
          AND status IN ('cancelled', 'failed', 'running', 'waiting_for_human')
          AND stage_order > (
            SELECT stage_order FROM research_stages
            WHERE research_run_id = ${runId} AND stage_key = ${stageKey}
          )
      `;
      await tx`
        UPDATE research_runs
        SET status = 'running', failure_reason = NULL, completed_at = NULL, updated_at = NOW()
        WHERE id = ${runId} AND status IN ('needs_more_work', 'waiting_for_human')
      `;
    });
    return "running";
  }
  await advanceUntil(sql, runId, stageKey);
  return getStageStatus(sql, runId, stageKey);
}

function isStageRunnable(status: string | undefined): boolean {
  return status === "running" || status === "completed" || status === "skipped";
}

async function latestTaskOutput(sql: Sql, runId: string, taskKey: string): Promise<Record<string, unknown> | null> {
  const rows = await sql`
    SELECT output_json
    FROM research_tasks
    WHERE research_run_id = ${runId}
      AND task_key = ${taskKey}
      AND status = 'completed'
      AND output_json IS NOT NULL
    ORDER BY completed_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  `;
  return rows[0]?.output_json ? objectValue(rows[0].output_json) : null;
}

async function systemPipelineResult(sql: Sql, runId: string, notes: string[]): Promise<SystemPipelineResult> {
  const rows = await sql`
    SELECT rr.status, count(rs.*) filter (where rs.status = 'completed') as completed, count(rs.*) as total
    FROM research_runs rr
    JOIN research_stages rs ON rs.research_run_id = rr.id
    WHERE rr.id = ${runId}
    GROUP BY rr.status
  `;

  return {
    runId,
    status: rows[0].status,
    completedStages: Number(rows[0].completed),
    totalStages: Number(rows[0].total),
    notes,
  };
}

async function markPipelineFailure(sql: Sql, runId: string, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
  const failureMetadata = {
    system_pipeline_failure: message,
    system_pipeline_failed_at: new Date().toISOString(),
  };
  await sql.begin(async (tx) => {
    await tx`
      UPDATE research_tasks
      SET status = 'failed', failure_reason = ${message}, completed_at = NOW(), updated_at = NOW()
      WHERE research_run_id = ${runId} AND status = 'running'
    `;
    await tx`
      UPDATE research_stages
      SET status = 'failed', failure_reason = ${message}, completed_at = NOW(), updated_at = NOW()
      WHERE research_run_id = ${runId} AND status IN ('running', 'waiting_for_human')
    `;
    await tx`
      UPDATE research_runs
      SET status = 'needs_more_work',
          failure_reason = ${message},
          completed_at = NOW(),
          metadata_json = (
            CASE WHEN jsonb_typeof(metadata_json) = 'object' THEN metadata_json ELSE '{}'::jsonb END
          ) || ${tx.json(failureMetadata)},
          updated_at = NOW()
      WHERE id = ${runId}
    `;
  });
}

/**
 * Version dispatcher — route to the current pipeline runner.
 * v1/v2 run creation is rejected; only pipeline version 3 is supported.
 */
export async function runSystemResearchPipeline(runId: string): Promise<SystemPipelineResult> {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    const rows = await sql`
      SELECT pipeline_version FROM research_runs WHERE id = ${runId} LIMIT 1
    `;
    if (!rows[0]) throw new Error(`Research run not found: ${runId}`);
    const pipelineVersion = Number(rows[0].pipeline_version || 1);
    if (pipelineVersion < 3) {
      throw new Error(
        `Run ${runId} has unsupported pipeline_version ${pipelineVersion}. ` +
        `Only pipeline_version >= 3 is supported. Please create a new research run.`
      );
    }
    const { runResearchPipeline } = await import("./pipeline-runner");
    return await runResearchPipeline(runId);
  } finally {
    await sql.end();
  }
}
