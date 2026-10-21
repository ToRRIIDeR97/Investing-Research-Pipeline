// Valuation engine v2: value-driver terminal with fade, PP&E roll-forward, timing, valuation sets, the case x set
// matrix, reverse valuation, cross-checks, FX/ADS conversion, stress cases and the loss-segment split.
import test from "node:test";
import assert from "node:assert/strict";
import { calculateValuationSchedule } from "../src/lib/research/valuation/schedules";
import { buildScenarioStatements, forecastYears, valuationPricePath, type StatementYear } from "../src/lib/research/valuation/engine";
import {
  buildFcffValuation, currencyConversion, defaultValuationSets, driverSchedule, fadeYears, latestFredValue, lossSegments, ronicDefault,
  terminalEquivalentMultiple, validateValuationSets, valuationTiming, type ValuationSet,
} from "../src/lib/research/valuation/v2";

const close = (actual: number | null, expected: number, tolerance = 1e-6) =>
  assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
const ratios = { da_to_revenue: 0.05, capex_to_revenue: 0.06, tax_rate: 0.2 };
const drivers = (growth: number, margin: number, years = [2026, 2027, 2028, 2029, 2030]) =>
  years.map((fiscal_year) => ({ fiscal_year, revenue_growth: growth, operating_margin: margin }));
const statements = (growth = 0.08, margin = 0.25) => buildScenarioStatements({ baseRevenue: 1000, baseYear: 2025, ratios, drivers: drivers(growth, margin) });
const set = (overrides: Partial<ValuationSet> = {}): ValuationSet => ({ set: "base", discount_rate: 0.09, terminal_growth: 0.025, ronic: 0.2, fade_years: 5, rationale: "test", ...overrides });
const common = { bridge: 50, shares: 10, currency: "USD", sourceNotes: ["n"], bridgeExplanation: "Cash less debt." };

test("the value-driver terminal reduces to Gordon on NOPAT with no fade and infinite RONIC", () => {
  const s = statements();
  const schedule = driverSchedule(s, "base", set({ fade_years: 0, ronic: 1e9 }), common);
  const calc = calculateValuationSchedule(schedule);
  const last = s.at(-1)!;
  close(calc.terminal_value, (last.nopat * 1.025) / (0.09 - 0.025), 1e-6);
});

test("fade years move growth to g and reinvest g / RONIC of NOPAT", () => {
  const last = statements().at(-1)!;
  const fade = fadeYears(last, set());
  assert.equal(fade.length, 5);
  close(fade.at(-1)!.growth, 0.025);
  for (const year of fade) close(year.reinvestment, (year.growth / 0.2) * year.nopat);
  assert.ok(fade[0].growth < last.revenue_growth && fade[0].growth > 0.025);
  const schedule = driverSchedule(statements(), "base", set(), common);
  assert.equal(schedule.years.filter((y) => y.fade).length, 5);
  assert.equal(schedule.terminal.type, "value_driver");
});

test("D&A rolls forward from net PP&E, so a capex surge raises later D&A; invested capital and ROIC are tracked", () => {
  const s = buildScenarioStatements({ baseRevenue: 1000, baseYear: 2025, drivers: drivers(0.1, 0.3).map((d) => ({ ...d, capex_to_revenue: 0.4 })),
    ratios: { ...ratios, ppe: { opening_net_ppe: 500, depreciation_rate: 0.1, as_of: "2025-12-31" }, invested_capital: 800 } });
  close(s[0].depreciation_amortization, 50);
  close(s[0].net_ppe_closing!, 500 + 440 - 50);
  close(s[1].depreciation_amortization, 0.1 * (500 + 440 - 50));
  assert.equal(s[0].depreciation_basis, "ppe_roll_forward");
  close(s[0].growth_capex!, 440 - 50);
  close(s[0].roic!, s[0].nopat / 800);
  close(s[1].incremental_roic!, (s[1].nopat - s[0].nopat) / s[0].net_reinvestment!);
  assert.equal(statements()[0].depreciation_basis, "revenue_ratio");
});

test("with zero cash flows and no bridge the FCFF path grows at the discount rate from the valuation date", () => {
  const s = statements().map((year) => ({ ...year, fcff: 0 })) as StatementYear[];
  const timing = { valuation_date: "2026-10-12", first_year_fraction: 0.22, first_year_reported_cash_flow: 0, reported_basis: "none" as const };
  const schedule = driverSchedule(s, "base", set({ fade_years: 0 }), { ...common, bridge: 0, timing });
  const today = calculateValuationSchedule(schedule).value_per_share;
  valuationPricePath(schedule).forEach((point, i) => close(point.price_target, today * 1.09 ** (0.22 + i), 1e-9));
});

