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
  calculateProbabilityWeightedReturn,
  buildFourQuarterMetricTrends,
  deriveExpectedReturnMatrix,
  inferPredictionPriceFromTargetPath,
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
  it("derives a reconciled expected-return matrix from accepted valuation targets", () => {
    const matrix = deriveExpectedReturnMatrix({
      scenarioSet: { probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25 },
      priceTargetPath: {
        currency: "USD",
        price_target_path: [
          { fiscal_year: 2027, scenario_type: "bear", price_target: 8, dividend_per_share: 0 },
          { fiscal_year: 2027, scenario_type: "base", price_target: 12, dividend_per_share: 0 },
          { fiscal_year: 2027, scenario_type: "bull", price_target: 16, dividend_per_share: 0 },
        ],
      },
      currentPrice: 10,
      predictionDate: "2026-08-24",
    });
    assert.equal(matrix.bear_return, -0.2);
    assert.equal(matrix.base_return, 0.2);
    assert.equal(matrix.bull_return, 0.6);
    assert.equal(matrix.probability_weighted_return, 0.2);
    assert.equal(matrix.rows.length, 3);
  });

  it("keeps the latest four observations for each monitoring metric", () => {
    const trends = buildFourQuarterMetricTrends([1, 2, 3, 4, 5].map((value) => ({
      metric_key: "members",
      period_end: `2025-0${value + 1}-30`,
      value,
      unit: "count",
    })));
    assert.deepEqual(trends.members.map((row) => row.value), [2, 3, 4, 5]);
  });

  it("recovers a common prediction price from accepted valuation returns", () => {
    assert.equal(inferPredictionPriceFromTargetPath({ price_target_path: [
      { price_target: 8, dividend_per_share: 0, total_return_target: -0.2 },
      { price_target: 12, dividend_per_share: 0, total_return_target: 0.2 },
      { price_target: 16, dividend_per_share: 0, total_return_target: 0.6 },
    ] }), 10);
    assert.throws(() => inferPredictionPriceFromTargetPath({ price_target_path: [
      { price_target: 8, total_return_target: -0.2 },
      { price_target: 12, total_return_target: 0.5 },
    ] }), /inconsistent prediction prices/);
  });

  it("calculates the scenario-probability weighted return deterministically", () => {
    assert.equal(calculateProbabilityWeightedReturn(
      { bear_return: -0.6754, base_return: 0.8932, bull_return: 2.2466 },
      { probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25 }
    ), 0.8394);
  });

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
          metric_key: "fintech_take_rate",
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

  it("rejects adjacent repeated words in the decision rationale", () => {
    const record: DecisionRecord = {
      artifact_type: "decision_record",
      decision: "pending",
      rationale: "The decision remains pending pending human review.",
    };
    const result = validateDecisionRecord(record);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("adjacent repeated word")));
  });
});
