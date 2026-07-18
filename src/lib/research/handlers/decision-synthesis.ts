import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { DECISION_SYNTHESIS_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export const decisionSynthesisHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "decision_synthesis",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const taskKey = "asset-analyst:decision";
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_modules: ["thesis_synthesis"],
        output_contract: "decision_synthesis",
      };

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: DECISION_SYNTHESIS_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Synthesize the final investment decision, including a clear thesis statement, risk factors, and upcoming catalysts.",
        ],
      });

      const output = await callResearchAgent<Record<string, any>>({
        sql, ctx, stageKey: "decision_synthesis", taskKey,
        taskType: "decision_synthesis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: DECISION_SYNTHESIS_CONTRACT,
      });

      // Persist to theses table
      const thesis = output.investment_thesis as any || {};
      await sql`
        INSERT INTO theses (
          asset_id, research_run_id, one_sentence_thesis, why_now, market_missing, status, created_by
        ) VALUES (
          ${ctx.assetId}, ${ctx.runId}, ${thesis.one_sentence_thesis || "Thesis statement"},
          ${thesis.why_now || null}, ${thesis.market_missing || null}, 'draft', 'system-research-os'
        )
      `;

      // Persist to risks table
      const riskAssessment = output.risk_assessment as any || {};
      const risks = Array.isArray(riskAssessment.risks) ? riskAssessment.risks : [];
      for (const r of risks) {
        await sql`
          INSERT INTO risks (
            asset_id, research_run_id, risk_name, risk_type, description, severity, probability,
            evidence_claim_ids, mitigants_json
          ) VALUES (
            ${ctx.assetId}, ${ctx.runId}, ${r.risk_name || "Risk factor"}, ${r.risk_type || "market"},
            ${r.description || null}, ${r.severity || "medium"}, ${r.probability || "medium"},
            ${sql.array([])}, ${sql.json([])}
          )
        `;
      }

      // Persist to catalysts table
      const catalystTimeline = output.catalyst_timeline as any || {};
      const catalysts = Array.isArray(catalystTimeline.catalysts) ? catalystTimeline.catalysts : [];
      for (const cat of catalysts) {
        await sql`
          INSERT INTO catalysts (
            asset_id, research_run_id, catalyst_name, catalyst_type, description, upside_downside, status
          ) VALUES (
            ${ctx.assetId}, ${ctx.runId}, ${cat.catalyst_name || "Catalyst event"}, ${cat.catalyst_type || "earnings"},
            ${cat.description || null}, ${cat.upside_downside || "neutral"}, 'open'
          )
        `;
      }

      // Persist generated sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = DECISION_SYNTHESIS_CONTRACT.requiredKeys;
      for (const k of subKeys) {
        if (output[k]) {
          await repo.upsertArtifact({
            research_run_id: ctx.runId,
            asset_id: ctx.assetId,
            profile_id: ctx.profileId || undefined,
            artifact_type: k,
            scope_key: `${ctx.assetSlug}-${k.replace(/_/g, "-")}`,
            status: "validated",
            content_json: output[k],
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
      const artifactKeys = DECISION_SYNTHESIS_CONTRACT.requiredKeys;
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
