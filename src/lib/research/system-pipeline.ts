import postgres from "postgres";
import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runResearchAgent } from "@/lib/opencode/runtime";
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

function textValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
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

async function getRunContext(sql: Sql, runId: string): Promise<RunContext> {
  const rows = await sql`
    SELECT
      rr.id as run_id,
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

async function fetchSecContext(ctx: RunContext) {
  const cik = await resolveSecCik(ctx.symbol);
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
  const cutoffDate = ctx.marketDataCutoffAt?.slice(0, 10) || "9999-12-31";
  const beforeCutoff = (value: unknown) => !value || String(value).slice(0, 10) <= cutoffDate;
  const factBeforeCutoff = (fact: Record<string, unknown>) =>
    beforeCutoff(fact.filed) && beforeCutoff(fact.end);
  const usGaap = companyFacts.facts?.["us-gaap"] || {};
  const revenue = (usGaap.Revenues?.units?.USD || []).filter(factBeforeCutoff).slice(-8);
  const netIncome = (usGaap.NetIncomeLoss?.units?.USD || []).filter(factBeforeCutoff).slice(-8);
  const operatingCashFlow = (usGaap.NetCashProvidedByUsedInOperatingActivities?.units?.USD || [])
    .filter(factBeforeCutoff)
    .slice(-8);
  const recentFilings = (submissions.filings?.recent?.form || [])
    .map((form: string, index: number) => ({
      form,
      filingDate: submissions.filings.recent.filingDate?.[index],
      accessionNumber: submissions.filings.recent.accessionNumber?.[index],
      reportDate: submissions.filings.recent.reportDate?.[index],
    }))
    .filter((filing: { form: string; filingDate?: string }) =>
      ["10-K", "10-Q", "8-K"].includes(filing.form) && beforeCutoff(filing.filingDate)
    )
    .slice(0, 12);

  return {
    cik,
    source: "SEC companyfacts and submissions APIs",
    entityName: companyFacts.entityName,
    revenue,
    netIncome,
    operatingCashFlow,
    recentFilings,
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

async function storeSourceContext(sql: Sql, ctx: RunContext, secContext: unknown) {
  const content = JSON.stringify(secContext, null, 2);
  const hash = createHash("sha256").update(content).digest("hex");
  const storageDir = join(process.cwd(), "storage", "sources");
  await mkdir(storageDir, { recursive: true });
  const storagePath = `storage/sources/${hash}.json`;
  await writeFile(join(process.cwd(), storagePath), content, "utf8");

  const rows = await sql`
    INSERT INTO source_documents (
      asset_id, research_run_id, source_type, title, publisher, url,
      file_hash, mime_type, language, storage_path, source_quality_score,
      metadata_json
    ) VALUES (
      ${ctx.assetId}, ${ctx.runId}, 'sec_api', ${`${ctx.assetName} SEC companyfacts context`},
      'SEC', 'https://data.sec.gov/', ${hash}, 'application/json', 'en',
      ${storagePath}, '0.95', ${JSON.stringify({ system_generated: true, source: "sec_api" })}::jsonb
    )
    ON CONFLICT (file_hash) DO UPDATE
    SET research_run_id = EXCLUDED.research_run_id
    RETURNING id
  `;
  const sourceId = rows[0].id as string;

  const parseRows = await sql`
    INSERT INTO document_parses (
      source_document_id, parser_name, parser_version,
      status, warnings_json, output_storage_path, completed_at
    ) VALUES (
      ${sourceId}, 'system-sec-json', '1', 'completed',
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
      ${sourceId}, ${parseId}, 0, 'SEC API context',
      0, ${content.length}, ${content}, ${Math.ceil(content.length / 4)},
      ${JSON.stringify({ system_generated: true })}::jsonb
    )
    RETURNING id
  `;

  return { sourceId, parseId, chunkId: chunkRows[0].id as string, content };
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
  try {
    const result = await runResearchAgent<T>({
      agentName: params.agentName,
      title: `${params.agentName} ${params.ctx.symbol} ${params.ctx.runId}`,
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
    "If evidence is insufficient, return empty arrays for the relevant fields and explain gaps in source_gaps or unresolved fields.",
    ...(params.extraRules || []),
    "",
    "Task packet:",
    JSON.stringify(params.packet, null, 2),
  ].join("\n");
}

async function persistEvidence(sql: Sql, ctx: RunContext, source: { sourceId: string; parseId: string; chunkId: string }, output: Record<string, unknown>) {
  const claims = arrayValue(output.evidence_claims).slice(0, 12);
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
        ${textValue(claim.as_of_date || claim.period_end, "2025-12-31")},
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

async function persistMetrics(sql: Sql, ctx: RunContext, sourceId: string, output: Record<string, unknown>) {
  const observations = arrayValue(output.normalized_observations).slice(0, 12);
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
        ${textValue(obs.period_start, "2025-09-30")},
        ${textValue(obs.period_end || obs.as_of_date, "2025-09-30")},
        ${textValue(obs.as_of_date || obs.period_end, "2025-09-30")},
        ${textValue(obs.available_at, "2025-12-31 00:00:00+00")},
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

export async function runSystemResearchPipeline(runId: string): Promise<SystemPipelineResult> {
  const sql = postgres(process.env.DATABASE_URL!);
  const notes: string[] = [];

  try {
    const ctx = await getRunContext(sql, runId);
    const statusRows = await sql`SELECT status FROM research_runs WHERE id = ${runId}`;
    if (statusRows[0].status === "pending") {
      await startRun(runId);
    }

    const secContext = await fetchSecContext(ctx);
    const source = await storeSourceContext(sql, ctx, secContext);
    notes.push("Fetched and stored SEC source context");

    const planStatus = await ensureStageReady(sql, runId, "research_plan");
    if (planStatus === "waiting_for_human") {
      await approveResearchPlan(runId, "system-research-pipeline");
      notes.push("Approved generated research plan gate");
    }

    await ensureStageReady(sql, runId, "evidence_extraction");
    let evidenceOutput = await latestTaskOutput(sql, runId, "source-reader:sec-context");
    if (!evidenceOutput || await getStageStatus(sql, runId, "evidence_extraction") !== "completed") {
      evidenceOutput = await callAgent<Record<string, unknown>>({
      sql,
      ctx,
      stageKey: "evidence_extraction",
      taskKey: "source-reader:sec-context",
      taskType: "evidence_extraction",
      agentName: "source-reader",
      modelTier: "cheap",
      packet: { asset: ctx, source_context: secContext, source_chunk: source.content },
      prompt: exactJsonPrompt({
        agentName: "source-reader",
        requiredKeys: ["evidence_claims", "contradictions", "source_gaps", "low_confidence_items", "rejected_candidates"],
        packet: { asset: ctx, source_context: secContext, source_chunk: source.content },
        extraRules: [
          "Each evidence_claim must include claim_text, claim_type, claim_category, as_of_date or period_end when available, confidence.",
          "Use only the SEC source_context and source_chunk in this packet.",
        ],
      }),
      });
      await persistEvidence(sql, ctx, source, evidenceOutput);
      notes.push("Source-reader produced evidence claims");
    }

    await ensureStageReady(sql, runId, "metric_normalization");
    let metricOutput = await latestTaskOutput(sql, runId, "metric-normalizer:sec-context");
    if (!metricOutput || await getStageStatus(sql, runId, "metric_normalization") !== "completed") {
      metricOutput = await callAgent<Record<string, unknown>>({
      sql,
      ctx,
      stageKey: "metric_normalization",
      taskKey: "metric-normalizer:sec-context",
      taskType: "metric_normalization",
      agentName: "metric-normalizer",
      modelTier: "cheap",
      packet: { asset: ctx, sec_context: secContext, evidence_claims: evidenceOutput.evidence_claims },
      prompt: exactJsonPrompt({
        agentName: "metric-normalizer",
        requiredKeys: ["normalized_observations", "definition_mappings", "conversion_notes", "unresolved_ambiguities", "quality_flags", "source_gaps"],
        packet: { asset: ctx, sec_context: secContext, evidence_claims: evidenceOutput.evidence_claims },
        extraRules: [
          "normalized_observations should include metric_key, display_name or metric_name, value_numeric where available, unit, currency, period_end, as_of_date, available_at, confidence.",
        ],
      }),
      });
      await persistMetrics(sql, ctx, source.sourceId, metricOutput);
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
    const result = await advanceStage(runId);
    if (!result.success) throw new Error(result.error || "Final stage advance failed");

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
  } finally {
    await sql.end();
  }
}
