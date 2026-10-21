import { z } from "zod/v4";
import type { AgentOutputFormat } from "@/lib/agent-harness/types";
import { CompanyGenesis, FounderProfile, StrategicHistoryTimeline, StrategicDNA } from "./genesis/contracts";
import { HistoricalDiagnosisArtifact, validateHistoricalDiagnosis } from "./diagnosis/contracts";
import { SegmentModel, CustomerDecisionMap, BusinessProcessMap, BottleneckRegister, CompetitiveResponseMatrix } from "./business/contracts";
import { MoatAssessment, MoatAttackMatrix, NoMoatCounterfactual } from "./moat/contracts";
import { DriverTree, OperatingModel, TopDownBottomUpReconciliation, ReinvestmentModel, OperatingScenarioSet, OperatingScenarioEntry, NumericAssumption, YearlyDriver } from "./forecast/contracts";
import {ValuationMethodInput} from './valuation/schedules';
import { ValuationScenarioSet, ReverseValuation, AnnualPriceTargetPath } from "./valuation/contracts";
import { InvestmentThesis, RiskRegister, CatalystRegister, ExpectedReturnMatrix, ThesisBreakers, MonitoringDashboard, ConfidenceAssessment, DecisionRecord } from "./decision/contracts";
import { validateGenesisArtifact, validateFounderProfile, validateStrategicHistoryTimeline, validateStrategicDNA } from "./genesis/validation";
import { validateSegmentModel, validateCustomerDecisionMap, validateBusinessProcessMap, validateBottleneckRegister, validateCompetitiveResponseMatrix } from "./business/validation";
import { validateMoatAssessment, validateMoatAttackMatrix, validateNoMoatCounterfactual } from "./moat/validation";
import { validateDriverTree, validateOperatingModel, validateOperatingScenarioSet, validateTopDownBottomUpReconciliation } from "./forecast/validation";
import { validateInvestmentThesis, validateRiskRegister, validateCatalystRegister, validateThesisBreakers, validateMonitoringDashboard, validateExpectedReturnMatrix } from "./decision/validation";
import { validateValuationScenarioSet, validateReverseValuation } from "./valuation/validation";
import { DepthCheck, REWORK_STAGES, depthCheckErrors } from "./reporting/depth";

type ContentValidation = { valid: boolean; errors: string[]; warnings: string[] };

const contentValidators: Record<string, (value: unknown) => ContentValidation> = {
  company_genesis: validateGenesisArtifact, founder_profile: validateFounderProfile,
  strategic_history_timeline: validateStrategicHistoryTimeline, strategic_dna: validateStrategicDNA,
  historical_diagnosis: validateHistoricalDiagnosis,
  segment_model: validateSegmentModel, customer_decision_map: validateCustomerDecisionMap,
  business_process_map: validateBusinessProcessMap, bottleneck_register: validateBottleneckRegister,
  competitive_response_matrix: validateCompetitiveResponseMatrix,
  moat_assessment: validateMoatAssessment, moat_attack_matrix: validateMoatAttackMatrix,
  no_moat_counterfactual: validateNoMoatCounterfactual,
  driver_tree: validateDriverTree, operating_model: validateOperatingModel,
  top_down_bottom_up_reconciliation: validateTopDownBottomUpReconciliation,
  operating_scenario_set: validateOperatingScenarioSet,
  valuation_scenario_set: validateValuationScenarioSet, reverse_valuation: validateReverseValuation,
  investment_thesis: validateInvestmentThesis, risk_register: validateRiskRegister,
  catalyst_register: validateCatalystRegister, thesis_breakers: validateThesisBreakers,
  monitoring_dashboard: validateMonitoringDashboard, expected_return_matrix: validateExpectedReturnMatrix,
};

export const ARTIFACT_SCHEMAS: Record<string, z.ZodType> = {};

// Prompt shapes, model repair, and persisted-artifact checks use the same contracts.
function artifactContract(shape: Record<string, z.ZodType>): AgentOutputFormat {
  Object.assign(ARTIFACT_SCHEMAS, shape);
  const output = z.object(shape);
  return {
    requiredKeys: Object.keys(shape),
    schema: z.toJSONSchema(output, { target: "draft-7", io: "input", reused: "inline" }),
    validate(value) {
      const parsed = output.safeParse(value);
      if (!parsed.success) return parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
      return Object.keys(shape).flatMap((key) =>
        (contentValidators[key]?.(parsed.data[key]).errors || []).map((message) => ({ path: key, message }))
      );
    },
  };
}

