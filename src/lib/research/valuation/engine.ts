/**
 * Deterministic valuation engine. The model supplies yearly drivers (operating scenarios) and a
 * discount rate plus terminal assumption per scenario; code builds the statements, the FCFF
 * schedules, the price path, the anchors and the reverse valuation. Amounts are currency millions
 * and rates are decimals.
 */

import { z } from "zod/v4";
import type { AgentOutputFormat } from "@/lib/agent-harness/types";
import type { ValuationFinancialInputs } from "./financial-inputs";
import { calculateValuationSchedule, yearTimes, type ValuationMethodInput } from "./schedules";

export const SCENARIOS = ["bear", "base", "bull"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export type YearlyDriver = {
  fiscal_year: number; revenue_growth: number; operating_margin: number;
  capex_to_revenue?: number | null; da_to_revenue?: number | null; tax_rate?: number | null; nwc_to_revenue_change?: number | null;
};
/** Net PP&E at the base fiscal year end and that year's D&A as a share of the PP&E it started with. */
export type PpeBase = { opening_net_ppe: number; depreciation_rate: number; as_of: string };
export type StatementRatios = {
  da_to_revenue: number | null; capex_to_revenue: number | null; tax_rate: number;
  ppe?: PpeBase | null;
  /** Equity + debt - cash - current securities at the base fiscal year end (the analytics definition). */
  invested_capital?: number | null;
};
export type StatementYear = {
  fiscal_year: number; revenue: number; revenue_growth: number; operating_income: number; operating_margin: number;
  depreciation_amortization: number; capital_expenditures: number; tax_rate: number; nopat: number;
  change_in_net_working_capital: number; fcff: number;
  /** How D&A was set: a driver override, the PP&E roll-forward, or the history revenue ratio. */
  depreciation_basis?: "driver" | "ppe_roll_forward" | "revenue_ratio";
  net_ppe_closing?: number | null;
  /** Capex up to D&A maintains the asset base; the rest grows it. */
  maintenance_capex?: number; growth_capex?: number;
  /** Capex - D&A + change in NWC. */
  net_reinvestment?: number;
  invested_capital_closing?: number | null;
  /** NOPAT over the invested capital the year started with. */
  roic?: number | null;
  /** Change in NOPAT over the prior year's net reinvestment. */
  incremental_roic?: number | null;
};
export type Terminal = { type: "multiple"; metric: "nopat"; multiple: number } | { type: "perpetuity"; growth_rate: number };
export type ValuationAssumption = { scenario_type: Scenario; discount_rate: number; terminal: Terminal; rationale: string };
type StatementInput = { baseRevenue: number; baseYear: number; ratios: StatementRatios; drivers: YearlyDriver[]; firstYear?: { revenue: number; operating_income: number } | null };
type ReverseInput = StatementInput & { assumptions: ValuationAssumption; bridge: number; dilutedSharesMillions: number; marketPrice: number | null };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const mean = (values: (number | null)[]) => {
  const kept = values.filter(finite);
  return kept.length ? kept.reduce((sum, value) => sum + value, 0) / kept.length : null;
};
const cell = (fi: ValuationFinancialInputs, row: unknown[], key: string) => {
  const at = fi.columns.indexOf(key);
  return at >= 0 && finite(row[at]) ? (row[at] as number) : null;
};

/** Last numeric FRED value on or before the cutoff, as a decimal (5.22 → 0.0522). Blank and "." rows are skipped. */
export function latestRiskFreeRate(csv: string, cutoffDate: string): { rate: number; observation_date: string } | null {
  const cutoff = cutoffDate.slice(0, 10);
  let found: { rate: number; observation_date: string } | null = null;
  for (const line of csv.trim().split(/\r?\n/)) {
    const [date = "", raw = ""] = line.split(",").map((part) => part.trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > cutoff || !raw || raw === "." || !Number.isFinite(Number(raw))) continue;
    if (!found || date >= found.observation_date) found = { rate: Number((Number(raw) / 100).toFixed(6)), observation_date: date };
  }
  return found;
}

/** D&A, capex and tax ratios averaged over the last three or fewer annual rows, plus the latest annual base year. */
export function historyRatios(fi: ValuationFinancialInputs | null) {
  const rows = fi?.annual.slice(-3) ?? [];
  const ratio = (row: unknown[], key: string) => {
    const revenue = cell(fi!, row, "revenue"), amount = cell(fi!, row, key);
    return revenue !== null && revenue > 0 && amount !== null ? Math.abs(amount) / revenue : null;
  };
  const tax = mean(rows.map((row) => {
    const pretax = cell(fi!, row, "pretax_income"), expense = cell(fi!, row, "income_tax_expense");
    const rate = pretax !== null && pretax > 0 && expense !== null ? expense / pretax : null;
    return rate !== null && rate >= 0 && rate < 1 ? rate : null;
  }));
  const base = fi ? [...fi.annual].reverse().find((row) => (cell(fi, row, "revenue") ?? 0) > 0) : undefined;
  // PP&E roll-forward base: base-year net PP&E, and base-year D&A over the prior year-end net PP&E.
  const baseIndex = base ? fi!.annual.indexOf(base) : -1;
  const prior = baseIndex > 0 ? fi!.annual[baseIndex - 1] : undefined;
  const ppeNow = base ? cell(fi!, base, "net_ppe") : null, ppeBefore = prior ? cell(fi!, prior, "net_ppe") : null;
  const daNow = base ? cell(fi!, base, "depreciation_amortization") : null;
  const ppe = ppeNow !== null && ppeNow > 0 && ppeBefore !== null && ppeBefore > 0 && daNow !== null && daNow > 0
    ? { opening_net_ppe: ppeNow, depreciation_rate: Number((Math.abs(daNow) / ppeBefore).toFixed(6)), as_of: String(base![0]) } : null;
  const equity = base ? cell(fi!, base, "stockholders_equity") : null, cash = base ? cell(fi!, base, "cash_and_equivalents") : null;
  const invested_capital = equity !== null && cash !== null
    ? equity + (cell(fi!, base!, "long_term_debt") ?? 0) + (cell(fi!, base!, "current_debt") ?? 0) - cash - (cell(fi!, base!, "marketable_securities") ?? 0) : null;
  return {
    da_to_revenue: mean(rows.map((row) => ratio(row, "depreciation_amortization"))),
    capex_to_revenue: mean(rows.map((row) => ratio(row, "capital_expenditures"))),
    tax_rate: tax ?? 0.21,
    tax_rate_source: (tax === null ? "statutory_default" : "history") as "history" | "statutory_default",
    ppe,
    invested_capital,
    base_year: base ? {
      fiscal_year: Number(base[fi!.columns.indexOf("fiscal_year")]),
      revenue: cell(fi!, base, "revenue")!,
      operating_income: cell(fi!, base, "operating_income"),
    } : null,
  };
}

/**
 * Equity bridge items. Operating lease liabilities are not subtracted: under US GAAP operating lease cost is already
 * inside operating income, so the FCFF has paid for them. Non-operating investments (equity-method and non-marketable
 * stakes) are added; noncontrolling interests are subtracted.
 */
const BRIDGE_ITEMS = [
  ["cash_and_equivalents", 1], ["marketable_securities", 1], ["long_term_investments", 1], ["long_term_debt", -1], ["current_debt", -1],
  ["finance_lease_liabilities", -1], ["noncontrolling_interest", -1],
] as const;

export type EquityBridge = {
  amount: number; period_end: string; components: Record<string, number>; missing: string[];
  /** Items taken from an earlier period than the bridge date, with that period. */
  carried_forward: Record<string, string>;
  /** Captured but left out, with the amount. */
  excluded: Record<string, number>;
};

/**
 * Equity bridge at the latest balance-sheet date (the latest period with cash, else with any item): each item's
 * latest value on or before that date, so a quarter missing a debt tag falls back to the prior period with a note.
 */
export function equityBridge(fi: ValuationFinancialInputs | null): EquityBridge | null {
  if (!fi) return null;
  // Under IFRS 16 every lease is a liability whose cost (depreciation and interest) sits outside FCFF's operating
  // costs, so lease liabilities are debt-like and the bridge subtracts them. US GAAP operating lease cost is already
  // in operating income, so those stay out (excluded below).
  const ifrs = fi.accounting_standard === "ifrs-full";
  const items: readonly (readonly [string, number])[] = ifrs ? [...BRIDGE_ITEMS, ["lease_liabilities_ifrs", -1]] : BRIDGE_ITEMS;
  const rows = [...fi.annual, ...fi.quarterly].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const withItem = (key: string) => rows.filter((row) => cell(fi, row, key) !== null);
  const dated = withItem("cash_and_equivalents").at(-1) ?? rows.filter((row) => items.some(([key]) => cell(fi, row, key) !== null)).at(-1);
  if (!dated) return null;
  const date = String(dated[0]);
  const components: Record<string, number> = {}, carried_forward: Record<string, string> = {};
  for (const [key] of items) {
    const row = withItem(key).filter((candidate) => String(candidate[0]) <= date).at(-1);
    if (!row) continue;
    components[key] = cell(fi, row, key)!;
    if (String(row[0]) !== date) carried_forward[key] = String(row[0]);
  }
  const amount = items.reduce((sum, [key, sign]) => sum + (key in components ? sign * components[key] : 0), 0);
  const leaseRow = ifrs ? undefined : withItem("operating_lease_liabilities").filter((row) => String(row[0]) <= date).at(-1);
  return {
    amount: Number(amount.toFixed(6)), period_end: date, components, carried_forward,
    excluded: leaseRow ? { operating_lease_liabilities: cell(fi, leaseRow, "operating_lease_liabilities")! } : {},
    missing: items.map(([key]) => key).filter((key) => !(key in components)),
  };
}

/**
 * Yearly statements from the drivers: revenue grows from the prior year, operating income is revenue × margin,
 * capex is revenue × (override ?? history ratio), NOPAT = OI × (1 − tax), ΔNWC = nwc_to_revenue_change × Δrevenue
 * and FCFF = NOPAT + D&A − capex − ΔNWC. firstYear pins the first year's revenue and operating income.
 * D&A is the driver's da_to_revenue when given; otherwise, with a PP&E base, the history depreciation rate times the
 * net PP&E the year starts with (closing PP&E = opening + capex − D&A), so a capex surge raises later D&A; otherwise
 * revenue × the history ratio. Invested capital rolls forward by net reinvestment from the base-year value.
 */
export function buildScenarioStatements(input: StatementInput): StatementYear[] {
  const drivers = [...input.drivers].sort((a, b) => a.fiscal_year - b.fiscal_year);
  if (!drivers.length) throw new Error(`No yearly drivers after FY${input.baseYear}.`);
  let prior = input.baseRevenue;
  let ppe = input.ratios.ppe?.opening_net_ppe ?? null;
  let capital = finite(input.ratios.invested_capital) ? input.ratios.invested_capital : null;
  let priorNopat: number | null = null, priorReinvestment: number | null = null;
  return drivers.map((driver, index) => {
    const year = input.baseYear + 1 + index;
    if (driver.fiscal_year !== year) throw new Error(`Yearly drivers miss FY${year}.`);
    const pinned = index === 0 && input.firstYear ? input.firstYear : null;
    if (!pinned && !(finite(driver.revenue_growth) && finite(driver.operating_margin))) {
      throw new Error(`FY${year} needs numeric revenue_growth and operating_margin.`);
    }
    const revenue = pinned ? pinned.revenue : prior * (1 + driver.revenue_growth);
    const operating_income = pinned ? pinned.operating_income : revenue * driver.operating_margin;
    const tax_rate = driver.tax_rate ?? input.ratios.tax_rate;
    const capital_expenditures = revenue * (driver.capex_to_revenue ?? input.ratios.capex_to_revenue ?? 0);
    const depreciation_basis: StatementYear["depreciation_basis"] = finite(driver.da_to_revenue) ? "driver"
      : ppe !== null && input.ratios.ppe ? "ppe_roll_forward" : "revenue_ratio";
    const depreciation_amortization = depreciation_basis === "driver" ? revenue * driver.da_to_revenue!
      : depreciation_basis === "ppe_roll_forward" ? ppe! * input.ratios.ppe!.depreciation_rate
      : revenue * (input.ratios.da_to_revenue ?? 0);
    const nopat = operating_income * (1 - tax_rate);
    const change_in_net_working_capital = (driver.nwc_to_revenue_change ?? 0) * (revenue - prior);
    const net_reinvestment = capital_expenditures - depreciation_amortization + change_in_net_working_capital;
    if (ppe !== null) ppe = ppe + capital_expenditures - depreciation_amortization;
    const openingCapital = capital;
    if (capital !== null) capital += net_reinvestment;
    const row: StatementYear = {
      fiscal_year: year, revenue, revenue_growth: revenue / prior - 1, operating_income, operating_margin: operating_income / revenue,
      depreciation_amortization, capital_expenditures, tax_rate, nopat, change_in_net_working_capital,
      fcff: nopat + depreciation_amortization - capital_expenditures - change_in_net_working_capital,
      depreciation_basis, net_ppe_closing: ppe,
      maintenance_capex: Math.min(capital_expenditures, depreciation_amortization),
      growth_capex: Math.max(0, capital_expenditures - depreciation_amortization),
      net_reinvestment, invested_capital_closing: capital,
      roic: openingCapital !== null && openingCapital > 0 ? nopat / openingCapital : null,
      incremental_roic: priorNopat !== null && priorReinvestment !== null && priorReinvestment > 0 ? (nopat - priorNopat) / priorReinvestment : null,
    };
    prior = revenue;
    priorNopat = nopat;
    priorReinvestment = net_reinvestment;
    return row;
  });
}

/** An FCFF schedule in the shape calculateValuationSchedule reads; every year carries its build. */
export function buildFcffSchedule(input: {
  statements: StatementYear[]; assumptions: ValuationAssumption; bridge: number; dilutedSharesMillions: number;
  currency: string; sourceNotes: string[]; bridgeExplanation?: string;
}): ValuationMethodInput {
  const { statements, assumptions } = input;
  const terminal = assumptions.terminal;
  return {
    method: "fcff", method_name: "Driver-based FCFF DCF", scenario_type: assumptions.scenario_type,
    rationale: assumptions.rationale, currency: input.currency,
    cash_flow_label: "FCFF = NOPAT + D&A - capex - change in NWC", discount_rate: assumptions.discount_rate,
    years: statements.map((year) => ({ fiscal_year: year.fiscal_year, cash_flow: year.fcff, build: {
      starting_profit: year.nopat, depreciation_amortization: year.depreciation_amortization,
      capital_expenditures: year.capital_expenditures, change_in_net_working_capital: year.change_in_net_working_capital, other_adjustments: 0,
    } })),
    terminal: terminal.type === "multiple"
      ? { type: "multiple", metric: "nopat", metric_value: statements.at(-1)!.nopat, multiple: terminal.multiple }
      : { type: "perpetuity", growth_rate: terminal.growth_rate },
    equity_bridge: input.bridge,
    equity_bridge_explanation: input.bridgeExplanation || "Cash and marketable securities less debt and lease liabilities.",
    diluted_shares: input.dilutedSharesMillions,
    source_notes: input.sourceNotes.length ? input.sourceNotes : ["Built by code from the operating scenario drivers."],
  };
}

/**
 * Value per share at each explicit year end (fade years are valued but not listed): the value then of the later cash
 * flows and the terminal value, plus the bridge. For FCFF the bridge also grows by the cash flows counted so far,
 * since no dividends are forecast: the cash stays in the company rather than vanishing from the path. Other methods
 * treat their cash flows as distributed, as before.
 */
export function valuationPricePath(schedule: ValuationMethodInput): { fiscal_year: number; price_target: number }[] {
  const calc = calculateValuationSchedule(schedule);
  const r = calc.discount_rate, times = yearTimes(calc), last = calc.years.length - 1;
  const retain = calc.method === "fcff";
  let retained = 0;
  return calc.years.flatMap((year, i) => {
    retained += retain ? ((year as { counted_cash_flow?: number }).counted_cash_flow ?? year.cash_flow) : 0;
    if (year.fade) return [];
    let value = calc.terminal_value / (1 + r) ** (times[last] - times[i]);
    for (let j = i + 1; j <= last; j += 1) value += calc.years[j].cash_flow / (1 + r) ** (times[j] - times[i]);
    return [{ fiscal_year: year.fiscal_year, price_target: (value + calc.equity_bridge + retained) / calc.diluted_shares }];
  });
}

const methodKey = (schedule: ValuationMethodInput) => schedule.method === "fcff"
  ? `fcff_dcf_${schedule.terminal.type === "multiple" ? "terminal_multiple" : "perpetuity"}` : schedule.method;

/** Price path, anchors (the terminal-year prices), weighted target and returns from three schedules of one method. */
export function assembleValuation(input: {
  schedules: Record<Scenario, ValuationMethodInput>;
  probabilities: Partial<Record<"probability_bear" | "probability_base" | "probability_bull", unknown>>;
  marketPrice: number | null; currency: string; fiscalYearEnd?: string;
}) {
  const { schedules, currency } = input;
  const paths = Object.fromEntries(SCENARIOS.map((scenario) => {
    if (schedules[scenario]?.scenario_type !== scenario) throw new Error(`The ${scenario} schedule is missing or labelled ${schedules[scenario]?.scenario_type}.`);
    return [scenario, valuationPricePath(schedules[scenario])];
  })) as Record<Scenario, { fiscal_year: number; price_target: number }[]>;
  const years = paths.base.map((row) => row.fiscal_year);
  for (const scenario of SCENARIOS) {
    const own = paths[scenario].map((row) => row.fiscal_year);
    if (own.join() !== years.join()) throw new Error(`The ${scenario} schedule covers FY${own.join(", FY")}; base covers FY${years.join(", FY")}.`);
  }
  const terminalYear = years.at(-1)!;
  const anchors = Object.fromEntries(SCENARIOS.map((scenario) => [scenario, paths[scenario].at(-1)!.price_target])) as Record<Scenario, number>;
  // Today's value per case and, against the market price, the annualized return to the terminal-year anchor.
  const today = Object.fromEntries(SCENARIOS.map((scenario) => [scenario, calculateValuationSchedule(schedules[scenario]).value_per_share])) as Record<Scenario, number>;
  const horizonYears = yearTimes(schedules.base)[years.length - 1];
  const market = Number(input.marketPrice);
  // Without a market price there is no return; 0 is stored only because the contract needs a number.
  const totalReturn = (price: number) => (market > 0 ? (price - market) / market : 0);
  const probabilities = SCENARIOS.map((scenario) => Number(input.probabilities[`probability_${scenario}`]));
  const weighted = probabilities.every(Number.isFinite) && Math.abs(probabilities.reduce((sum, p) => sum + p, 0) - 1) <= 0.001
    ? SCENARIOS.reduce((sum, scenario, i) => sum + anchors[scenario] * probabilities[i], 0) : null;
  const weightedToday = weighted === null ? null : SCENARIOS.reduce((sum, scenario, i) => sum + today[scenario] * probabilities[i], 0);
  const irr = (anchor: number) => market > 0 && anchor > 0 ? (anchor / market) ** (1 / horizonYears) - 1 : null;
  const shares = schedules.base.diluted_shares;
  const monthDay = /^\d{2}-\d{2}$/.test(input.fiscalYearEnd ?? "") ? input.fiscalYearEnd : "12-31";
  return {
    valuation_scenario_set: {
      artifact_type: "valuation_scenario_set" as const, valuation_status: "complete" as const, terminal_year: terminalYear,
      terminal_anchor_bear: anchors.bear, terminal_anchor_base: anchors.base, terminal_anchor_bull: anchors.bull,
      uses_adjusted_fcf: true, segments_reconciled: true,
      method_inputs: SCENARIOS.map((scenario) => schedules[scenario]), omitted_methods: [] as { method: string; reason: string }[],
      methods: [...new Set(SCENARIOS.map((scenario) => methodKey(schedules[scenario])))],
      value_today_bear: today.bear, value_today_base: today.base, value_today_bull: today.bull,
      irr_to_terminal_year: Object.fromEntries(SCENARIOS.map((scenario) => [scenario, irr(anchors[scenario])])),
      ...(weighted === null ? {} : {
        probability_bear: probabilities[0], probability_base: probabilities[1], probability_bull: probabilities[2], weighted_target: weighted,
        weighted_value_today: weightedToday,
      }),
      ...(market > 0 ? { current_market_price: market } : {}),
    },
    annual_price_target_path: {
      artifact_type: "annual_price_target_path" as const, currency, market_price_currency: currency,
      annual_projections: years.map((fiscal_year, i) => ({
        fiscal_year, target_date: `${fiscal_year}-${monthDay}`,
        operating_values: Object.fromEntries(SCENARIOS.flatMap((scenario) => {
          const year = schedules[scenario].years[i];
          return [[`cash_flow_${scenario}`, year.cash_flow], ...(year.build ? [[`starting_profit_${scenario}`, year.build.starting_profit]] : [])];
        })),
        balance_sheet_values: { diluted_shares_millions: shares, shares_outstanding_millions: shares, equity_bridge: schedules.base.equity_bridge },
        per_share_values: Object.fromEntries(SCENARIOS.map((scenario) => [`value_per_share_${scenario}`, paths[scenario][i].price_target])),
      })),
      price_target_path: years.flatMap((fiscal_year, i) => SCENARIOS.map((scenario) => {
        const schedule = schedules[scenario], price = paths[scenario][i].price_target;
        return {
          fiscal_year, scenario_type: scenario, valuation_method: methodKey(schedule),
          operating_metric_key: schedule.method, operating_metric_value: schedule.years[i].cash_flow,
          valuation_parameter_key: "discount_rate", valuation_parameter_value: schedule.discount_rate,
          price_target: price, dividend_per_share: 0, total_return_target: totalReturn(price), is_interpolated: false,
        };
      })),
    },
  };
}

/** Scan the range for the first crossing of the target, then bisect it. Null when no value in range reaches it. */
export function solve(value: (x: number) => number, lo: number, hi: number, target: number | null): number | null {
  if (!(Number(target) > 0)) return null;
  const f = (x: number) => { try { return value(x) - target!; } catch { return Number.NaN; } };
  const steps = 100;
  let a = lo, fa = f(lo);
  for (let i = 1; i <= steps; i += 1) {
    const b = lo + ((hi - lo) * i) / steps, fb = f(b);
    if (Number.isFinite(fa) && Number.isFinite(fb) && fa * fb <= 0) {
      let [x0, f0, x1] = [a, fa, b];
      for (let k = 0; k < 60; k += 1) {
        const mid = (x0 + x1) / 2, fm = f(mid);
        if (f0 * fm <= 0) x1 = mid; else [x0, f0] = [mid, fm];
      }
      return Number(((x0 + x1) / 2).toFixed(6));
    }
    [a, fa] = [b, fb];
  }
  return null;
}

/** Today's value per share for the drivers with one field replaced in every year (the first-year pin is dropped). */
const reverseValue = (input: ReverseInput, override: Partial<YearlyDriver>) => calculateValuationSchedule(buildFcffSchedule({
  statements: buildScenarioStatements({ ...input, firstYear: null, drivers: input.drivers.map((driver) => ({ ...driver, ...override })) }),
  assumptions: { ...input.assumptions, rationale: input.assumptions.rationale || "Reverse valuation" },
  bridge: input.bridge, dilutedSharesMillions: input.dilutedSharesMillions, currency: "USD", sourceNotes: [],
})).value_per_share;

/** The uniform operating margin in [−0.5, 0.95] at which the value per share equals the market price. */
export function impliedOperatingMargin(input: ReverseInput): number | null {
  return solve((margin) => reverseValue(input, { operating_margin: margin }), -0.5, 0.95, input.marketPrice);
}

/** The uniform revenue growth in [−0.5, 1.5] at which the value per share equals the market price. */
export function impliedRevenueGrowth(input: ReverseInput): number | null {
  return solve((growth) => reverseValue(input, { revenue_growth: growth }), -0.5, 1.5, input.marketPrice);
}

const hasDriver = (drivers: unknown, year: number) => Array.isArray(drivers) && drivers.some((driver) =>
  driver?.fiscal_year === year && finite(driver.revenue_growth) && finite(driver.operating_margin));

/** What the FCFF valuation needs before any model call; each missing item names the scenario and year or the input. */
export function valuationReadiness(input: {
  drivers: Partial<Record<Scenario, YearlyDriver[] | null | undefined>> | null | undefined; horizon: number[];
  dilutedSharesMillions: number | null | undefined; marketPrice: number | null | undefined; baseRevenue: number | null | undefined;
}): { ready: boolean; missing: string[] } {
  const missing = input.horizon.length ? SCENARIOS.flatMap((scenario) => input.horizon
    .filter((year) => !hasDriver(input.drivers?.[scenario], year))
    .map((year) => `${scenario} yearly drivers for FY${year}`)) : ["forecast horizon"];
  if (!(Number(input.dilutedSharesMillions) > 0)) missing.push("diluted shares");
  if (!(Number(input.marketPrice) > 0)) missing.push("market price");
  if (!(Number(input.baseRevenue) > 0)) missing.push("base-year revenue");
  return { ready: missing.length === 0, missing };
}

/** One message per scenario whose yearly_drivers miss a horizon year. */
export function validateScenarioDriverCoverage(scenarioSet: unknown, horizon: number[]): string[] {
  const scenarios = (scenarioSet as { scenarios?: unknown })?.scenarios;
  const list = Array.isArray(scenarios) ? scenarios : [];
  return SCENARIOS.flatMap((scenario) => {
    const drivers = list.find((entry) => entry?.scenario_type === scenario)?.yearly_drivers;
    const gaps = horizon.filter((year) => !hasDriver(drivers, year));
    return gaps.length ? [`${scenario} yearly_drivers miss FY${gaps.join(", FY")}: give revenue_growth and operating_margin for every forecast_horizon year.`] : [];
  });
}

const AssumptionTerminal = z.discriminatedUnion("type", [
  z.object({ type: z.literal("multiple"), metric: z.literal("nopat"), multiple: z.number().nonnegative() }),
  z.object({ type: z.literal("perpetuity"), growth_rate: z.number().min(-1).max(1) }),
]);
const ValuationAssumptions = z.object({ valuation_assumptions: z.object({
  artifact_type: z.literal("valuation_assumptions"),
  scenarios: z.array(z.object({
    scenario_type: z.enum(SCENARIOS), discount_rate: z.number().gt(0).lt(1), terminal: AssumptionTerminal, rationale: z.string().min(1),
  })).length(3),
  omitted_methods: z.array(z.object({ method: z.string().min(1), reason: z.string().min(1) })).default([]),
  source_notes: z.array(z.string().min(1)).default([]),
}) });
export type ValuationAssumptionsOutput = z.infer<typeof ValuationAssumptions>["valuation_assumptions"];

/** The model-facing valuation format: only per-scenario assumptions, checked against the risk-free rate. */
export function valuationAssumptionsFormat(riskFreeRate: number | null): AgentOutputFormat {
  return {
    requiredKeys: ["valuation_assumptions"],
    schema: z.toJSONSchema(ValuationAssumptions, { target: "draft-7", io: "input", reused: "inline" }) as Record<string, unknown>,
    validate(value) {
      const parsed = ValuationAssumptions.safeParse(value);
      if (!parsed.success) return parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
      const scenarios = parsed.data.valuation_assumptions.scenarios;
      const errors: { path: string; message: string }[] = [];
      const types = scenarios.map((scenario) => scenario.scenario_type);
      if (SCENARIOS.some((type) => types.filter((t) => t === type).length !== 1)) {
        errors.push({ path: "valuation_assumptions.scenarios", message: `Give exactly one bear, one base and one bull scenario; got ${types.join(", ")}.` });
      }
      scenarios.forEach((scenario, i) => {
        const path = `valuation_assumptions.scenarios.${i}`;
        if (riskFreeRate !== null && scenario.discount_rate <= riskFreeRate) {
          errors.push({ path: `${path}.discount_rate`, message: `${scenario.scenario_type} discount_rate ${scenario.discount_rate} must exceed the risk-free rate ${riskFreeRate} (FRED DGS10).` });
        }
        if (scenario.terminal.type === "perpetuity" && scenario.terminal.growth_rate >= scenario.discount_rate) {
          errors.push({ path: `${path}.terminal.growth_rate`, message: `${scenario.scenario_type} perpetuity growth_rate ${scenario.terminal.growth_rate} must be below its discount_rate ${scenario.discount_rate}.` });
        }
      });
      return errors;
    },
  };
}

/**
 * The accepted operating model's revenue and operating income in millions, for pinning the base case's first year.
 * The model may state whole currency units; the unit is taken as the one that puts revenue within 0.5–2× base revenue.
 */
export function operatingModelFirstYear(model: { consolidated_revenue?: unknown; consolidated_operating_income?: unknown } | null | undefined, baseRevenue: number | null | undefined) {
  const revenue = Number(model?.consolidated_revenue), income = Number(model?.consolidated_operating_income), base = Number(baseRevenue);
  if (!(revenue > 0) || !Number.isFinite(income) || !(base > 0)) return null;
  const unit = [1, 1e3, 1e6].find((u) => revenue / u / base > 0.5 && revenue / u / base < 2);
  return unit === undefined ? null : { revenue: revenue / unit, operating_income: income / unit };
}

/** The run's forecast years: its own forecast_years (set at the plan gate), else RESEARCH_FORECAST_YEARS, else 5; 3 to 10. */
export function forecastYears(runValue?: number | null): number {
  const value = Number(runValue) || Number(process.env.RESEARCH_FORECAST_YEARS) || 5;
  return Math.max(3, Math.min(10, Math.round(value)));
}

/** Forecast years after the base fiscal year. */
export function forecastHorizon(baseFiscalYear: number, years = forecastYears()): number[] {
  return Array.from({ length: Math.max(1, Math.min(10, Math.round(years))) }, (_, i) => baseFiscalYear + 1 + i);
}
