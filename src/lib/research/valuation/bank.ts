/**
 * Bank valuation (pure): excess return on tangible equity, also called residual income. A deposit-funded bank's
 * growth is funded by deposits; what shareholders fund is the capital that growth ties up. So value is today's tangible
 * common equity plus the present value of the returns above the cost of equity that equity earns:
 *
 *   value = B0 + sum PV(NI_t - r x B_t-1) + PV(B_T x (ROTE - r) / (r - g))
 *
 * Tangible equity B_t follows a regulatory capital constraint: it is the capital the risk-weighted assets need at the
 * target CET1 ratio, B_t = B0 x (target_t / current CET1 ratio) x RWA_t / RWA_0. Net income above that is distributable;
 * a shortfall is capital the bank must raise, which an issue at intrinsic value leaves the value per share unchanged.
 * The model proposes the cost of equity, the RWA growth and target CET1 path, and the terminal ROTE and growth; code
 * computes everything else. Amounts are currency millions, shares millions, rates decimals.
 */

import { z } from "zod/v4";
import { contractJsonSchema } from "@/lib/research/contract-json-schema";
import type { AgentOutputFormat } from "@/lib/agent-harness/types";
import { calculateValuationSchedule, yearTimes, type ValuationMethodInput } from "./schedules";
import { SCENARIOS, assembleValuation, type Scenario, type StatementYear } from "./engine";
import { latestSecInstantFact } from "../history/sec-companyfacts";

type Num = number | null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const r4 = (value: Num) => (finite(value) ? Number(value.toFixed(4)) : null);
const r2 = (value: Num) => (finite(value) ? Number(value.toFixed(2)) : null);
const r1 = (value: number) => Number(value.toFixed(1));
const DAY = 86_400_000;

/** Deposits at or above this share of total assets mark a deposit-funded bank in the filings. */
export const DEPOSIT_FUNDED_SHARE = 0.3;
/** The lowest target CET1 ratio accepted: the 4.5% minimum plus the 2.5% capital conservation buffer. */
export const MIN_TARGET_CET1 = 0.07;

// ---------------------------------------------------------------- inputs from the filings

export type BankCapitalBase = {
  book_date: string;
  stockholders_equity: number; goodwill: number; intangibles: number; preferred_equity: number;
  /** Stockholders' equity less goodwill, other intangibles and preferred equity, in millions. */
  tangible_equity: number;
  deposits: Num; total_assets: Num; deposit_share_of_assets: Num;
  cet1_ratio: Num; cet1_ratio_source: string | null;
  /** Net income of the first forecast year already in the opening book (reported to the book date), in millions. */
  first_year_reported_net_income: Num; first_year_reported_through: string | null;
  notes: string[];
};

const facts = (companyFacts: unknown, concept: string, unit: string) =>
  ((companyFacts as any)?.facts?.["us-gaap"]?.[concept]?.units?.[unit] ?? []) as { start?: string; end?: string; val?: number; form?: string; filed?: string }[];

/**
 * The bank inputs the filings give: tangible common equity at the latest equity date (goodwill, other intangibles and
 * preferred equity subtracted; a concept the company has never tagged counts as zero, with a note), deposits and total
 * assets, a tagged holding-company CET1 ratio, and the net income of the first forecast year to the book date (the
 * year-to-date fact from the latest 10-Q). Null without stockholders' equity.
 */
