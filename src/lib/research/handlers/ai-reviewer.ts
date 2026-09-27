import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { AI_REVIEWER_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { draftAndReviewReport } from "../reporting/runtime";

export const aiReviewerHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "ai_reviewer",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const artifacts = await sql`
        SELECT artifact_type, content_json
        FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND status IN ('validated', 'accepted')
          AND artifact_type NOT IN ('review_summary', 'findings', 'quality_score', 'recommendations', 'review_verdict')
        ORDER BY artifact_type
      `;
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        artifacts: Object.fromEntries(
          artifacts.map((artifact) => [artifact.artifact_type, artifact.content_json])
        ),
      };
      const taskKey = "research-reviewer:review";

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "research-reviewer",
        requiredKeys: AI_REVIEWER_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Perform a comprehensive review checking consistency and rules compliance across all generated artifacts.",
          "Judge the current artifacts in this packet; do not repeat findings from an earlier review.",
          "Verify that the backtest executed at least 50 thesis-distinct combinations, ranked a top 10, reviewed at least five weak or failed combinations, used shifted signals and transaction costs, and disclosed proxy-data limitations.",
        ],
      });

      const adaptive = artifacts.some(artifact => artifact.artifact_type === "research_plan" && artifact.content_json?.report_standard);
      const output = adaptive ? (await draftAndReviewReport(sql, ctx)).review : await callResearchAgent<Record<string, unknown>>({
        sql, ctx, stageKey: "ai_reviewer", taskKey,
        taskType: "ai_review", agentName: "research-reviewer", modelTier: "cheap",
        packet, promptFactory,
        outputFormat: AI_REVIEWER_CONTRACT,
      });

      // Persist generated sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = AI_REVIEWER_CONTRACT.requiredKeys;
      for (const k of subKeys) {
        if (output[k]) {
          await repo.upsertArtifact({
            research_run_id: ctx.runId,
            asset_id: ctx.assetId,
            profile_id: ctx.profileId || undefined,
            artifact_type: k,
            scope_key: `${ctx.assetSlug}-${k.replace(/_/g, "-")}`,
            status: "validated",
            content_json: output[k] as Record<string, unknown>,
            schema_version: "3.0.0",
            validator_version: "1.0.0",
            prompt_version: "current",
            created_by: "system-research-os",
            idempotency_key: `${ctx.runId}-${k}`,
          });
        }
      }

      return output;
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: ResearchRunContext, _output: unknown): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const errors: string[] = [];
      const artifactKeys = AI_REVIEWER_CONTRACT.requiredKeys;
      for (const k of artifactKeys) {
        const rows = await sql`
          SELECT COUNT(*) as cnt FROM research_artifacts
          WHERE research_run_id = ${ctx.runId}
            AND artifact_type = ${k}
            AND status IN ('validated', 'accepted')
        `;
        if (Number(rows[0].cnt) === 0) {
          errors.push(`Missing required artifact: ${k}`);
        }
      }
      return makeValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
