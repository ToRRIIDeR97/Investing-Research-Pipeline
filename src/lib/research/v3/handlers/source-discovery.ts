import type { V3RunContext, V3StageHandler, ValidationResult } from "../../v3-context";
import { v3ValidationResult } from "../../v3-context";
import { fetchProfileResearchContext, storeSourceCorpus, reconcileSourceGaps } from "../../system-pipeline";
import { buildSourcePlan, planMissingRoles } from "../../sources/planner";
import { SOURCE_ROLES, type SourceRole } from "../../sources/roles";
import postgres from "postgres";

function mapToSourceRole(sourceType: string, title: string): SourceRole {
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

export const sourceDiscoveryHandler: V3StageHandler<unknown> = {
  stageKey: "source_discovery",
  async execute(ctx: V3RunContext): Promise<unknown> {
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
        pipelineVersion: 3,
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
        const role = mapToSourceRole(source.sourceType, source.title || "");
        coveredRoles.add(role);

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
          const isRoleLinked = art.rationale?.toLowerCase().includes(role) || art.rationale?.toLowerCase().includes(role.replace(/_/g, " "));
          const coverageStatus = isRoleLinked ? "covered" : "uncovered";
          await sql`
            INSERT INTO source_role_coverage (
              research_run_id, source_role, artifact_type, source_document_id,
              coverage_status, confidence, rationale, blocked_artifact_types
            ) VALUES (
              ${ctx.runId}, ${role}, ${art.artifact_type}, ${source.sourceId},
              ${coverageStatus}, 100, 'Source document assigned', ${sql.json([])}
            )
            ON CONFLICT (research_run_id, source_role, artifact_type) DO UPDATE
            SET coverage_status = ${coverageStatus}, source_document_id = ${source.sourceId}
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
  async validate(ctx: V3RunContext, output: any): Promise<ValidationResult> {
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
      return v3ValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
