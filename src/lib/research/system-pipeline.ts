import postgres from "postgres";
import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ResearchAgentRunError, runResearchAgent } from "@/lib/opencode/runtime";
import { recordModelCall } from "@/lib/agents/model-calls";
import { advanceStage, approveHumanReview, approveResearchPlan, startRun } from "@/lib/workflow/orchestrator";
import { generateMemo } from "@/lib/export/memo-generator";
import { generateResearchPackage } from "@/lib/export/research-package-generator";
import { createBacktestRequest } from "@/lib/backtesting/service";
import { executeBacktestTask } from "@/lib/backtesting/executor";

type Sql = ReturnType<typeof postgres>;

interface SystemPipelineResult {
  runId: string;
  status: string;
  completedStages: number;
  totalStages: number;
  notes: string[];
}

interface RunContext {
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

interface StoredSource {
  sourceId: string;
  parseId: string;
  chunkId: string;
  content: string;
  title: string;
  sourceType: string;
}

interface StoredSourceCorpus {
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
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
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

function buildSourcePacket(sources: StoredSource[]) {
  return sources.map((source) => ({
    source_id: source.sourceId,
    source_type: source.sourceType,
    title: source.title,
    content_excerpt: source.content.slice(0, 12000),
  }));
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
  const rows = factRows(companyFacts, taxonomy, conceptNames, unit)
    .filter((row) => Number.isFinite(Number(row.val)))
    .sort((a, b) => {
      const annualForms = new Set(["10-K", "20-F", "40-F"]);
      const aAnnual = a.fp === "FY" || annualForms.has(String(a.form));
      const bAnnual = b.fp === "FY" || annualForms.has(String(b.form));
      if (preferAnnual && aAnnual !== bAnnual) return aAnnual ? -1 : 1;
      const periodOrder = String(b.end || "").localeCompare(String(a.end || ""));
      if (periodOrder !== 0) return periodOrder;
      return String(b.filed || "").localeCompare(String(a.filed || ""));
    });
  return rows[0] || null;
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
  const historicalPrice = historicalIndex >= 0 ? closes[historicalIndex] : NaN;
  const price = Number.isFinite(historicalPrice) ? historicalPrice : cutoffSeconds === null ? Number(meta.regularMarketPrice) : NaN;
  const currency = textValue(meta.currency, "USD");
  const observedAt = historicalIndex >= 0
    ? new Date(timestamps[historicalIndex] * 1000).toISOString()
    : snapshot.retrieved_at || new Date().toISOString();
  const observations: Record<string, unknown>[] = [];
  if (Number.isFinite(price)) {
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
    if (Number.isFinite(Number(value))) {
      observations.push({
        metric_key: metricKey,
        display_name: displayName,
        metric_category: "market_data",
        unit_type: metricKey === "market_volume" ? "shares" : "per_share",
        value_numeric: Number(value),
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
  if (Number.isFinite(price) && Number.isFinite(Number(shares?.value_numeric))) {
    observations.push({
      metric_key: "market_cap",
      display_name: "Market Capitalization",
      metric_category: "market_data",
      unit_type: "currency",
      value_numeric: price * Number(shares?.value_numeric),
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

  for (const output of outputs) {
    if (!output) continue;
    merged.normalized_observations.push(...arrayValue(output.normalized_observations));
    merged.definition_mappings.push(...arrayValue(output.definition_mappings));
    merged.conversion_notes.push(...(Array.isArray(output.conversion_notes) ? output.conversion_notes : []));
    merged.unresolved_ambiguities.push(...(Array.isArray(output.unresolved_ambiguities) ? output.unresolved_ambiguities : []));
    merged.quality_flags.push(...(Array.isArray(output.quality_flags) ? output.quality_flags : []));
    merged.source_gaps.push(...arrayValue(output.source_gaps));
  }

  return merged;
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
      rp.required_valuation_lenses_json,
      rr.market_data_cutoff_at,
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

  return {
    runId,
    runType: row.run_type,
    assetId: row.asset_id,
    assetName: row.canonical_name,
    assetSlug: row.slug,
    symbol: row.symbol,
    profileId: row.profile_id,
    profileKey: row.profile_key,
    requiredModules: (row.required_modules_json as string[]) || [],
    requiredLenses: (row.required_valuation_lenses_json as string[]) || [],
    marketDataCutoffAt: row.market_data_cutoff_at ? new Date(row.market_data_cutoff_at).toISOString() : null,
  };
}

async function logAgentCall(params: {
  runId: string;
  stageId: string;
  taskId: string;
  agentName: string;
  modelTier: string;
  usage: Awaited<ReturnType<typeof runResearchAgent>>["usage"];
  status: string;
  errorMessage?: string;
}) {
  await recordModelCall({
    researchRunId: params.runId,
    stageId: params.stageId,
    taskId: params.taskId,
    agentName: params.agentName,
    modelProvider: params.usage.provider,
    modelName: params.usage.model,
    modelTier: params.modelTier,
    promptVersion: params.usage.promptVersion,
    inputTokens: params.usage.inputTokens,
    outputTokens: params.usage.outputTokens,
    costUsd: params.usage.costUsd,
    latencyMs: params.usage.latencyMs,
    status: params.status,
    errorMessage: params.errorMessage,
    responseMetadata: { session_id: params.usage.sessionId },
    escalationReason:
      params.modelTier === "premium" || params.modelTier === "specialist"
        ? "System research pipeline stage requires specialist reasoning"
        : undefined,
  });
}

async function createTask(sql: Sql, runId: string, stageKey: string, taskKey: string, taskType: string, agentName: string) {
  const rows = await sql`
    INSERT INTO research_tasks (
      research_run_id, stage_id, task_key, task_type, agent_name,
      status, priority, input_json, started_at
    )
    SELECT
      ${runId}, id, ${taskKey}, ${taskType}, ${agentName},
      'running', 80, ${JSON.stringify({ system_generated: true })}::jsonb, NOW()
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
        output_json = ${JSON.stringify(output)}::jsonb,
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

    const url = secArchiveUrl(cik, accessionNumber, primaryDocument);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "ResearchOS/0.1 research-pipeline@example.com" },
      });
      if (!response.ok) {
        payloads.push({
          sourceType: `sec_filing_${textValue(filing.form, "unknown").toLowerCase()}`,
          title: `${ctx.assetName} ${textValue(filing.form, "SEC filing")} download failed`,
          publisher: "SEC EDGAR",
          url,
          content: JSON.stringify({ filing, url, fetch_status: "failed", status_code: response.status }, null, 2),
          mimeType: "application/json",
          qualityScore: "0.20",
          publishedAt: textValue(filing.filingDate, "") || null,
          periodEnd: textValue(filing.reportDate, "") || null,
          metadata: { system_generated: true, source: "sec_edgar_filing", fetch_status: "failed", status_code: response.status, filing },
          chunkTitle: "SEC filing download failure",
        });
        continue;
      }
      const content = await response.text();
      payloads.push(filingSourcePayload(ctx, cik, filing, content));
    } catch {
      payloads.push({
        sourceType: `sec_filing_${textValue(filing.form, "unknown").toLowerCase()}`,
        title: `${ctx.assetName} ${textValue(filing.form, "SEC filing")} ${textValue(filing.reportDate, "")}`.trim(),
        publisher: "SEC EDGAR",
        url,
        content: JSON.stringify({ filing, url, fetch_status: "failed" }, null, 2),
        mimeType: "application/json",
        qualityScore: "0.75",
        publishedAt: textValue(filing.filingDate, "") || null,
        periodEnd: textValue(filing.reportDate, "") || null,
        metadata: { system_generated: true, source: "sec_edgar_filing", fetch_status: "failed", filing },
        chunkTitle: "SEC filing metadata",
      });
    }
  }
  return payloads;
}

function externalSourcePayloads(ctx: RunContext): SourcePayload[] {
  const ticker = ctx.symbol.toUpperCase();
  const encodedName = encodeURIComponent(ctx.assetName);
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
      title: `${ctx.assetName} software and cloud industry context`,
      publisher: "Public industry and competitor sources",
      url: `https://www.bing.com/search?q=${encodedName}+cloud+software+industry+market+share+valuation+peers`,
      area: "industry and peer context",
      why: "Peer set, cloud growth, AI infrastructure demand, software multiples, and competitive positioning.",
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
    (entry) => entry.ticker?.toUpperCase() === symbol.toUpperCase()
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
      ${storagePath}, ${payload.qualityScore}, ${JSON.stringify(payload.metadata)}::jsonb
    )
    ON CONFLICT (file_hash) DO UPDATE
    SET research_run_id = EXCLUDED.research_run_id,
        asset_id = EXCLUDED.asset_id
    RETURNING id
  `;
  const sourceId = rows[0].id as string;

  const parseRows = await sql`
    INSERT INTO document_parses (
      source_document_id, parser_name, parser_version,
      status, warnings_json, output_storage_path, completed_at
    ) VALUES (
      ${sourceId}, 'system-source-payload', '1', 'completed',
      ${JSON.stringify([])}::jsonb, ${storagePath}, NOW()
    )
    ON CONFLICT (source_document_id, parser_name, parser_version, parse_config_json) DO UPDATE
    SET status = 'completed', completed_at = NOW()
    RETURNING id
  `;
  const parseId = parseRows[0].id as string;

  const chunkRows = await sql`
    INSERT INTO document_chunks (
      source_document_id, document_parse_id, chunk_index, section_title,
      char_start, char_end, text, token_count, metadata_json
    ) VALUES (
      ${sourceId}, ${parseId}, 0, ${payload.chunkTitle},
      0, ${Math.min(content.length, 60000)}, ${content.slice(0, 60000)}, ${Math.ceil(Math.min(content.length, 60000) / 4)},
      ${JSON.stringify({ system_generated: true })}::jsonb
    )
    RETURNING id
  `;

  return {
    sourceId,
    parseId,
    chunkId: chunkRows[0].id as string,
    content: content.slice(0, 60000),
    title: payload.title,
    sourceType: payload.sourceType,
  };
}

async function storeSourceCorpus(sql: Sql, ctx: RunContext, secContext: unknown): Promise<StoredSourceCorpus> {
  const context = objectValue(secContext);
  const publisher = textValue(context.source, "Primary source context");
  const [marketPayload, macroPayload] = await Promise.all([
    marketSourcePayload(ctx),
    macroSourcePayload(ctx),
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
  // Search/source-plan candidates are useful agent context, but are not source documents
  // and must never satisfy source-depth quality gates.
  const externalCandidates = externalSourcePayloads(ctx);
  const payloads = [
    basePayload,
    ...filingPayloads,
    ...(marketPayload ? [marketPayload] : []),
    ...(macroPayload ? [macroPayload] : []),
  ];
  const stored: StoredSource[] = [];
  for (const payload of payloads) {
    stored.push(await storeSourcePayload(sql, ctx, payload));
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
}): Promise<T> {
  const task = await createTask(params.sql, params.ctx.runId, params.stageKey, params.taskKey, params.taskType, params.agentName);
  const maxAttempts = Math.max(1, Number(process.env.RESEARCH_PIPELINE_AGENT_ATTEMPTS || 3));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await runResearchAgent<T>({
        agentName: params.agentName,
        title: `${params.agentName} ${params.ctx.symbol} ${params.ctx.runId} attempt ${attempt}`,
        taskPacket: params.packet,
        prompt: params.prompt,
      });
      await logAgentCall({
        runId: params.ctx.runId,
        stageId: task.stage_id,
        taskId: task.id,
        agentName: params.agentName,
        modelTier: params.modelTier,
        usage: result.usage,
        status: "success",
      });
      await completeTask(params.sql, task.id, result.structured);
      return objectValue(result.structured) as T;
    } catch (error) {
    if (error instanceof ResearchAgentRunError) {
      await recordModelCall({
        researchRunId: params.ctx.runId,
        stageId: task.stage_id,
        taskId: task.id,
        agentName: params.agentName,
        modelProvider: error.usage.provider,
        modelName: error.usage.model,
        modelTier: params.modelTier,
        promptVersion: error.usage.promptVersion,
        inputTokens: error.usage.inputTokens,
        outputTokens: error.usage.outputTokens,
        costUsd: error.usage.costUsd,
        latencyMs: error.usage.latencyMs,
        status: "failed",
        errorMessage: error.message,
        responseMetadata: { ...error.responseMetadata, attempt, max_attempts: maxAttempts },
        escalationReason:
          params.modelTier === "premium" || params.modelTier === "specialist"
            ? "System research pipeline stage requires specialist reasoning"
            : undefined,
      });
    } else {
      await recordModelCall({
        researchRunId: params.ctx.runId,
        stageId: task.stage_id,
        taskId: task.id,
        agentName: params.agentName,
        modelProvider: "opencode",
        modelName: "unknown",
        modelTier: params.modelTier,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        responseMetadata: { transport_or_runtime_failure: true, attempt, max_attempts: maxAttempts },
        escalationReason:
          params.modelTier === "premium" || params.modelTier === "specialist"
            ? "System research pipeline stage requires specialist reasoning"
            : undefined,
      });
    }
      const message = error instanceof Error ? error.message : String(error);
      const transient = /fetch failed|timeout|timed out|ECONNRESET|ECONNREFUSED|socket|network/i.test(message);
      if (transient && attempt < maxAttempts) {
        await params.sql`
          UPDATE research_tasks
          SET retry_count = ${attempt}, failure_reason = ${`Attempt ${attempt}/${maxAttempts} failed: ${message}`}, updated_at = NOW()
          WHERE id = ${task.id}
        `;
        continue;
      }
      await failTask(params.sql, task.id, error);
      throw error;
    }
  }
  throw new Error(`Agent ${params.agentName} exhausted retries`);
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
    "If evidence is insufficient, return empty arrays for the relevant fields and explain gaps in source_gaps or unresolved fields.",
    ...(params.extraRules || []),
    "",
    "Task packet:",
    JSON.stringify(params.packet, null, 2),
  ].join("\n");
}

async function persistEvidence(sql: Sql, ctx: RunContext, source: { sourceId: string; parseId: string; chunkId: string }, output: Record<string, unknown>) {
  const evidenceCap = Math.max(25, Number(process.env.RESEARCH_PIPELINE_EVIDENCE_CAP || 40));
  const claims = usableEvidenceClaims(output).slice(0, evidenceCap);
  for (const claim of claims) {
    const claimText = textValue(claim.claim_text || claim.text || claim.claim, "");
    if (!claimText) continue;
    const rows = await sql`
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
        'source-reader', 'accepted', NULL,
        ${JSON.stringify({ system_generated: true, agent_output: claim })}::jsonb
      )
      RETURNING id
    `;
    const locationRows = await sql`
      INSERT INTO source_locations (
        source_document_id, document_parse_id, document_chunk_id,
        char_start, char_end, locator_json
      ) VALUES (
        ${source.sourceId}, ${source.parseId}, ${source.chunkId},
        0, NULL, ${JSON.stringify({ system_generated: true })}::jsonb
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO evidence_links (
        evidence_claim_id, source_location_id, support_type, quoted_text, confidence
      ) VALUES (
        ${rows[0].id}, ${locationRows[0].id}, 'supports',
        ${claimText.slice(0, 500)}, ${numberValue(claim.confidence, 0.75).toString()}
      )
    `;
  }

  for (const gap of arrayValue(output.source_gaps).slice(0, 8)) {
    await sql`
      INSERT INTO source_gaps (
        asset_id, research_run_id, gap_key, description, severity, status, owner
      ) VALUES (
        ${ctx.assetId}, ${ctx.runId}, ${textValue(gap.gap_key || gap.key, "agent_source_gap")},
        ${textValue(gap.description || gap.reason, "Agent identified an unresolved source gap.")},
        ${textValue(gap.severity, "medium")}, 'open', 'source-reader'
      )
    `;
  }
}

function usableEvidenceClaims(output: Record<string, unknown>) {
  const placeholders = new Set(["string", "claim", "claim text", "n/a", "none", "null"]);
  return arrayValue(output.evidence_claims).filter((claim) => {
    const claimText = textValue(claim.claim_text || claim.text || claim.claim, "");
    return claimText.length >= 20 && !placeholders.has(claimText.toLowerCase());
  });
}

async function persistMetrics(sql: Sql, ctx: RunContext, sourceId: string, output: Record<string, unknown>) {
  const observations = arrayValue(output.normalized_observations).slice(0, 60);
  for (const obs of observations) {
    const metricKey = textValue(obs.metric_key || obs.metric || obs.label, "agent_metric").toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    const metricRows = await sql`
      INSERT INTO metric_definitions (
        metric_key, display_name, metric_category, unit_type, default_unit,
        default_currency, description, applicable_profile_keys, metadata_json
      ) VALUES (
        ${metricKey}, ${textValue(obs.display_name || obs.metric_name || metricKey, metricKey)},
        ${textValue(obs.metric_category, "financial")},
        ${textValue(obs.unit_type, "number")},
        ${textValue(obs.unit || obs.default_unit, "") || null},
        ${textValue(obs.currency || obs.default_currency, "USD")},
        ${textValue(obs.description, "Agent-normalized metric")},
        ARRAY[${ctx.profileKey}], ${JSON.stringify({ system_generated: true })}::jsonb
      )
      ON CONFLICT (metric_key) DO UPDATE
      SET updated_at = NOW()
      RETURNING id
    `;
    await sql`
      INSERT INTO metric_observations (
        asset_id, research_run_id, metric_definition_id,
        period_start, period_end, as_of_date, available_at,
        value_numeric, value_text, unit, currency, data_provider,
        source_document_id, confidence, review_status, metadata_json
      ) VALUES (
        ${ctx.assetId}, ${ctx.runId}, ${metricRows[0].id},
        ${nullableText(obs.period_start)},
        ${textValue(obs.period_end || obs.as_of_date, new Date().toISOString().slice(0, 10))},
        ${textValue(obs.as_of_date || obs.period_end, new Date().toISOString().slice(0, 10))},
        ${textValue(obs.available_at, new Date().toISOString())},
        ${Number.isFinite(Number(obs.value_numeric || obs.value)) ? String(obs.value_numeric || obs.value) : null},
        ${textValue(obs.value_text, "") || null},
        ${textValue(obs.unit, "") || null},
        ${textValue(obs.currency, "USD")},
        'metric-normalizer',
        ${sourceId}, ${numberValue(obs.confidence, 0.7).toString()},
        'accepted', ${JSON.stringify({ system_generated: true, agent_output: obs })}::jsonb
      )
    `;
  }
}

async function persistAnalysis(sql: Sql, ctx: RunContext, output: Record<string, unknown>) {
  const sections = arrayValue(output.analysis_sections);
  const stageRows = await sql`SELECT id FROM research_stages WHERE research_run_id = ${ctx.runId} AND stage_key = 'asset_analysis'`;
  const stageId = stageRows[0].id;
  await sql`
    INSERT INTO research_tasks (
      research_run_id, stage_id, task_key, task_type, agent_name,
      status, priority, input_json, output_json, completed_at
    ) VALUES (
      ${ctx.runId}, ${stageId}, 'agent_analysis_sections', 'analysis', 'asset-analyst',
      'completed', 60, ${JSON.stringify({ system_generated: true })}::jsonb,
      ${JSON.stringify(output)}::jsonb, NOW()
    )
  `;
  for (const moduleKey of ctx.requiredModules) {
    await sql`
      INSERT INTO research_tasks (
        research_run_id, stage_id, task_key, task_type, agent_name,
        status, priority, input_json, output_json, completed_at
      ) VALUES (
        ${ctx.runId}, ${stageId}, ${moduleKey}, 'profile_module', 'asset-analyst',
        'completed', 50, ${JSON.stringify({ system_generated: true })}::jsonb,
        ${JSON.stringify({ system_generated: true, module: moduleKey, sections })}::jsonb, NOW()
      )
    `;
  }
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
        ${JSON.stringify(signal.comparison_range_json || {})}::jsonb,
        ${textValue(signal.cheaper_when, "lower")},
        ${textValue(signal.signal, "inconclusive")},
        ${numericTextOrNull(signal.cheapness_score)},
        ${numberValue(signal.confidence, 0.65).toString()},
        ${JSON.stringify({ system_generated: true, agent_output: signal })}::jsonb,
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
        ${JSON.stringify(scenario.assumptions_json || scenario.assumptions || [])}::jsonb,
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
        ${JSON.stringify(risk.mitigants_json || [])}::jsonb
      )
    `;
  }

  for (const catalyst of arrayValue(analysis.key_drivers).slice(0, 3)) {
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
      'completed', 60, ${JSON.stringify({ system_generated: true })}::jsonb,
      ${JSON.stringify(output)}::jsonb, NOW()
    )
  `;
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
  if (status === "completed" || status === "running" || status === "waiting_for_human") return status;
  await advanceUntil(sql, runId, stageKey);
  return getStageStatus(sql, runId, stageKey);
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

export async function runSystemResearchPipeline(runId: string): Promise<SystemPipelineResult> {
  const sql = postgres(process.env.DATABASE_URL!);
  const notes: string[] = [];
  const autoApprove = process.env.RESEARCH_PIPELINE_AUTO_APPROVE === "true";

  try {
    const ctx = await getRunContext(sql, runId);
    const statusRows = await sql`SELECT status FROM research_runs WHERE id = ${runId}`;
    if (statusRows[0].status === "pending") {
      await startRun(runId);
    }

    const secContext = await fetchSecContext(ctx);
    const sourceCorpus = await storeSourceCorpus(sql, ctx, secContext);
    const sources = sourceCorpus.sources;
    const primarySource = sources[0];
    const sourcePacket = buildSourcePacket(sources);
    const agentSecContext = compactSecContextForAgents(secContext);
    notes.push(`Fetched and stored ${sources.filter((source) => !source.sourceType.startsWith("source_candidate_")).length} source documents`);

    const planStatus = await ensureStageReady(sql, runId, "research_plan");
    if (planStatus === "waiting_for_human") {
      if (!autoApprove) {
        notes.push("Research plan is waiting for human approval");
        return systemPipelineResult(sql, runId, notes);
      }
      await approveResearchPlan(runId, "system-research-pipeline");
      notes.push("Approved generated research plan gate");
    }

    await ensureStageReady(sql, runId, "evidence_extraction");
    let evidenceOutput = await latestTaskOutput(sql, runId, "source-reader:sec-context");
    if (!evidenceOutput || await getStageStatus(sql, runId, "evidence_extraction") !== "completed") {
      const evidenceTarget = ctx.runType === "deep_dive" ? 25 : 12;
      const evidencePacket = { asset: ctx, source_context: agentSecContext, source_corpus: sourcePacket };
      const evidencePrompt = exactJsonPrompt({
        agentName: "source-reader",
        requiredKeys: ["evidence_claims", "contradictions", "source_gaps", "low_confidence_items", "rejected_candidates"],
        packet: evidencePacket,
        extraRules: [
          "Each evidence_claim must include claim_text, claim_type, claim_category, as_of_date or period_end when available, confidence.",
          `Return at least ${evidenceTarget} distinct, decision-relevant evidence claims when the supplied primary sources support them. Never return schema examples or placeholder values.`,
          "Use only the source_context and source_corpus in this packet.",
          "Prefer annual and quarterly SEC filings for financial facts. Use external source candidates only as context or gap indicators unless their content contains a specific sourced fact.",
        ],
      });
      evidenceOutput = await callAgent<Record<string, unknown>>({
      sql,
      ctx,
      stageKey: "evidence_extraction",
      taskKey: "source-reader:sec-context",
      taskType: "evidence_extraction",
      agentName: "source-reader",
      modelTier: "cheap",
      packet: evidencePacket,
      prompt: evidencePrompt,
      });
      if (usableEvidenceClaims(evidenceOutput).length < evidenceTarget) {
        evidenceOutput = await callAgent<Record<string, unknown>>({
          sql,
          ctx,
          stageKey: "evidence_extraction",
          taskKey: "source-reader:sec-context",
          taskType: "evidence_extraction_repair",
          agentName: "source-reader",
          modelTier: "cheap",
          packet: evidencePacket,
          prompt: `${evidencePrompt}\n\nA previous attempt returned too few usable claims. This is a schema repair retry: provide ${evidenceTarget} substantive claims and no placeholders.`,
        });
      }
      if (usableEvidenceClaims(evidenceOutput).length < evidenceTarget) {
        throw new Error(`Source-reader returned ${usableEvidenceClaims(evidenceOutput).length}/${evidenceTarget} usable evidence claims after repair`);
      }
      await persistEvidence(sql, ctx, primarySource, evidenceOutput);
      notes.push("Source-reader produced evidence claims");
    }

    await ensureStageReady(sql, runId, "metric_normalization");
    await persistMetrics(sql, ctx, primarySource.sourceId, sourceCorpus.deterministicMetrics);
    let metricOutput = mergeMetricOutputs(
      sourceCorpus.deterministicMetrics,
      await latestTaskOutput(sql, runId, "metric-normalizer:sec-context")
    );
    if (!metricOutput || await getStageStatus(sql, runId, "metric_normalization") !== "completed") {
      const agentMetricOutput = await callAgent<Record<string, unknown>>({
        sql,
        ctx,
        stageKey: "metric_normalization",
        taskKey: "metric-normalizer:sec-context",
        taskType: "metric_normalization",
        agentName: "metric-normalizer",
        modelTier: "cheap",
        packet: {
          asset: ctx,
          sec_context: agentSecContext,
          deterministic_observations: sourceCorpus.deterministicMetrics.normalized_observations,
          evidence_claims: evidenceOutput.evidence_claims,
        },
        prompt: exactJsonPrompt({
          agentName: "metric-normalizer",
          requiredKeys: ["normalized_observations", "definition_mappings", "conversion_notes", "unresolved_ambiguities", "quality_flags", "source_gaps"],
          packet: {
            asset: ctx,
            sec_context: agentSecContext,
            deterministic_observations: sourceCorpus.deterministicMetrics.normalized_observations,
            evidence_claims: evidenceOutput.evidence_claims,
          },
          extraRules: [
            "normalized_observations should include metric_key, display_name or metric_name, value_numeric where available, unit, currency, period_end, as_of_date, available_at, confidence.",
            "Do not duplicate deterministic_observations unless you improve or correct them.",
          ],
        }),
      });
      metricOutput = mergeMetricOutputs(sourceCorpus.deterministicMetrics, agentMetricOutput);
      await persistMetrics(sql, ctx, primarySource.sourceId, agentMetricOutput);
      notes.push("Metric-normalizer produced metric observations");
    }

    await ensureStageReady(sql, runId, "asset_analysis");
    let analysisOutput = await latestTaskOutput(sql, runId, "asset-analyst:full-analysis");
    if (!analysisOutput || await getStageStatus(sql, runId, "asset_analysis") !== "completed") {
      const analysisPacket = compactResearchContext({ ctx, evidenceOutput, metricOutput });
      analysisOutput = await callAgent<Record<string, unknown>>({
      sql,
      ctx,
      stageKey: "asset_analysis",
      taskKey: "asset-analyst:full-analysis",
      taskType: "analysis",
      agentName: "asset-analyst",
      modelTier: "specialist",
      packet: analysisPacket,
      prompt: exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: ["analysis_sections", "key_drivers", "metric_interpretation", "contradictions_or_tensions", "missing_modules", "source_gaps", "analyst_questions", "confidence"],
        packet: analysisPacket,
        extraRules: [
          "Produce a SOFI-style investment research analysis, not a terse summary.",
          "analysis_sections must include section_key, title, summary, evidence, implication, open_questions, and confidence.",
          "Include sections for business_or_asset_profile, industry_or_context, financial_history, investment_thesis, risk_reward, valuation_inputs, and source_completeness when applicable.",
          "key_drivers must be named, specific drivers with driver_name, driver_type, description, value_impact, evidence_claim_ids where known, and confidence. Never use placeholder names like Agent driver.",
          "metric_interpretation should explain what changed, what matters, what is stale, and what cannot be concluded.",
          "Separate facts, assumptions, estimates, and opinions inside analysis_sections when relevant.",
          "If recent primary-source data is missing, state the missing data as source_gaps with severity and why it matters.",
        ],
      }),
      });
      await persistAnalysis(sql, ctx, analysisOutput);
      notes.push("Asset-analyst produced analysis sections and module outputs");
    }

    await ensureStageReady(sql, runId, "asset_valuation");
    let valuationOutput = await latestTaskOutput(sql, runId, "valuation-analyst:signals");
    if (!valuationOutput) {
      const valuationPacket = compactResearchContext({ ctx, evidenceOutput, metricOutput, analysisOutput });
      valuationOutput = await callAgent<Record<string, unknown>>({
      sql,
      ctx,
      stageKey: "asset_valuation",
      taskKey: "valuation-analyst:signals",
      taskType: "valuation",
      agentName: "valuation-analyst",
      modelTier: "premium",
      packet: {
        ...valuationPacket,
        instruction: "Return at least one valuation_signal for each required lens family.",
      },
      prompt: exactJsonPrompt({
        agentName: "valuation-analyst",
        requiredKeys: ["applicable_methods", "not_applicable_methods", "valuation_signals", "scenarios", "assumptions", "sensitivity_notes", "method_risks", "source_gaps"],
        packet: valuationPacket,
        extraRules: [
          "Produce a SOFI-style valuation dashboard, not a terse list.",
          "valuation_signals must include at least one object for each required_lenses item and should target 10 useful cheapness/expensiveness indicators when data allows.",
          "Each valuation signal should include signal_key, signal_name, lens_family, current_value_text, comparison_range_json, signal, cheapness_score, cheaper_when, confidence, and the source or gap behind it.",
          "scenarios should include bull/base/bear or explain why scenario valuation is blocked; include scenario_name, scenario_type, probability, value_anchor when supportable, assumptions_json, and confidence.",
          "Include direct DCF, exit-multiple DCF, reverse DCF, peer multiple, cash-flow quality, and sensitivity notes for operating companies when evidence supports them; otherwise mark them not_applicable with a reason.",
          "method_risks must identify stale data, missing per-share data, missing capex/free-cash-flow data, circular valuation, peer mismatch, and point-in-time risks when relevant.",
        ],
      }),
      });
    }
    valuationOutput = addDeterministicScenarioAnchors(valuationOutput, metricOutput);
    await persistValuation(sql, ctx, valuationOutput);
    notes.push("Valuation-analyst produced valuation signals and scenarios");

    await ensureStageReady(sql, runId, "thesis_risks");
    await persistThesisRiskCatalyst(sql, ctx, analysisOutput, valuationOutput);
    notes.push("System synthesized thesis, risks, and catalysts from agent outputs");

    await ensureStageReady(sql, runId, "backtest_execution");
    const backtest = await createBacktestRequest(runId, {
      strategy_prompt: "System research pipeline validation: trend-following strategy using only historical adjusted close prices.",
      symbol: ctx.symbol,
      benchmark_symbol: "SPY",
      start_date: "2021-01-04",
      end_date: "2025-12-31",
      initial_capital: 100000,
      params: { short_window: 50, long_window: 200 },
    });
    const taskRows = await sql`SELECT * FROM research_tasks WHERE id = ${backtest.research_task_id}`;
    await executeBacktestTask(taskRows[0] as never);
    notes.push("Backtest-coder generated and executed a backtest");

    await ensureStageReady(sql, runId, "ai_reviewer");
    const reviewOutput = await callAgent<Record<string, unknown>>({
      sql,
      ctx,
      stageKey: "ai_reviewer",
      taskKey: "research-reviewer:full-run",
      taskType: "ai_review",
      agentName: "research-reviewer",
      modelTier: "premium",
      packet: compactResearchContext({ ctx, evidenceOutput, metricOutput, analysisOutput, valuationOutput }),
      prompt: exactJsonPrompt({
        agentName: "research-reviewer",
        requiredKeys: ["pass_fail", "findings", "unsupported_claims", "contradictions", "category_errors", "missing_coverage", "valuation_review", "backtest_review", "escalation_recommendations"],
        packet: compactResearchContext({ ctx, evidenceOutput, metricOutput, analysisOutput, valuationOutput }),
      }),
    });
    await persistReview(sql, ctx, reviewOutput);
    notes.push("Research-reviewer produced review findings");

    await ensureStageReady(sql, runId, "human_review");
    if (!autoApprove) {
      notes.push("Human review is waiting for analyst approval");
      return systemPipelineResult(sql, runId, notes);
    }
    await approveHumanReview(runId, "system-research-pipeline");
    notes.push("Approved human review gate for system test run");

    await ensureStageReady(sql, runId, "export");
    await generateMemo({ runId, assetId: ctx.assetId, generatedBy: "system-research-pipeline" });
    const researchPackage = await generateResearchPackage({
      runId,
      assetId: ctx.assetId,
      generatedBy: "system-research-pipeline",
    });
    notes.push(`Generated memo export and research package at ${researchPackage.storagePath}`);

    await ensureStageReady(sql, runId, "refresh_schedule");
    return systemPipelineResult(sql, runId, notes);
  } catch (error) {
    await markPipelineFailure(sql, runId, error);
    throw error;
  } finally {
    await sql.end();
  }
}
