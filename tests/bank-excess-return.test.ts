import assert from "node:assert/strict";
import test from "node:test";
import {
  bankAssumptionsFormat, bankSchedule, buildBankValuation, currentCet1Ratio, isDepositFundedBank, type BankAssumptions,
} from "../src/lib/research/valuation/bank";
import { calculateValuationSchedule } from "../src/lib/research/valuation/schedules";
import { valuationPricePath } from "../src/lib/research/valuation/engine";
import { buildReportFacts } from "../src/lib/research/reporting/facts";
import { tableRows } from "../src/lib/research/history/analytics";
import { SOFI, sofiInputs } from "./helpers/sofi-bank";

const build = (assumptions?: BankAssumptions, valuationDate = SOFI.valuationDate) => {
  const { base, statements, defaults } = sofiInputs();
  return buildBankValuation({ statements, assumptions: assumptions ?? defaults.assumptions, probabilities: SOFI.probabilities, price: SOFI.price,
    netIncomeTtm: SOFI.netIncomeTtm, fiscalYearEnd: "12-31",
    common: { base, shares: SOFI.shares, currency: "USD", valuationDate, fiscalYearEnd: "12-31", sourceNotes: ["SoFi fixture"] } });
};

test("SoFi's filings give tangible equity, the deposit share and the year-to-date net income in the opening book", () => {
  const { base, current } = sofiInputs();
  // 11,295.137 equity − 1,425.159 goodwill − 208.093 intangibles at 30 Sep 2026 (10-Q filed 5 Nov 2026).
  assert.equal(base.tangible_equity, 9661.9);
  assert.equal(base.book_date, "2026-09-30");
  assert.equal(base.deposit_share_of_assets, 0.7574, "51,325m deposits over 67,767m assets");
  assert.equal(base.first_year_reported_net_income, 564.3, "nine-month 2026 net income");
  assert.equal(base.preferred_equity, 0);
  assert.ok(isDepositFundedBank([], base), "deposits alone select the bank method");
  assert.ok(!isDepositFundedBank(["lender"], { deposit_share_of_assets: 0.1 }));
  assert.ok(isDepositFundedBank(["bank"], null), "the plan's bank archetype selects it too");
  assert.equal(current.ratio, 0.149, "the metric on the same basis as the scenarios' CET1 targets");
});

test("the current CET1 ratio prefers the targets' basis, then the filings, and reads percentages", () => {
  const metrics = [{ metric_key: "holding_cet1_ratio", value_numeric: 16.9, period_end: "2026-09-30" }, { metric_key: "bank_cet1_ratio", value_numeric: 0.149, period_end: "2026-09-30" }];
  assert.equal(currentCet1Ratio({ base: null, metrics, targetKeys: ["bank_cet1_ratio"] }).ratio, 0.149);
  assert.equal(currentCet1Ratio({ base: null, metrics, targetKeys: [] }).ratio, 0.169);
  assert.equal(currentCet1Ratio({ base: { cet1_ratio: 0.12, cet1_ratio_source: "tag" } as any, metrics, targetKeys: [] }).ratio, 0.12);
  assert.equal(currentCet1Ratio({ base: null, metrics: [{ metric_key: "cet1_minimum_ratio", value_numeric: 0.07 }], targetKeys: [] }).ratio, null);
});

test("code defaults take RWA growth from loan growth, CET1 targets from the scenarios and the CAPM cost of equity", () => {
  const { defaults } = sofiInputs();
  const baseCase = defaults.assumptions.scenarios.find((s) => s.scenario_type === "base")!;
  assert.deepEqual(baseCase.capital_path.map((p) => [p.rwa_growth, p.target_cet1_ratio]), [[0.4, 0.14], [0.2, 0.13], [0.15, 0.125], [0.12, 0.125], [0.1, 0.125]]);
  assert.equal(baseCase.cost_of_equity, 0.1267);
  assert.equal(baseCase.terminal_growth, 0.025, "2.5%, under the 4.92% risk-free rate");
  // Final explicit ROTE 2,170.9 / 13,636.9 = 15.92%; halfway to 12.67% is 14.29%.
  assert.equal(baseCase.terminal_rote, 0.1429);
  assert.match(defaults.basis.join(" "), /average_loan_growth/);
});