export function bankCapitalBase(input: { companyFacts: unknown; currency: string; cutoff: Date; firstForecastYearStart: string }): BankCapitalBase | null {
  const { companyFacts, currency, cutoff } = input;
  const instant = (concept: string, unit = currency) => latestSecInstantFact(companyFacts, "us-gaap", concept, unit, cutoff);
  const equity = instant("StockholdersEquity");
  if (!equity) return null;
  const notes: string[] = [];
  // Each deduction is the latest value on or before the equity date; a concept never tagged is zero.
  const deduction = (concepts: string[], label: string) => {
    for (const concept of concepts) {
      const rows = facts(companyFacts, concept, currency).filter((row) => !row.start && row.end && row.end <= equity.end && finite(row.val));
      if (rows.length) return rows.sort((a, b) => b.end!.localeCompare(a.end!) || (b.filed ?? "").localeCompare(a.filed ?? ""))[0].val!;
    }
    notes.push(`No ${label} is tagged in the filings; it is taken as zero.`);
    return 0;
  };
  const goodwill = deduction(["Goodwill"], "goodwill");
  const intangibles = deduction(["IntangibleAssetsNetExcludingGoodwill", "FiniteLivedIntangibleAssetsNet"], "other intangible assets");
  const preferred = deduction(["PreferredStockValue", "PreferredStockValueOutstanding"], "preferred equity");
  const deposits = instant("Deposits"), assets = instant("Assets");
  const ratioFact = ["CommonEquityTierOneCapitalToRiskWeightedAssets", "CommonEquityTierOneCapitalRatio"]
    .map((concept) => instant(concept, "pure")).find(Boolean) ?? null;
  // The year-to-date net income in the opening book: the fact from the first forecast year's start to the book date.
  const ytd = input.firstForecastYearStart <= equity.end
    ? facts(companyFacts, "NetIncomeLoss", currency).filter((row) => row.start === input.firstForecastYearStart && row.end === equity.end
      && finite(row.val) && (row.filed ?? "9999") <= cutoff.toISOString().slice(0, 10))
      .sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""))[0] : undefined;
  const m = (value: number) => value / 1e6;
  return {
    book_date: equity.end,
    stockholders_equity: r1(m(equity.value)), goodwill: r1(m(goodwill)), intangibles: r1(m(intangibles)), preferred_equity: r1(m(preferred)),
    tangible_equity: r1(m(equity.value - goodwill - intangibles - preferred)),
    deposits: deposits ? r1(m(deposits.value)) : null, total_assets: assets ? r1(m(assets.value)) : null,
    deposit_share_of_assets: deposits && assets && assets.value > 0 ? r4(deposits.value / assets.value) : null,
    cet1_ratio: ratioFact ? ratioFact.value : null,
    cet1_ratio_source: ratioFact ? `CET1 ratio tagged in the ${ratioFact.filed} filing for ${ratioFact.end}` : null,
    first_year_reported_net_income: input.firstForecastYearStart > equity.end ? 0 : ytd ? r1(m(ytd.val!)) : null,
    first_year_reported_through: input.firstForecastYearStart > equity.end ? null : ytd ? equity.end : null,
    notes,
  };
}

/** A deposit-funded bank: the bank archetype, or deposits at least 30% of total assets in the filings. */
export function isDepositFundedBank(archetypeKeys: string[], base: Pick<BankCapitalBase, "deposit_share_of_assets"> | null) {
  return archetypeKeys.includes("bank") || (base?.deposit_share_of_assets ?? 0) >= DEPOSIT_FUNDED_SHARE;
}

// ---------------------------------------------------------------- assumptions

export type BankCapitalYear = { fiscal_year: number; rwa_growth: number; target_cet1_ratio: number | null };
export type BankScenarioAssumptions = {
  scenario_type: Scenario; cost_of_equity: number; terminal_rote: number; terminal_growth: number;
  capital_path: BankCapitalYear[]; rationale: string;
};
export type BankAssumptions = {
  current_cet1_ratio: number | null; current_cet1_ratio_source: string;
  scenarios: BankScenarioAssumptions[];
};
type NumericAssumption = { driver_key?: unknown; fiscal_year?: unknown; value?: unknown };
export type ScenarioInput = { scenario_type: Scenario; numeric_assumptions?: NumericAssumption[] | null };

const RWA_GROWTH_KEY = /^(risk_weighted_assets?|rwa)_growth$/i;
const LOAN_GROWTH_KEY = /loan.*growth|growth.*loan/i;
export const CET1_KEY = /cet1|common_equity_tier_?1/i;

/** A scenario's per-year numeric assumption whose key matches, as a decimal. */
function yearly(scenario: ScenarioInput | undefined, key: RegExp, year: number, accept: (v: number) => boolean) {
  const found = (scenario?.numeric_assumptions ?? []).find((a) => typeof a.driver_key === "string" && key.test(a.driver_key)
    && Number(a.fiscal_year) === year && finite(Number(a.value)) && accept(Number(a.value)));
  return found ? { value: Number(found.value), key: String(found.driver_key) } : null;
}

/**
 * The current CET1 ratio: a ratio metric with the same key the scenarios' target uses (same entity, same basis), else
 * the ratio tagged in the filings, else any accepted CET1-ratio metric; percentages are read as decimals.
 */
