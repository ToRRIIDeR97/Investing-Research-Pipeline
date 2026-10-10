import { describe, it } from "node:test";
import assert from "node:assert";
import {
  validateInvestmentThesis,
  validateRiskRegister,
  validateCatalystRegister,
  validateExpectedReturnMatrix,
  validateThesisBreakers,
  validateMonitoringDashboard,
  validateDecisionRecord,
  WITHHELD_VALUATION_LINKAGE,
} from "@/lib/research/decision/validation";
import type {
  InvestmentThesis,
  RiskRegister,
  CatalystRegister,
  ExpectedReturnMatrix,
  ThesisBreakers,
  MonitoringDashboard,
  DecisionRecord,
} from "@/lib/research/decision/contracts";

const uuid1 = "00000000-0000-0000-0000-000000000001";

describe("investment decision artifacts (Component 12)", () => {
  it("C12-T1: Source gap submitted as operating risk without mechanism is rejected", () => {
    const reg: RiskRegister = {
      artifact_type: "risk_register",
      risks: [
        {
          risk_name: "Missing 10-Q filing",
          causal_mechanism: "Filing was not retrieved.",
          probability: 0.1,
          severity: 2,
          exposure: 0.2,
          leading_indicator: "Retrieval log",
          failure_threshold: "Filing date past",
          financial_consequence: "None directly",
          model_input_affected: "None",
          mitigants: ["Wait for filing"],
          supporting_claim_ids: [uuid1],
          confidence: 0.9,
          is_source_gap_only: true, // source gap only
        },
      ],
    };
    const result = validateRiskRegister(reg);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("classified as a source gap only")));
  });

  it("C12-T2: Business driver submitted as catalyst without event is rejected", () => {
    const reg: CatalystRegister = {
      artifact_type: "catalyst_register",
      catalysts: [
        {
          catalyst_name: "Steady customer growth",
          expected_date_range: "Continuous",
          event_mechanism: "More merchants adopt platform over time.",
          probability: 0.8,
          direction: "upside",
          model_input_affected: "active_buyers",
          evidence: "Historical growth trend",
          is_business_driver_only: true, // driver only, not catalyst event
        },
      ],
    };
    const result = validateCatalystRegister(reg);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("continuous business driver without an event")));
  });

  it("C12-T3: Thesis generated before accepted valuation fails", () => {
    const thesis: InvestmentThesis = {
      artifact_type: "investment_thesis",
      thesis_statement: "MELI is undervalued.",
      causal_chain: "E-commerce growth drives fintech monetization.",
      market_mispricing: "Market underestimates fintech growth.",
      must_be_true: ["Fintech grows >30%"],
      disproving_evidence: ["Fintech growth <20%"],
      horizon: "3 years",
      expected_return_linkage: "Upside base returns of 20% CAGR",
      valuation_accepted_first: false, // valuation not accepted first
    };
    const result = validateInvestmentThesis(thesis);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("cannot be finalized before the valuation is accepted")));
  });

  it("C12-T3b: Thesis may stand as a withheld conclusion when the valuation was withheld", () => {
    const thesis: InvestmentThesis = {
      artifact_type: "investment_thesis",
      thesis_statement: "META's growth is intact but reinvestment absorbs cash.",
      causal_chain: "Ad growth funds AI capex.",
      market_mispricing: "Not established without a valuation.",
      must_be_true: ["Family of Apps growth stays above 12%"],
      disproving_evidence: ["Capex above operating cash flow for two years"],
      horizon: "3 years",
      expected_return_linkage: `${WITHHELD_VALUATION_LINKAGE} Discount rate and multi-year scenarios are not sourced.`,
      valuation_accepted_first: false,
    };
    assert.equal(validateInvestmentThesis(thesis).valid, true);
    const notWithheld = { ...thesis, expected_return_linkage: "Valuation withheld but no marker." };
    assert.equal(validateInvestmentThesis(notWithheld).valid, false);
  });

  it("C12-T4: Thesis breaker lacks threshold is rejected", () => {
    const breakers: ThesisBreakers = {
      artifact_type: "thesis_breakers",
      breakers: [
        {
          name: "Fintech growth slow down",
          threshold: "", // empty threshold
          model_consequence: "Base case revenue growth reduced to 15%",
        },
      ],
    };
    const result = validateThesisBreakers(breakers);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("lacks a measurable threshold")));
  });

  it("C12-T5: Monitoring KPI has no model input is rejected", () => {
    const dash: MonitoringDashboard = {
      artifact_type: "monitoring_dashboard",
      items: [
        {
          kpi: "Fintech take rate",
          process_node: "Payments processing",
          current_level: 0.038,
          bear_threshold: 0.032,
          base_range: "0.035-0.040",
          bull_threshold: 0.042,
          reporting_frequency: "Quarterly",
          model_input_affected: "", // empty model input link
          source_role: "regulatory_filing",
        },
      ],
    };
    const result = validateMonitoringDashboard(dash);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("lacks an affected model input link")));
  });

  it("C12-T6: Expected return omits dilution is rejected", () => {
    const matrix: ExpectedReturnMatrix = {
      artifact_type: "expected_return_matrix",
      bear_return: -0.15,
      base_return: 0.15,
      bull_return: 0.40,
      probability_weighted_return: 0.12,
      no_rerating_return: 0.08,
      weak_stock_outcome: 0.02,
      permanent_loss_limit: -0.30,
      dilution_omitted: true, // dilution omitted
    };
    const result = validateExpectedReturnMatrix(matrix);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("cannot omit dilution effects")));
  });

  it("C12-T8: Decision approved without human record is blocked", () => {
    const record: DecisionRecord = {
      artifact_type: "decision_record",
      decision: "approve",
      rationale: "Thesis remains valid and valuation is attractive.",
      // human_approved_by omitted
    };
    const result = validateDecisionRecord(record);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("cannot be approved without a human approver name")));
  });
});
