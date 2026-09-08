import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { generateMarkdownReport, mapArtifactsToReportData } from "@/lib/export/report-generator";

export interface ResearchArtifactReadModel {
  id: string;
  type: string;
  artifact_type: string;
  scope: string;
  scope_key: string;
  artifact_version: number;
  status: string;
  content: Record<string, unknown>;
  content_json: Record<string, unknown>;
  schema_version: string;
  validator_version: string;
  prompt_version: string;
  validation_result: Record<string, unknown>;
  validation_result_json: Record<string, unknown>;
  created_by: string;
  supersedes_artifact_id: string | null;
  accepted_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export type ResearchReportTab =
  | "general"
  | "financials"
  | "valuation"
  | "thesis"
  | "evidence"
  | "backtests"
  | "updates";

export type ResearchReportSectionStatus = "complete" | "incomplete" | "skipped";

export interface ResearchReportSectionManifestEntry {
  number: number;
  key: string;
  heading: string;
  tab: ResearchReportTab;
  route: string;
  anchor: string;
  artifact_types: string[];
  missing_artifact_types: string[];
  missing_data: string[];
  status: ResearchReportSectionStatus;
}

export interface ResearchReportSectionManifestTab {
  key: ResearchReportTab;
  label: string;
  route: string;
  section_numbers: number[];
}

export interface ResearchReportSectionManifest {
  taxonomy_version: "research-adapted-v1";
  tabs: ResearchReportSectionManifestTab[];
  sections: ResearchReportSectionManifestEntry[];
}

/**
 * A normalized provenance row shared by evidence, analytical artifacts, and
 * live report data. Nulls are intentional: older records often have a claim
 * without a source location, or a metric with no direct citation.
 */
export interface ResearchReportProvenanceRecord {
  entity_type: "evidence" | "artifact" | "metric" | "valuation" | "scenario";
  entity_id: string | null;
  claim_id: string | null;
  claim_text: string | null;
  support_type: string | null;
  source_document_id: string | null;
  source_title: string | null;
  source_url: string | null;
  quote: string | null;
  locator: Record<string, unknown>;
  page_start: number | null;
  page_end: number | null;
  char_start: number | null;
  char_end: number | null;
  table_row: number | null;
  table_column: number | null;
  as_of: string | Date | null;
  artifact_id: string | null;
  artifact_type: string | null;
  artifact_version: number | null;
  artifact_status: string | null;
  metric_id: string | null;
  metric_key: string | null;
  metric_name: string | null;
  valuation_signal_id: string | null;
  signal_key: string | null;
  signal_name: string | null;
  scenario_id: string | null;
  scenario_name: string | null;
}

export interface ResearchReportProvenance {
  evidence: ResearchReportProvenanceRecord[];
  artifacts: ResearchReportProvenanceRecord[];
  metrics: ResearchReportProvenanceRecord[];
  valuation: ResearchReportProvenanceRecord[];
  scenarios: ResearchReportProvenanceRecord[];
}

function objectValue(value: unknown): Record<string, unknown> {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      return current as Record<string, unknown>;
    }
    if (typeof current !== "string") return {};
    try {
      current = JSON.parse(current);
    } catch {
      return {};
    }
  }
  return {};
}

type SectionDefinition = Omit<ResearchReportSectionManifestEntry, "missing_artifact_types" | "missing_data" | "status" | "route" | "anchor"> & {
  stage_key?: string;
  data_keys?: string[];
};

