import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { DECISION_SYNTHESIS_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadAcceptedEvidencePacket } from "../system-pipeline";
import { createHash } from "node:crypto";
import { validateArtifactCitationIds } from "../sources/artifact-evidence";
import { CURRENT_PIPELINE_VERSION } from "../version";

export const decisionSynthesisHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "decision_synthesis",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const evidenceClaims = await loadAcceptedEvidencePacket(sql, {
        runId: ctx.runId, runType: ctx.runType, assetId: ctx.assetId,
        assetName: ctx.assetName, assetSlug: ctx.assetSlug, symbol: ctx.symbol,
        profileId: ctx.profileId || "", profileKey: ctx.profileKey || "",
        requiredModules: [], requiredLenses: [],
        marketDataCutoffAt: ctx.marketDataCutoffAt?.toISOString() || null,
        pipelineVersion: CURRENT_PIPELINE_VERSION,
      });
      const [backtestReview] = await sql`
        SELECT content_json
        FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type = 'backtest_review'
          AND status IN ('validated', 'accepted')
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const valuationRows = await sql`
        SELECT artifact_type, content_json
        FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type IN ('valuation_scenario_set', 'reverse_valuation', 'annual_price_target_path')
          AND status IN ('validated', 'accepted')
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
        required_modules: ["thesis_synthesis"],
        backtest_review: backtestReview?.content_json || null,
        accepted_valuation: Object.fromEntries(
          valuationRows.map((row) => [String(row.artifact_type), row.content_json])
        ),
        output_contract: "decision_synthesis",
        output_schema: DECISION_SYNTHESIS_CONTRACT.schema,
        evidence_claims: evidenceClaims,
      };
      const taskKey = `asset-analyst:decision:v2:${createHash("sha256")
        .update(JSON.stringify(packet))
        .digest("hex")
        .slice(0, 12)}`;

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: DECISION_SYNTHESIS_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Synthesize the final investment decision, including a clear thesis statement, risk factors, and upcoming catalysts.",
          "Use the backtest only as timing/risk evidence. Preserve its proxy-data limitations and do not claim that it proves the fundamental thesis.",
          "If the backtest framework gate did not pass, state exactly: Conclusion withheld - research incomplete.",
          "Follow output_schema exactly. Return one bounded risk, one catalyst, one thesis breaker, and one monitoring item.",
          "Copy risk supporting_claim_ids exactly from evidence_claims; never invent UUIDs.",
          "Set investment_thesis.valuation_accepted_first to true because accepted_valuation is supplied by the completed valuation stage.",
          "Risk probability and confidence must be between 0 and 1; risk severity must be between 1 and 5.",
          "The decision must remain pending because human review is the approval gate.",
        ],
      });

      const output = await callResearchAgent<Record<string, any>>({
        sql, ctx, stageKey: "decision_synthesis", taskKey,
        taskType: "decision_synthesis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: DECISION_SYNTHESIS_CONTRACT,
      });
      const citationValidation = validateArtifactCitationIds(
        output,
        evidenceClaims.map((claim: any) => String(claim.id))
      );
      if (!citationValidation.valid) {
        throw new Error(
          `Decision synthesis cited evidence IDs outside the accepted packet: ${citationValidation.invalidIds.join(", ")}`
        );
      }

      // Persist to theses table
      const thesis = output.investment_thesis as any || {};
      await sql`
        INSERT INTO theses (
          asset_id, research_run_id, one_sentence_thesis, why_now, market_missing, status, created_by
        )
        SELECT
          ${ctx.assetId}, ${ctx.runId}, ${thesis.thesis_statement || thesis.one_sentence_thesis || "Thesis statement"},
          ${thesis.why_now || thesis.causal_chain || null},
          ${thesis.market_missing || thesis.market_mispricing || null},
          'draft', 'system-research-os'
        WHERE NOT EXISTS (
          SELECT 1 FROM theses WHERE research_run_id = ${ctx.runId}
        )
      `;

      // Persist to risks table
      const riskAssessment = output.risk_register as any || output.risk_assessment as any || {};
      const risks = Array.isArray(riskAssessment.risks) ? riskAssessment.risks : [];
      for (const r of risks) {
        await sql`
          INSERT INTO risks (
            asset_id, research_run_id, risk_name, risk_type, description, severity, probability,
            evidence_claim_ids, mitigants_json
          )
          SELECT
            ${ctx.assetId}, ${ctx.runId}, ${r.risk_name || "Risk factor"}, ${r.risk_type || "market"},
            ${r.description || r.causal_mechanism || null}, ${String(r.severity || "medium")},
            ${String(r.probability ?? "medium")},
            ${sql.array(Array.isArray(r.supporting_claim_ids) ? r.supporting_claim_ids : [])}::uuid[],
            ${sql.json(Array.isArray(r.mitigants) ? r.mitigants : [])}
          WHERE NOT EXISTS (
            SELECT 1 FROM risks
            WHERE research_run_id = ${ctx.runId} AND risk_name = ${r.risk_name || "Risk factor"}
          )
        `;
      }

      // Persist to catalysts table
      const catalystTimeline = output.catalyst_register as any || output.catalyst_timeline as any || {};
      const catalysts = Array.isArray(catalystTimeline.catalysts) ? catalystTimeline.catalysts : [];
      for (const cat of catalysts) {
        await sql`
          INSERT INTO catalysts (
            asset_id, research_run_id, catalyst_name, catalyst_type, description, upside_downside, status
          )
          SELECT
            ${ctx.assetId}, ${ctx.runId}, ${cat.catalyst_name || "Catalyst event"}, ${cat.catalyst_type || "earnings"},
            ${cat.description || cat.event_mechanism || null},
            ${cat.upside_downside || cat.direction || "neutral"}, 'open'
          WHERE NOT EXISTS (
            SELECT 1 FROM catalysts
            WHERE research_run_id = ${ctx.runId}
              AND catalyst_name = ${cat.catalyst_name || "Catalyst event"}
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
