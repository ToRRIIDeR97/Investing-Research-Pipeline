import { describe, it } from "node:test";
import assert from "node:assert";
import { hasDepreciationInputs, valuationFinancialInputs } from "@/lib/research/valuation/financial-inputs";
import { cashFlowBuildErrors } from "@/lib/research/valuation/schedules";
import { withheldValuationReason } from "@/lib/research/valuation/contracts";
import { evaluateQualityGates, VALUATION_WITHHELD_KEY } from "@/lib/workflow/quality-gates";
import { generateMarkdownReport } from "@/lib/export/report-generator";
import { valuationSummary } from "@/lib/research/reporting/valuation-summary";

const obs = (metric_key: string, period_end: string, value: number, extra: Record<string, unknown> = {}) => ({
  metric_key, period_end, value_numeric: value, periodicity: "quarterly", fiscal_year: Number(period_end.slice(0, 4)),
  fiscal_quarter: Math.ceil(Number(period_end.slice(5, 7)) / 3), currency: "USD", unit: "USD", segment: null,
  available_at: period_end, restatement_version: 0, metadata_json: {}, ...extra,
});

describe("valuation financial inputs", () => {
  const quarters = ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"];
  const statements = quarters.flatMap((end, i) => [
    obs("revenue", end, (40 + i) * 1e9),
    obs("us_gaap_DepreciationDepletionAndAmortization", end, 4e9),
    obs("us_gaap_OperatingLeaseLiabilityCurrent", end, 2e9),
    obs("us_gaap_OperatingLeaseLiabilityNoncurrent", end, 18e9),
    obs("us_gaap_WeightedAverageNumberOfDilutedSharesOutstanding", end, 2.566e9, { unit: "shares", currency: null }),
  ]).concat([
    obs("revenue", "2026-06-30", 47e9, { segment: "meta:FamilyOfAppsMember" }),
    obs("revenue", "2026-06-30", 61e9, { restatement_version: 1, available_at: "2026-07-30" }),
    obs("revenue", "2026-09-30", 70e9, { available_at: "2026-10-30" }),
    obs("revenue", "2025-12-31", 200e9, { periodicity: "annual", fiscal_quarter: null }),
  ]);
  const market = [
    { metric_key: "period_end_share_price", period_end: "2026-06-30", periodicity: "quarterly", value_numeric: 563.29,
      available_at: "2026-07-01", metadata_json: { metric_category: "market_data", verified: false } },
    { metric_key: "market_cap", period_end: "2026-06-30", periodicity: "quarterly", value_numeric: 1.4352e12,
      available_at: "2026-07-30", metadata_json: { metric_category: "market_data" } },
  ];
  const inputs = valuationFinancialInputs({
    statementObservations: statements, marketObservations: market,
    marketCrossCheck: { provider: "stooq", verified_periods: 0, unverified_periods: 1 }, cutoff: new Date("2026-10-10"),
  })!;
  const cell = (row: unknown[], column: string) => row[inputs.columns.indexOf(column)];

  it("builds chronological consolidated rows in millions, point-in-time", () => {
    assert.deepStrictEqual(inputs.quarterly.map((row) => row[0]), quarters);
    const last = inputs.quarterly.at(-1)!;
    assert.strictEqual(cell(last, "revenue"), 61000, "the latest restatement wins; segment rows are excluded");
    assert.strictEqual(cell(last, "operating_lease_liabilities"), 20000, "split lease balances are summed");
    assert.strictEqual(cell(last, "diluted_shares"), 2566);
    assert.strictEqual(cell(last, "period_end_close"), 563.29);
    assert.strictEqual(cell(last, "market_cap"), 1435200);
    assert.strictEqual(cell(last, "price_verified"), false);
    assert.strictEqual(cell(inputs.quarterly[0], "period_end_close"), null);
    assert.deepStrictEqual(inputs.annual.map((row) => [row[0], cell(row, "revenue")]), [["2025-12-31", 200000]]);
    assert.ok(!inputs.quarterly.some((row) => row[0] === "2026-09-30"), "a period filed after the cutoff is excluded");
  });

  it("names columns that were not captured instead of sending empty ones", () => {
    assert.ok(inputs.not_captured.includes("capital_expenditures"));
    assert.ok(!inputs.columns.includes("capital_expenditures"));
    assert.ok(hasDepreciationInputs(inputs));
    assert.strictEqual(inputs.currency, "USD");
    assert.deepStrictEqual(inputs.price_cross_check, { provider: "stooq", verified_periods: 0, unverified_periods: 1 });
  });

  it("serializes identically for identical inputs", () => {
    const again = valuationFinancialInputs({
      statementObservations: [...statements].reverse(), marketObservations: market,
      marketCrossCheck: { provider: "stooq", verified_periods: 0, unverified_periods: 1 }, cutoff: new Date("2026-10-10"),
    });
    assert.strictEqual(JSON.stringify(again), JSON.stringify(inputs));
  });

  it("returns null without captured statements", () => {
    assert.strictEqual(valuationFinancialInputs({ statementObservations: [], cutoff: new Date("2026-10-10") }), null);
    assert.strictEqual(hasDepreciationInputs(null), false);
  });
});