test("the first year counts only the cash flow after the reported quarters, discounted over its remaining fraction", () => {
  const timing = valuationTiming({ valuationDate: "2026-10-12", firstYearEnd: "2026-12-31", taxRate: 0.2, reportedQuarters: [
    { period_end: "2026-03-31", operating_income: 100, depreciation_amortization: 20, capital_expenditures: 50 },
    { period_end: "2026-06-30", operating_income: 100, depreciation_amortization: 20, capital_expenditures: 50 },
    { period_end: "2026-12-31", operating_income: 999, depreciation_amortization: 0, capital_expenditures: 0 },
  ] })!;
  close(timing.first_year_fraction, 80 / 365, 1e-4);
  assert.equal(timing.reported_basis, "reported");
  close(timing.first_year_reported_cash_flow, 2 * (80 + 20 - 50));
  const schedule = driverSchedule(statements(), "base", set(), { ...common, timing });
  const calc = calculateValuationSchedule(schedule);
  close(calc.years[0].present_value, (calc.years[0].cash_flow - 100) / 1.09 ** timing.first_year_fraction);
});

test("default sets bracket CAPM by 1pt, cap growth at the risk-free rate, and the validator enforces order, g <= rf and a RONIC rationale", () => {
  const defaults = defaultValuationSets({ capm: 0.095, riskFree: 0.02, ronic: 0.18 });
  assert.deepEqual(defaults.map((d) => [d.set, d.discount_rate, d.terminal_growth]), [["conservative", 0.105, 0.015], ["base", 0.095, 0.02], ["aggressive", 0.085, 0.02]]);
  assert.deepEqual(validateValuationSets(defaults, defaults, 0.02), []);
  const swapped = defaults.map((d) => d.set === "aggressive" ? { ...d, discount_rate: 0.12 } : d);
  assert.match(validateValuationSets(swapped, defaults, 0.02).map((e) => e.message).join(" "), /conservative >= base >= aggressive/);
  const tooHigh = defaults.map((d) => d.set === "base" ? { ...d, terminal_growth: 0.03 } : d);
  assert.match(validateValuationSets(tooHigh, defaults, 0.02).map((e) => e.message).join(" "), /must not exceed the risk-free rate/);
  const ronic = defaults.map((d) => d.set === "base" ? { ...d, ronic: 0.4 } : d);
  assert.match(validateValuationSets(ronic, defaults, 0.02).map((e) => e.message).join(" "), /ronic_rationale/);
  assert.deepEqual(validateValuationSets(ronic.map((d) => d.set === "base" ? { ...d, ronic_rationale: "Network effects." } : d), defaults, 0.02), []);
  const fallback = ronicDefault({ historyRoic: null, baseStatements: null, discountRate: 0.09 });
  assert.equal(fallback.ronic, 0.09);
  assert.equal(forecastYears(null), Number(process.env.RESEARCH_FORECAST_YEARS) || 5);
  assert.equal(forecastYears(12), 10);
});

const PRICE = 400;
const valuation = (sets: ValuationSet[]) => buildFcffValuation({
  statements: { bear: statements(0.03, 0.2), base: statements(), bull: statements(0.12, 0.3) }, sets,
  probabilities: { probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25 }, price: PRICE, currency: "USD",
  common, timing: null, pack: null, fx: 1, capm: 0.09, riskFree: 0.04, historyRoic: 0.2,
});

test("every case is valued under every set; with equal sets the matrix reproduces the cases' values today", () => {
  const base = set();
  const out = valuation(["conservative", "base", "aggressive"].map((key) => ({ ...base, set: key as ValuationSet["set"] })));
  assert.equal(out.additions.valuation_matrix.rows.length, 9);
  const vs = out.assembled.valuation_scenario_set;
  for (const row of out.additions.valuation_matrix.rows) close(row[5] as number, Number(vs[`value_today_${row[0]}` as "value_today_base"].toFixed(2)), 1e-9);
  assert.equal(out.additions.sensitivity_grid.rows.length, 9);
  assert.ok(out.additions.sensitivity_grid.rows.every((row) => row[2] === null || Number.isFinite(row[2])));
  assert.equal(out.additions.stress_cases.length, 2);
  const [impairment, tail] = out.additions.stress_cases;
  assert.ok(tail.value_per_share! < impairment.value_per_share! && impairment.value_per_share! < vs.value_today_bear);
});

test("the reverse valuation's implied terminal multiple reproduces the price, and growth solves are in range", () => {
  const out = valuation(defaultValuationSets({ capm: 0.09, riskFree: 0.04, ronic: 0.2 }));
  const multiple = out.reverse.implied_terminal_multiple!;
  const base = out.schedules.base, explicit = base.years.filter((y) => !y.fade);
  const check = calculateValuationSchedule({ ...base, years: explicit, terminal: { type: "multiple", metric: "nopat", metric_value: explicit.at(-1)!.build!.starting_profit, multiple } });
  close(check.value_per_share, PRICE, 1e-3);
  assert.ok(out.reverse.implied_perpetual_growth === null || out.reverse.implied_perpetual_growth < 0.09);
  close(terminalEquivalentMultiple(base)!, (() => {
    const calc = calculateValuationSchedule(base), n = explicit.length;
    let v = calc.terminal_value / 1.09 ** (calc.years.length - n);
    for (let j = n; j < calc.years.length; j += 1) v += calc.years[j].cash_flow / 1.09 ** (j + 1 - n);
    return v / explicit.at(-1)!.build!.starting_profit;
  })(), 1e-9);
});

