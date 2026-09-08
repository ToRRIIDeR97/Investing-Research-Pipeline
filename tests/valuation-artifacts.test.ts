import { describe, it } from "node:test";
import assert from "node:assert";
import {
  validateAnnualPriceTargetPath,
  validateReverseValuation,
} from "@/lib/research/valuation/validation";
import type {
  AnnualPriceTargetPath,
} from "@/lib/research/valuation/contracts";
import { missingRequiredValuationMethods } from "@/lib/research/valuation/contracts";
import {
  buildValuationInputManifest,
  deriveAnnualPriceTargetPath,
  deriveValuationExpectedReturns,
  reconcileValuationMethods,
} from "@/lib/research/valuation/checkpoints";

const baseProjection = () => [
  {
    fiscal_year: 2025,
    target_date: "2025-12-31",
    operating_values: { revenue: 100, eps: 5, fcf: 4 },
    balance_sheet_values: { net_debt: 20 },
    per_share_values: { shares: 10, eps: 5 },
  },
  {
    fiscal_year: 2026,
    target_date: "2026-12-31",
    operating_values: { revenue: 110, eps: 6, fcf: 5 },
    balance_sheet_values: { net_debt: 15 },
    per_share_values: { shares: 10, eps: 6 },
  },
];

const baseTargetPath = (): AnnualPriceTargetPath => ({
  artifact_type: "annual_price_target_path",
  currency: "USD",
  market_price_currency: "USD",
  annual_projections: baseProjection(),
  price_target_path: [
    {
      fiscal_year: 2025,
      scenario_type: "bear",
      valuation_method: "P/E",
      operating_metric_key: "eps",
      operating_metric_value: 5,
      valuation_parameter_key: "multiple",
      valuation_parameter_value: 15,
      price_target: 75,
      dividend_per_share: 0,
      total_return_target: 75,
      is_interpolated: false,
    },
    {
      fiscal_year: 2026,
      scenario_type: "bear",
      valuation_method: "P/E",
      operating_metric_key: "eps",
      operating_metric_value: 6,
      valuation_parameter_key: "multiple",
      valuation_parameter_value: 15,
      price_target: 90,
      dividend_per_share: 0,
      total_return_target: 90,
      is_interpolated: false,
    },
  ],
});

describe("valuation annual price paths (Component 11)", () => {
  it("C11-T1: P/E path with known EPS and multiples computes exact targets", () => {
    const path = baseTargetPath();
    const result = validateAnnualPriceTargetPath(path);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it("C11-T5: Missing intermediate forecast year fails", () => {
    const path = baseTargetPath();
    // remove 2025 to create a gap if we had 2024 and 2026
    path.price_target_path = [
      {
        fiscal_year: 2024,
        scenario_type: "bear",
        valuation_method: "P/E",
        operating_metric_key: "eps",
        operating_metric_value: 4,
        valuation_parameter_key: "multiple",
        valuation_parameter_value: 15,
        price_target: 60,
        dividend_per_share: 0,
        total_return_target: 60,
        is_interpolated: false,
      },
      {
        fiscal_year: 2026,
        scenario_type: "bear",
        valuation_method: "P/E",
        operating_metric_key: "eps",
        operating_metric_value: 6,
        valuation_parameter_key: "multiple",
        valuation_parameter_value: 15,
        price_target: 90,
        dividend_per_share: 0,
        total_return_target: 90,
        is_interpolated: false,
      },
    ];
    const result = validateAnnualPriceTargetPath(path);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("Missing intermediate forecast year: 2025")));
  });

  it("C11-T6: Final-year path differs from terminal anchor fails", () => {
    const path = baseTargetPath();
    const scenarioSet = {
      terminal_year: 2026,
      terminal_anchor_bear: 100, // path final-year bear is 90
      terminal_anchor_base: 150,
      terminal_anchor_bull: 200,
      uses_adjusted_fcf: true,
      segments_reconciled: true,
    };
    // Make sure we have base and bull final year entries too
    path.price_target_path.push(
      {
        fiscal_year: 2026,
        scenario_type: "base",
        valuation_method: "P/E",
        operating_metric_key: "eps",
        operating_metric_value: 8,
        valuation_parameter_key: "multiple",
        valuation_parameter_value: 20,
        price_target: 150,
        dividend_per_share: 0,
        total_return_target: 150,
        is_interpolated: false,
      },
      {
        fiscal_year: 2026,
        scenario_type: "bull",
        valuation_method: "P/E",
        operating_metric_key: "eps",
        operating_metric_value: 10,
        valuation_parameter_key: "multiple",
        valuation_parameter_value: 25,
        price_target: 200,
        dividend_per_share: 0,
        total_return_target: 200,
        is_interpolated: false,
      }
    );
    const result = validateAnnualPriceTargetPath(path, scenarioSet);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("differs from terminal anchor")));
  });

  it("C11-T7: Linear interpolation fails", () => {
    const path = baseTargetPath();
    path.price_target_path[1].is_interpolated = true;
    const result = validateAnnualPriceTargetPath(path);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("linearly interpolated")));
  });

  it("C11-T9: Bear case declines then recovers is accepted (non-monotonicity allowed)", () => {
    const path = baseTargetPath();
    path.price_target_path[0].price_target = 80;
    path.price_target_path[1].price_target = 70; // declines, which is allowed
    const result = validateAnnualPriceTargetPath(path);
    assert.equal(result.valid, true);
  });

  it("C11-T10: Scenario currency differs from market price currency fails", () => {
    const path = baseTargetPath();
    path.currency = "BRL"; // differs from USD
    const result = validateAnnualPriceTargetPath(path);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("differs from market price currency")));
  });

  it("requires cumulative returns from the current market price", () => {
    const path = baseTargetPath();
    path.price_target_path[0].total_return_target = -0.25;
    path.price_target_path[1].total_return_target = -0.1;
    const valid = validateAnnualPriceTargetPath(path, undefined, 100);
    assert.equal(valid.valid, true);

    path.price_target_path[1].total_return_target = 0.2;
    const invalid = validateAnnualPriceTargetPath(path, undefined, 100);
    assert.equal(invalid.valid, false);
    assert.ok(invalid.errors.some((e) => e.includes("must be cumulative")));
  });

  it("C11-T13: FCF method blocked if unadjusted FCF is used", () => {
    const path = baseTargetPath();
    path.price_target_path[0].valuation_method = "FCF yield";
    const scenarioSet = {
      terminal_year: 2026,
      terminal_anchor_bear: 90,
      terminal_anchor_base: 150,
      terminal_anchor_bull: 200,
      uses_adjusted_fcf: false, // unadjusted FCF used
      segments_reconciled: true,
    };
    const result = validateAnnualPriceTargetPath(path, scenarioSet);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("blocked because unadjusted FCF is used")));
  });

  it("C11-T14: SOTP method blocked if segment assumptions do not reconcile", () => {
    const path = baseTargetPath();
    path.price_target_path[0].valuation_method = "SOTP parts";
    const scenarioSet = {
      terminal_year: 2026,
      terminal_anchor_bear: 90,
      terminal_anchor_base: 150,
      terminal_anchor_bull: 200,
      uses_adjusted_fcf: true,
      segments_reconciled: false, // not reconciled
    };
    const result = validateAnnualPriceTargetPath(path, scenarioSet);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("blocked because segment assumptions do not reconcile")));
  });

  it("requires the profile's valuation method rather than accepting a proxy", () => {
    const path = baseTargetPath();
    assert.deepEqual(missingRequiredValuationMethods(["residual_income"], path.price_target_path), ["residual_income"]);
    path.price_target_path[0].valuation_method = "Residual Income";
    assert.deepEqual(missingRequiredValuationMethods(["residual_income"], path.price_target_path), []);
  });

  it("requires the ROE-versus-cost-of-equity spread to reconcile", () => {
    const valid = validateReverseValuation({
      artifact_type: "reverse_valuation",
      implied_growth: 0.15,
      implied_margin: 0.2,
      return_on_equity: 0.14,
      cost_of_equity: 0.1,
      roe_minus_cost_of_equity: 0.04,
      roe_vs_coe_assessment: "ROE exceeds the cost of equity, supporting book-value compounding.",
    });
    assert.equal(valid.valid, true);

    const invalid = validateReverseValuation({
      artifact_type: "reverse_valuation",
      implied_growth: 0.15,
      implied_margin: 0.2,
      return_on_equity: 0.14,
      cost_of_equity: 0.1,
      roe_minus_cost_of_equity: 0.08,
      roe_vs_coe_assessment: "Inconsistent spread.",
    });
    assert.equal(invalid.valid, false);
    assert.ok(invalid.errors.some((error) => error.includes("ROE-minus-cost-of-equity")));
  });
});