test("SoFi's base case: the capital path follows RWA and the CET1 target, and Q4 2026 alone counts in the first year", () => {
  const rows = tableRows(build().additions.capital_schedule.base as any);
  const first = rows[0], last = rows.at(-1)!;
  // 957.0m FY2026 net income less 564.3m already in the 30 Sep book; equity charge 0.1267 × 9,661.9 × 92/365.
  assert.equal(first.counted_net_income, 392.7);
  assert.equal(first.equity_charge, 308.6);
  // Closing equity = 9,661.9 × 14.0% / 14.9% × 1.40^(92/365).
  assert.equal(first.closing_tangible_equity, 9881.8);
  assert.equal(last.closing_tangible_equity, 15000.6);
  assert.equal(last.rote, 0.1592);
  for (const row of rows) {
    assert.ok(Math.abs(row.excess_return - (row.counted_net_income - row.equity_charge)) < 0.2);
    assert.ok(Math.abs(row.distributable - (row.counted_net_income + row.opening_tangible_equity - row.closing_tangible_equity)) < 0.2);
  }
});

test("SoFi reproduces: value today per case, the weighted value and a terminal value well under 90% of value", () => {
  const built = build();
  const set = built.assembled.valuation_scenario_set as Record<string, any>;
  assert.deepEqual([set.value_today_bear, set.value_today_base, set.value_today_bull].map((v: number) => Number(v.toFixed(2))), [5.14, 8.62, 11.07]);
  assert.equal(Number(set.weighted_value_today.toFixed(2)), 8.06);
  // FCFE in the same run put 97%, 83%, 97% then 106% of base value in the terminal value.
  assert.deepEqual(built.additions.terminal_value_share, { bear: -0.2106, base: 0.1252, bull: 0.2373 });
  for (const share of Object.values(built.additions.terminal_value_share)) assert.ok(share! < 0.5);
  assert.equal(built.reverse.implied_rote, 0.2088, "12.86 is 1.81x tangible book: a 20.9% ROTE for good at 12.67% and 2.5%");
  assert.equal(built.additions.cross_checks.price_to_tangible_book, 1.81);
  assert.ok(built.additions.sanity.flags.some((f) => f.flag === "capital_raise_bull"), "the bull case outgrows its earnings and must raise capital");
  // Stress cases sit below bear.
  for (const stress of built.additions.stress_cases) assert.ok(stress.value_per_share! < Number(set.value_today_bear.toFixed(2)));
});

test("report_facts passes SoFi's bank valuation on every valuationCheck criterion", () => {
  const built = build();
  const facts = buildReportFacts([{ artifact_type: "valuation_scenario_set", content_json: {
    ...built.assembled.valuation_scenario_set, ...built.additions, current_market_price: SOFI.price } }])!;
  const cases = tableRows(facts.cases as any);
  assert.equal(cases.length, 3);
  const base = cases.find((c) => c.case === "base")!;
  assert.equal(base.method, "residual_income");
  assert.equal(base.tv_share_of_ev, 0.1252, "the terminal share is of the whole equity value, book included");
  assert.ok(base.tv_share_of_ev <= 0.9);
  assert.ok(!cases.every((c) => c.explicit_cash_flow_sum < 0), "excess returns are not negative in every case");
  const ratio = facts.weighted.pv_per_share! / SOFI.price;
  assert.ok(ratio >= 0.4 && ratio <= 3, `weighted value / price ${ratio}`);
  assert.equal(base.no_rerating_return, 0.6516, "the stage's P/TBV no-rerating return wins");
  assert.equal(facts.market.price_to_tangible_book, 1.81);
  assert.equal(facts.market.enterprise_value, facts.market.market_cap, "no net-debt bridge for a bank");
});

test("excess returns on book equal discounted distributions plus terminal equity (clean surplus)", () => {
  // With the valuation on the book date the first-year charge and its discounting cover the same fraction.
  const built = build(undefined, "2026-09-30");
  const calc = calculateValuationSchedule(built.schedules.base);
  const r = calc.discount_rate;
  const last = calc.years.at(-1)!;
  const times = calc.years.map((y) => y.years_from_valuation_date!);
  const ddm = calc.years.reduce((n, y, i) => n + y.equity_build!.distributable / (1 + r) ** times[i], 0)
    + (last.equity_build!.closing_tangible_equity + calc.terminal_value) / (1 + r) ** times.at(-1)!;
  // The stub charge is simple interest (r × fraction), so the two differ by a few millions on a 11.7bn value.
  assert.ok(Math.abs(ddm - calc.equity_value) < 20, `${ddm} vs ${calc.equity_value}`);
  // The path's terminal-year value is the final tangible equity, its terminal and the capital distributed, per share.
  const distributed = calc.years.reduce((n, y) => n + y.equity_build!.distributable, 0);
  const anchor = valuationPricePath(built.schedules.base).at(-1)!.price_target;
  assert.ok(Math.abs(anchor - (last.equity_build!.closing_tangible_equity + calc.terminal_value + distributed) / SOFI.shares) < 1e-9);
});

