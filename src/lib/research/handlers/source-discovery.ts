import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { fetchProfileResearchContext, storeSourceCorpus, reconcileSourceGaps } from "../system-pipeline";
import { buildSourcePlan, planMissingRoles } from "../sources/planner";
import { SOURCE_ROLES, type SourceRole } from "../sources/roles";
import postgres from "postgres";
import { CURRENT_PIPELINE_VERSION } from "../version";

function mapToSourceRole(
  sourceType: string,
  title: string,
  metadata?: Record<string, unknown>
): SourceRole {
  const explicitRole = String(metadata?.source_role || "");
  if (SOURCE_ROLES.includes(explicitRole as SourceRole)) return explicitRole as SourceRole;
  const normType = sourceType.toLowerCase();
  const normTitle = title.toLowerCase();

  if (normType.includes("filing") || normType.includes("primary_document") || normType.includes("sec")) {
    return "regulatory_filing";
  }
  if (normType.includes("investor") || normType.includes("ir_presentation") || normType.includes("ir")) {
    return "company_investor_relations";
  }
  if (normType.includes("release") || normTitle.includes("earnings release")) {
    return "earnings_release";
  }
  if (normType.includes("presentation") || normTitle.includes("presentation")) {
    return "earnings_presentation";
  }
  if (normType.includes("transcript") || normTitle.includes("transcript")) {
    return "earnings_transcript";
  }
  if (normType.includes("proxy") || normTitle.includes("proxy")) {
    return "proxy_and_governance";
  }
  if (normType.includes("founder") || normType.includes("history") || normTitle.includes("history") || normTitle.includes("founder")) {
    return "founder_and_company_history";
  }
  if (normType.includes("peer") || normTitle.includes("peer")) {
    return "peer_company_primary";
  }
  if (normType.includes("industry") || normTitle.includes("industry")) {
    return "industry_primary";
  }
  if (normType.includes("customer") || normTitle.includes("customer")) {
    return "customer_or_channel";
  }
  if (normType.includes("supplier") || normTitle.includes("supplier")) {
    return "supplier_or_partner";
  }
  if (normType.includes("regulatory") || normTitle.includes("fdic") || normTitle.includes("federal")) {
    return "regulatory_or_government";
  }
  if (normType.includes("macro") || normTitle.includes("macro")) {
    return "macro_dataset";
  }
  if (normType.includes("market") || normTitle.includes("market data") || normTitle.includes("yahoo")) {
    return "market_data";
  }
  return "regulatory_filing"; // Default fallback
}