export function currentCet1Ratio(input: { base: BankCapitalBase | null; metrics: { metric_key: string; value_numeric: unknown; period_end?: unknown }[]; targetKeys: string[] }) {
  const ratios = input.metrics.flatMap((row) => {
    const raw = Number(row.value_numeric);
    if (!CET1_KEY.test(row.metric_key) || !/ratio/i.test(row.metric_key) || /minimum|required|buffer/i.test(row.metric_key) || !finite(raw)) return [];
    const value = raw > 1 ? Number((raw / 100).toFixed(6)) : raw;
    return value > 0.02 && value < 0.8 ? [{ key: row.metric_key, value, period: String(row.period_end ?? "").slice(0, 10) }] : [];
  }).sort((a, b) => b.period.localeCompare(a.period));
  const sameBasis = ratios.find((row) => input.targetKeys.includes(row.key));
  if (sameBasis) return { ratio: sameBasis.value, source: `Accepted metric ${sameBasis.key} at ${sameBasis.period}, the same basis as the scenarios' CET1 targets.` };
  if (finite(input.base?.cet1_ratio)) return { ratio: input.base!.cet1_ratio!, source: input.base!.cet1_ratio_source ?? "CET1 ratio tagged in the filings." };
  if (ratios[0]) return { ratio: ratios[0].value, source: `Accepted metric ${ratios[0].key} at ${ratios[0].period}.` };
  return { ratio: null, source: "No CET1 ratio in the filings or accepted metrics: tangible equity holds its current ratio to risk-weighted assets." };
}

/**
 * Code-prepared assumptions. Cost of equity: the CAPM rate (else risk-free + 5pt, else 10%). RWA growth: a scenario's
 * RWA-growth assumption, else its loan growth, else its revenue growth (all stated). Target CET1: the scenario's CET1
 * assumption for the year, else the current ratio (hold). Terminal growth: 2.5% capped at the risk-free rate. Terminal
 * ROTE: halfway from the final explicit ROTE to the cost of equity (half the excess return persists), within g+1pt-35%.
 */
export function defaultBankAssumptions(input: {
  scenarios: ScenarioInput[]; statements: Record<Scenario, StatementYear[]>; base: BankCapitalBase;
  current: { ratio: number | null; source: string }; capm: Num; riskFree: Num; valuationDate: string; fiscalYearEnd: string; shares: number;
}): { assumptions: BankAssumptions; basis: string[] } {
  const rf = finite(input.riskFree) ? input.riskFree : null;
  const coe = Number((finite(input.capm) ? input.capm : rf !== null ? rf + 0.05 : 0.1).toFixed(4));
  const g = Number(Math.min(0.025, rf ?? 0.025).toFixed(4));
  const basis = new Set<string>();
  const scenarios = SCENARIOS.map((scenario_type) => {
    const own = input.scenarios.find((s) => s.scenario_type === scenario_type);
    const capital_path = input.statements[scenario_type].map((year) => {
      const rwa = yearly(own, RWA_GROWTH_KEY, year.fiscal_year, (v) => v > -0.5 && v < 1.5);
      const loans = rwa ? null : yearly(own, LOAN_GROWTH_KEY, year.fiscal_year, (v) => v > -0.5 && v < 1.5);
      basis.add(rwa ? `RWA growth: the scenarios' ${rwa.key}.` : loans ? `RWA growth: the scenarios' ${loans.key} (loans as the risk base).`
        : "RWA growth: each scenario's revenue growth (no RWA or loan growth assumption).");
      const target = input.current.ratio === null ? null : yearly(own, CET1_KEY, year.fiscal_year, (v) => v >= MIN_TARGET_CET1 && v <= 0.3);
      if (input.current.ratio !== null) basis.add(target ? `Target CET1: the scenarios' ${target.key}.` : "Target CET1: the current ratio, held.");
      return { fiscal_year: year.fiscal_year, rwa_growth: Number((rwa?.value ?? loans?.value ?? year.revenue_growth).toFixed(4)),
        target_cet1_ratio: input.current.ratio === null ? null : Number((target?.value ?? input.current.ratio).toFixed(4)) };
    });
    const draft: BankScenarioAssumptions = { scenario_type, cost_of_equity: coe, terminal_growth: g, terminal_rote: coe, capital_path, rationale: "Code default." };
    const years = bankYears({ statements: input.statements[scenario_type], scenario: draft, current: input.current.ratio, base: input.base,
      valuationDate: input.valuationDate, fiscalYearEnd: input.fiscalYearEnd });
    const finalRote = years.at(-1)?.rote ?? coe;
    const terminal_rote = Number(Math.max(g + 0.01, Math.min(0.35, (finalRote + coe) / 2)).toFixed(4));
    return { ...draft, terminal_rote,
      rationale: `Code default: cost of equity ${coe} (${finite(input.capm) ? "CAPM" : rf !== null ? "risk-free + 5pt" : "10% default"}); terminal ROTE ${terminal_rote}, halfway from the final explicit ROTE ${r4(finalRote)} to the cost of equity; terminal growth ${g}.` };
  });
  return { assumptions: { current_cet1_ratio: input.current.ratio, current_cet1_ratio_source: input.current.source, scenarios }, basis: [...basis] };
}

