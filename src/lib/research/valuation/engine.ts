/**
 * Deterministic valuation engine. The model supplies yearly drivers (operating scenarios) and a
 * discount rate plus terminal assumption per scenario; code builds the statements, the FCFF
 * schedules, the price path, the anchors and the reverse valuation. Amounts are currency millions
 * and rates are decimals.
 */

import { z } from "zod/v4";
import type { AgentOutputFormat } from "@/lib/agent-harness/types";
import type { ValuationFinancialInputs } from "./financial-inputs";
import { calculateValuationSchedule, type ValuationMethodInput } from "./schedules";

export const SCENARIOS = ["bear", "base", "bull"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export type YearlyDriver = {
  fiscal_year: number; revenue_growth: number; operating_margin: number;
  capex_to_revenue?: number | null; da_to_revenue?: number | null; tax_rate?: number | null; nwc_to_revenue_change?: number | null;
};
export type StatementRatios = { da_to_revenue: number | null; capex_to_revenue: number | null; tax_rate: number };
export type StatementYear = {
  fiscal_year: number; revenue: number; revenue_growth: number; operating_income: number; operating_margin: number;
  depreciation_amortization: number; capital_expenditures: number; tax_rate: number; nopat: number;
  change_in_net_working_capital: number; fcff: number;
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
  return {
    da_to_revenue: mean(rows.map((row) => ratio(row, "depreciation_amortization"))),
    capex_to_revenue: mean(rows.map((row) => ratio(row, "capital_expenditures"))),
    tax_rate: tax ?? 0.21,
    tax_rate_source: (tax === null ? "statutory_default" : "history") as "history" | "statutory_default",
    base_year: base ? {
      fiscal_year: Number(base[fi!.columns.indexOf("fiscal_year")]),
      revenue: cell(fi!, base, "revenue")!,
      operating_income: cell(fi!, base, "operating_income"),
    } : null,
  };
}

const BRIDGE_ITEMS = [
  ["cash_and_equivalents", 1], ["marketable_securities", 1], ["long_term_debt", -1], ["current_debt", -1],
  ["operating_lease_liabilities", -1], ["finance_lease_liabilities", -1],
] as const;

/** Equity bridge from the latest row (annual or quarterly) with any balance item: cash + securities − debt − leases. */
export function equityBridge(fi: ValuationFinancialInputs | null): { amount: number; period_end: string; components: Record<string, number>; missing: string[] } | null {
  if (!fi) return null;
  const rows = [...fi.annual, ...fi.quarterly]
    .map((row) => ({ row, items: BRIDGE_ITEMS.filter(([key]) => cell(fi, row, key) !== null) }))
    .filter((entry) => entry.items.length)
    .sort((a, b) => String(a.row[0]).localeCompare(String(b.row[0])) || a.items.length - b.items.length);
  const latest = rows.at(-1);
  if (!latest) return null;
  const components = Object.fromEntries(latest.items.map(([key]) => [key, cell(fi, latest.row, key)!]));
  const amount = latest.items.reduce((sum, [key, sign]) => sum + sign * components[key], 0);
  return {
    amount: Number(amount.toFixed(6)), period_end: String(latest.row[0]), components,
    missing: BRIDGE_ITEMS.map(([key]) => key).filter((key) => !(key in components)),
  };
}

/**
 * Yearly statements from the drivers: revenue grows from the prior year, operating income is revenue × margin,
 * D&A and capex are revenue × (override ?? history ratio), NOPAT = OI × (1 − tax), ΔNWC = nwc_to_revenue_change × Δrevenue
 * and FCFF = NOPAT + D&A − capex − ΔNWC. firstYear pins the first year's revenue and operating income.
 */
export function buildScenarioStatements(input: StatementInput): StatementYear[] {
  const drivers = [...input.drivers].sort((a, b) => a.fiscal_year - b.fiscal_year);
  if (!drivers.length) throw new Error(`No yearly drivers after FY${input.baseYear}.`);
  let prior = input.baseRevenue;
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
    const depreciation_amortization = revenue * (driver.da_to_revenue ?? input.ratios.da_to_revenue ?? 0);
    const capital_expenditures = revenue * (driver.capex_to_revenue ?? input.ratios.capex_to_revenue ?? 0);
    const nopat = operating_income * (1 - tax_rate);
    const change_in_net_working_capital = (driver.nwc_to_revenue_change ?? 0) * (revenue - prior);
    const row = {
      fiscal_year: year, revenue, revenue_growth: revenue / prior - 1, operating_income, operating_margin: operating_income / revenue,
      depreciation_amortization, capital_expenditures, tax_rate, nopat, change_in_net_working_capital,
      fcff: nopat + depreciation_amortization - capital_expenditures - change_in_net_working_capital,
    };
    prior = revenue;
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

/** Value per share at each year end: (PV at t of later cash flows + PV at t of terminal value + bridge) / shares. */
export function valuationPricePath(schedule: ValuationMethodInput): { fiscal_year: number; price_target: number }[] {
  const calc = calculateValuationSchedule(schedule);
  const path: { fiscal_year: number; price_target: number }[] = [];
  let value = calc.terminal_value;
  for (let i = calc.years.length - 1; i >= 0; i -= 1) {
    path.unshift({ fiscal_year: calc.years[i].fiscal_year, price_target: (value + calc.equity_bridge) / calc.diluted_shares });
    value = (value + calc.years[i].cash_flow) / (1 + calc.discount_rate);
  }
  return path;
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
  const market = Number(input.marketPrice);
  // Without a market price there is no return; 0 is stored only because the contract needs a number.
  const totalReturn = (price: number) => (market > 0 ? (price - market) / market : 0);
  const probabilities = SCENARIOS.map((scenario) => Number(input.probabilities[`probability_${scenario}`]));
  const weighted = probabilities.every(Number.isFinite) && Math.abs(probabilities.reduce((sum, p) => sum + p, 0) - 1) <= 0.001
    ? SCENARIOS.reduce((sum, scenario, i) => sum + anchors[scenario] * probabilities[i], 0) : null;
  const shares = schedules.base.diluted_shares;
  const monthDay = /^\d{2}-\d{2}$/.test(input.fiscalYearEnd ?? "") ? input.fiscalYearEnd : "12-31";
  return {
    valuation_scenario_set: {
      artifact_type: "valuation_scenario_set" as const, valuation_status: "complete" as const, terminal_year: terminalYear,
      terminal_anchor_bear: anchors.bear, terminal_anchor_base: anchors.base, terminal_anchor_bull: anchors.bull,
      uses_adjusted_fcf: true, segments_reconciled: true,
      method_inputs: SCENARIOS.map((scenario) => schedules[scenario]), omitted_methods: [] as { method: string; reason: string }[],
      methods: [...new Set(SCENARIOS.map((scenario) => methodKey(schedules[scenario])))],
      ...(weighted === null ? {} : {
        probability_bear: probabilities[0], probability_base: probabilities[1], probability_bull: probabilities[2], weighted_target: weighted,
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
function solve(value: (x: number) => number, lo: number, hi: number, target: number | null): number | null {
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

/** Forecast years after the base fiscal year (RESEARCH_FORECAST_YEARS, default 3). */
export function forecastHorizon(baseFiscalYear: number, years = Number(process.env.RESEARCH_FORECAST_YEARS) || 3): number[] {
  return Array.from({ length: Math.max(1, Math.min(10, Math.round(years))) }, (_, i) => baseFiscalYear + 1 + i);
}
