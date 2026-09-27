import type { ResearchAgentName } from "@/lib/agent-harness/registry";

export const TEAM_ROLES = {
  data: { agent: "source-discovery-agent", stage: "source_discovery", purpose: "Gather primary documents and independent evidence. Check disclosure coverage, dates and source gaps. Fetch missing information requested by the other specialists." },
  financials: { agent: "metric-normalizer", stage: "historical_record", purpose: "Read downloaded filings and normalize complete financial statements, periods, units, currencies and restatements. Reconcile totals and distinguish reported figures from estimates." },
  business: { agent: "asset-analyst", stage: "company_genesis", purpose: "Explain management, incentives, capital allocation, operations, history, competition and intangible advantages. Form evidence-backed bear, base and bull operating assumptions." },
  valuation: { agent: "valuation-analyst", stage: "asset_valuation", purpose: "Design investment-specific valuation methods from the business drivers and checked financials. Trace scenario assumptions into cash flows, discounting, reinvestment, terminal value and dilution. Explain when a DCF is inappropriate." },
  report: { agent: "export-writer", stage: "ai_reviewer", purpose: "Combine the specialists' work into a coherent report. Challenge contradictions and ask the responsible specialist for missing information. Withhold material conclusions until supported." },
} satisfies Record<string, { agent: ResearchAgentName; stage: string; purpose: string }>;
export type TeamRole = keyof typeof TEAM_ROLES;

export const STAGE_OWNERS: Record<string, TeamRole> = {
  source_discovery: "data", source_ingestion: "data", evidence_extraction: "data",
  historical_record: "financials", company_genesis: "business", historical_diagnosis: "business",
  business_process_analysis: "business", moat_analysis: "business", operating_model: "business",
  operating_scenarios: "business", asset_valuation: "valuation", indicator_design: "business",
  strategy_design: "business", backtest_execution: "business", backtest_review: "business",
  decision_synthesis: "report", ai_reviewer: "report", export: "report",
};

// Dependencies describe actual inputs. Stage order remains the display order.
export const STAGE_DEPENDENCIES: Record<string, string[]> = {
  intake: [], asset_identity: ["intake"], archetype_composition: ["asset_identity"],
  research_plan: ["archetype_composition"], source_discovery: ["research_plan"],
  source_ingestion: ["source_discovery"], evidence_extraction: ["source_ingestion"],
  historical_record: ["evidence_extraction"], company_genesis: ["evidence_extraction"],
  historical_diagnosis: ["historical_record"], business_process_analysis: ["company_genesis"],
  moat_analysis: ["business_process_analysis"], operating_model: ["historical_diagnosis", "moat_analysis"],
  operating_scenarios: ["operating_model"], asset_valuation: ["operating_scenarios"],
  indicator_design: ["asset_valuation"], strategy_design: ["indicator_design"],
  backtest_execution: ["strategy_design"], backtest_review: ["backtest_execution"],
  decision_synthesis: ["asset_valuation", "backtest_review"], ai_reviewer: ["decision_synthesis"],
  human_review: ["ai_reviewer"], export: ["human_review"], refresh_schedule: ["export"],
};

export interface StageState { stage_key: string; status: string }
export function readyStages(stages: StageState[]): string[] {
  const state = new Map(stages.map(s => [s.stage_key, s.status]));
  // Neither human gate may be crossed while another branch is unfinished.
  return stages.filter(s => ["pending", "running"].includes(s.status) &&
    STAGE_DEPENDENCIES[s.stage_key]?.every(key => ["completed", "skipped"].includes(state.get(key) || "")))
    .map(s => s.stage_key);
}

export function dependentStages(roots: string[]): string[] {
  const affected = new Set(roots);
  for (let changed = true; changed;) {
    changed = false;
    for (const [key, dependencies] of Object.entries(STAGE_DEPENDENCIES)) {
      if (!affected.has(key) && dependencies.some(d => affected.has(d))) {
        affected.add(key); changed = true;
      }
    }
  }
  return [...affected];
}
