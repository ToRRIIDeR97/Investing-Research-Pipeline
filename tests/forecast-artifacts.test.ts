import { describe, it } from "node:test";
import assert from "node:assert";
import {
  validateDriverTree,
  validateOperatingScenarioSet,
  validateOperatingModel,
  validateTopDownBottomUpReconciliation,
} from "@/lib/research/forecast/validation";
import type {
  DriverTree,
  OperatingScenarioSet,
  OperatingModel,
  TopDownBottomUpReconciliation,
} from "@/lib/research/forecast/contracts";

describe("operating forecasts and scenarios (Component 10)", () => {
  it("C10-T1: Revenue CAGR without driver decomposition is rejected", () => {
    const tree: DriverTree = {
      artifact_type: "driver_tree",
      drivers: [
        {
          driver_key: "Marketplace Revenue",
          formula_decomposition: "CAGR", // direct CAGR
          historical_metric_key: "marketplace_revenue",
          historical_diagnosis_key: "diag-1",
          process_node_key: "node-1",
          assumption_key: "assump-1",
          time_lag: "1 month",
          failure_condition: "Competition",
          financial_line_affected: "Revenue",
        },
      ],
    };
    const result = validateDriverTree(tree);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("without operational driver decomposition")));
  });

  it("C10-T2: Bear case is blanket 20% reduction of base case is rejected", () => {
    const set: OperatingScenarioSet = {
      artifact_type: "operating_scenario_set",
      probability_bear: 0.2,
      probability_base: 0.6,
      probability_bull: 0.2,
      scenarios: [
        {
          scenario_type: "bear",
          end_market: "Weak demand",
          customer_economics: "Stretched",
          customer_spending: "Declining",
          competitive_response: "Aggressive",
          capacity: "Unchanged",
          pricing_mix: "Lower take rate",
          moat_state: "Stable",
          margin_formation: "Lower operating leverage",
          reinvestment: "Reduced capex",
          working_capital: "Deteriorating",
          balance_sheet: "Leveraged",
          resulting_financial_statements_json: {},
          revenue_cagr: 0.08, // 8% is exactly 0.8 * 10%
          operating_margin: 0.16, // 16% is exactly 0.8 * 20%
        },
        {
          scenario_type: "base",
          end_market: "Normal demand",
          customer_economics: "Stable",
          customer_spending: "Stable",
          competitive_response: "Standard",
          capacity: "Expanding",
          pricing_mix: "Stable take rate",
          moat_state: "Stable",
          margin_formation: "Stable operating leverage",
          reinvestment: "Normal capex",
          working_capital: "Stable",
          balance_sheet: "Healthy",
          resulting_financial_statements_json: {},
          revenue_cagr: 0.10,
          operating_margin: 0.20,
        },
        {
          scenario_type: "bull",
          end_market: "Strong demand",
          customer_economics: "Excellent",
          customer_spending: "Rising",
          competitive_response: "Passive",
          capacity: "Rapid expansion",
          pricing_mix: "Higher take rate",
          moat_state: "Stronger",
          margin_formation: "Expanding leverage",
          reinvestment: "Aggressive capex",
          working_capital: "Favorable",
          balance_sheet: "Cash-rich",
          resulting_financial_statements_json: {},
        },
      ],
    };
    const result = validateOperatingScenarioSet(set);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("blanket 20% reduction")));
  });

  it("C10-T3: Scenario probabilities total 0.95 or 1.05 fails", () => {
    const set: OperatingScenarioSet = {
      artifact_type: "operating_scenario_set",
      probability_bear: 0.15,
      probability_base: 0.70,
      probability_bull: 0.10, // sums to 0.95
      scenarios: [
        {
          scenario_type: "bear",
          end_market: "Weak",
          customer_economics: "Poor",
          customer_spending: "Low",
          competitive_response: "Match price",
          capacity: "Static",
          pricing_mix: "Poor",
          moat_state: "Decaying",
          margin_formation: "Poor",
          reinvestment: "Low",
          working_capital: "Slow",
          balance_sheet: "Weak",
          resulting_financial_statements_json: {},
        },
        {
          scenario_type: "base",
          end_market: "Normal",
          customer_economics: "Stable",
          customer_spending: "Flat",
          competitive_response: "None",
          capacity: "Stable",
          pricing_mix: "Stable",
          moat_state: "Stable",
          margin_formation: "Flat",
          reinvestment: "Flat",
          working_capital: "Flat",
          balance_sheet: "Stable",
          resulting_financial_statements_json: {},
        },
        {
          scenario_type: "bull",
          end_market: "Strong",
          customer_economics: "Strong",
          customer_spending: "High",
          competitive_response: "None",
          capacity: "Growing",
          pricing_mix: "Strong",
          moat_state: "Growing",
          margin_formation: "Leverage",
          reinvestment: "High",
          working_capital: "Strong",
          balance_sheet: "Strong",
          resulting_financial_statements_json: {},
        },
      ],
    };
    const result = validateOperatingScenarioSet(set);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("must total exactly 1.0")));
  });

  it("C10-T4: Segment revenue does not equal consolidated revenue fails", () => {
    const model: OperatingModel = {
      artifact_type: "operating_model",
      segments: [
        { segment_name: "Commerce", forecast_revenue: 100, forecast_operating_income: 15 },
        { segment_name: "Fintech", forecast_revenue: 80, forecast_operating_income: 10 },
      ],
      consolidated_revenue: 200, // segment sum is 180, doesn't match 200
      consolidated_operating_income: 25,
      credit_capital_required: 0,
      balance_sheet_effect_present: false,
    };
    const result = validateOperatingModel(model);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("does not reconcile")));
  });

  it("C10-T5: Forecast exceeds TAM or customer budget fails", () => {
    const recon: TopDownBottomUpReconciliation = {
      artifact_type: "top_down_bottom_up_reconciliation",
      top_down_forecast_total: 100,
      bottom_up_forecast_total: 150, // exceeds TAM and budget
      tam_limit: 120,
      customer_budget_limit: 110,
    };
    const result = validateTopDownBottomUpReconciliation(recon);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("exceeds the TAM limit")));
    assert.ok(result.errors.some((e) => e.includes("exceeds the customer budget limit")));
  });

  it("C10-T6: Growth requires credit capital but no balance-sheet effect exists fails", () => {
    const model: OperatingModel = {
      artifact_type: "operating_model",
      segments: [
        { segment_name: "Commerce", forecast_revenue: 100, forecast_operating_income: 15 },
        { segment_name: "Fintech", forecast_revenue: 100, forecast_operating_income: 10 },
      ],
      consolidated_revenue: 200,
      consolidated_operating_income: 25,
      credit_capital_required: 50, // requires credit capital
      balance_sheet_effect_present: false, // but no balance-sheet effect modeled
    };
    const result = validateOperatingModel(model);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("requires credit capital but models no corresponding balance-sheet effect")));
  });

  it("C10-T7: Bull case assumes stronger moat and lower maintenance spend fails", () => {
    const set: OperatingScenarioSet = {
      artifact_type: "operating_scenario_set",
      probability_bear: 0.2,
      probability_base: 0.6,
      probability_bull: 0.2,
      scenarios: [
        {
          scenario_type: "bear",
          end_market: "Weak",
          customer_economics: "Poor",
          customer_spending: "Low",
          competitive_response: "Match price",
          capacity: "Static",
          pricing_mix: "Poor",
          moat_state: "Decaying",
          margin_formation: "Poor",
          reinvestment: "Low",
          working_capital: "Slow",
          balance_sheet: "Weak",
          resulting_financial_statements_json: {},
        },
        {
          scenario_type: "base",
          end_market: "Normal",
          customer_economics: "Stable",
          customer_spending: "Flat",
          competitive_response: "None",
          capacity: "Stable",
          pricing_mix: "Stable",
          moat_state: "Stable",
          margin_formation: "Flat",
          reinvestment: "Flat",
          working_capital: "Flat",
          balance_sheet: "Stable",
          resulting_financial_statements_json: {},
          maintenance_spend: 100,
        },
        {
          scenario_type: "bull",
          end_market: "Strong",
          customer_economics: "Strong",
          customer_spending: "High",
          competitive_response: "None",
          capacity: "Growing",
          pricing_mix: "Strong",
          moat_state: "Stronger brand", // stronger moat
          margin_formation: "Leverage",
          reinvestment: "High",
          working_capital: "Strong",
          balance_sheet: "Strong",
          resulting_financial_statements_json: {},
          maintenance_spend: 50, // but lower maintenance spend than base
        },
      ],
    };
    const result = validateOperatingScenarioSet(set);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("assumes a stronger/expanding moat but models lower maintenance spending")));
  });
});