// ---------------------------------------------------------------- the build

export type BankYear = NonNullable<ValuationMethodInput["years"][number]["equity_build"]> & { fiscal_year: number; excess_return: number };

const fiscalYearEndDate = (year: number, monthDay: string) => `${year}-${/^\d{2}-\d{2}$/.test(monthDay) ? monthDay : "12-31"}`;
const yearsBetween = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (365 * DAY);

/**
 * The capital roll-forward and excess returns for one scenario. The first year counts only its part after the book date:
 * net income less what was reported to then (pro rata when not reported) and the equity charge for that fraction; RWA
 * grows by the same fraction of the year's growth.
 */
export function bankYears(input: {
  statements: StatementYear[]; scenario: Pick<BankScenarioAssumptions, "cost_of_equity" | "capital_path">; current: number | null;
  base: BankCapitalBase; valuationDate: string; fiscalYearEnd: string;
}): BankYear[] {
  const r = input.scenario.cost_of_equity, b0 = input.base.tangible_equity;
  let opening = b0, index = 1;
  return input.statements.map((year, i) => {
    const path = input.scenario.capital_path.find((p) => p.fiscal_year === year.fiscal_year);
    if (!path) throw new Error(`The capital path misses FY${year.fiscal_year}.`);
    const fraction = i === 0 ? Math.max(0, Math.min(1, yearsBetween(input.base.book_date, fiscalYearEndDate(year.fiscal_year, input.fiscalYearEnd)))) : 1;
    const netIncome = year.nopat;
    const reported = input.base.first_year_reported_net_income;
    const counted = i > 0 ? netIncome : finite(reported) ? netIncome - reported : netIncome * fraction;
    index *= (1 + path.rwa_growth) ** fraction;
    const scale = input.current !== null && path.target_cet1_ratio !== null ? path.target_cet1_ratio / input.current : 1;
    const closing = b0 * scale * index;
    const charge = r * opening * fraction;
    const row: BankYear = {
      fiscal_year: year.fiscal_year, opening_tangible_equity: opening, net_income: netIncome, counted_net_income: counted, equity_charge: charge,
      rote: opening > 0 && fraction > 0 ? counted / (opening * fraction) : null, rwa_growth: path.rwa_growth, rwa_index: index,
      target_cet1_ratio: path.target_cet1_ratio, closing_tangible_equity: closing, distributable: counted + opening - closing,
      excess_return: counted - charge,
    };
    opening = closing;
    return row;
  });
}

export type BankScheduleCommon = { base: BankCapitalBase; current: number | null; shares: number; currency: string; valuationDate: string; fiscalYearEnd: string; sourceNotes: string[] };

/** The residual_income schedule for one scenario: excess returns, the opening tangible equity as bridge, and the excess-return terminal. */
export function bankSchedule(statements: StatementYear[], scenario: BankScenarioAssumptions, common: BankScheduleCommon): ValuationMethodInput {
  const years = bankYears({ statements, scenario, current: common.current, base: common.base, valuationDate: common.valuationDate, fiscalYearEnd: common.fiscalYearEnd });
  const firstEnd = fiscalYearEndDate(statements[0].fiscal_year, common.fiscalYearEnd);
  const discountFraction = Math.max(1 / 365, Math.min(1, yearsBetween(common.valuationDate, firstEnd)));
  const reported = common.base.first_year_reported_net_income;
  const round = (value: number) => Number(value.toFixed(3));
  return {
    method: "residual_income", method_name: "Excess return on tangible equity (residual income) with a CET1 capital constraint",
    scenario_type: scenario.scenario_type, rationale: scenario.rationale, currency: common.currency,
    cash_flow_label: "Excess return = net income - cost of equity x opening tangible equity",
    discount_rate: scenario.cost_of_equity,
    years: years.map((year) => {
      const { fiscal_year, excess_return, ...equity_build } = year;
      return { fiscal_year, cash_flow: round(excess_return),
        // starting_profit is the full year's net income; other_adjustments removes the equity charge and, in the first
        // year, the income already in the opening book, so the build reconciles to the excess return.
        build: { starting_profit: round(year.net_income), depreciation_amortization: 0, capital_expenditures: 0, change_in_net_working_capital: 0,
          other_adjustments: round(excess_return - year.net_income) },
        equity_build: Object.fromEntries(Object.entries(equity_build).map(([key, value]) => [key, typeof value === "number" ? Number(value.toFixed(6)) : value])) as BankYear };
    }),
    terminal: { type: "excess_return", metric: "tangible_equity", metric_value: round(years.at(-1)!.closing_tangible_equity),
      growth_rate: scenario.terminal_growth, rote: scenario.terminal_rote },
    equity_bridge: common.base.tangible_equity,
    equity_bridge_explanation: `Opening tangible common equity at ${common.base.book_date}: stockholders' equity ${common.base.stockholders_equity} less goodwill ${common.base.goodwill}, other intangibles ${common.base.intangibles} and preferred equity ${common.base.preferred_equity}. The excess-return method adds it to the value of returns above the cost of equity; no net debt is subtracted, as deposits and borrowings are the bank's operating funding.`,
    diluted_shares: common.shares,
    timing: { valuation_date: common.valuationDate, first_year_fraction: Number(discountFraction.toFixed(6)), first_year_reported_cash_flow: 0,
      reported_basis: statements.length && finite(reported) ? (reported === 0 ? "none" : "reported") : "pro_rata" },
    source_notes: common.sourceNotes.length ? common.sourceNotes : ["Built by code from the operating scenarios and the bank capital base."],
  };
}

