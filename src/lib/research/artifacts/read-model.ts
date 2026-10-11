import postgres from "postgres";

export interface ResearchArtifactReadModel {
  id: string;
  type: string;
  artifact_type: string;
  scope: string;
  scope_key: string;
  artifact_version: number;
  status: string;
  content_json: Record<string, unknown>;
  schema_version: string;
  validator_version: string;
  prompt_version: string;
  validation_result_json: Record<string, unknown>;
  created_by: string;
  supersedes_artifact_id: string | null;
  accepted_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
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

// Each body appears once in a response: JSON serialises a shared object every time it is referenced.
function normalizeArtifact(row: Record<string, unknown>): ResearchArtifactReadModel {
  return {
    id: String(row.id),
    type: String(row.artifact_type),
    artifact_type: String(row.artifact_type),
    scope: String(row.scope_key),
    scope_key: String(row.scope_key),
    artifact_version: Number(row.artifact_version || 1),
    status: String(row.status),
    content_json: objectValue(row.content_json),
    schema_version: String(row.schema_version || "unknown"),
    validator_version: String(row.validator_version || "unknown"),
    prompt_version: String(row.prompt_version || "unknown"),
    validation_result_json: objectValue(row.validation_result_json),
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

export async function getResearchRunReport(runId: string) {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    const run = await loadRun(sql, runId);
    if (!run) return null;
    const [artifactRows, evidence, metrics, valuationSignals, scenarios, backtests, sources, roleCoverage, modelCalls, exports, reviews, theses, risks, catalysts, stageRows] = await Promise.all([
      sql`
        SELECT DISTINCT ON (artifact_type, scope_key) *
        FROM research_artifacts
        WHERE research_run_id = ${runId} AND status <> 'superseded'
        ORDER BY artifact_type, scope_key, artifact_version DESC, created_at DESC
      `,
      sql`SELECT * FROM evidence_claims WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
      sql`SELECT * FROM metric_observations WHERE research_run_id = ${runId} ORDER BY period_end DESC NULLS LAST, created_at DESC`,
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
    ]);
    const artifacts = artifactRows.map((row) => normalizeArtifact(row as Record<string, unknown>));
    const byType: Record<string, ResearchArtifactReadModel[]> = {};
    for (const artifact of artifacts) (byType[artifact.type] ||= []).push(artifact);

    const stageStatus = new Map(
      stageRows.map((stage) => [String(stage.stage_key), String(stage.status)])
    );
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
        artifactTypes: ["review_summary", "findings", "quality_score", "recommendations", "review_verdict"],
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
      // The report document's body is sent once, as report_document, not again in its artifact row.
      artifacts: artifacts.map((artifact) => artifact.type === "report_document" ? { ...artifact, content_json: {} } : artifact),
      report_document: byType.report_document?.[0]?.content_json || null,
      missing_sections: missingSections,
      incomplete: missingSections.length > 0,
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
      export: artifacts.find((artifact) => artifact.type === "synthetic_report") || exports[0] || null,
      refresh_schedule: artifacts.find((artifact) => artifact.type === "refresh_schedule") || null,
    };
  } finally {
    await sql.end();
  }
}
