import test from "node:test";
import assert from "node:assert/strict";
import { BASE_ASSUMPTIONS, BASE_DRIVERS, BRIDGE, FRED_CSV, RATIOS, SHARES, close, loadEngine, obs, statementInput } from "./fixtures";
import { calculateValuationSchedule, cashFlowBuildErrors } from "../../../src/lib/research/valuation/schedules";
import { validateAnnualPriceTargetPath } from "../../../src/lib/research/valuation/validation";
import { validateArtifactContent } from "../../../src/lib/research/stage-contracts";
import { valuationFinancialInputs } from "../../../src/lib/research/valuation/financial-inputs";

const schedule = async (drivers = BASE_DRIVERS, assumptions: any = BASE_ASSUMPTIONS) => {
  const e = await loadEngine();
  const statements = e.buildScenarioStatements(statementInput(drivers));
  return e.buildFcffSchedule({ statements, assumptions, bridge: BRIDGE, dilutedSharesMillions: SHARES, currency: "USD", sourceNotes: ["fixture"] });
};

test("AC-1: the risk-free rate is the last non-blank FRED value on or before the cutoff, as a decimal", async () => {
  const { latestRiskFreeRate } = await loadEngine();
  assert.deepEqual(latestRiskFreeRate(FRED_CSV, "2026-10-08"), { rate: 0.0522, observation_date: "2026-10-08" });
  assert.deepEqual(latestRiskFreeRate(FRED_CSV, "2026-10-06"), { rate: 0.0531, observation_date: "2026-10-05" });
  assert.equal(latestRiskFreeRate(FRED_CSV, "2026-10-01"), null);
});

test("AC-2: readiness names every missing input so the stage can withhold without a model call", async () => {
  const { valuationReadiness } = await loadEngine();
  const ok = valuationReadiness({ drivers: { bear: BASE_DRIVERS, base: BASE_DRIVERS, bull: BASE_DRIVERS }, horizon: [2026, 2027, 2028], dilutedSharesMillions: SHARES, marketPrice: 719.87, baseRevenue: 200_000 });
  assert.deepEqual(ok, { ready: true, missing: [] });
  const missing = valuationReadiness({ drivers: { bear: BASE_DRIVERS, base: BASE_DRIVERS, bull: BASE_DRIVERS.slice(0, 2) }, horizon: [2026, 2027, 2028], dilutedSharesMillions: null, marketPrice: 719.87, baseRevenue: 200_000 });
  assert.equal(missing.ready, false);
  assert.ok(missing.missing.some((m: string) => /bull/.test(m) && /2028/.test(m)), missing.missing.join("; "));
  assert.ok(missing.missing.some((m: string) => /diluted shares/i.test(m)), missing.missing.join("; "));
});