// ---------------------------------------------------------------- assembly and cross-checks

export type BankLensValue = { lens: string; value_per_share: Num; value_to_price: Num; signal: string; cheapness_score: Num; basis: string; reason?: string };
const lensSignal = (value: Num, price: number) => {
  if (value === null || !(price > 0)) return { value_to_price: null, signal: "not_applicable", cheapness_score: null };
  const ratio = value / price;
  const signal = ratio >= 1.5 ? "very_cheap" : ratio >= 1.15 ? "cheap" : ratio > 0.85 ? "neutral" : ratio > 0.6 ? "expensive" : "very_expensive";
  return { value_to_price: r4(ratio), signal, cheapness_score: r4(Math.max(0, Math.min(1, ratio / 2))) };
};
const valueToday = (schedule: ValuationMethodInput) => calculateValuationSchedule(schedule).value_per_share;

export type BankValuationInput = {
  statements: Record<Scenario, StatementYear[]>; assumptions: BankAssumptions;
  probabilities: Partial<Record<"probability_bear" | "probability_base" | "probability_bull", unknown>>;
  price: number; netIncomeTtm: Num; fiscalYearEnd?: string; common: Omit<BankScheduleCommon, "current">;
};

/** The whole bank valuation: schedules, path and anchors, and the bank cross-checks, stress cases and reverse valuation. */
export function buildBankValuation(input: BankValuationInput) {
  const current = input.assumptions.current_cet1_ratio;
  const common: BankScheduleCommon = { ...input.common, current };
  const by = (scenario: Scenario) => input.assumptions.scenarios.find((s) => s.scenario_type === scenario)!;
  const schedules = Object.fromEntries(SCENARIOS.map((scenario) => [scenario, bankSchedule(input.statements[scenario], by(scenario), common)])) as Record<Scenario, ValuationMethodInput>;
  const assembled = assembleValuation({ schedules, probabilities: input.probabilities, marketPrice: input.price, currency: common.currency, fiscalYearEnd: input.fiscalYearEnd });
  const set = assembled.valuation_scenario_set;
  const weightedToday = "weighted_value_today" in set ? (set.weighted_value_today as number) : null;
  const shares = common.shares, b0 = common.base.tangible_equity, price = input.price;
  const marketCap = price * shares, ptbv = b0 > 0 ? marketCap / b0 : null;
  const base = by("base");

  const capital = Object.fromEntries(SCENARIOS.map((scenario) => [scenario, {
    columns: ["fiscal_year", "rwa_growth", "target_cet1_ratio", "opening_tangible_equity", "net_income", "counted_net_income", "rote", "equity_charge", "excess_return", "closing_tangible_equity", "distributable"],
    rows: schedules[scenario].years.map((year) => {
      const e = year.equity_build!;
      return [year.fiscal_year, e.rwa_growth, e.target_cet1_ratio, r1(e.opening_tangible_equity), r1(e.net_income), r1(e.counted_net_income), r4(e.rote),
        r1(e.equity_charge), r1(year.cash_flow), r1(e.closing_tangible_equity), r1(e.distributable)];
    }),
  }]));
  const raises = Object.fromEntries(SCENARIOS.map((scenario) => [scenario, schedules[scenario].years
    .filter((year) => (year.equity_build?.distributable ?? 0) < -0.5).map((year) => ({ fiscal_year: year.fiscal_year, amount: r1(-year.equity_build!.distributable) }))]));

  // No-rerating: today's price-to-tangible-book held on terminal-year tangible equity, plus the capital distributed to then.
  const no_rerating = Object.fromEntries(SCENARIOS.map((scenario) => {
    const years = schedules[scenario].years, last = years.at(-1)!;
    const distributed = years.reduce((sum, year) => sum + (year.equity_build?.distributable ?? 0), 0);
    const value = ptbv !== null ? (ptbv * last.equity_build!.closing_tangible_equity + distributed) / shares : null;
    const ret = value !== null && price > 0 ? value / price - 1 : null;
    const t = yearTimes(schedules[scenario]).at(-1)!;
    return [scenario, { terminal_year: last.fiscal_year, value_per_share: r2(value), return: r4(ret),
      annualized: r4(ret !== null && ret > -1 ? (1 + ret) ** (1 / t) - 1 : null), basis: "Today's price-to-tangible-book held on terminal-year tangible equity, plus capital distributed less capital raised" }];
  }));

  const sanity: { flag: string; value: Num; threshold: string; message: string }[] = [];
  for (const scenario of SCENARIOS) {
    const share = calculateValuationSchedule(schedules[scenario]).tv_share_of_ev;
    if (share !== null && share > 0.85) sanity.push({ flag: `terminal_share_${scenario}`, value: r4(share), threshold: "> 0.85",
      message: `The terminal excess return is ${Math.round(share * 100)}% of the ${scenario} value; the forecast and today's book decide little.` });
    if (raises[scenario].length) sanity.push({ flag: `capital_raise_${scenario}`, value: r1(raises[scenario].reduce((sum, row) => sum + (row.amount ?? 0), 0)), threshold: "> 0",
      message: `The ${scenario} case needs ${raises[scenario].map((row) => `${row.amount}m in FY${row.fiscal_year}`).join(", ")} of new capital to hold its CET1 target; valued as raised at intrinsic value, which leaves today's value per share unchanged but dilutes holders who do not take part.` });
  }
  const today = weightedToday ?? set.value_today_base;
  const ratio = price > 0 ? today / price : null;
  if (ratio !== null && (ratio < 0.6 || ratio > 1.6)) sanity.push({ flag: "value_to_price", value: r4(ratio), threshold: "outside 0.6-1.6",
    message: `Value today is ${ratio.toFixed(2)}x the market price; the reverse valuation shows the sustained ROTE the price implies.` });

  // Mechanical stress below bear: impairment (cost of equity +1pt, and no excess return after the forecast unless bear
  // already assumes a loss of value there); tail (also every year's net income cut 30%, a credit cycle, and zero growth).
  const bear = by("bear");
  const stressedCoe = Number((bear.cost_of_equity + 0.01).toFixed(4));
  const impairment: BankScenarioAssumptions = { ...bear, cost_of_equity: stressedCoe, terminal_rote: Math.min(bear.terminal_rote, stressedCoe) };
  const cut = input.statements.bear.map((year) => ({ ...year, nopat: year.nopat * 0.7 }));
  const tail: BankScenarioAssumptions = { ...impairment, terminal_growth: 0 };
  const stress = (name: string, value: number, definition: string) => ({ case: name, value_per_share: r2(value), return: r4(price > 0 ? value / price - 1 : null), definition });
  const stress_cases = [
    stress("impairment", valueToday(bankSchedule(input.statements.bear, impairment, common)), `Bear operations, cost of equity ${impairment.cost_of_equity} and terminal ROTE ${r4(impairment.terminal_rote)} (no more than the cost of equity): no excess return after the forecast.`),
    stress("tail", valueToday(bankSchedule(cut, tail, common)), "Impairment with every year's net income cut 30% (a credit-loss cycle) and zero terminal growth."),
  ];

  const grid = [-0.01, 0, 0.01].flatMap((dr) => [-0.02, 0, 0.02].map((drote) => {
    const s = { ...base, cost_of_equity: Number((base.cost_of_equity + dr).toFixed(4)), terminal_rote: Number((base.terminal_rote + drote).toFixed(4)) };
    let value: Num = null;
    try { value = s.terminal_growth < s.cost_of_equity && s.terminal_rote > s.terminal_growth ? valueToday(bankSchedule(input.statements.base, s, common)) : null; } catch { value = null; }
    return [s.cost_of_equity, s.terminal_rote, r2(value)];
  }));

  // Reverse: the ROTE the price implies, sustained on today's tangible book, P/TBV = (ROTE - g) / (r - g).
  const impliedRote = ptbv !== null ? base.terminal_growth + ptbv * (base.cost_of_equity - base.terminal_growth) : null;
  const reverse = {
    artifact_type: "reverse_valuation" as const, implied_growth: null, implied_margin: null,
    implied_rote: r4(impliedRote), price_to_tangible_book: r4(ptbv), cost_of_equity: base.cost_of_equity, terminal_growth: base.terminal_growth,
    method: "Sustained return on tangible equity the market price implies on today's tangible book: P/TBV = (ROTE - g) / (r - g), at the base cost of equity and terminal growth.",
    note: "Revenue growth and margin are not solved for banks; implied_rote is the bank reverse valuation.",
  };
  const tbvps = b0 / shares;
  const lenses: BankLensValue[] = [
    { lens: "residual_income", value_per_share: r2(today), ...lensSignal(today, price), basis: "Probability-weighted excess-return value on tangible equity today" },
    { lens: "nav", value_per_share: r2(tbvps), ...lensSignal(tbvps, price), basis: `Tangible book value per diluted share at ${common.base.book_date}` },
  ];
  const share = (scenario: Scenario) => r4(calculateValuationSchedule(schedules[scenario]).tv_share_of_ev);
  return {
    schedules, assembled, reverse, lenses,
    additions: {
      engine_version: "bank-excess-return-v1",
      bank_capital_base: common.base,
      bank_assumptions: input.assumptions,
      capital_schedule: capital,
      capital_raises: raises,
      // The terminal excess return over the whole equity value (book included); with no fade years both shares agree.
      terminal_value_share: Object.fromEntries(SCENARIOS.map((scenario) => [scenario, share(scenario)])),
      value_beyond_explicit_share: Object.fromEntries(SCENARIOS.map((scenario) => [scenario, share(scenario)])),
      cross_checks: {
        market_cap: r2(marketCap), tangible_book_per_share: r2(tbvps), price_to_tangible_book: r2(ptbv),
        pe_ttm: r2(finite(input.netIncomeTtm) && input.netIncomeTtm > 0 ? marketCap / input.netIncomeTtm : null),
        rote_next: r4(schedules.base.years[0].equity_build?.rote ?? null),
        no_rerating,
      },
      sensitivity_grid: { columns: ["cost_of_equity", "terminal_rote", "value_per_share"], rows: grid, case: "base",
        note: `Base case, cost of equity ±1pt and terminal ROTE ±2pt; terminal growth ${base.terminal_growth}.` },
      lens_values: lenses,
      sanity: { flags: sanity, attribution: [], base_value_today: r2(set.value_today_base) },
      stress_cases,
    },
  };
}