const REPORT_SECTION_DEFINITIONS: SectionDefinition[] = [
  { number: 1, key: "executive_conclusion", heading: "Executive conclusion", tab: "general", artifact_types: ["investment_thesis", "decision_record"] },
  { number: 2, key: "company_genesis", heading: "Company genesis and strategic identity", tab: "general", artifact_types: ["company_genesis", "founder_profile", "strategic_history_timeline", "strategic_dna"] },
  { number: 3, key: "asset_definition", heading: "Asset definition", tab: "general", artifact_types: [] },
  { number: 4, key: "evidence_and_source_role_map", heading: "Evidence and source-role map", tab: "evidence", artifact_types: [], data_keys: ["evidence_claims", "source_documents"] },
  { number: 5, key: "historical_record", heading: "Twenty-quarter historical record", tab: "financials", artifact_types: ["historical_record", "twenty_quarter_history"] },
  { number: 6, key: "historical_diagnosis", heading: "Historical diagnosis", tab: "financials", artifact_types: ["historical_diagnosis"] },
  { number: 7, key: "segment_and_value_chain_map", heading: "Segment and value-chain map", tab: "general", artifact_types: ["segment_model"] },
  { number: 8, key: "customer_decision_processes", heading: "Customer decision processes", tab: "general", artifact_types: ["customer_decision_map"] },
  { number: 9, key: "operational_process_and_bottlenecks", heading: "Operational process and bottlenecks", tab: "general", artifact_types: ["business_process_map", "bottleneck_register"] },
  { number: 10, key: "competitive_response", heading: "Competitive response", tab: "general", artifact_types: ["competitive_response_matrix"] },
  { number: 11, key: "moat_proof_attacks_and_counterfactual", heading: "Moat proof, attacks, and no-moat counterfactual", tab: "general", artifact_types: ["moat_assessment", "moat_attack_matrix", "no_moat_counterfactual"] },
  { number: 12, key: "driver_tree_and_operating_model", heading: "Driver tree and operating model", tab: "financials", artifact_types: ["driver_tree", "operating_model"] },
  { number: 13, key: "top_down_bottom_up_reconciliation", heading: "Top-down/bottom-up reconciliation", tab: "financials", artifact_types: ["top_down_bottom_up_reconciliation"] },
  { number: 14, key: "reinvestment_economics", heading: "Reinvestment economics", tab: "financials", artifact_types: ["reinvestment_model"] },
  { number: 15, key: "operating_scenarios", heading: "Operating scenarios", tab: "financials", artifact_types: ["operating_scenario_set"] },
  { number: 16, key: "valuation_scenario_matrix", heading: "Valuation scenario matrix", tab: "valuation", artifact_types: ["valuation_scenario_set", "valuation_method_run"] },
  { number: 17, key: "annual_price_target_table", heading: "Annual bear/base/bull price-target table", tab: "valuation", artifact_types: ["annual_price_target_path"] },
  { number: 18, key: "reverse_valuation", heading: "Reverse valuation", tab: "valuation", artifact_types: ["reverse_valuation"] },
  { number: 19, key: "expected_return_matrix", heading: "Expected-return matrix", tab: "valuation", artifact_types: ["expected_return_matrix"] },
  { number: 20, key: "risks_and_catalysts", heading: "Risks and catalysts", tab: "thesis", artifact_types: ["risk_register", "catalyst_register"] },
  { number: 21, key: "thesis_breakers", heading: "Thesis breakers", tab: "thesis", artifact_types: ["thesis_breakers"] },
  { number: 22, key: "monitoring_dashboard", heading: "Monitoring dashboard", tab: "updates", artifact_types: ["monitoring_dashboard", "refresh_schedule"] },
  { number: 23, key: "backtesting_evidence_and_confidence", heading: "Backtesting evidence and confidence assessment", tab: "backtests", artifact_types: ["backtest_review"], stage_key: "backtest_review" },
  { number: 24, key: "human_decision", heading: "Human decision", tab: "thesis", artifact_types: ["decision_record"] },
  { number: 25, key: "limitations_and_open_research", heading: "Limitations and open research", tab: "updates", artifact_types: [] },
];

const REPORT_TABS: ResearchReportSectionManifestTab[] = [
  { key: "general", label: "General", route: "research/general", section_numbers: [1, 2, 3, 7, 8, 9, 10, 11] },
  { key: "financials", label: "Financials & KPIs", route: "research/financials", section_numbers: [5, 6, 12, 13, 14, 15] },
  { key: "valuation", label: "Valuation", route: "research/valuation", section_numbers: [16, 17, 18, 19] },
  { key: "thesis", label: "Thesis & Risks", route: "research/thesis", section_numbers: [20, 21, 24] },
  { key: "evidence", label: "Evidence", route: "research/evidence", section_numbers: [4] },
  { key: "backtests", label: "Backtests", route: "research/backtests", section_numbers: [23] },
  { key: "updates", label: "Updates", route: "research/updates", section_numbers: [22, 25] },
];