describe("cash-flow build check", () => {
  const model = (years: unknown[], extra: Record<string, unknown> = {}) => ({
    method: "fcff", scenario_type: "base", cash_flow_label: "FCFF", rationale: "Driver-based", years, ...extra,
  });

  it("accepts a reconciled build with a D&A add-back", () => {
    const build = { starting_profit: 60000, depreciation_amortization: 20000, capital_expenditures: 70000, change_in_net_working_capital: 1000, other_adjustments: 0 };
    assert.deepStrictEqual(cashFlowBuildErrors([model([{ fiscal_year: 2026, cash_flow: 9000, build }])]), []);
  });

  it("rejects the capex-only proxy from the failed run", () => {
    const errors = cashFlowBuildErrors([model([{ fiscal_year: 2026, cash_flow: -53700 }],
      { cash_flow_label: "FCFF proxy: after-tax operating income less capex, no D&A add-back" })]);
    assert.ok(errors.some((e) => /omits the D&A add-back/.test(e.message)));
    assert.ok(errors.some((e) => /needs build/.test(e.message)));
  });

  it("rejects a zero add-back and a cash flow that does not match its build", () => {
    const build = { starting_profit: 60000, depreciation_amortization: 0, capital_expenditures: 70000, change_in_net_working_capital: 0, other_adjustments: 0 };
    const errors = cashFlowBuildErrors([model([{ fiscal_year: 2026, cash_flow: 5000, build }])]);
    assert.ok(errors.some((e) => /positive depreciation_amortization/.test(e.message)));
    assert.ok(errors.some((e) => /does not equal its build/.test(e.message)));
  });

  it("ignores equity exit and dividend methods", () => {
    assert.deepStrictEqual(cashFlowBuildErrors([{ method: "earnings_exit", years: [{ fiscal_year: 2026, cash_flow: 1 }] }]), []);
  });
});

describe("withheld valuation", () => {
  const withheld = {
    artifact_type: "valuation_scenario_set", valuation_status: "withheld",
    terminal_anchor_bear: 0, terminal_anchor_base: 0, terminal_anchor_bull: 0,
    withheld_reason: "No FY2027-FY2035 cash-flow schedule.",
  };

  it("is recognized only with status withheld, all-zero anchors and a reason", () => {
    assert.strictEqual(withheldValuationReason(withheld), "No FY2027-FY2035 cash-flow schedule.");
    assert.strictEqual(withheldValuationReason({ ...withheld, withheld_reason: undefined, terminal_anchor_note: "Withheld markers." }), "Withheld markers.");
    assert.strictEqual(withheldValuationReason({ ...withheld, terminal_anchor_base: 12 }), null);
    assert.strictEqual(withheldValuationReason({ ...withheld, valuation_status: undefined }), null);
    assert.strictEqual(withheldValuationReason({ ...withheld, withheld_reason: " " }), null);
  });

  it("labels the anchor gaps as withheld and keeps them blocking completion", () => {
    const quality = evaluateQualityGates({
      run: { run_type: "deep_dive" },
      artifacts: [{ artifact_type: "valuation_scenario_set", status: "validated", content_json: withheld }],
    });
    const items = quality.missingCoverage.filter((item) => item.key === VALUATION_WITHHELD_KEY);
    assert.strictEqual(items.length, 2);
    assert.ok(items.every((item) => item.requiredForCompletion && /withheld/i.test(item.description)));
    assert.notStrictEqual(quality.status, "pass");
    const plain = evaluateQualityGates({ run: { run_type: "deep_dive" } });
    assert.ok(!plain.missingCoverage.some((item) => item.key === VALUATION_WITHHELD_KEY));
  });

  it("gives the report valuation view no zero price targets", () => {
    assert.strictEqual(valuationSummary([{ artifact_type: "valuation_scenario_set", content_json: withheld }]), null);
  });

  it("prints the reason in the report instead of zero anchors", () => {
    const report = generateMarkdownReport({
      asset: { canonical_name: "Example", slug: "example", asset_kind: "equity" },
      valuation: { terminal_year: 2035, withheld_reason: "No FY2027-FY2035 cash-flow schedule." },
    } as any);
    assert.strictEqual((report.match(/Valuation withheld\*\*: No FY2027-FY2035 cash-flow schedule\./g) || []).length, 4);
    assert.ok(!/Terminal Anchor Value/.test(report));
  });
});