// ---------------------------------------------------------------- model contract

const BankAssumptionsOutput = z.object({ bank_valuation_assumptions: z.object({
  artifact_type: z.literal("bank_valuation_assumptions"),
  current_cet1_ratio: z.number().gt(0).lt(1).nullable(),
  current_cet1_ratio_source: z.string().min(1),
  scenarios: z.array(z.object({
    scenario_type: z.enum(SCENARIOS), cost_of_equity: z.number().gt(0).lt(1), terminal_rote: z.number().gt(-1).lt(1),
    terminal_growth: z.number().min(-0.05).lt(0.2),
    capital_path: z.array(z.object({ fiscal_year: z.number().int(), rwa_growth: z.number(), target_cet1_ratio: z.number().nullable() })).min(1),
    rationale: z.string().min(1),
  })).length(3),
  omitted_methods: z.array(z.object({ method: z.string().min(1), reason: z.string().min(1) })).default([]),
  source_notes: z.array(z.string().min(1)).default([]),
}) });
export type BankAssumptionsOutput = z.infer<typeof BankAssumptionsOutput>["bank_valuation_assumptions"];

/** Problems with model-adjusted bank assumptions, one per message. */
export function validateBankAssumptions(value: BankAssumptions, input: { riskFree: Num; horizon: number[] }): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  const types = value.scenarios.map((s) => s.scenario_type);
  if (SCENARIOS.some((type) => types.filter((t) => t === type).length !== 1)) {
    return [{ path: "bank_valuation_assumptions.scenarios", message: `Give exactly one bear, one base and one bull scenario; got ${types.join(", ")}.` }];
  }
  const current = value.current_cet1_ratio;
  if (current !== null && (current < 0.045 || current > 0.6)) errors.push({ path: "bank_valuation_assumptions.current_cet1_ratio", message: `current_cet1_ratio ${current} must be a decimal between 0.045 and 0.6.` });
  value.scenarios.forEach((s, i) => {
    const path = `bank_valuation_assumptions.scenarios.${i}`;
    if (input.riskFree !== null && s.cost_of_equity <= input.riskFree) errors.push({ path: `${path}.cost_of_equity`, message: `${s.scenario_type} cost_of_equity ${s.cost_of_equity} must exceed the risk-free rate ${input.riskFree} (FRED DGS10).` });
    if (s.cost_of_equity > 0.3) errors.push({ path: `${path}.cost_of_equity`, message: `${s.scenario_type} cost_of_equity ${s.cost_of_equity} is above 30%.` });
    if (s.terminal_growth >= s.cost_of_equity) errors.push({ path: `${path}.terminal_growth`, message: `${s.scenario_type} terminal_growth must be below its cost_of_equity.` });
    if (input.riskFree !== null && s.terminal_growth > input.riskFree + 1e-9) errors.push({ path: `${path}.terminal_growth`, message: `${s.scenario_type} terminal_growth ${s.terminal_growth} must not exceed the risk-free rate ${input.riskFree}.` });
    if (s.terminal_rote <= s.terminal_growth || s.terminal_rote > 0.5) errors.push({ path: `${path}.terminal_rote`, message: `${s.scenario_type} terminal_rote ${s.terminal_rote} must exceed terminal_growth ${s.terminal_growth} and not exceed 0.5.` });
    for (const year of input.horizon) {
      const row = s.capital_path.find((p) => p.fiscal_year === year);
      if (!row) { errors.push({ path: `${path}.capital_path`, message: `${s.scenario_type} capital_path misses FY${year}.` }); continue; }
      if (!(row.rwa_growth > -0.5 && row.rwa_growth < 1.5)) errors.push({ path: `${path}.capital_path`, message: `${s.scenario_type} FY${year} rwa_growth ${row.rwa_growth} must be between -0.5 and 1.5.` });
      if (current === null && row.target_cet1_ratio !== null) errors.push({ path: `${path}.capital_path`, message: `${s.scenario_type} FY${year} target_cet1_ratio needs current_cet1_ratio; without it give null (hold the current capital ratio).` });
      if (row.target_cet1_ratio !== null && (row.target_cet1_ratio < MIN_TARGET_CET1 || row.target_cet1_ratio > 0.3))
        errors.push({ path: `${path}.capital_path`, message: `${s.scenario_type} FY${year} target_cet1_ratio ${row.target_cet1_ratio} must be between ${MIN_TARGET_CET1} (4.5% minimum + 2.5% buffer) and 0.3.` });
    }
  });
  return errors;
}