function artifactTypePresent(byType: Record<string, unknown>, type: string): boolean {
  const value = byType[type];
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

/** Build the stable 25-section manifest without querying or mutating storage. */
export function buildResearchSectionManifest(params: {
  artifactsByType: Record<string, unknown>;
  evidenceCount?: number;
  sourceCount?: number;
  stageStatus?: ReadonlyMap<string, string>;
}): ResearchReportSectionManifest {
  const sections = REPORT_SECTION_DEFINITIONS.map((definition) => {
    const missingArtifactTypes = definition.artifact_types.filter(
      (type) => !artifactTypePresent(params.artifactsByType, type)
    );
    const missingData = (definition.data_keys || []).filter((key) => {
      if (key === "evidence_claims") return !(params.evidenceCount || 0);
      if (key === "source_documents") return !(params.sourceCount || 0);
      return true;
    });
    const stageSkipped = definition.stage_key && params.stageStatus?.get(definition.stage_key) === "skipped";
    const hasRequiredArtifact = definition.artifact_types.length === 0
      ? missingData.length === 0
      : definition.artifact_types.some((type) => artifactTypePresent(params.artifactsByType, type));
    const status: ResearchReportSectionStatus = stageSkipped
      ? "skipped"
      : hasRequiredArtifact && missingData.length === 0
        ? "complete"
        : "incomplete";

    return {
      number: definition.number,
      key: definition.key,
      heading: definition.heading,
      tab: definition.tab,
      route: `research/${definition.tab}`,
      anchor: `report-section-${definition.number}`,
      artifact_types: [...definition.artifact_types],
      missing_artifact_types: hasRequiredArtifact ? [] : missingArtifactTypes,
      missing_data: missingData,
      status,
    };
  });

  return {
    taxonomy_version: "research-adapted-v1",
    tabs: REPORT_TABS.map((tab) => ({ ...tab, section_numbers: [...tab.section_numbers] })),
    sections,
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Normalize joined SQL rows while retaining nulls for missing provenance. */
export function normalizeResearchProvenanceRow(
  row: Record<string, unknown>,
  entityType: ResearchReportProvenanceRecord["entity_type"]
): ResearchReportProvenanceRecord {
  const entityIdByType = {
    evidence: row.claim_id,
    artifact: row.artifact_id,
    metric: row.metric_id,
    valuation: row.valuation_signal_id,
    scenario: row.scenario_id,
  } satisfies Record<ResearchReportProvenanceRecord["entity_type"], unknown>;
  return {
    entity_type: entityType,
    entity_id: nullableString(row.entity_id || entityIdByType[entityType]),
    claim_id: nullableString(row.claim_id),
    claim_text: nullableString(row.claim_text),
    support_type: nullableString(row.support_type),
    source_document_id: nullableString(row.source_document_id),
    source_title: nullableString(row.source_title),
    source_url: nullableString(row.source_canonical_url || row.source_url),
    quote: nullableString(row.quoted_text || row.quote),
    locator: objectValue(row.locator_json || row.locator),
    page_start: nullableNumber(row.page_start),
    page_end: nullableNumber(row.page_end),
    char_start: nullableNumber(row.char_start),
    char_end: nullableNumber(row.char_end),
    table_row: nullableNumber(row.table_row),
    table_column: nullableNumber(row.table_column),
    as_of: (row.as_of || row.as_of_date || null) as string | Date | null,
    artifact_id: nullableString(row.artifact_id),
    artifact_type: nullableString(row.artifact_type),
    artifact_version: nullableNumber(row.artifact_version),
    artifact_status: nullableString(row.artifact_status || row.status),
    metric_id: nullableString(row.metric_id),
    metric_key: nullableString(row.metric_key),
    metric_name: nullableString(row.metric_name),
    valuation_signal_id: nullableString(row.valuation_signal_id),
    signal_key: nullableString(row.signal_key),
    signal_name: nullableString(row.signal_name),
    scenario_id: nullableString(row.scenario_id),
    scenario_name: nullableString(row.scenario_name),
  };
}

function normalizeResearchProvenanceRows(
  rows: readonly Record<string, unknown>[],
  entityType: ResearchReportProvenanceRecord["entity_type"]
): ResearchReportProvenanceRecord[] {
  return rows.map((row) => normalizeResearchProvenanceRow(row, entityType));
}

function normalizeArtifact(row: Record<string, unknown>): ResearchArtifactReadModel {
  const content = objectValue(row.content_json);
  const validation = objectValue(row.validation_result_json);
  return {
    id: String(row.id),
    type: String(row.artifact_type),
    artifact_type: String(row.artifact_type),
    scope: String(row.scope_key),
    scope_key: String(row.scope_key),
    artifact_version: Number(row.artifact_version || 1),
    status: String(row.status),
    content,
    content_json: content,
    schema_version: String(row.schema_version || "unknown"),
    validator_version: String(row.validator_version || "unknown"),
    prompt_version: String(row.prompt_version || "unknown"),
    validation_result: validation,
    validation_result_json: validation,
    created_by: String(row.created_by || "unknown"),
    supersedes_artifact_id: row.supersedes_artifact_id ? String(row.supersedes_artifact_id) : null,
    accepted_at: (row.accepted_at as string | Date | null) || null,
    created_at: row.created_at as string | Date,
    updated_at: row.updated_at as string | Date,
  };
}

async function loadRun(sql: ReturnType<typeof postgres>, runId: string) {
  const rows = await sql`
    SELECT rr.*, a.canonical_name AS asset_name, a.slug AS asset_slug, a.asset_kind,
           a.sector, a.industry, a.base_currency, a.home_country
    FROM research_runs rr
    JOIN assets a ON a.id = rr.asset_id
    WHERE rr.id = ${runId}
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function getResearchRunArtifacts(runId: string, artifactType?: string) {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    const run = await loadRun(sql, runId);
    if (!run) return null;
    const rows = artifactType
      ? await sql`
          SELECT DISTINCT ON (artifact_type, scope_key) *
          FROM research_artifacts
          WHERE research_run_id = ${runId}
            AND artifact_type = ${artifactType}
            AND status <> 'superseded'
          ORDER BY artifact_type, scope_key, artifact_version DESC, created_at DESC
        `
      : await sql`
          SELECT DISTINCT ON (artifact_type, scope_key) *
          FROM research_artifacts
          WHERE research_run_id = ${runId}
            AND status <> 'superseded'
          ORDER BY artifact_type, scope_key, artifact_version DESC, created_at DESC
        `;
    return rows.map((row) => normalizeArtifact(row as Record<string, unknown>));
  } finally {
    await sql.end();
  }
}

export async function getResearchRunReport(
  runId: string,
  options: { includeProvenance?: boolean } = {},
) {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    const run = await loadRun(sql, runId);
    if (!run) return null;
    const includeProvenance = options.includeProvenance !== false;
    const [artifactRows, evidence, metrics, valuationSignals, scenarios, backtests, sources, roleCoverage, modelCalls, exports, reviews, theses, risks, catalysts, stageRows, evidenceProvenance, artifactProvenance, metricProvenance, valuationProvenance, scenarioProvenance] = await Promise.all([
      sql`
        SELECT DISTINCT ON (artifact_type, scope_key) *
        FROM research_artifacts
        WHERE research_run_id = ${runId} AND status <> 'superseded'
        ORDER BY artifact_type, scope_key, artifact_version DESC, created_at DESC
      `,
      sql`SELECT * FROM evidence_claims WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
      sql`SELECT mo.*, md.metric_key, md.display_name AS metric_display_name,
                 COUNT(*) OVER (PARTITION BY md.metric_key) AS metric_observation_count
          FROM metric_observations mo
          JOIN metric_definitions md ON md.id = mo.metric_definition_id
          WHERE mo.research_run_id = ${runId}
          ORDER BY metric_observation_count DESC, mo.period_end DESC NULLS LAST, mo.created_at DESC`,
      sql`SELECT * FROM valuation_signals WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
      sql`SELECT * FROM scenarios WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
      sql`SELECT * FROM backtest_runs WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
      sql`SELECT DISTINCT sd.*
          FROM source_documents sd
          LEFT JOIN research_run_sources rrs ON rrs.source_document_id = sd.id
          WHERE sd.research_run_id = ${runId} OR rrs.research_run_id = ${runId}
          ORDER BY sd.created_at DESC`,
      sql`SELECT * FROM source_role_coverage WHERE research_run_id = ${runId} ORDER BY source_role, artifact_type`,
      sql`SELECT * FROM model_call_logs WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
      sql`SELECT * FROM exports WHERE research_run_id = ${runId} ORDER BY generated_at DESC`,
      sql`SELECT * FROM review_decisions WHERE research_run_id = ${runId} ORDER BY reviewed_at DESC`,
      sql`SELECT * FROM theses WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
      sql`SELECT * FROM risks WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
      sql`SELECT * FROM catalysts WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
      sql`SELECT stage_key, status FROM research_stages WHERE research_run_id = ${runId}`,
      includeProvenance ? sql`
        SELECT ec.id AS claim_id, ec.claim_text, ec.as_of_date AS as_of,
               el.support_type, el.quoted_text,
               sd.id AS source_document_id, sd.title AS source_title,
               sd.url AS source_url, sd.canonical_url AS source_canonical_url,
               sl.page_start, sl.page_end, sl.char_start, sl.char_end,
               sl.table_row, sl.table_column, sl.locator_json
        FROM evidence_claims ec
        LEFT JOIN evidence_links el ON el.evidence_claim_id = ec.id
        LEFT JOIN source_locations sl ON sl.id = el.source_location_id
        LEFT JOIN source_documents sd ON sd.id = sl.source_document_id
        WHERE ec.research_run_id = ${runId}
        ORDER BY ec.created_at DESC, el.created_at DESC
      ` : Promise.resolve([]),
      includeProvenance ? sql`
        SELECT ra.id AS artifact_id, ra.artifact_type, ra.artifact_version,
               ra.status AS artifact_status, ral.support_type,
               ec.id AS claim_id, ec.claim_text, ec.as_of_date AS as_of,
               el.quoted_text,
               sd.id AS source_document_id, sd.title AS source_title,
               sd.url AS source_url, sd.canonical_url AS source_canonical_url,
               sl.page_start, sl.page_end, sl.char_start, sl.char_end,
               sl.table_row, sl.table_column, sl.locator_json
        FROM research_artifacts ra
        JOIN research_artifact_claim_links ral ON ral.artifact_id = ra.id
        JOIN evidence_claims ec
          ON ec.id = ral.evidence_claim_id AND ec.research_run_id = ${runId}
        LEFT JOIN evidence_links el ON el.evidence_claim_id = ec.id
        LEFT JOIN source_locations sl ON sl.id = el.source_location_id
        LEFT JOIN source_documents sd ON sd.id = sl.source_document_id
        WHERE ra.research_run_id = ${runId} AND ra.status <> 'superseded'
        ORDER BY ra.artifact_type, ra.artifact_version DESC, ec.created_at DESC
      ` : Promise.resolve([]),
      includeProvenance ? sql`
        SELECT mo.id AS metric_id, md.metric_key, md.display_name AS metric_name,
               mo.as_of_date AS as_of, mo.evidence_claim_id AS claim_id,
               ec.claim_text, el.support_type, el.quoted_text,
               mo.source_document_id, sd.title AS source_title,
               sd.url AS source_url, sd.canonical_url AS source_canonical_url,
               sl.page_start, sl.page_end, sl.char_start, sl.char_end,
               sl.table_row, sl.table_column, sl.locator_json
        FROM metric_observations mo
        LEFT JOIN metric_definitions md ON md.id = mo.metric_definition_id
        LEFT JOIN source_documents sd ON sd.id = mo.source_document_id
        LEFT JOIN evidence_claims ec
          ON ec.id = mo.evidence_claim_id AND ec.research_run_id = ${runId}
        LEFT JOIN evidence_links el ON el.evidence_claim_id = ec.id
        LEFT JOIN source_locations sl ON sl.id = el.source_location_id
        WHERE mo.research_run_id = ${runId}
        ORDER BY mo.period_end DESC NULLS LAST, mo.created_at DESC
      ` : Promise.resolve([]),
      includeProvenance ? sql`
        SELECT vs.id AS valuation_signal_id, vs.signal_key, vs.signal_name,
               ec.as_of_date AS as_of,
               vs.evidence_claim_id AS claim_id,
               ec.claim_text, el.support_type, el.quoted_text,
               vs.source_document_id, sd.title AS source_title,
               sd.url AS source_url, sd.canonical_url AS source_canonical_url,
               sl.page_start, sl.page_end, sl.char_start, sl.char_end,
               sl.table_row, sl.table_column, sl.locator_json
        FROM valuation_signals vs
        LEFT JOIN source_documents sd ON sd.id = vs.source_document_id
        LEFT JOIN evidence_claims ec
          ON ec.id = vs.evidence_claim_id AND ec.research_run_id = ${runId}
        LEFT JOIN evidence_links el ON el.evidence_claim_id = ec.id
        LEFT JOIN source_locations sl ON sl.id = el.source_location_id
        WHERE vs.research_run_id = ${runId}
        ORDER BY vs.created_at DESC
      ` : Promise.resolve([]),
      includeProvenance ? sql`
        SELECT s.id AS scenario_id, s.scenario_name, s.created_at,
               ec.id AS claim_id, ec.claim_text, ec.as_of_date AS as_of,
               el.support_type, el.quoted_text,
               sd.id AS source_document_id, sd.title AS source_title,
               sd.url AS source_url, sd.canonical_url AS source_canonical_url,
               sl.page_start, sl.page_end, sl.char_start, sl.char_end,
               sl.table_row, sl.table_column, sl.locator_json
        FROM scenarios s
        LEFT JOIN LATERAL unnest(COALESCE(s.supporting_claim_ids, ARRAY[]::uuid[])) AS claim(id) ON TRUE
        LEFT JOIN evidence_claims ec
          ON ec.id = claim.id AND ec.research_run_id = ${runId}
        LEFT JOIN evidence_links el ON el.evidence_claim_id = ec.id
        LEFT JOIN source_locations sl ON sl.id = el.source_location_id
        LEFT JOIN source_documents sd ON sd.id = sl.source_document_id
        WHERE s.research_run_id = ${runId}
        ORDER BY s.created_at DESC, ec.created_at DESC
      ` : Promise.resolve([]),
    ]);
    const artifacts = artifactRows.map((row) => normalizeArtifact(row as Record<string, unknown>));
    const markdownExport = exports.find((item) => String(item.export_type) === "markdown_memo" && item.storage_path);
    const canonicalMarkdown = markdownExport ? await readCanonicalMarkdown(String(markdownExport.storage_path)) : null;
    const previewArtifacts = artifacts.filter((artifact) => artifact.status === "accepted" || artifact.status === "validated");
    const liveMarkdown = !canonicalMarkdown && previewArtifacts.length > 0 ? generateMarkdownReport(mapArtifactsToReportData({
      runId,
      asset: {
        canonical_name: String(run.asset_name),
        slug: String(run.asset_slug),
        asset_kind: String(run.asset_kind),
      },
      artifacts: previewArtifacts.map((artifact) => ({
        artifact_type: artifact.type,
        content_json: artifact.content,
      })),
      isTestRun: process.env.RESEARCH_ACCEPTANCE_PROVIDER === "mock" || process.env.RESEARCH_TEST_MODE === "1",
    })) : null;
    const byType: Record<string, ResearchArtifactReadModel[]> = {};
    for (const artifact of artifacts) (byType[artifact.type] ||= []).push(artifact);

    const stageStatus = new Map(
      stageRows.map((stage) => [String(stage.stage_key), String(stage.status)])
    );
    const sectionManifest = buildResearchSectionManifest({
      artifactsByType: byType,
      evidenceCount: evidence.length,
      sourceCount: sources.length,
      stageStatus,
    });
    const requiredSections: Array<{
      type: string;
      label: string;
      stageKey?: string;
      artifactTypes?: readonly string[];
    }> = [
      { type: "company_genesis", label: "Company genesis" },
      { type: "historical_record", label: "Historical record" },
      { type: "business_process_map", label: "Business process" },
      { type: "moat_assessment", label: "Moat assessment" },
      { type: "driver_tree", label: "Driver tree" },
      { type: "operating_model", label: "Operating model" },
      { type: "operating_scenario_set", label: "Operating scenarios" },
      { type: "annual_price_target_path", label: "Annual price targets" },
      { type: "decision_record", label: "Decision" },
      { type: "backtest_review", label: "Backtest review", stageKey: "backtest_review" },
      {
        type: "ai_review",
        label: "AI review",
        stageKey: "ai_reviewer",
        artifactTypes: ["pass_fail", "review_summary", "findings", "quality_score", "recommendations"],
      },
      { type: "refresh_schedule", label: "Refresh schedule" },
    ];
    const missingSections = requiredSections
      .filter((section) => {
        if (section.stageKey && stageStatus.get(section.stageKey) === "skipped") return false;
        if (section.artifactTypes) {
          return section.artifactTypes.some((type) => !byType[type]?.length);
        }
        return !byType[section.type]?.length;
      })
      .map((section) => ({ type: section.type, label: section.label, status: "incomplete" }));

    return {
      run: run,
      asset: {
        id: run.asset_id,
        canonical_name: run.asset_name,
        slug: run.asset_slug,
        asset_kind: run.asset_kind,
        sector: run.sector,
        industry: run.industry,
        base_currency: run.base_currency,
        home_country: run.home_country,
      },
      artifacts,
      artifacts_by_type: byType,
      section_manifest: sectionManifest,
      missing_sections: missingSections,
      incomplete: missingSections.length > 0,
      canonical_markdown: canonicalMarkdown ?? liveMarkdown,
      canonical_markdown_source: canonicalMarkdown ? "export" : liveMarkdown ? "live_preview" : null,
      read_models: {
        evidence,
        metrics,
        valuation_signals: valuationSignals,
        scenarios,
        backtests,
        sources,
        source_role_coverage: roleCoverage,
        model_calls: modelCalls,
        exports,
        review_decisions: reviews,
        theses,
        risks,
        catalysts,
      },
      provenance: {
        evidence: normalizeResearchProvenanceRows(evidenceProvenance as Record<string, unknown>[], "evidence"),
        artifacts: normalizeResearchProvenanceRows(artifactProvenance as Record<string, unknown>[], "artifact"),
        metrics: normalizeResearchProvenanceRows(metricProvenance as Record<string, unknown>[], "metric"),
        valuation: normalizeResearchProvenanceRows(valuationProvenance as Record<string, unknown>[], "valuation"),
        scenarios: normalizeResearchProvenanceRows(scenarioProvenance as Record<string, unknown>[], "scenario"),
      } satisfies ResearchReportProvenance,
      export: artifacts.find((artifact) => artifact.type === "synthetic_report") || exports[0] || null,
      refresh_schedule: artifacts.find((artifact) => artifact.type === "refresh_schedule") || null,
    };
  } finally {
    await sql.end();
  }
}

async function readCanonicalMarkdown(storagePath: string): Promise<string | null> {
  const exportRoot = resolve(process.cwd(), "storage", "exports");
  const relativePath = storagePath.replace(/^storage[\\/]exports[\\/]/, "");
  const target = resolve(exportRoot, relativePath);
  if (!relativePath) return null;
  if (target !== exportRoot && !target.startsWith(`${exportRoot}${sep}`)) return null;
  try {
    return await readFile(target, "utf8");
  } catch {
    return null;
  }
}
