import type postgres from "postgres";
import type { ResearchRunContext } from "../run-context";
import { reconcileSourceGaps, type RunContext, type StoredSource } from "./corpus";
import { buildSourcePlan, planMissingRoles, type SourcePlan } from "./planner";
import { SOURCE_ROLES, isValidSourceRole, type SourceRole } from "./roles";
import { isPlausibleSourceRole } from "./role-discovery";
import { CURRENT_PIPELINE_VERSION } from "../version";

type Sql = ReturnType<typeof postgres>;

/** Owner of role-coverage gaps. Distinct from the source reader so neither pass resolves the other's gaps. */
export const SOURCE_COLLECTOR_OWNER = "system:source-collector";

export function mapToSourceRole(
  sourceType: string,
  title: string,
  metadata?: Record<string, unknown>
): SourceRole | null {
  const explicitRole = String(metadata?.source_role || "");
  if (SOURCE_ROLES.includes(explicitRole as SourceRole)) return explicitRole as SourceRole;
  const normType = sourceType.toLowerCase();
  const normTitle = title.toLowerCase();
  if (normType.startsWith("web_") && isValidSourceRole(normType.slice(4))) {
    return normType.slice(4) as SourceRole;
  }

  if (metadata?.semanticRole === "earnings_release" || metadata?.semanticRole === "earnings_exhibit") {
    return "earnings_release";
  }
  if (normType === "peer_industry_context") return "industry_primary";
  if (normType === "primary_source_context" || normType.includes("filing") || normType.includes("primary_document") || normType.includes("sec")) {
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
  return null;
}

export type CoverageSource = Pick<StoredSource, "sourceId" | "sourceType" | "title" | "url" | "metadata">;

/**
 * Documents fetched by earlier discovery passes stay linked to the run. A replay's web search can
 * return different results, so coverage is rebuilt from both the new and the already linked documents.
 */
export async function withLinkedRunSources(sql: Sql, runId: string, current: CoverageSource[]): Promise<CoverageSource[]> {
  const rows = await sql`SELECT d.id, d.source_type, d.title, d.url, d.metadata_json
    FROM source_documents d JOIN research_run_sources r ON r.source_document_id = d.id
    WHERE r.research_run_id = ${runId} ORDER BY r.created_at, d.id`;
  const seen = new Set(current.map(source => source.sourceId));
  return [...current, ...rows.filter(row => !seen.has(String(row.id))).map(row => ({
    sourceId: String(row.id), sourceType: String(row.source_type), title: String(row.title),
    url: row.url ? String(row.url) : undefined, metadata: row.metadata_json || {},
  }))];
}

export function v2RunContext(ctx: ResearchRunContext): RunContext {
  return {
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
}

export function sourcePlanFor(ctx: ResearchRunContext): SourcePlan {
  return buildSourcePlan(ctx.runId, ctx.assetId, (ctx.composedProfile?.required_artifacts || []) as any,
    (ctx.composedProfile?.source_roles || [])
      .filter((item: any) => isValidSourceRole(String(item.role)))
      .map((item: any) => ({
        role: item.role as SourceRole,
        required: item.required,
        rationale: item.rationale,
        blockedArtifacts: item.blockedArtifacts,
      })));
}

/** Assign roles to substantive documents and record which planned artifacts each role now covers. */
export async function recordSourceCoverage(sql: Sql, runId: string, sources: CoverageSource[], plan: SourcePlan): Promise<Set<SourceRole>> {
  const coveredRoles = new Set<SourceRole>();
  for (const source of sources) {
    if (source.sourceId.startsWith("candidate-")) continue;
    const mapped = mapToSourceRole(source.sourceType, source.title || "", source.metadata);
    const roles = mapped ? [mapped] : [];
    if (source.sourceType === "peer_industry_context" && source.url
      && isPlausibleSourceRole(source.url, "regulatory_or_government")) {
      roles.push("regulatory_or_government");
    }
    for (const role of new Set(roles)) {
      if (!source.url || !isPlausibleSourceRole(source.url, role)) continue;
      coveredRoles.add(role);

      await sql`
        INSERT INTO source_retrieval_attempts (
          research_run_id, source_role, source_url, source_title,
          attempt_status, attempt_metadata_json
        )
        SELECT
          ${runId}, ${role}, ${source.url || null},
          ${source.title || null}, 'fetched',
          ${sql.json({
            source_document_id: source.sourceId,
            fetch_status: String(source.metadata?.fetch_status || "fetched"),
            substantive: true,
          })}
        WHERE NOT EXISTS (
          SELECT 1 FROM source_retrieval_attempts
          WHERE research_run_id = ${runId}
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

      // A role covers only the artifacts explicitly linked by the composed profile.
      const linkedArtifacts = plan.items.find((item) => item.source_role === role)?.artifact_types || [];
      for (const artifactType of linkedArtifacts) {
        await sql`
          INSERT INTO source_role_coverage (
            research_run_id, source_role, artifact_type, source_document_id,
            coverage_status, confidence, rationale, blocked_artifact_types
          ) VALUES (
            ${runId}, ${role}, ${artifactType}, ${source.sourceId},
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
  }
  return coveredRoles;
}

/**
 * Required roles still missing after the collector has finished searching are recorded as
 * non-blocking gaps: the run continues and the affected artifacts carry the limitation.
 */
export async function reconcileRoleGaps(sql: Sql, ctx: RunContext, plan: SourcePlan, covered: Set<SourceRole>,
  notes: Partial<Record<SourceRole, string>> = {}) {
  const missingRoles = planMissingRoles(plan, Array.from(covered));
  const gaps = missingRoles.map((role) => {
    const item = plan.items.find((planItem) => planItem.source_role === role);
    const affected = item?.artifact_types.length ? ` Affects: ${item.artifact_types.join(", ")}.` : "";
    const note = notes[role] ? ` Collector note: ${notes[role]}` : "";
    return {
      gap_key: `missing_${role}`,
      description: `Required source role '${role}' is not covered by any fetched documents.${affected}${note}`,
      severity: "medium",
    };
  });
  for (const role of missingRoles) {
    const planItem = plan.items.find((item) => item.source_role === role);
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
  await reconcileSourceGaps(sql, ctx, { source_gaps: gaps }, SOURCE_COLLECTOR_OWNER);
  return { missingRoles, gaps: gaps.map(gap => ({ ...gap, gapKey: gap.gap_key })) };
}
