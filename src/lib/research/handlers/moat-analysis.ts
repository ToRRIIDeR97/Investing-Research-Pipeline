import type { ResearchRunContext, StageHandler } from "../run-context";
import { MOAT_ASSESSMENT_CONTRACT, MOAT_ATTACK_CONTRACT, MOAT_CONTRACT } from "../stage-contracts";
import { runSplitStage } from "./split-calls";
import { attackTargetErrors, capMoatClassifications } from "../moat/validation";
import { createArtifactRepository } from "../artifacts/repository";
import { pipelineDb, pipelineSql } from "@/db/pipeline-sql";

/** The first call: each claimed moat, tested and classified. */
export const MOAT_ASSESSMENT_RULES = [
  "Test each claimed moat source (network effects, switching costs, cost advantage, intangibles, efficient scale) against a specific KPI and its trend: retention or churn, pricing versus peers, unit cost versus competitors, share stability, or return on incremental capital above the cost of capital.",
  "Explain how each advantage shows up in margins or returns, and state the counter-evidence: competitor entry, price cuts, rising acquisition cost, falling take rate or retention. A source without KPI support is unproven; no demonstrated moat is a valid conclusion.",
  "Classify each moat as unproven, weak, moderate, strong or exceptional and score the six scores 0-5. Cite evidence_claims ids in supporting_claim_ids and the computed data you tested it against in artifact_paths: financial_analytics paths for the multi-year record (margins, returns, segment economics; for example financial_analytics.segments.quarterly) and peer_benchmark.peers.<TICKER> for a named peer's growth and margins. Strong or exceptional needs a history path, a peer path and a supporting claim; code checks each against the stored data and caps the moat at moderate otherwise.",
];

/** The second call: the attacks on the accepted assessment and the no-moat counterfactual. */
export const MOAT_ATTACK_RULES = [
  "Build the attack table from the named attackers, including competitors the filing passages name (for example in risk factors) and research_framing.named_peers. Each attack names the claimed_moat it tests in targets_moat, exactly as accepted_artifacts.moat_assessment names it, and says whether the moat survives fully, partially or not at all, with competitor numbers from peer_benchmark where stored.",
  "Write no_moat_counterfactual against the moats accepted_artifacts.moat_assessment classifies.",
];

export const moatAnalysisHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "moat_analysis",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = pipelineSql();
    const taskKey = "moat-analyst:assessment";
    const asset = {
      runId: ctx.runId,
      assetId: ctx.assetId,
      assetName: ctx.assetName,
      symbol: ctx.symbol,
      profileKey: ctx.profileKey,
    };
    // Two calls: the assessment, then the attacks and the counterfactual that test it (split-calls.ts).
    const output = await runSplitStage({
      sql, ctx, stageKey: "moat_analysis", taskKey, taskType: "moat_analysis", agentName: "asset-analyst", modelTier: "premium",
      packet: { asset, required_modules: ["moat_durability", "competitive_advantage_sources"] },
      rules: ["Follow output_schema exactly, including every nested required field and primitive type."],
      parts: [
        { name: "assessment", contract: MOAT_ASSESSMENT_CONTRACT, rules: MOAT_ASSESSMENT_RULES },
        { name: "attacks", contract: MOAT_ATTACK_CONTRACT, rules: MOAT_ATTACK_RULES, after: ["assessment"],
          validate: (value, accepted) => attackTargetErrors(accepted.moat_assessment, value.moat_attack_matrix)
            .map(message => ({ path: "moat_attack_matrix.attacks", message })) },
      ],
    });
    if (output.moat_assessment) {
      // Cited paths and claims are checked against what this run stores, not trusted as strings.
      const stored = await sql`SELECT DISTINCT ON (artifact_type) artifact_type, content_json FROM research_artifacts
        WHERE research_run_id = ${ctx.runId} AND status IN ('validated', 'accepted')
          AND artifact_type IN ('financial_analytics', 'historical_record', 'historical_diagnosis', 'peer_benchmark')
        ORDER BY artifact_type, artifact_version DESC, created_at DESC`;
      const claims = await sql`SELECT id FROM evidence_claims WHERE research_run_id = ${ctx.runId} AND review_status = 'accepted'`;
      output.moat_assessment = capMoatClassifications(output.moat_assessment, {
        artifacts: Object.fromEntries(stored.map((row) => [String(row.artifact_type), row.content_json])),
        claimIds: new Set(claims.map((row) => String(row.id))) });
    }

    // Persist generated sub-artifacts
    const db = pipelineDb();
    const repo = createArtifactRepository(db);
    const subKeys = MOAT_CONTRACT.requiredKeys;
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
        });
      }
    }

    return output;
  },
};
