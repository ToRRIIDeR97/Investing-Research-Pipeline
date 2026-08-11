import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgentArtifacts, exactJsonPrompt } from "../run-context";
import { DECISION_SYNTHESIS_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadAcceptedEvidencePacket } from "../system-pipeline";
import { createHash } from "node:crypto";
import { validateArtifactCitationIds } from "../sources/artifact-evidence";
import { CURRENT_PIPELINE_VERSION } from "../version";
import {
  calculateProbabilityWeightedReturn,
  validateCatalystRegister,
  validateDecisionRecord,
  validateExpectedReturnMatrix,
  validateInvestmentThesis,
  validateMonitoringDashboard,
  validateRiskRegister,
  validateThesisBreakers,
} from "../decision/validation";
import { ConfidenceAssessment } from "../decision/contracts";

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
      const [operatingScenarios] = await sql`
        SELECT content_json
        FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type = 'operating_scenario_set'
          AND status IN ('validated', 'accepted')
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const riskContextRows = await sql`
        SELECT artifact_type, content_json
        FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type IN ('moat_attack_matrix', 'business_process_map', 'no_moat_counterfactual')
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
        operating_scenarios: operatingScenarios?.content_json || null,
        risk_context: Object.fromEntries(
          riskContextRows.map((row) => [String(row.artifact_type), row.content_json])
        ),
        evidence_claims: evidenceClaims,
      };
      const taskKey = `asset-analyst:decision:v3:${createHash("sha256")
        .update(JSON.stringify(packet))
        .digest("hex")
        .slice(0, 12)}`;

      const promptFactory = (p: Record<string, unknown>, artifactKey: string) => exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: [artifactKey],
        packet: p,
        extraRules: [
          "Synthesize the final investment decision, including a clear thesis statement, risk factors, and upcoming catalysts.",
          "Use the backtest only as timing/risk evidence. Preserve its proxy-data limitations and do not claim that it proves the fundamental thesis.",
          "If backtest_review is present and its framework gate did not pass, state exactly: Conclusion withheld - research incomplete. If it is absent, disclose that no accepted timing hypothesis was tested and continue the fundamental decision.",
          "Follow output_schema exactly. Return two to four material risks, one to three catalysts, one to three thesis breakers, and one to three monitoring items.",
          "Use accepted_artifacts as validated upstream context; do not reproduce them in the response.",
          "Every thesis breaker must map to a named risk with the same underlying causal mechanism and measurable threshold.",
          "Convert every material attack in risk_context.moat_attack_matrix into a risk or thesis breaker, preserving its leading indicators. Do not omit deposit, funding, engagement, or cross-sell deterioration when present.",
          "Compute probability_weighted_return exactly as bear_return*probability_bear + base_return*probability_base + bull_return*probability_bull using operating_scenarios.",
          "Copy risk supporting_claim_ids exactly from evidence_claims; never invent UUIDs.",
          "Set investment_thesis.valuation_accepted_first to true because accepted_valuation is supplied by the completed valuation stage.",
          "Risk probability and confidence must be between 0 and 1; risk severity must be between 1 and 5.",
          "The decision must remain pending because human review is the approval gate.",
        ],
      });

      const validators: Record<string, (value: unknown) => Pick<ValidationResult, "valid" | "errors" | "warnings">> = {
        investment_thesis: validateInvestmentThesis,
        risk_register: validateRiskRegister,
        catalyst_register: validateCatalystRegister,
        expected_return_matrix: validateExpectedReturnMatrix,
        thesis_breakers: validateThesisBreakers,
        monitoring_dashboard: validateMonitoringDashboard,
        confidence_assessment: (value) => {
          const parsed = ConfidenceAssessment.safeParse(value);
          return parsed.success
            ? { valid: true, errors: [], warnings: [] }
            : { valid: false, errors: parsed.error.errors.map((error) => error.message), warnings: [] };
        },
        decision_record: validateDecisionRecord,
      };
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const acceptedEvidenceIds = evidenceClaims.map((claim: any) => String(claim.id));
      const output = await callResearchAgentArtifacts({
        sql, ctx, stageKey: "decision_synthesis", taskKeyPrefix: taskKey,
        taskType: "decision_synthesis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: DECISION_SYNTHESIS_CONTRACT,
        artifactWaves: [
          ["expected_return_matrix", "risk_register", "catalyst_register", "confidence_assessment"],
          ["investment_thesis", "thesis_breakers", "monitoring_dashboard"],
          ["decision_record"],
        ],
        validateArtifact: (artifactKey, value) => {
          const validation = validators[artifactKey](value);
          const citations = validateArtifactCitationIds(value, acceptedEvidenceIds);
          return citations.valid
            ? validation
            : {
                valid: false,
                errors: [...validation.errors, `Cited evidence IDs outside the accepted packet: ${citations.invalidIds.join(", ")}`],
                warnings: validation.warnings,
              };
        },
        onArtifact: async (artifactKey, value) => {
          if (artifactKey === "expected_return_matrix" && operatingScenarios?.content_json) {
            (value as any).probability_weighted_return = calculateProbabilityWeightedReturn(
              value as any,
              operatingScenarios.content_json as any
            );
          }
          await repo.upsertArtifact({
            research_run_id: ctx.runId,
            asset_id: ctx.assetId,
            profile_id: ctx.profileId || undefined,
            artifact_type: artifactKey,
            scope_key: `${ctx.assetSlug}-${artifactKey.replace(/_/g, "-")}`,
            status: "draft",
            content_json: value,
            schema_version: "3.0.0",
            validator_version: "1.0.0",
            prompt_version: "current",
            created_by: "system-research-os",
            idempotency_key: `${ctx.runId}-${artifactKey}`,
          });
        },
      });
      await sql`
        UPDATE research_artifacts
        SET status = 'validated', updated_at = NOW()
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type = ANY(${DECISION_SYNTHESIS_CONTRACT.requiredKeys})
      `;

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
        const supportingClaimIds = Array.isArray(r.supporting_claim_ids) ? r.supporting_claim_ids : [];
        const riskName = String(r.risk_name || "Risk factor");
        await sql`
          INSERT INTO risks (
            asset_id, research_run_id, risk_name, risk_type, description, severity, probability,
            evidence_claim_ids, mitigants_json
          )
          SELECT
            ${ctx.assetId}, ${ctx.runId}, ${riskName}, 'market',
            ${String(r.causal_mechanism || "") || null}, ${String(r.severity || "medium")},
            ${String(r.probability ?? "medium")},
            ${`{${supportingClaimIds.join(",")}}`}::uuid[],
            ${JSON.stringify(Array.isArray(r.mitigants) ? r.mitigants : [])}::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM risks
            WHERE research_run_id = ${ctx.runId} AND risk_name = ${riskName}
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