test("AC-3: history ratios and the base year come from captured annual filings, including tax", async () => {
  const { historyRatios } = await loadEngine();
  const m = 1e6;
  const fi = valuationFinancialInputs({
    statementObservations: [
      obs("revenue", "2024-12-31", 160_000 * m), obs("us_gaap_DepreciationDepletionAndAmortization", "2024-12-31", 14_400 * m),
      obs("us_gaap_PaymentsToAcquirePropertyPlantAndEquipment", "2024-12-31", 48_000 * m),
      obs("us_gaap_IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "2024-12-31", 70_000 * m),
      obs("us_gaap_IncomeTaxExpenseBenefit", "2024-12-31", 12_600 * m),
      obs("revenue", "2025-12-31", 200_000 * m), obs("us_gaap_OperatingIncomeLoss", "2025-12-31", 80_000 * m),
      obs("us_gaap_DepreciationDepletionAndAmortization", "2025-12-31", 18_000 * m),
      obs("us_gaap_PaymentsToAcquirePropertyPlantAndEquipment", "2025-12-31", 70_000 * m),
      obs("us_gaap_IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "2025-12-31", 82_000 * m),
      obs("us_gaap_IncomeTaxExpenseBenefit", "2025-12-31", 14_760 * m),
    ],
    cutoff: new Date("2026-10-10"),
  });
  assert.ok(fi!.columns.includes("pretax_income") && fi!.columns.includes("income_tax_expense"), "financial_inputs carries the tax columns");
  const r = historyRatios(fi);
  close(r.da_to_revenue, 0.09);
  close(r.capex_to_revenue, 0.325);
  close(r.tax_rate, 0.18);
  assert.equal(r.tax_rate_source, "history");
  assert.deepEqual(r.base_year, { fiscal_year: 2025, revenue: 200_000, operating_income: 80_000 });
});

test("AC-4: yearly statements are computed from the drivers, with D&A added back in FCFF", async () => {
  const { buildScenarioStatements } = await loadEngine();
  const [y26, y27, y28] = buildScenarioStatements(statementInput());
  assert.deepEqual([y26.fiscal_year, y27.fiscal_year, y28.fiscal_year], [2026, 2027, 2028]);
  close(y26.revenue, 240_000); close(y26.operating_income, 91_200); close(y26.capital_expenditures, 108_000);
  close(y26.depreciation_amortization, 21_600); close(y26.nopat, 74_784); close(y26.fcff, -11_616);
  close(y27.revenue, 268_800); close(y27.fcff, 9_461.76);
  close(y28.nopat, 89_709.312); close(y28.fcff, 12_832.512);
  assert.throws(() => buildScenarioStatements(statementInput([BASE_DRIVERS[0], BASE_DRIVERS[2]])), /2027/);
});

test("AC-5: the FCFF schedule passes the existing schedule math and the D&A build check", async () => {
  const s = await schedule();
  assert.equal(s.method, "fcff");
  assert.deepEqual(cashFlowBuildErrors([s]), []);
  const calc = calculateValuationSchedule(s);
  close(calc.terminal_value, 89_709.312 * 20);
  assert.ok(Number.isFinite(calc.value_per_share));
});

test("AC-6: the price path is the schedule's value at each year end and rolls back to today's value", async () => {
  const { valuationPricePath } = await loadEngine();
  const s = await schedule();
  const path = valuationPricePath(s);
  assert.deepEqual(path.map((p: any) => p.fiscal_year), [2026, 2027, 2028]);
  // Valuation v2: the FCFF path also carries the cash flows retained to each year end (no dividends are forecast).
  const retained = (i: number) => s.years.slice(0, i + 1).reduce((sum: number, y: any) => sum + y.cash_flow, 0);
  close(path[2].price_target, (89_709.312 * 20 + BRIDGE + retained(2)) / SHARES);
  // Roll back: EV(t-1) = (EV(t) + CF(t)) / (1 + r); EV = price * shares - bridge - retained cash.
  let ev = 89_709.312 * 20;
  for (let i = s.years.length - 1; i >= 0; i -= 1) {
    ev = (ev + s.years[i].cash_flow) / 1.09;
    if (i > 0) close(path[i - 1].price_target, (ev + BRIDGE + retained(i - 1)) / SHARES, 1e-9);
  }
  close((ev + BRIDGE) / SHARES, calculateValuationSchedule(s).value_per_share, 1e-9);
});

test("AC-7: anchors, path, weighted target and returns are assembled by code and pass the existing validators", async () => {
  const { assembleValuation } = await loadEngine();
  const bear = await schedule(BASE_DRIVERS.map((d) => ({ ...d, operating_margin: d.operating_margin - 0.05 })), { ...BASE_ASSUMPTIONS, scenario_type: "bear", terminal: { type: "multiple", metric: "nopat", multiple: 15 } });
  const base = await schedule();
  const bull = await schedule(BASE_DRIVERS.map((d) => ({ ...d, operating_margin: d.operating_margin + 0.03 })), { ...BASE_ASSUMPTIONS, scenario_type: "bull", terminal: { type: "multiple", metric: "nopat", multiple: 24 } });
  const out = assembleValuation({ schedules: { bear, base, bull }, probabilities: { probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25 }, marketPrice: 719.87, currency: "USD" });
  const set = out.valuation_scenario_set, path = out.annual_price_target_path;
  for (const scenario of ["bear", "base", "bull"]) {
    const last = path.price_target_path.find((r: any) => r.scenario_type === scenario && r.fiscal_year === 2028);
    assert.equal(set[`terminal_anchor_${scenario}`], last.price_target);
    close(last.total_return_target, (last.price_target - 719.87) / 719.87);
  }
  close(set.weighted_target, 0.25 * set.terminal_anchor_bear + 0.5 * set.terminal_anchor_base + 0.25 * set.terminal_anchor_bull);
  assert.ok(path.price_target_path.every((r: any) => r.is_interpolated === false));
  // decision-synthesis.ts reads the terminal-year share count from the projections.
  const terminal = path.annual_projections.find((p: any) => p.fiscal_year === 2028);
  assert.equal(terminal.balance_sheet_values.shares_outstanding_millions, SHARES);
  assert.equal(terminal.balance_sheet_values.diluted_shares_millions, SHARES);
  assert.deepEqual(validateAnnualPriceTargetPath(path, set).errors, []);
  for (const [type, content] of Object.entries(out)) {
    const v = validateArtifactContent(type, content);
    assert.equal(v.valid, true, `${type}: ${v.errors.join("; ")}`);
  }
});

test("AC-8: the reverse valuation solves for the margin and the growth the market price implies", async () => {
  const e = await loadEngine();
  const uniform = (margin: number) => BASE_DRIVERS.map((d) => ({ ...d, operating_margin: margin }));
  const price = calculateValuationSchedule(await schedule(uniform(0.30))).value_per_share;
  const common = { ...statementInput(), assumptions: BASE_ASSUMPTIONS, bridge: BRIDGE, dilutedSharesMillions: SHARES };
  close(e.impliedOperatingMargin({ ...common, marketPrice: price }), 0.30, 1e-4);
  const growthPrice = calculateValuationSchedule(await schedule(BASE_DRIVERS.map((d) => ({ ...d, revenue_growth: 0.08 })))).value_per_share;
  close(e.impliedRevenueGrowth({ ...common, marketPrice: growthPrice }), 0.08, 1e-4);
});

test("AC-9: the model supplies only assumptions; a discount rate at or below the risk-free rate is rejected", async () => {
  const { valuationAssumptionsFormat } = await loadEngine();
  const format = valuationAssumptionsFormat(0.0522);
  assert.deepEqual(format.requiredKeys, ["valuation_assumptions"]);
  const schemaText = JSON.stringify(format.schema);
  for (const key of ["price_target", "terminal_anchor", "annual_projections", "value_per_share", "cash_flow"]) {
    assert.ok(!schemaText.includes(key), `the model-facing schema must not ask for ${key}`);
  }
  const answer = (baseRate: number) => ({ valuation_assumptions: {
    artifact_type: "valuation_assumptions",
    scenarios: ["bear", "base", "bull"].map((scenario_type) => ({ ...BASE_ASSUMPTIONS, scenario_type, discount_rate: scenario_type === "base" ? baseRate : 0.1 })),
    omitted_methods: [{ method: "fcfe", reason: "Operating company: FCFF is the primary method." }],
    source_notes: ["5.22% 10-year Treasury on 2026-10-08 (FRED DGS10)."],
  } });
  assert.deepEqual(format.validate(answer(0.09)), []);
  const errors = format.validate(answer(0.05));
  assert.ok(errors.some((e: any) => /0\.05/.test(e.message) && /risk-free/i.test(e.message)), JSON.stringify(errors));
});

test("AC-10: operating scenarios must carry yearly drivers for every horizon year", async () => {
  const { validateScenarioDriverCoverage } = await loadEngine();
  const set = { scenarios: [
    { scenario_type: "bear", yearly_drivers: BASE_DRIVERS.slice(0, 2) },
    { scenario_type: "base", yearly_drivers: BASE_DRIVERS },
    { scenario_type: "bull", yearly_drivers: BASE_DRIVERS },
  ] };
  const problems = validateScenarioDriverCoverage(set, [2026, 2027, 2028]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /bear/);
  assert.match(problems[0], /2028/);
  assert.deepEqual(validateScenarioDriverCoverage({ scenarios: set.scenarios.map((s) => ({ ...s, yearly_drivers: BASE_DRIVERS })) }, [2026, 2027, 2028]), []);
});

test("AC-4: the base case first year can be pinned to the accepted operating model", async () => {
  const { buildScenarioStatements } = await loadEngine();
  const [y26, y27] = buildScenarioStatements({ ...statementInput(), firstYear: { revenue: 252_358.2, operating_income: 83_508.6 } });
  assert.equal(y26.revenue, 252_358.2);
  assert.equal(y26.operating_income, 83_508.6);
  close(y27.revenue, 252_358.2 * 1.12);
  assert.ok(RATIOS.tax_rate > 0);
});