test("the same inputs give the same value: nothing in the schedule is model-written", () => {
  assert.deepEqual(build().assembled.valuation_scenario_set, build().assembled.valuation_scenario_set);
});

test("the bank assumptions contract rejects rates, capital and terminals that break the method", () => {
  const { defaults } = sofiInputs();
  const format = bankAssumptionsFormat({ riskFree: SOFI.riskFree, horizon: [2026, 2027, 2028, 2029, 2030] });
  const answer = (change: (a: any) => void) => {
    const a = structuredClone({ artifact_type: "bank_valuation_assumptions", ...defaults.assumptions, omitted_methods: [], source_notes: [] });
    change(a);
    return format.validate!({ bank_valuation_assumptions: a }).map((e) => e.message).join(" | ");
  };
  assert.equal(answer(() => {}), "");
  assert.match(answer((a) => { a.scenarios[0].cost_of_equity = 0.04; }), /must exceed the risk-free rate/);
  assert.match(answer((a) => { a.scenarios[1].terminal_growth = 0.06; }), /must not exceed the risk-free rate/);
  assert.match(answer((a) => { a.scenarios[1].terminal_rote = 0.02; }), /terminal_rote 0.02 must exceed terminal_growth/);
  assert.match(answer((a) => { a.scenarios[2].capital_path[0].target_cet1_ratio = 0.05; }), /between 0.07/);
  assert.match(answer((a) => { a.scenarios[2].capital_path.pop(); }), /misses FY2030/);
  assert.match(answer((a) => { a.current_cet1_ratio = null; }), /needs current_cet1_ratio/);
});

test("the schedule maths keeps residual income to its own terminal and rejects a ROTE at or below growth", () => {
  const { base, statements, defaults } = sofiInputs();
  const common = { base, current: 0.149, shares: SOFI.shares, currency: "USD", valuationDate: SOFI.valuationDate, fiscalYearEnd: "12-31", sourceNotes: [] };
  const schedule = bankSchedule(statements.base, defaults.assumptions.scenarios[1], common);
  assert.throws(() => calculateValuationSchedule({ ...schedule, terminal: { type: "perpetuity", growth_rate: 0.02 } }), /excess_return terminal/);
  assert.throws(() => calculateValuationSchedule({ ...schedule, terminal: { ...schedule.terminal, rote: 0.02 } }), /must exceed terminal growth/);
  assert.throws(() => calculateValuationSchedule({ ...schedule, method: "fcfe" }), /excess_return terminal/);
});

test("the valuation summary reads a bank: excess-return rows, the book in the steps and the implied ROTE", async () => {
  const { valuationSummary } = await import("../src/lib/research/reporting/valuation-summary");
  const built = build();
  const valuation = { ...built.assembled.valuation_scenario_set, ...built.additions, current_market_price: SOFI.price,
    method_schedules: Object.values(built.schedules).map(calculateValuationSchedule) };
  const summary = valuationSummary([
    { artifact_type: "valuation_scenario_set", content_json: valuation },
    { artifact_type: "annual_price_target_path", content_json: built.assembled.annual_price_target_path },
    { artifact_type: "reverse_valuation", content_json: built.reverse },
  ])!;
  const base = summary.calculations.find((c) => c.type === "base")!;
  assert.deepEqual(base.rows.map((r) => r.label), ["Net income", "Cost of equity on tangible equity", "Excess return", "Tangible equity at year end"]);
  assert.match(base.steps.map((s) => s.text).join(" "), /tangible book today/);
  assert.equal(base.note, null, "the schedule's end value reconciles with the path's anchor");
  assert.match(summary.priceImplies.join(" "), /about 21% on its tangible equity for good, against a 13% cost of equity \(1\.81 times tangible book\)/);
});
