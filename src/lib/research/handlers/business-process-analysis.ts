import type { ResearchRunContext, StageHandler } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { runSplitStage } from "./split-calls";
import { BUSINESS_COMPETITION_CONTRACT, BUSINESS_FLOW_CONTRACT, BUSINESS_SEGMENTS_CONTRACT, MANAGEMENT_CONTRACT } from "../stage-contracts";

export const MANAGEMENT_RULES = [
  "Score management on five separate axes, 1 (poor) to 5 (excellent): operating_execution (delivery against plans, margins and growth versus history), balance_sheet_discipline (net cash or leverage, liquidity, debt maturities), capital_returns (buybacks and dividends against FCF, net share count change, the SBC offset), capital_allocation (returns on reinvestment and acquisitions, loss-making segments, capex against returns) and governance_alignment (share classes, voting versus economic control, board independence, incentives).",
  "Score each axis from evidence: cite financial_analytics paths (for example financial_analytics.capital_allocation.quarterly or financial_analytics.cash_conversion.quarterly) in analytics_paths and claim ids from evidence_claims in supporting_claim_ids. Leave score null with a rationale saying what is missing when the evidence can't support it. Axes are independent: strong execution does not lift weak governance.",
  "Use research_framing.management_axes, when present, as the questions each axis must answer.",
];

/** Rules every business call gets, after its own. */
const BUSINESS_SHARED_RULES = [
  "Follow output_schema exactly, including every nested required field and primitive type.",
  "Cite only UUIDs copied exactly from evidence_claims.",
];

/** The first call: segment economics and customer decisions. */
export const SEGMENT_RULES = [
  "Document each segment's unit economics.",
  "Decompose each segment's revenue as price × volume (for example take rate × GMV, ARPU × users, yield × balances) and give unit economics where disclosed: revenue, variable cost and contribution per unit, acquisition cost and payback. Name the KPI and period of each figure.",
  "Explain why each figure moved (price, volume, mix, cost, accounting), not only that it moved. List an undisclosed driver as a gap rather than estimating it.",
  "Cover every reportable company segment supported by evidence_claims, including distinct Lending, Financial Services, and Technology Platform segments when the sources establish them.",
  "segment_name is the segment's own name only. Put notes such as where a business is reported, or that it is not a separate reportable segment, in product_or_service, never in segment_name.",
  "A segment whose segment_name contains 'lending', 'lender' or 'credit' (any case) must include lender_details with nonempty funding_cost and credit_losses grounded in evidence; where the business keeps no funding or credit risk (for example loans originated and sold), say so in those fields. A segment whose segment_name contains 'marketplace' or 'commerce' must include marketplace_details with buyers, transactions, gmv, and take_rate.",
];

/** The second call: how the business runs, built on the accepted segment model. */
export const FLOW_RULES = [
  "Trace buyer, seller and user acquisition and the transaction flow through the business.",
  "Cover each applicable required_process_node. For a node without supporting evidence, list it in business_process_map.source_gaps instead of inventing a process or citation.",
  "business_process_map must contain process_nodes, never process_steps.",
  "Each process node must cite only UUIDs copied exactly from evidence_claims in supporting_claim_ids.",
  "The canonical bottleneck key and artifact_type are both bottleneck_register.",
  "bottleneck_register.capacity_limit is a disclosed capacity greater than 0 in unit; use null when no capacity is disclosed and explain the constraint in description.",
];

/** The third call: competitors and responses, built on the accepted segment model. */
export const COMPETITION_RULES = [
  "Cover the competitors and substitutes the accepted segment model names.",
  "market_share is a disclosed share between 0 and 1; use null when it is not disclosed, never 0 or an invented percentage.",
  "For every competitor with market_share above 0.10, include a response scenario in which the company loses market share to that competitor; say 'loses share' in its threat_description and model the response and financial impact.",
];

import { loadAcceptedEvidencePacket } from "../sources/corpus";
import { createArtifactRepository } from "../artifacts/repository";
import { pipelineDb, pipelineSql } from "@/db/pipeline-sql";
import { CURRENT_PIPELINE_VERSION } from "../version";

