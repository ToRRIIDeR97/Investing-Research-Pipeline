import type { ResearchAgentName } from "@/lib/agent-harness/registry";

export const TEAM_ROLES = {
  data: { agent: "source-discovery-agent", stage: "source_discovery", purpose: "Gather primary documents and independent evidence before any specialist starts. Check disclosure coverage, dates and source gaps, search for named documents until the corpus is sufficient, and fetch missing information the other specialists request." },
  financials: { agent: "metric-normalizer", stage: "historical_record", purpose: "Read downloaded filings and normalize complete financial statements, periods, units, currencies and restatements. Reconcile totals and distinguish reported figures from estimates." },
  business: { agent: "asset-analyst", stage: "company_genesis", purpose: "Explain management, incentives, capital allocation, operations, history, competition and intangible advantages. Form evidence-backed bear, base and bull operating assumptions." },
  valuation: { agent: "valuation-analyst", stage: "asset_valuation", purpose: "Design investment-specific valuation methods from the business drivers and checked financials. Trace scenario assumptions into cash flows, discounting, reinvestment, terminal value and dilution. Explain when a DCF is inappropriate." },
  report: { agent: "export-writer", stage: "ai_reviewer", purpose: "Combine the specialists' work into a coherent report. Challenge contradictions and ask the responsible specialist for missing information. Withhold material conclusions until supported." },
  // On demand only: called when deterministic filing parsing fails, never briefed or requested.
  repair: { agent: "repair-agent", stage: "historical_record", onDemand: true, purpose: "When the deterministic parser cannot locate primary statements, write a run-scoped JavaScript parser module that locates the statement tables. The module runs sandboxed, never produces values, and its result must pass the normal completeness and reconciliation checks." },
} satisfies Record<string, { agent: ResearchAgentName; stage: string; purpose: string; onDemand?: boolean }>;
export type TeamRole = keyof typeof TEAM_ROLES;
/**
 * Roles that plan once the collector declares the corpus sufficient. The collector itself
 * reviews coverage during discovery, and on-demand specialists are excluded.
 */
export const BRIEF_ROLES = (Object.keys(TEAM_ROLES) as TeamRole[]).filter(role => role !== "data" && !("onDemand" in TEAM_ROLES[role]));
/** Specialists that may ask the collector for documents while their stage runs. */
export const SOURCE_REQUEST_ROLES: TeamRole[] = ["financials", "business", "valuation"];
/** Collector search rounds before discovery hands the corpus to the specialists. */
export const MAX_DISCOVERY_ROUNDS = 3;
/** Collector rounds one stage may trigger; later outputs must work with what was found. */
export const MAX_STAGE_SOURCE_REQUEST_ROUNDS = 2;
/** The stage whose rerun re-evaluates each gap owner's source gaps. */
export const GAP_OWNER_STAGES: Record<string, string> = {
  "system:source-reader": "source_discovery",
  "system:source-collector": "source_discovery",
  [TEAM_ROLES.financials.agent]: "historical_record",
};

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
  // Analysis stages read the financial_analytics digest that historical_record saves.
  historical_record: ["evidence_extraction"], company_genesis: ["evidence_extraction", "historical_record"],
  historical_diagnosis: ["historical_record"], business_process_analysis: ["company_genesis", "historical_diagnosis"],
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