describe("valuation checkpoints", () => {
  const upstream = [{
    id: "scenario-artifact",
    artifactType: "operating_scenario_set",
    schemaVersion: "3.0.0",
    content: {},
  }];

  it("hashes a sorted manifest and rejects incompatible duplicate units", () => {
    const rows = [
      { id: "2", metric_key: "revenue", period_end: "2025-03-31", value_numeric: 20, unit: "USD", currency: "USD" },
      { id: "1", metric_key: "revenue", period_end: "2024-12-31", value_numeric: 10, unit: "USD", currency: "USD" },
    ];
    const make = (metricRows: any[]) => buildValuationInputManifest({
      runId: "run", marketSnapshot: { regular_market_price: 10, currency: "USD", retrieved_at: "2026-01-01" },
      metricRows, operatingScenarioSet: { probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25 },
      requiredMethods: ["dcf"], upstreamArtifacts: upstream,
    });
    assert.equal(make(rows).input_manifest_hash, make([...rows].reverse()).input_manifest_hash);
    assert.equal(make(rows).executionMetrics.find((metric) => metric.metricKey === "revenue")?.value, 20);
    assert.throws(() => make([...rows, { ...rows[0], id: "3", unit: "shares" }]), /incompatible duplicate units/);
  });

  it("reconciles executed anchors and derives reproducible targets and returns", () => {
    const execution = {
      valid: true,
      scenarios: [
        { scenarioType: "bear", valueAnchor: 8 },
        { scenarioType: "base", valueAnchor: 12 },
        { scenarioType: "bull", valueAnchor: 16 },
      ],
    } as any;
    const scenarioSet = reconcileValuationMethods({
      methods: new Map([["dcf", execution]]), requiredMethods: ["dcf"], primaryMethod: "dcf",
      operatingScenarioSet: { probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25 },
      terminalYear: 2028,
    });
    const path = deriveAnnualPriceTargetPath({ scenarioSet, currentMarketPrice: 10, currency: "USD", primaryMethod: "dcf", startYear: 2027 });
    const final = path.price_target_path.filter((row) => row.fiscal_year === 2028);
    assert.deepEqual(final.map((row) => row.price_target), [8, 12, 16]);
    assert.equal(validateAnnualPriceTargetPath(path, scenarioSet, 10).valid, true);
    const returns = deriveValuationExpectedReturns({ scenarioSet, priceTargetPath: path, currentPrice: 10, predictionDate: "2026-01-01" });
    assert.equal(returns.artifact_type, "expected_return_matrix");
    assert.equal(returns.probability_weighted_return, 0.087558);
  });
});