export const COMPANY_GENESIS_CONTRACT = artifactContract({
  company_genesis: CompanyGenesis, founder_profile: FounderProfile,
  strategic_history_timeline: StrategicHistoryTimeline, strategic_dna: StrategicDNA,
});
export const HISTORICAL_DIAGNOSIS_CONTRACT = artifactContract({ historical_diagnosis: HistoricalDiagnosisArtifact });
export const BUSINESS_PROCESS_CONTRACT = artifactContract({
  segment_model: SegmentModel, customer_decision_map: CustomerDecisionMap,
  business_process_map: BusinessProcessMap, bottleneck_register: BottleneckRegister,
  competitive_response_matrix: CompetitiveResponseMatrix,
});
export const MOAT_CONTRACT = artifactContract({
  moat_assessment: MoatAssessment, moat_attack_matrix: MoatAttackMatrix, no_moat_counterfactual: NoMoatCounterfactual,
});
export const OPERATING_MODEL_CONTRACT = artifactContract({
  driver_tree: DriverTree, operating_model: OperatingModel,
  top_down_bottom_up_reconciliation: TopDownBottomUpReconciliation, reinvestment_model: ReinvestmentModel,
});
export const OPERATING_SCENARIOS_CONTRACT = artifactContract({ operating_scenario_set: OperatingScenarioSet.extend({scenarios:z.array(OperatingScenarioEntry.extend({numeric_assumptions:z.array(NumericAssumption).min(1),yearly_drivers:z.array(YearlyDriver).min(1)})).length(3)}) });
export const VALUATION_CONTRACT = artifactContract({
  valuation_scenario_set: ValuationScenarioSet.extend({method_inputs:z.array(ValuationMethodInput),omitted_methods:z.array(z.object({method:z.string().min(1),reason:z.string().min(1)}))}), reverse_valuation: ReverseValuation, annual_price_target_path: AnnualPriceTargetPath,
});
export const DECISION_SYNTHESIS_CONTRACT = artifactContract({
  investment_thesis: InvestmentThesis, risk_register: RiskRegister, catalyst_register: CatalystRegister,
  expected_return_matrix: ExpectedReturnMatrix, thesis_breakers: ThesisBreakers,
  monitoring_dashboard: MonitoringDashboard.extend({items:z.array(MonitoringDashboard.shape.items.element.omit({history_median:true,history_percentile:true}).extend({metric_key:z.string().min(1),definition:z.string().min(1),unit:z.string().min(1),reporting_basis:z.string().min(1)})).min(1)}), confidence_assessment: ConfidenceAssessment, decision_record: DecisionRecord,
});

const reviewer = z.object({
  review_summary: z.string().min(1), findings: z.array(z.record(z.string(), z.unknown())),
  quality_score: z.number().min(0).max(1), recommendations: z.array(z.record(z.string(), z.unknown())),
  review_verdict: z.enum(["pass", "conditional_pass", "fail", "needs_more_work"]),
  depth_checks: z.array(DepthCheck),
});
export const AI_REVIEWER_CONTRACT: AgentOutputFormat = {
  requiredKeys: Object.keys(reviewer.shape),
  schema: z.toJSONSchema(reviewer, { target: "draft-7", io: "input" }),
  validate(value) {
    const parsed = reviewer.safeParse(value);
    if (!parsed.success) return parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    const errors = depthCheckErrors(parsed.data.depth_checks).map((message) => ({ path: "depth_checks", message }));
    parsed.data.findings.forEach((finding, i) => {
      if (finding.category === "analysis_rework" && !(REWORK_STAGES as readonly string[]).includes(String(finding.owner_stage)))
        errors.push({ path: `findings.${i}.owner_stage`, message: `An analysis_rework finding needs owner_stage, one of: ${REWORK_STAGES.join(", ")}` });
    });
    return errors;
  },
};

export const STAGE_OUTPUT_CONTRACTS: Record<string, AgentOutputFormat> = {
  company_genesis: COMPANY_GENESIS_CONTRACT, historical_diagnosis: HISTORICAL_DIAGNOSIS_CONTRACT,
  business_process_analysis: BUSINESS_PROCESS_CONTRACT, moat_analysis: MOAT_CONTRACT,
  operating_model: OPERATING_MODEL_CONTRACT, operating_scenarios: OPERATING_SCENARIOS_CONTRACT,
  asset_valuation: VALUATION_CONTRACT, decision_synthesis: DECISION_SYNTHESIS_CONTRACT,
  ai_reviewer: AI_REVIEWER_CONTRACT,
};

export function getStageOutputContract(stageKey: string): AgentOutputFormat | undefined {
  return STAGE_OUTPUT_CONTRACTS[stageKey];
}

export function validateArtifactContent(artifactType: string, content: unknown): ContentValidation {
  const schema = ARTIFACT_SCHEMAS[artifactType];
  if (!schema) return { valid: false, errors: [`Unknown artifact type: ${artifactType}`], warnings: [] };
  const parsed = schema.safeParse(content);
  if (!parsed.success) return {
    valid: false, errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`), warnings: [],
  };
  return contentValidators[artifactType]?.(content) || { valid: true, errors: [], warnings: [] };
}