test("a foreign listing needs an FX rate and the depositary ratio; with both, the value is per listed share in the price currency", () => {
  assert.deepEqual(currencyConversion({ statementCurrency: "CNY", priceCurrency: "USD", depositaryRatio: null, fx: null }).missing.length, 2);
  const fx = latestFredValue("observation_date,DEXCHUS\n2026-10-01,7.10\n2026-10-02,.\n2026-11-01,7.30", "2026-10-15")!;
  assert.deepEqual(fx, { value: 7.1, observation_date: "2026-10-01" });
  const conversion = currencyConversion({ statementCurrency: "CNY", priceCurrency: "USD", depositaryRatio: 2, fx: { series: "DEXCHUS", perUsd: true, ...fx } });
  assert.deepEqual(conversion.missing, []);
  close(conversion.fx_rate, 1 / 7.1, 1e-6);
  const ordinary = calculateValuationSchedule(driverSchedule(statements(), "base", set(), common)).value_per_share;
  const scaled = buildScenarioStatements({ baseRevenue: 1000 * conversion.fx_rate, baseYear: 2025, ratios, drivers: drivers(0.08, 0.25) });
  const perAds = calculateValuationSchedule(driverSchedule(scaled, "base", set(), { ...common, bridge: 50 * conversion.fx_rate, shares: 10 / 2 })).value_per_share;
  close(perAds, ordinary * conversion.fx_rate * 2, 1e-9);
  assert.deepEqual(currencyConversion({ statementCurrency: "USD", priceCurrency: "USD", depositaryRatio: null, fx: null }).missing, []);
  // An ADS needs its ratio even in one currency, and a missing statement currency withholds.
  assert.match(currencyConversion({ statementCurrency: "USD", priceCurrency: "USD", depositaryRatio: null, fx: null, depositaryListing: true }).missing.join(), /depositary ratio/);
  assert.deepEqual(currencyConversion({ statementCurrency: "USD", priceCurrency: "USD", depositaryRatio: 2, fx: null, depositaryListing: true }).missing, []);
  assert.match(currencyConversion({ statementCurrency: null, priceCurrency: "USD", depositaryRatio: null, fx: null }).missing.join(), /statement currency/);
});

test("RONIC at or below terminal growth is rejected by the validator and the schedule math", () => {
  const defaults = defaultValuationSets({ capm: 0.09, riskFree: 0.04, ronic: 0.18 });
  const bad = defaults.map((d) => d.set === "base" ? { ...d, ronic: 0.01, ronic_rationale: "test" } : d);
  assert.match(validateValuationSets(bad, defaults, 0.04).map((e) => e.message).join(" "), /must exceed terminal_growth/);
  assert.throws(() => calculateValuationSchedule(driverSchedule(statements(), "base", set({ ronic: 0.02, terminal_growth: 0.02 }), common)), /RONIC must exceed terminal growth/);
});

test("the gated terminal share is the terminal value alone; the share beyond the explicit forecast is reported separately", () => {
  const out = valuation(defaultValuationSets({ capm: 0.09, riskFree: 0.04, ronic: 0.2 }));
  const tv = out.additions.terminal_value_share.base!, beyond = out.additions.value_beyond_explicit_share.base!;
  close(tv, calculateValuationSchedule(out.schedules.base).tv_share_of_ev!, 1e-3);
  assert.ok(beyond > tv, "fade years add to the share beyond the explicit forecast");
  assert.ok(out.additions.sanity.flags.filter((f) => f.flag.startsWith("terminal_share")).every((f) => f.value! > 0.85));
});

test("loss-making segments are valued as a persistent or fading loss stream, and segments must reconcile", () => {
  const s = statements();
  const segmentDrivers = s.map((year) => ({ fiscal_year: year.fiscal_year, segment_operating_income: [
    { segment: "Core", operating_income: year.operating_income + 40 }, { segment: "Labs", operating_income: -40 }] }));
  const schedule = driverSchedule(s, "base", set(), common);
  const out = lossSegments({ drivers: segmentDrivers, statements: s, schedule, set: set() });
  assert.ok(out.available && out.segments_reconciled);
  if (!out.available) return;
  const labs = out.segments[0];
  assert.equal(labs.segment, "Labs");
  assert.ok(labs.pv_persistent! < labs.pv_fading! && labs.pv_fading! < 0);
  assert.ok(out.core_value_per_share! > out.value_if_losses_fade! && out.value_if_losses_fade! > out.consolidated_value_per_share!);
  const off = lossSegments({ drivers: segmentDrivers.map((d) => ({ ...d, segment_operating_income: [{ segment: "Core", operating_income: 1 }] })), statements: s, schedule, set: set() });
  assert.equal(off.segments_reconciled, false);
  assert.equal(lossSegments({ drivers: [], statements: s, schedule, set: set() }).available, false);
});
