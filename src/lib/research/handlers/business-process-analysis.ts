import type { ResearchRunContext, StageHandler } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { BUSINESS_PROCESS_CONTRACT } from "../stage-contracts";
import { loadAcceptedEvidencePacket } from "../sources/corpus";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { CURRENT_PIPELINE_VERSION } from "../version";

export const businessProcessAnalysisHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "business_process_analysis",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
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
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_modules: ["customer_funnel_mechanics", "segment_economics", "business_process_flow"],
        required_process_nodes: ctx.composedProfile?.required_process_nodes || [],
        output_contract: "business_process_analysis",
        output_schema: BUSINESS_PROCESS_CONTRACT.schema,
        evidence_claims: evidenceClaims,
      };

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: BUSINESS_PROCESS_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Document segment unit-economics and trace buyer/seller/user acquisition and transaction flow diagrams.",
          "Decompose each segment's revenue as price × volume (for example take rate × GMV, ARPU × users, yield × balances) and give unit economics where disclosed: revenue, variable cost and contribution per unit, acquisition cost and payback. Name the KPI and period of each figure.",
          "Explain why each figure moved (price, volume, mix, cost, accounting), not only that it moved. List an undisclosed driver as a gap rather than estimating it.",
          "Follow output_schema exactly, including every nested required field and primitive type.",
          "For a Lending or Credit segment, include lender_details with nonempty funding_cost and credit_losses grounded in evidence. For a Marketplace or Commerce segment, include marketplace_details with buyers, transactions, gmv, and take_rate.",
          "The canonical bottleneck key and artifact_type are both bottleneck_register.",
          "Cover every reportable company segment supported by evidence_claims, including distinct Lending, Financial Services, and Technology Platform segments when the sources establish them.",
          "Cover each applicable required_process_node. For a node without supporting evidence, list it in business_process_map.source_gaps instead of inventing a process or citation.",
          "business_process_map must contain process_nodes, never process_steps.",
          "Each process node must cite only UUIDs copied exactly from evidence_claims in supporting_claim_ids.",
          "market_share is a disclosed share between 0 and 1; use null when it is not disclosed, never 0 or an invented percentage.",
          "For every competitor with market_share above 0.10, include a response scenario in which the company loses market share to that competitor; say 'loses share' in its threat_description and model the response and financial impact.",
          "bottleneck_register.capacity_limit is a disclosed capacity greater than 0 in unit; use null when no capacity is disclosed and explain the constraint in description.",
        ],
      });

      const output = await callResearchAgent<Record<string, any>>({
        sql, ctx, stageKey: "business_process_analysis", taskKey,
        taskType: "business_process_analysis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: BUSINESS_PROCESS_CONTRACT,
      });
      const processMap = output.business_process_map;
      if (processMap && Array.isArray(packet.required_process_nodes)) {
        const covered = new Set((Array.isArray(processMap.process_nodes) ? processMap.process_nodes : [])
          .map((node: any) => String(node.process_node)));
        const gaps = Array.isArray(processMap.source_gaps) ? processMap.source_gaps : [];
        processMap.required_node_coverage = packet.required_process_nodes
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
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = BUSINESS_PROCESS_CONTRACT.requiredKeys;
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
};