/** The model-facing format: the three bank scenarios' cost of equity, capital path and terminal, checked in code. */
export function bankAssumptionsFormat(input: { riskFree: Num; horizon: number[] }): AgentOutputFormat {
  return {
    requiredKeys: ["bank_valuation_assumptions"],
    schema: contractJsonSchema(BankAssumptionsOutput, { target: "draft-7", io: "input", reused: "inline" }) as Record<string, unknown>,
    validate(value) {
      const parsed = BankAssumptionsOutput.safeParse(value);
      if (!parsed.success) return parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
      return validateBankAssumptions(parsed.data.bank_valuation_assumptions as BankAssumptions, input);
    },
  };
}

export const BANK_METHOD_RULES = [
  "This is a deposit-funded bank. The application values it by excess return on tangible equity (residual income): value = opening tangible common equity + PV of (net income - cost of equity x opening tangible equity) + a terminal excess return on the final tangible equity, B_T x (ROTE - r) / (r - g). Net income comes from the operating scenarios' statements (operating income after tax). Supply only bank_valuation_assumptions.",
  "Tangible equity follows the regulatory capital constraint: each year it is the capital the risk-weighted assets need at the target CET1 ratio, B_t = B_0 x target_cet1_ratio / current_cet1_ratio x RWA_t / RWA_0. Net income above that is distributable; a shortfall is capital the bank must raise, which the application reports. Deposits and borrowings fund the rest of the balance sheet: never deduct loan or balance-sheet growth.",
  "default_bank_assumptions holds the code-prepared assumptions and default_bank_assumptions_basis says where each came from: start from them. capital_path gives every forecast year an rwa_growth (decimal; loan growth is the usual proxy when RWA growth is not sourced) and a target_cet1_ratio (decimal, at least 0.07; null holds today's ratio, and must be null when current_cet1_ratio is null). Use the same basis (holding company or bank) for current_cet1_ratio and the targets, and say which in current_cet1_ratio_source.",
  "cost_of_equity must exceed risk_free_rate.rate. terminal_growth must be below cost_of_equity and not above risk_free_rate.rate. terminal_rote is the return on tangible equity the bank sustains after the forecast: above terminal_growth and at most 0.5. A terminal_rote above the cost of equity needs a moat the evidence supports; state it in rationale.",
  "Use the valuation specialist's team_context.brief. Do not return schedules, per-share values or a reverse valuation; the application computes them. Name sources and calibration in source_notes and list methods judged inappropriate, with the reason, in omitted_methods.",
  "Follow output_schema exactly.",
];
