/**
 * Validators for business, customer, process, and competitive analysis.
 */

import {
  SegmentModel,
  CustomerDecisionMap,
  BusinessProcessMap,
  BottleneckRegister,
  CompetitiveResponseMatrix,
  ManagementAssessment,
  MANAGEMENT_AXES,
  type SegmentDetails,
  type CustomerDecision,
  type ProcessNode,
  type Bottleneck,
  type CompetitorEntry,
} from "./contracts";

export type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export function validateSegmentModel(content: unknown): ValidationResult {
  const parsed = SegmentModel.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  for (const s of data.segments) {
    // C8-T1: Segment has revenue description but no customer/decision maker
    if (!s.customer_or_end_user || s.customer_or_end_user.toLowerCase() === "unknown" || s.customer_or_end_user.trim().length === 0) {
      errors.push(`Segment '${s.segment_name}' lacks a customer decision maker.`);
    }

    const isMarketplace = s.segment_name.toLowerCase().includes("marketplace") || s.segment_name.toLowerCase().includes("commerce");
    const isLender = s.segment_name.toLowerCase().includes("lender") || s.segment_name.toLowerCase().includes("credit") || s.segment_name.toLowerCase().includes("lending");

    // C8-T3: Marketplace model omits buyers, transactions, GMV, and take rate
    if (isMarketplace && !s.marketplace_details) {
      errors.push(`Segment '${s.segment_name}' is a marketplace but marketplace_details are missing.`);
    }

    // C8-T4: Lender model omits funding cost and credit losses
    if (isLender && !s.lender_details) {
      errors.push(`Segment '${s.segment_name}' is a lender but lender_details are missing.`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateCustomerDecisionMap(content: unknown): ValidationResult {
  const parsed = CustomerDecisionMap.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  for (const c of data.customer_groups) {
    if (!c.problem_initiating_demand || c.problem_initiating_demand.trim().length === 0) {
      errors.push(`Customer group '${c.customer_group}' is missing demand initiator.`);
    }
    // C8-T7: Customer can multi-home (warning if multi-homing switching cost is not addressed)
    if (c.switching_or_multihoming_path.toLowerCase().includes("multi-home") && !c.switching_or_multihoming_path.toLowerCase().includes("switching cost")) {
      warnings.push(`Customer group '${c.customer_group}' can multi-home but switching cost is not explicitly addressed.`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateBusinessProcessMap(content: unknown): ValidationResult {
  const parsed = BusinessProcessMap.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  for (const node of data.process_nodes) {
    // C8-T5: Revenue and cash collection treated as simultaneous without evidence
    const isSimultaneous = node.time_lag.toLowerCase().includes("simultaneous") || node.time_lag.toLowerCase().includes("immediate") || node.time_lag === "0" || node.time_lag.toLowerCase().includes("none");
    if (isSimultaneous && node.supporting_claim_ids.length < 2) {
      errors.push(`Process node '${node.process_node}' treats revenue and cash collection as simultaneous without sufficient evidence claims.`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateBottleneckRegister(content: unknown): ValidationResult {
  const parsed = BottleneckRegister.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  return { valid: errors.length === 0, errors, warnings };
}

/** A scenario in which share shifts away from someone: "loses share", "share loss", "share erosion" and similar. */
const MARKET_SHARE_LOSS = /\b(los(e|es|ing|t)|ced(e|es|ing)|giv(e|es|ing) up)\b[^.]{0,30}\b(market )?share\b|\b(market )?share (loss|losses|erosion|decline|reduction|shift)\b|market share reduction/i;

export function validateCompetitiveResponseMatrix(content: unknown): ValidationResult {
  const parsed = CompetitiveResponseMatrix.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  for (const comp of data.competitors) {
    // C8-T6: Competitor loses share but no response is modeled
    const hasMarketShareLossScenario = comp.response_scenarios.some((s) => MARKET_SHARE_LOSS.test(`${s.scenario_name} ${s.threat_description}`));
    if (comp.market_share !== null && comp.market_share > 0.1 && !hasMarketShareLossScenario) {
      errors.push(`Competitor '${comp.competitor_name}' has significant market share (${comp.market_share * 100}%) but no market share loss response scenario is modeled.`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Each axis once. A score needs a computed path or a cited claim, and governance needs a cited claim (share classes,
 * voting control, board): code can compute capital returns, but not governance.
 */
export function validateManagementAssessment(content: unknown): ValidationResult {
  const parsed = ManagementAssessment.safeParse(content);
  if (!parsed.success) return { valid: false, errors: parsed.error.issues.map((e) => e.message), warnings: [] };
  const errors: string[] = [];
  const axes = parsed.data.axes.map((a) => a.axis);
  for (const axis of MANAGEMENT_AXES) if (axes.filter((a) => a === axis).length !== 1) errors.push(`management_assessment must score ${axis} exactly once.`);
  for (const a of parsed.data.axes) {
    if (a.score === null) continue;
    if (!a.analytics_paths.length && !a.supporting_claim_ids.length) errors.push(`${a.axis} is scored without an analytics path or a cited claim; cite one or leave the score null.`);
    if (a.axis === "governance_alignment" && !a.supporting_claim_ids.length) errors.push("governance_alignment is scored without a cited claim on control or the board; leave it null when none is supplied.");
  }
  return { valid: errors.length === 0, errors, warnings: [] };
}
