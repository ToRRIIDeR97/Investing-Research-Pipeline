import { describe, it } from "node:test";
import assert from "node:assert";
import {
  validateAnnualPriceTargetPath,
} from "@/lib/research/valuation/validation";
import type {
  AnnualPriceTargetPath,
} from "@/lib/research/valuation/contracts";

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
});