export const sourceDiscoveryHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "source_discovery",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      // 1. Map ctx to V2-style RunContext
      const v2Ctx = {
        runId: ctx.runId,
        runType: ctx.runType,
        assetId: ctx.assetId,
        assetName: ctx.assetName,
        assetSlug: ctx.assetSlug,
        symbol: ctx.symbol,
        profileId: ctx.profileId || "",
        profileKey: ctx.profileKey || "",
        requiredModules: ctx.composedProfile?.required_artifacts.map((a: any) => a.artifact_type) || [],
        requiredLenses: ctx.composedProfile?.valuation_methods.map((m: any) => m.method) || [],
        marketDataCutoffAt: ctx.marketDataCutoffAt ? ctx.marketDataCutoffAt.toISOString() : null,
        pipelineVersion: CURRENT_PIPELINE_VERSION,
      };

      // 2. Fetch public/SEC context
      const secContext = await fetchProfileResearchContext(v2Ctx);

      // 3. Store source corpus in database (creates source_documents, parses, chunks, etc.)
      const sourceCorpus = await storeSourceCorpus(sql, v2Ctx, secContext);

      // 4. Create source plan
      const requiredArtifacts = ctx.composedProfile?.required_artifacts || [];
      const sourcePlan = buildSourcePlan(ctx.runId, ctx.assetId, requiredArtifacts as any);

      // 5. Create assignments and insert into source_role_assignments
      const coveredRoles = new Set<SourceRole>();
      for (const source of sourceCorpus.sources) {
        if (source.sourceId.startsWith("candidate-")) continue;
        const role = mapToSourceRole(source.sourceType, source.title || "", source.metadata);
        coveredRoles.add(role);

        await sql`
          INSERT INTO source_retrieval_attempts (
            research_run_id, source_role, source_url, source_title,
            attempt_status, attempt_metadata_json
          )
          SELECT
            ${ctx.runId}, ${role}, ${source.url || null},
            ${source.title || null}, 'fetched',
            ${sql.json({
              source_document_id: source.sourceId,
              fetch_status: String(source.metadata?.fetch_status || "fetched"),
              substantive: true,
            })}
          WHERE NOT EXISTS (
            SELECT 1 FROM source_retrieval_attempts
            WHERE research_run_id = ${ctx.runId}
              AND source_role = ${role}
              AND attempt_status = 'fetched'
              AND source_title = ${source.title || null}
          )
        `;

        await sql`
          INSERT INTO source_role_assignments (
            source_document_id, role, confidence, rationale, assigned_by, assigned_at
          ) VALUES (
            ${source.sourceId}, ${role}, 100, 'Mapped from document metadata', 'system-discovery', NOW()
          )
          ON CONFLICT (source_document_id, role) DO UPDATE
          SET confidence = 100
        `;

        // Populate source_role_coverage
        for (const art of requiredArtifacts) {
          await sql`
            INSERT INTO source_role_coverage (
              research_run_id, source_role, artifact_type, source_document_id,
              coverage_status, confidence, rationale, blocked_artifact_types
            ) VALUES (
              ${ctx.runId}, ${role}, ${art.artifact_type}, ${source.sourceId},
              'covered', 100, 'Substantive source document assigned to role', ${sql.json([])}
            )
            ON CONFLICT (research_run_id, source_role, artifact_type) DO UPDATE
            SET coverage_status = 'covered',
                source_document_id = ${source.sourceId},
                confidence = 100,
                rationale = 'Substantive source document assigned to role',
                updated_at = NOW()
          `;
        }
      }

      // 6. Enforce source gaps
      const missingRoles = planMissingRoles(sourcePlan, Array.from(coveredRoles));
      const gaps = missingRoles.map((role: any) => ({
        gapKey: `missing_${role}`,
        description: `Required source role '${role}' is not covered by any fetched documents`,
        severity: "high",
      }));
      for (const role of missingRoles) {
        const planItem = sourcePlan.items.find((item) => item.source_role === role);
        await sql`
          INSERT INTO source_retrieval_attempts (
            research_run_id, source_role, attempt_status,
            failure_reason, attempt_metadata_json
          )
          SELECT
            ${ctx.runId}, ${role}, 'unavailable', 'no_substantive_source_fetched',
            ${sql.json({
              generated_queries: planItem?.search_keywords || [],
              artifact_types: planItem?.artifact_types || [],
            })}
          WHERE NOT EXISTS (
            SELECT 1 FROM source_retrieval_attempts
            WHERE research_run_id = ${ctx.runId}
              AND source_role = ${role}
              AND attempt_status = 'unavailable'
              AND failure_reason = 'no_substantive_source_fetched'
          )
        `;
      }

      await reconcileSourceGaps(sql, v2Ctx, { source_gaps: gaps }, "system:source-reader");

      return {
        status: "success",
        sourcesFetched: sourceCorpus.sources.length,
        coveredRoles: Array.from(coveredRoles),
        gaps: gaps.map((g: any) => g.gapKey),
      };
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: ResearchRunContext, output: any): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const rows = await sql`
        SELECT COUNT(DISTINCT sd.id) as cnt
        FROM source_documents sd
        LEFT JOIN research_run_sources rrs ON rrs.source_document_id = sd.id
        WHERE sd.research_run_id = ${ctx.runId} OR rrs.research_run_id = ${ctx.runId}
      `;
      const errors: string[] = [];
      if (Number(rows[0].cnt) === 0) {
        errors.push("No source documents ingested for this run");
      }
      return makeValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