export const businessProcessAnalysisHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "business_process_analysis",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = pipelineSql();
    const evidenceClaims = await loadAcceptedEvidencePacket(sql, {
      runId: ctx.runId,
      runType: ctx.runType,
      assetId: ctx.assetId,
      assetName: ctx.assetName,
      assetSlug: ctx.assetSlug,
      symbol: ctx.symbol,
      profileId: ctx.profileId || "",
      profileKey: ctx.profileKey || "",
      requiredModules: [],
      requiredLenses: [],
      marketDataCutoffAt: ctx.marketDataCutoffAt?.toISOString() || null,
      pipelineVersion: CURRENT_PIPELINE_VERSION,
    });
    const taskKey = "business-model-analyst:process-map";
    const asset = {
      runId: ctx.runId,
      assetId: ctx.assetId,
      assetName: ctx.assetName,
      symbol: ctx.symbol,
      profileKey: ctx.profileKey,
    };
    const requiredProcessNodes: any[] = ctx.composedProfile?.required_process_nodes || [];

    // The five artifacts are written in three calls (see BUSINESS_SEGMENTS_CONTRACT): segments first, then the process
    // map and the competitive matrix side by side, both given the accepted segments.
    const output = await runSplitStage({
      sql, ctx, stageKey: "business_process_analysis", taskKey, taskType: "business_process_analysis",
      agentName: "asset-analyst", modelTier: "premium",
      packet: { asset, evidence_claims: evidenceClaims }, rules: BUSINESS_SHARED_RULES,
      parts: [
        { name: "segments", contract: BUSINESS_SEGMENTS_CONTRACT, rules: SEGMENT_RULES,
          extra: { required_modules: ["customer_funnel_mechanics", "segment_economics"] } },
        { name: "flow", contract: BUSINESS_FLOW_CONTRACT, rules: FLOW_RULES, after: ["segments"],
          extra: { required_modules: ["business_process_flow"], required_process_nodes: requiredProcessNodes } },
        { name: "competition", contract: BUSINESS_COMPETITION_CONTRACT, rules: COMPETITION_RULES, after: ["segments"] },
      ],
    });

    const processMap = output.business_process_map;
    if (processMap) {
      const covered = new Set((Array.isArray(processMap.process_nodes) ? processMap.process_nodes : [])
        .map((node: any) => String(node.process_node)));
      const gaps = Array.isArray(processMap.source_gaps) ? processMap.source_gaps : [];
      processMap.required_node_coverage = requiredProcessNodes
        .filter((node: any) => node.required)
        .map((node: any) => {
          const key = String(node.node_key);
          const gap = gaps.find((item: any) => item.node_key === key);
          return {
            node_key: key,
            status: covered.has(key) ? "documented" : "blocked",
            ...(covered.has(key) ? {} : { gap_reason: String(gap?.reason || "No supported process node was produced") }),
          };
        });
    }

    // Persist generated sub-artifacts
    const db = pipelineDb();
    const repo = createArtifactRepository(db);
    const subKeys = [...BUSINESS_SEGMENTS_CONTRACT.requiredKeys, ...BUSINESS_FLOW_CONTRACT.requiredKeys, ...BUSINESS_COMPETITION_CONTRACT.requiredKeys];
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

    // A further small call scores management on separate axes from the capital-allocation pack and the evidence.
    const managementPacket = {
      asset, evidence_claims: evidenceClaims,
      business_analysis: { segment_model: output.segment_model ?? null, bottleneck_register: output.bottleneck_register ?? null },
      output_contract: "management_assessment", output_schema: MANAGEMENT_CONTRACT.schema,
    };
    const management = await callResearchAgent<Record<string, any>>({
      sql, ctx, stageKey: "business_process_analysis", taskKey: "business-model-analyst:management",
      taskType: "management_assessment", agentName: "asset-analyst", modelTier: "premium", packet: managementPacket,
      outputFormat: MANAGEMENT_CONTRACT, promptFactory: p => exactJsonPrompt({ agentName: "asset-analyst",
        requiredKeys: MANAGEMENT_CONTRACT.requiredKeys, packet: p, extraRules: MANAGEMENT_RULES }),
    });
    await repo.upsertArtifact({
      research_run_id: ctx.runId, asset_id: ctx.assetId, profile_id: ctx.profileId || undefined,
      artifact_type: "management_assessment", scope_key: `${ctx.assetSlug}-management-assessment`, status: "validated",
      content_json: management.management_assessment, schema_version: "3.0.0", validator_version: "1.0.0",
      prompt_version: "current", created_by: "system-research-os",
    });

    return { ...output, management_assessment: management.management_assessment };
  },
};
