/**
 * Valuation engine v2 (pure). The operating cases (bear, base, bull) come from the scenario drivers; the valuation
 * assumptions come as three separate sets (conservative, base, aggressive), so every case can be valued under every
 * set. After the explicit forecast, code appends fade years in which growth moves to the terminal rate and
 * reinvestment follows growth / RONIC, and the terminal value is the value-driver formula
 * TV = NOPAT x (1 + g) x (1 - g / RONIC) / (r - g). Anchors and probability weighting use the base set.
 * Everything else here is a cross-check computed from the same inputs: the 3x3 case x set matrix, an r x g grid,
 * reverse valuation in multiple and FCF-growth terms, market multiples against their own history, the no-rerating
 * return, lens values, sanity flags with a per-share attribution, stress cases below bear and a loss-segment split.
 * Amounts are currency millions, shares millions, rates decimals.
 */

import { calculateValuationSchedule, yearTimes, type ValuationMethodInput } from "./schedules";
import { SCENARIOS, assembleValuation, buildScenarioStatements, solve, type Scenario, type StatementYear, type YearlyDriver } from "./engine";
import { z } from "zod/v4";
import type { AgentOutputFormat } from "@/lib/agent-harness/types";
import { tableRows, type FinancialAnalytics } from "../history/analytics";

export const VALUATION_SETS = ["conservative", "base", "aggressive"] as const;
export type ValuationSetKey = (typeof VALUATION_SETS)[number];
export type ValuationSet = {
  set: ValuationSetKey; discount_rate: number; terminal_growth: number; ronic: number; fade_years: number;
  rationale: string; ronic_rationale?: string | null;
};
export type Timing = NonNullable<ValuationMethodInput["timing"]>;
export type ScheduleCommon = {
  bridge: number; shares: number; currency: string; timing?: Timing | null; sourceNotes: string[]; bridgeExplanation: string;
};
export type SegmentOperatingIncome = { segment: string; operating_income: number };
export type SegmentDriver = { fiscal_year: number; segment_operating_income?: SegmentOperatingIncome[] | null };

type Num = number | null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const r4 = (value: Num) => (finite(value) ? Number(value.toFixed(4)) : null);
const r2 = (value: Num) => (finite(value) ? Number(value.toFixed(2)) : null);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : null;
};
export const DEFAULT_FADE_YEARS = 5;

// ---------------------------------------------------------------- schedules

/** Fade years after the last explicit year: growth moves linearly to g, the margin is held, reinvestment = g_t / RONIC x NOPAT_t. */
export function fadeYears(last: StatementYear, set: Pick<ValuationSet, "terminal_growth" | "ronic" | "fade_years">) {
  const rows: { fiscal_year: number; growth: number; nopat: number; reinvestment: number; fcff: number }[] = [];
  let nopat = last.nopat;
  for (let t = 1; t <= set.fade_years; t += 1) {
    const growth = last.revenue_growth + (set.terminal_growth - last.revenue_growth) * (t / set.fade_years);
    nopat *= 1 + growth;
    const reinvestment = (growth / set.ronic) * nopat;
    rows.push({ fiscal_year: last.fiscal_year + t, growth, nopat, reinvestment, fcff: nopat - reinvestment });
  }
  return rows;
}

/** An FCFF schedule for one operating case under one valuation set: explicit years, fade years, value-driver terminal. */
export function driverSchedule(statements: StatementYear[], scenario: Scenario, set: ValuationSet, common: ScheduleCommon): ValuationMethodInput {
  const fade = fadeYears(statements.at(-1)!, set);
  const finalNopat = fade.at(-1)?.nopat ?? statements.at(-1)!.nopat;
  return {
    method: "fcff", method_name: "Driver-based FCFF DCF with value-driver terminal", scenario_type: scenario,
    rationale: `${set.set} valuation set: ${set.rationale}`, currency: common.currency,
    cash_flow_label: "FCFF = NOPAT + D&A - capex - change in NWC; fade years: NOPAT - g / RONIC x NOPAT",
    discount_rate: set.discount_rate,
    years: [
      ...statements.map((year) => ({ fiscal_year: year.fiscal_year, cash_flow: year.fcff, build: {
        starting_profit: year.nopat, depreciation_amortization: year.depreciation_amortization,
        capital_expenditures: year.capital_expenditures, change_in_net_working_capital: year.change_in_net_working_capital, other_adjustments: 0,
      } })),
      ...fade.map((year) => ({ fiscal_year: year.fiscal_year, cash_flow: year.fcff, fade: true, build: {
        starting_profit: year.nopat, depreciation_amortization: 0, capital_expenditures: 0, change_in_net_working_capital: 0,
        other_adjustments: -year.reinvestment,
      } })),
    ],
    terminal: { type: "value_driver", metric: "nopat", metric_value: finalNopat, growth_rate: set.terminal_growth, ronic: set.ronic },
    equity_bridge: common.bridge, equity_bridge_explanation: common.bridgeExplanation, diluted_shares: common.shares,
    ...(common.timing ? { timing: common.timing } : {}),
    source_notes: common.sourceNotes.length ? common.sourceNotes : ["Built by code from the operating scenario drivers."],
  };
}

const valueToday = (schedule: ValuationMethodInput) => calculateValuationSchedule(schedule).value_per_share;
const explicitCount = (schedule: ValuationMethodInput) => schedule.years.filter((year) => !year.fade).length;

/**
 * Value at the end of the explicit forecast of everything after it (fade years and terminal value), as a multiple of
 * that year's NOPAT: the EV/NOPAT the valuation assumes then, comparable with today's and the stock's own history.
 */
export function terminalEquivalentMultiple(schedule: ValuationMethodInput): Num {
  const calc = calculateValuationSchedule(schedule);
  const times = yearTimes(calc), r = calc.discount_rate, t = explicitCount(schedule) - 1, last = calc.years.length - 1;
  let value = calc.terminal_value / (1 + r) ** (times[last] - times[t]);
  for (let j = t + 1; j <= last; j += 1) value += calc.years[j].cash_flow / (1 + r) ** (times[j] - times[t]);
  const nopat = calc.years[t].build?.starting_profit ?? null;
  return nopat !== null && nopat > 0 ? value / nopat : null;
}

/** Share of enterprise value from beyond the explicit forecast (fade years and terminal value). */
export function valueBeyondExplicitShare(schedule: ValuationMethodInput): Num {
  const calc = calculateValuationSchedule(schedule);
  const explicit = calc.years.slice(0, explicitCount(schedule)).reduce((sum, year) => sum + year.present_value, 0);
  return calc.enterprise_value > 0 ? (calc.enterprise_value - explicit) / calc.enterprise_value : null;
}

// ---------------------------------------------------------------- defaults

/**
 * The RONIC default: the mean of the history ROIC median and the base case's explicit incremental ROIC (change in NOPAT
 * over the net reinvestment of the years before), where each is positive. Without either it is the discount rate, at
 * which growth adds no value.
 */
export function ronicDefault(input: { historyRoic: Num; baseStatements: StatementYear[] | null; discountRate: number }) {
  const s = input.baseStatements ?? [];
  const reinvested = s.slice(0, -1).reduce((sum, year) => sum + (year.net_reinvestment ?? year.capital_expenditures - year.depreciation_amortization + year.change_in_net_working_capital), 0);
  const explicit = s.length > 1 && reinvested > 0 ? (s.at(-1)!.nopat - s[0].nopat) / reinvested : null;
  const candidates = [input.historyRoic, explicit].filter((value): value is number => finite(value) && value > 0);
  const raw = candidates.length ? candidates.reduce((a, b) => a + b, 0) / candidates.length : input.discountRate;
  const ronic = Number(Math.max(0.04, Math.min(0.6, raw)).toFixed(4));
  return {
    ronic, history_roic: r4(input.historyRoic), explicit_incremental_roic: r4(explicit),
    basis: candidates.length
      ? `Mean of ${[finite(input.historyRoic) && input.historyRoic > 0 ? "the 20-quarter median ROIC" : "", finite(explicit) && explicit > 0 ? "the base case's explicit incremental ROIC" : ""].filter(Boolean).join(" and ")}, bounded to 4-60%.`
      : "No usable ROIC history or explicit incremental ROIC; RONIC equals the base discount rate, so terminal growth adds no value.",
  };
}

/**
 * Code-prepared sets: the base discount rate is the CAPM cost of equity (used as the FCFF rate; label it when debt is
 * material), conservative +1pt and aggressive -1pt. Terminal growth is 2.5% capped at the risk-free rate, +/-0.5pt
 * (aggressive also capped at the risk-free rate). RONIC is the default for all three.
 */
export function defaultValuationSets(input: { capm: Num; riskFree: Num; ronic: number; fadeYears?: number }): ValuationSet[] {
  const rf = finite(input.riskFree) ? input.riskFree : null;
  const base = finite(input.capm) ? input.capm : rf !== null ? rf + 0.05 : 0.09;
  const g = Math.min(0.025, rf ?? 0.025);
  const fade = input.fadeYears ?? DEFAULT_FADE_YEARS;
  const rate = (value: number) => Number(Math.max(value, (rf ?? 0) + 0.005).toFixed(4));
  const growth = (value: number) => Number(Math.min(value, rf ?? value).toFixed(4));
  const source = finite(input.capm) ? "CAPM cost of equity" : rf !== null ? "risk-free rate + 5pt (no CAPM inputs)" : "9% default (no CAPM or risk-free rate)";
  return [
    { set: "conservative", discount_rate: rate(base + 0.01), terminal_growth: growth(g - 0.005), ronic: input.ronic, fade_years: fade,
      rationale: `${source} + 1pt; terminal growth 0.5pt below base.` },
    { set: "base", discount_rate: rate(base), terminal_growth: growth(g), ronic: input.ronic, fade_years: fade,
      rationale: `${source}; terminal growth ${(g * 100).toFixed(1)}%${rf !== null && g === rf ? " (the risk-free rate)" : ""}.` },
    { set: "aggressive", discount_rate: rate(base - 0.01), terminal_growth: growth(g + 0.005), ronic: input.ronic, fade_years: fade,
      rationale: `${source} - 1pt; terminal growth 0.5pt above base, capped at the risk-free rate.` },
  ];
}

/** Problems with model-adjusted sets, one per message. */
export function validateValuationSets(sets: ValuationSet[], defaults: ValuationSet[], riskFree: Num): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  const keys = sets.map((set) => set.set);
  if (VALUATION_SETS.some((key) => keys.filter((k) => k === key).length !== 1)) {
    errors.push({ path: "valuation_assumptions.sets", message: `Give exactly one conservative, one base and one aggressive set; got ${keys.join(", ")}.` });
    return errors;
  }
  const by = Object.fromEntries(sets.map((set) => [set.set, set])) as Record<ValuationSetKey, ValuationSet>;
  sets.forEach((set, i) => {
    const path = `valuation_assumptions.sets.${i}`;
    if (riskFree !== null && set.discount_rate <= riskFree) errors.push({ path: `${path}.discount_rate`, message: `${set.set} discount_rate ${set.discount_rate} must exceed the risk-free rate ${riskFree} (FRED DGS10).` });
    if (set.terminal_growth >= set.discount_rate) errors.push({ path: `${path}.terminal_growth`, message: `${set.set} terminal_growth must be below its discount_rate.` });
    if (set.ronic <= set.terminal_growth) errors.push({ path: `${path}.ronic`, message: `${set.set} ronic ${set.ronic} must exceed terminal_growth ${set.terminal_growth}: at or below it, growth costs all of NOPAT and the terminal value is zero or negative.` });
    if (riskFree !== null && set.terminal_growth > riskFree + 1e-9) errors.push({ path: `${path}.terminal_growth`, message: `${set.set} terminal_growth ${set.terminal_growth} must not exceed the risk-free rate ${riskFree}: no business outgrows the economy forever.` });
    const fallback = defaults.find((d) => d.set === set.set);
    if (fallback && Math.abs(set.ronic - fallback.ronic) > 0.005 && !set.ronic_rationale?.trim()) {
      errors.push({ path: `${path}.ronic_rationale`, message: `${set.set} ronic ${set.ronic} departs from the code default ${fallback.ronic}; state why in ronic_rationale.` });
    }
  });
  if (!(by.conservative.discount_rate >= by.base.discount_rate && by.base.discount_rate >= by.aggressive.discount_rate)) {
    errors.push({ path: "valuation_assumptions.sets", message: "Discount rates must not fall from conservative to base to aggressive in the wrong order: conservative >= base >= aggressive." });
  }
  if (!(by.conservative.terminal_growth <= by.base.terminal_growth && by.base.terminal_growth <= by.aggressive.terminal_growth)) {
    errors.push({ path: "valuation_assumptions.sets", message: "Terminal growth must satisfy conservative <= base <= aggressive." });
  }
  return errors;
}

// ---------------------------------------------------------------- timing

/**
 * Discount timing from the valuation date: the fraction of the first forecast year still ahead, and the FCFF that year
 * already reported in its quarters up to the valuation date (NOPAT at the forecast tax rate + D&A - capex). The equity
 * bridge is at the latest reported quarter, so first-year cash after that quarter is what still counts. When a reported
 * quarter lacks a component, the reported part is pro-rated (a quarter of the case's first-year FCFF per quarter).
 */
export function valuationTiming(input: {
  valuationDate: string; firstYearEnd: string; taxRate: number;
  reportedQuarters: { period_end: string; operating_income: Num; depreciation_amortization: Num; capital_expenditures: Num }[];
}): (Timing & { first_year_reported_quarters: string[] }) | null {
  const start = Date.parse(`${input.valuationDate.slice(0, 10)}T00:00:00Z`), end = Date.parse(`${input.firstYearEnd}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const fraction = Math.max(1 / 365, Math.min(1, (end - start) / (365 * 86_400_000)));
  const quarters = input.reportedQuarters.filter((q) => q.period_end <= input.valuationDate.slice(0, 10)).slice(0, 3);
  const complete = quarters.every((q) => finite(q.operating_income) && finite(q.depreciation_amortization) && finite(q.capital_expenditures));
  const reported = complete ? quarters.reduce((sum, q) => sum + q.operating_income! * (1 - input.taxRate) + Math.abs(q.depreciation_amortization!) - Math.abs(q.capital_expenditures!), 0) : 0;
  return {
    valuation_date: input.valuationDate.slice(0, 10), first_year_fraction: Number(fraction.toFixed(6)),
    first_year_reported_cash_flow: Number(reported.toFixed(3)),
    reported_basis: !quarters.length ? "none" : complete ? "reported" : "pro_rata",
    first_year_reported_quarters: quarters.map((q) => q.period_end),
  };
}

/** A case's timing: pro-rata timing takes the reported part from the case's own first-year FCFF. */
export function caseTiming(timing: ReturnType<typeof valuationTiming>, statements: StatementYear[]): Timing | null {
  if (!timing) return null;
  const { first_year_reported_quarters: quarters, ...rest } = timing;
  return rest.reported_basis === "pro_rata"
    ? { ...rest, first_year_reported_cash_flow: Number((statements[0].fcff * quarters.length / 4).toFixed(3)) } : rest;
}

// ---------------------------------------------------------------- currency

/** FRED daily rates against the US dollar; `perUsd` series quote foreign units per dollar. */
const FX_SERIES: Record<string, { series: string; perUsd: boolean }> = {
  CNY: { series: "DEXCHUS", perUsd: true }, JPY: { series: "DEXJPUS", perUsd: true }, EUR: { series: "DEXUSEU", perUsd: false },
  GBP: { series: "DEXUSUK", perUsd: false }, CAD: { series: "DEXCAUS", perUsd: true }, HKD: { series: "DEXHKUS", perUsd: true },
  KRW: { series: "DEXKOUS", perUsd: true }, INR: { series: "DEXINUS", perUsd: true }, BRL: { series: "DEXBZUS", perUsd: true },
  MXN: { series: "DEXMXUS", perUsd: true }, CHF: { series: "DEXSZUS", perUsd: true }, AUD: { series: "DEXUSAL", perUsd: false },
  TWD: { series: "DEXTAUS", perUsd: true },
};

/** The FRED series that converts statement currency into a USD price currency, or null. */
export function fxSeriesFor(statementCurrency: string, priceCurrency: string) {
  return priceCurrency === "USD" ? FX_SERIES[statementCurrency] ?? null : null;
}

/** Last numeric FRED value on or before the cutoff, as quoted. */
export function latestFredValue(csv: string, cutoffDate: string): { value: number; observation_date: string } | null {
  let found: { value: number; observation_date: string } | null = null;
  for (const line of csv.trim().split(/\r?\n/)) {
    const [date = "", raw = ""] = line.split(",").map((part) => part.trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > cutoffDate.slice(0, 10) || !raw || raw === "." || !Number.isFinite(Number(raw)) || !(Number(raw) > 0)) continue;
    if (!found || date >= found.observation_date) found = { value: Number(raw), observation_date: date };
  }
  return found;
}

/**
 * Price-currency units per statement-currency unit and ordinary shares per listed share. When the statement currency
 * differs from the price currency, both an FX rate and the depositary ratio must be known, or the valuation is withheld
 * rather than comparing, say, RMB per ordinary share with a USD price per ADS.
 */
export function currencyConversion(input: {
  statementCurrency: string | null; priceCurrency: string | null; depositaryRatio: Num;
  fx: { series: string; value: number; observation_date: string; perUsd: boolean } | null;
  /** The listing is a depositary share (ADS/ADR) or the issuer files as a foreign private issuer. */
  depositaryListing?: boolean;
}) {
  const foreign = Boolean(input.statementCurrency && input.priceCurrency && input.statementCurrency !== input.priceCurrency);
  // A depositary share needs its ratio even when statements and price share a currency.
  const needsRatio = foreign || Boolean(input.depositaryListing);
  const missing = [
    ...(!input.statementCurrency ? ["the statement currency (financial_inputs.currency was not captured)"] : []),
    ...(foreign && !input.fx ? [`an FX rate from ${input.statementCurrency} to ${input.priceCurrency} on or before the cutoff${fxSeriesFor(input.statementCurrency!, input.priceCurrency!) ? ` (FRED ${fxSeriesFor(input.statementCurrency!, input.priceCurrency!)!.series})` : ""}`] : []),
    ...(needsRatio && !(Number(input.depositaryRatio) > 0) ? ["the depositary ratio (ordinary shares per listed share; 1 for an ordinary listing) on the asset's instrument"] : []),
  ];
  const rate = foreign && input.fx ? (input.fx.perUsd ? 1 / input.fx.value : input.fx.value) : 1;
  const ratio = Number(input.depositaryRatio) > 0 ? Number(input.depositaryRatio) : 1;
  return {
    missing, fx_rate: Number(rate.toPrecision(8)), depositary_ratio: ratio,
    statement_currency: input.statementCurrency, price_currency: input.priceCurrency ?? input.statementCurrency,
    fx_source: foreign && input.fx ? { series: input.fx.series, source: "FRED", observation_date: input.fx.observation_date, quoted: input.fx.value } : null,
    basis: foreign ? `Amounts converted at ${rate.toPrecision(6)} ${input.priceCurrency} per ${input.statementCurrency}; per-share values per listed share of ${ratio} ordinary shares.`
      : ratio !== 1 ? `Per-share values per listed share of ${ratio} ordinary shares.` : "Statements and price share one currency; ordinary shares.",
  };
}

// ---------------------------------------------------------------- reverse valuation

type ReverseContext = { statements: StatementYear[]; set: ValuationSet; common: ScheduleCommon; price: number };

/** The FCFF base a reverse growth solve starts from, as of the latest reported TTM. */
export type GrowthBase = { basis: "nopat" | "normalized_fcf" | "ocf_minus_capex"; label: string; amount: number };

export function growthBases(pack: FinancialAnalytics | null, fx = 1): GrowthBase[] {
  if (!pack) return [];
  const latest = tableRows(pack.cash_conversion.quarterly).at(-1) ?? {};
  const nopat = finite(latest.nopat_ttm) ? latest.nopat_ttm : null;
  const growthCapex = finite(latest.growth_capex_ttm) ? latest.growth_capex_ttm : null;
  const fcf = finite(latest.fcf_ttm) ? latest.fcf_ttm : null;
  return [
    ...(nopat !== null ? [{ basis: "nopat" as const, label: `TTM NOPAT ${latest.period} (owner earnings if capex only maintained the base)`, amount: nopat * fx }] : []),
    ...(nopat !== null && growthCapex !== null ? [{ basis: "normalized_fcf" as const, label: `TTM NOPAT - (capex - D&A) ${latest.period}`, amount: (nopat - growthCapex) * fx }] : []),
    ...(fcf !== null ? [{ basis: "ocf_minus_capex" as const, label: `TTM operating cash flow - capex ${latest.period}`, amount: fcf * fx }] : []),
  ];
}

/**
 * Reverse valuation in interpretable terms, under the base set:
 * - implied_terminal_multiple: the EV/NOPAT at the end of the explicit forecast that the price needs (closed form);
 * - implied_perpetual_growth: the terminal growth at the set's RONIC (fade included) that reproduces the price;
 * - implied FCF growth for 10 years, then terminal growth, from each growth base, and the value of flat FCF;
 * - implied_margin and implied_growth: the uniform explicit-year driver, kept as secondary measures.
 */
export function reverseValuationV2(ctx: ReverseContext, bases: GrowthBase[]) {
  const { statements, set, common, price } = ctx;
  const schedule = driverSchedule(statements, "base", set, common);
  const calc = calculateValuationSchedule(schedule);
  const n = explicitCount(schedule);
  const explicitPv = calc.years.slice(0, n).reduce((sum, year) => sum + year.present_value, 0);
  const needed = (price * common.shares - common.bridge - explicitPv) / calc.years[n - 1].discount_factor;
  const lastNopat = statements.at(-1)!.nopat;
  const value = (s: ValuationSet, st = statements) => valueToday(driverSchedule(st, "base", s, common));
  const r = set.discount_rate, times = yearTimes(schedule);
  const tenYear = (base: number, x: number) => {
    let pv = 0, flow = base;
    for (let t = 0; t < 10; t += 1) { flow *= 1 + x; pv += flow / (1 + r) ** (times[0] + t); }
    const tv = (flow * (1 + set.terminal_growth)) / (r - set.terminal_growth);
    return (pv + tv / (1 + r) ** (times[0] + 9) + common.bridge) / common.shares;
  };
  const uniform = (override: Partial<YearlyDriver>) => (x: number) => {
    const drivers = statements.map((year) => ({ fiscal_year: year.fiscal_year, revenue_growth: year.revenue_growth, operating_margin: year.operating_margin,
      capex_to_revenue: year.capital_expenditures / year.revenue, tax_rate: year.tax_rate,
      ...(override.operating_margin !== undefined ? { operating_margin: x } : {}), ...(override.revenue_growth !== undefined ? { revenue_growth: x } : {}) }));
    const base = statements[0].revenue / (1 + statements[0].revenue_growth);
    return value(set, buildScenarioStatements({ baseRevenue: base, baseYear: statements[0].fiscal_year - 1,
      ratios: { da_to_revenue: statements[0].depreciation_amortization / statements[0].revenue, capex_to_revenue: null, tax_rate: statements[0].tax_rate }, drivers }));
  };
  return {
    artifact_type: "reverse_valuation" as const, method: "fcff", market_price: price, valuation_set: set.set,
    implied_terminal_multiple: r2(lastNopat > 0 ? needed / lastNopat : null),
    implied_perpetual_growth: solve((g) => value({ ...set, terminal_growth: g }), -0.05, set.discount_rate - 0.001, price),
    ronic_used: set.ronic,
    implied_fcf_growth_10y: bases.map((base) => ({
      basis: base.basis, label: base.label, base_amount: r2(base.amount),
      implied_growth: base.amount > 0 ? solve((x) => tenYear(base.amount, x), -0.5, 1, price) : null,
      flat_value_per_share: r2(base.amount > 0 ? tenYear(base.amount, 0) : null),
    })),
    implied_margin: solve(uniform({ operating_margin: 0 }), -0.5, 0.95, price),
    implied_growth: solve(uniform({ revenue_growth: 0 }), -0.5, 1.5, price),
    basis: `Base operating case under the ${set.set} valuation set (r ${set.discount_rate}, g ${set.terminal_growth}, RONIC ${set.ronic}, ${set.fade_years} fade years). implied_terminal_multiple is the EV/NOPAT at FY${statements.at(-1)!.fiscal_year} the price needs; implied_perpetual_growth reproduces the price at the same RONIC; implied_fcf_growth_10y grows each base for 10 years, then at g. implied_margin and implied_growth replace one driver in every explicit year. null: no value in range reaches the price.`,
  };
}

// ---------------------------------------------------------------- market cross-checks

type Range = { min: Num; median: Num; max: Num; n: number; first_period: string | null; last_period: string | null };
const range = (points: { period: string; value: number }[]): Range => {
  const values = points.map((p) => p.value).sort((a, b) => a - b);
  return { min: r2(values[0] ?? null), median: r2(median(values)), max: r2(values.at(-1) ?? null), n: values.length,
    first_period: points[0]?.period ?? null, last_period: points.at(-1)?.period ?? null };
};

/**
 * Today's EV/NOPAT, EV/EBIT, P/FCF and FCF yields at the market price, the stock's own quarterly EV/NOPAT and FCF-yield
 * history from the analytics pack, and per case the no-rerating value: today's EV/NOPAT held on terminal-year NOPAT, plus
 * the bridge and the cash flows retained to then. Own history needs statements and prices in one currency.
 */
export function marketCrossChecks(input: {
  price: number; shares: number; bridge: number; pack: FinancialAnalytics | null; fx: number;
  schedules: Record<Scenario, ValuationMethodInput>;
}) {
  const { price, shares, bridge, pack, fx } = input;
  const marketCap = price * shares, ev = marketCap - bridge;
  const latest = pack ? tableRows(pack.cash_conversion.quarterly).at(-1) ?? {} : {};
  const tax = pack?.tax_rate.normalized ?? null;
  const nopat = finite(latest.nopat_ttm) ? latest.nopat_ttm * fx : null;
  const fcf = finite(latest.fcf_ttm) ? latest.fcf_ttm * fx : null;
  const growthCapex = finite(latest.growth_capex_ttm) ? latest.growth_capex_ttm * fx : null;
  const ebit = nopat !== null && tax !== null && tax < 1 ? nopat / (1 - tax) : null;
  const evToNopat = nopat !== null && nopat > 0 ? ev / nopat : null;
  const history = (() => {
    if (!pack || fx !== 1) return null;
    const cash = new Map(tableRows(pack.cash_conversion.quarterly).map((row) => [row.period, row]));
    const multiples: { period: string; value: number }[] = [], yields: { period: string; value: number }[] = [];
    for (const row of tableRows(pack.capital_allocation.quarterly)) {
      const n = cash.get(row.period)?.nopat_ttm;
      if (finite(row.market_cap) && finite(row.net_cash) && finite(n) && n > 0) multiples.push({ period: row.period, value: (row.market_cap - row.net_cash) / n });
      if (finite(row.fcf_yield)) yields.push({ period: row.period, value: row.fcf_yield });
    }
    return { ev_to_nopat: range(multiples), fcf_yield: { ...range(yields), min: r4(Math.min(...yields.map((y) => y.value))), median: r4(median(yields.map((y) => y.value))), max: r4(Math.max(...yields.map((y) => y.value))) } };
  })();
  const no_rerating = Object.fromEntries(SCENARIOS.map((scenario) => {
    const schedule = input.schedules[scenario];
    const calc = calculateValuationSchedule(schedule);
    const n = explicitCount(schedule), times = yearTimes(schedule);
    const lastNopat = calc.years[n - 1].build?.starting_profit ?? null;
    const retained = calc.years.slice(0, n).reduce((sum, year) => sum + ((year as { counted_cash_flow?: number }).counted_cash_flow ?? year.cash_flow), 0);
    const value = evToNopat !== null && lastNopat !== null ? (evToNopat * lastNopat + calc.equity_bridge + retained) / calc.diluted_shares : null;
    const ret = value !== null ? value / price - 1 : null;
    return [scenario, { terminal_year: calc.years[n - 1].fiscal_year, value_per_share: r2(value), return: r4(ret),
      annualized: r4(ret !== null && ret > -1 ? (1 + ret) ** (1 / times[n - 1]) - 1 : null) }];
  })) as Record<Scenario, { terminal_year: number; value_per_share: Num; return: Num; annualized: Num }>;
  const assumed = terminalEquivalentMultiple(input.schedules.base);
  return {
    period: (latest.period as string | undefined) ?? null, market_cap: r2(marketCap), enterprise_value: r2(ev),
    ev_to_nopat: r2(evToNopat), ev_to_ebit: r2(ebit !== null && ebit > 0 ? ev / ebit : null),
    price_to_fcf: r2(fcf !== null && fcf > 0 ? marketCap / fcf : null),
    fcf_yield_ocf_basis: r4(fcf !== null ? fcf / marketCap : null),
    fcf_yield_nopat_basis: r4(nopat !== null && growthCapex !== null ? (nopat - growthCapex) / marketCap : null),
    sbc_treatment: "The OCF basis (operating cash flow - capex) adds stock-based compensation back as non-cash; the NOPAT basis (NOPAT + D&A - capex) keeps it as a cost through operating income.",
    own_history: history,
    own_history_note: history ? "Quarterly EV = market cap - net cash (the analytics definition, without current debt or investments) over TTM NOPAT." : fx !== 1 ? "Own-history multiples need statements and prices in one currency; not computed." : "No analytics pack.",
    assumed_terminal_ev_to_nopat: r2(assumed),
    implied_multiple_change: r4(assumed !== null && evToNopat !== null ? assumed / evToNopat : null),
    no_rerating,
  };
}

// ---------------------------------------------------------------- lenses

export type LensValue = { lens: string; value_per_share: Num; value_to_price: Num; signal: string; cheapness_score: Num; basis: string; reason?: string };

const lensSignal = (value: Num, price: number) => {
  if (value === null || !(price > 0)) return { value_to_price: null, signal: "not_applicable", cheapness_score: null };
  const ratio = value / price;
  // The signal vocabulary the valuation-signal views draw.
  const signal = ratio >= 1.5 ? "very_cheap" : ratio >= 1.15 ? "cheap" : ratio > 0.85 ? "neutral" : ratio > 0.6 ? "expensive" : "very_expensive";
  return { value_to_price: r4(ratio), signal, cheapness_score: r4(Math.max(0, Math.min(1, ratio / 2))) };
};

/** The required lenses with real values: DCF today, own-history EV/NOPAT on next-year NOPAT, and own-history FCF yield on TTM FCF. */
export function lensValues(input: {
  price: number; shares: number; bridge: number; dcfToday: number; nextNopat: Num; fcfTtm: Num;
  checks: ReturnType<typeof marketCrossChecks>;
}): LensValue[] {
  const multiple = input.checks.own_history?.ev_to_nopat.median ?? null;
  const yieldMedian = input.checks.own_history?.fcf_yield.median ?? null;
  const multipleValue = multiple !== null && input.nextNopat !== null ? (multiple * input.nextNopat + input.bridge) / input.shares : null;
  const cashValue = yieldMedian !== null && yieldMedian > 0 && input.fcfTtm !== null ? input.fcfTtm / yieldMedian / input.shares : null;
  return [
    { lens: "dcf", value_per_share: r2(input.dcfToday), ...lensSignal(input.dcfToday, input.price), basis: "Probability-weighted DCF value today under the base valuation set" },
    { lens: "multiple", value_per_share: r2(multipleValue), ...lensSignal(multipleValue, input.price),
      basis: `Own-history median EV/NOPAT (${multiple ?? "n/a"}x) on the base case's first forecast-year NOPAT, plus the bridge`,
      ...(multipleValue === null ? { reason: "No own-history EV/NOPAT (needs the analytics pack, market caps and one currency)" } : {}) },
    { lens: "cash_flow", value_per_share: r2(cashValue), ...lensSignal(cashValue, input.price),
      basis: `TTM FCF (operating cash flow - capex) at the own-history median FCF yield (${yieldMedian ?? "n/a"})`,
      ...(cashValue === null ? { reason: "No own-history FCF yield or positive TTM FCF" } : {}) },
  ];
}

// ---------------------------------------------------------------- sanity flags and stress

/**
 * Flags: value beyond the explicit forecast above 85% of EV, weighted value today / price outside 0.6-1.6, the assumed
 * terminal EV/NOPAT outside the stock's own range, and terminal-year capex above 1.5x D&A. When value/price or the
 * terminal share fires, one-at-a-time per-share deltas on the base case attribute the gap.
 */
export function sanityFlags(input: {
  schedules: Record<Scenario, ValuationMethodInput>; statements: Record<Scenario, StatementYear[]>; set: ValuationSet; common: ScheduleCommon;
  price: number; weightedToday: Num; capm: Num; riskFree: Num; historyRoic: Num; checks: ReturnType<typeof marketCrossChecks>;
}) {
  const flags: { flag: string; value: Num; threshold: string; message: string }[] = [];
  // The 0.85 gate is the terminal value alone, after the fade years (the same measure as report_facts' tv_share_of_ev).
  for (const scenario of SCENARIOS) {
    const share = calculateValuationSchedule(input.schedules[scenario]).tv_share_of_ev;
    if (share !== null && share > 0.85) flags.push({ flag: `terminal_share_${scenario}`, value: r4(share), threshold: "> 0.85",
      message: `The terminal value is ${Math.round(share * 100)}% of the ${scenario} enterprise value even after the fade years; the forecast decides little.` });
  }
  const today = input.weightedToday ?? valueToday(input.schedules.base);
  const ratio = input.price > 0 ? today / input.price : null;
  if (ratio !== null && (ratio < 0.6 || ratio > 1.6)) flags.push({ flag: "value_to_price", value: r4(ratio), threshold: "outside 0.6-1.6",
    message: `Value today is ${ratio.toFixed(2)}x the market price; for a liquid stock a gap this size more often means a modelling assumption than a market error.` });
  const assumed = input.checks.assumed_terminal_ev_to_nopat, own = input.checks.own_history?.ev_to_nopat;
  if (assumed !== null && own && own.min !== null && own.max !== null && (assumed < own.min || assumed > own.max)) flags.push({ flag: "terminal_multiple_outside_history", value: assumed,
    threshold: `${own.min}-${own.max}x`, message: `The valuation assumes ${assumed}x NOPAT at the end of the forecast, outside the stock's ${own.min}-${own.max}x EV/NOPAT range since ${own.first_period}.` });
  const last = input.statements.base.at(-1)!;
  const capexToDa = last.depreciation_amortization > 0 ? last.capital_expenditures / last.depreciation_amortization : null;
  if (capexToDa !== null && capexToDa > 1.5) flags.push({ flag: "terminal_year_capex_to_da", value: r2(capexToDa), threshold: "> 1.5",
    message: `Base FY${last.fiscal_year} capex is ${capexToDa.toFixed(2)}x D&A; the fade years bring reinvestment to g / RONIC, so check the explicit forecast does not end mid-cycle.` });
  const fires = flags.some((flag) => flag.flag === "value_to_price" || flag.flag.startsWith("terminal_share"));
  const base = valueToday(input.schedules.base);
  // A change the schedule rejects (g at or above r, RONIC at or below g) gives no delta rather than failing the stage.
  const alt = (set: ValuationSet): number | null => {
    try { return valueToday(driverSchedule(input.statements.base, "base", set, input.common)) - base; } catch { return null; }
  };
  const attribution = !fires ? [] : [
    ...(own?.median != null ? [(() => {
      const calc = calculateValuationSchedule(input.schedules.base), n = explicitCount(input.schedules.base);
      const explicit = calc.years.slice(0, n).reduce((sum, year) => sum + year.present_value, 0);
      const value = (explicit + own.median! * last.nopat * calc.years[n - 1].discount_factor + calc.equity_bridge) / calc.diluted_shares;
      return { change: `Terminal at the own-history median ${own.median}x EV/NOPAT instead of the value-driver terminal`, delta_per_share: r2(value - base) };
    })()] : []),
    ...(finite(input.capm) && Math.abs(input.capm - input.set.discount_rate) > 0.0005 ? [{ change: `Discount rate at CAPM ${input.capm}`, delta_per_share: r2(alt({ ...input.set, discount_rate: input.capm })) }] : []),
    ...(finite(input.historyRoic) && input.historyRoic > input.set.terminal_growth && Math.abs(input.historyRoic - input.set.ronic) > 0.005 ? [{ change: `RONIC at the history ROIC median ${r4(input.historyRoic)}`, delta_per_share: r2(alt({ ...input.set, ronic: input.historyRoic })) }] : []),
    { change: "Ten fade years instead of " + input.set.fade_years, delta_per_share: r2(alt({ ...input.set, fade_years: 10 })) },
    ...(finite(input.riskFree) && input.riskFree < input.set.discount_rate && Math.abs(input.riskFree - input.set.terminal_growth) > 0.0005 ? [{ change: `Terminal growth at the risk-free rate ${input.riskFree}`, delta_per_share: r2(alt({ ...input.set, terminal_growth: input.riskFree })) }] : []),
  ];
  return { flags, attribution, base_value_today: r2(base) };
}

/**
 * Stress cases below bear, mechanical rather than forecasts: impairment = bear operations, conservative set and RONIC
 * equal to the discount rate (growth creates no value); tail = impairment with zero terminal growth and the final
 * explicit year's NOPAT cut by 30% before the fade (lasting moat decay).
 */
export function stressCases(input: { bear: StatementYear[]; conservative: ValuationSet; common: ScheduleCommon; price: number }) {
  const impairmentSet = { ...input.conservative, ronic: input.conservative.discount_rate };
  const impaired = valueToday(driverSchedule(input.bear, "bear", impairmentSet, input.common));
  const last = input.bear.at(-1)!, cut = last.nopat * 0.3;
  const decayed = [...input.bear.slice(0, -1), { ...last, nopat: last.nopat - cut, fcff: last.fcff - cut }];
  const tail = valueToday(driverSchedule(decayed, "bear", { ...impairmentSet, terminal_growth: 0 }, input.common));
  const row = (name: string, value: number, definition: string) => ({ case: name, value_per_share: r2(value), return: r4(input.price > 0 ? value / input.price - 1 : null), definition });
  return [
    row("impairment", impaired, `Bear operations, conservative set (r ${impairmentSet.discount_rate}, g ${impairmentSet.terminal_growth}) and RONIC = r: growth creates no value.`),
    row("tail", tail, "Impairment with zero terminal growth and the final explicit year's NOPAT cut by 30% before the fade: a lasting loss of competitive position."),
  ];
}

// ---------------------------------------------------------------- loss-making segments

/**
 * Loss-making segments as an explicit after-tax loss stream on the base case. The consolidated terminal carries the
 * final-year loss forward, so core value adds back the persistent stream (final loss as a zero-growth perpetuity);
 * value_if_losses_fade then subtracts a stream that fades linearly to zero over the fade years. Segment operating
 * income must reconcile to consolidated within 0.5% for every year it is given.
 */
export function lossSegments(input: { drivers: SegmentDriver[] | null | undefined; statements: StatementYear[]; schedule: ValuationMethodInput; set: ValuationSet }) {
  const byYear = new Map((input.drivers ?? []).filter((d) => Array.isArray(d.segment_operating_income) && d.segment_operating_income.length)
    .map((d) => [d.fiscal_year, d.segment_operating_income!]));
  if (!byYear.size) return { available: false as const, segments_reconciled: true, reason: "No per-year segment operating income in the base case's yearly_drivers." };
  const mismatches = input.statements.flatMap((year) => {
    const parts = byYear.get(year.fiscal_year);
    if (!parts) return [];
    const sum = parts.reduce((total, part) => total + part.operating_income, 0);
    return Math.abs(sum - year.operating_income) > Math.max(1, Math.abs(year.operating_income) * 0.005)
      ? [`FY${year.fiscal_year}: segments sum to ${sum.toFixed(1)}, consolidated operating income is ${year.operating_income.toFixed(1)}.`] : [];
  });
  const calc = calculateValuationSchedule(input.schedule), times = yearTimes(input.schedule), r = calc.discount_rate;
  const lastYear = input.statements.at(-1)!;
  const lastParts = byYear.get(lastYear.fiscal_year) ?? [];
  const shares = calc.diluted_shares;
  const segments = lastParts.filter((part) => part.operating_income < 0).map((part) => {
    let explicit = 0;
    input.statements.forEach((year, i) => {
      const income = byYear.get(year.fiscal_year)?.find((p) => p.segment === part.segment)?.operating_income ?? 0;
      const share = i === 0 && input.schedule.timing ? input.schedule.timing.first_year_fraction : 1;
      explicit += (income * (1 - year.tax_rate) * share) / (1 + r) ** times[i];
    });
    const loss = part.operating_income * (1 - lastYear.tax_rate);
    const t = times[input.statements.length - 1];
    const persistent = explicit + loss / r / (1 + r) ** t;
    let fading = explicit;
    for (let k = 1; k <= input.set.fade_years; k += 1) fading += (loss * (1 - k / input.set.fade_years)) / (1 + r) ** (t + k);
    return { segment: part.segment, final_year_operating_income: r2(part.operating_income),
      pv_persistent: r2(persistent), pv_fading: r2(fading), per_share_persistent: r2(persistent / shares), per_share_fading: r2(fading / shares) };
  });
  const persistent = segments.reduce((sum, s) => sum + (s.pv_persistent ?? 0), 0);
  const fading = segments.reduce((sum, s) => sum + (s.pv_fading ?? 0), 0);
  const consolidated = calc.value_per_share;
  return {
    available: true as const, segments_reconciled: mismatches.length === 0, reconciliation_issues: mismatches, segments,
    consolidated_value_per_share: r2(consolidated),
    core_value_per_share: r2(consolidated - persistent / shares),
    value_if_losses_fade: r2(consolidated - persistent / shares + fading / shares),
    note: "The consolidated value carries the final-year segment losses inside its terminal; core adds back the persistent loss stream. An approximation: the consolidated terminal grows the loss with g.",
  };
}

// ---------------------------------------------------------------- assembly

export type FcffValuationInput = {
  statements: Record<Scenario, StatementYear[]>;
  sets: ValuationSet[];
  probabilities: Partial<Record<"probability_bear" | "probability_base" | "probability_bull", unknown>>;
  price: number; currency: string; fiscalYearEnd?: string;
  common: Omit<ScheduleCommon, "timing">;
  timing: ReturnType<typeof valuationTiming>;
  pack: FinancialAnalytics | null; fx: number;
  capm: Num; riskFree: Num; historyRoic: Num;
  segmentDrivers?: SegmentDriver[] | null;
};

/** The whole FCFF valuation from statements and sets: anchors on the base set plus every cross-check above. */
export function buildFcffValuation(input: FcffValuationInput) {
  const set = (key: ValuationSetKey) => input.sets.find((s) => s.set === key)!;
  const common = (scenario: Scenario): ScheduleCommon => ({ ...input.common, timing: caseTiming(input.timing, input.statements[scenario]) });
  const schedulesFor = (s: ValuationSet) => Object.fromEntries(SCENARIOS.map((scenario) =>
    [scenario, driverSchedule(input.statements[scenario], scenario, s, common(scenario))])) as Record<Scenario, ValuationMethodInput>;
  const schedules = schedulesFor(set("base"));
  const assembled = assembleValuation({ schedules, probabilities: input.probabilities, marketPrice: input.price, currency: input.currency, fiscalYearEnd: input.fiscalYearEnd });
  const matrix = SCENARIOS.flatMap((scenario) => VALUATION_SETS.map((key) => {
    const value = valueToday(driverSchedule(input.statements[scenario], scenario, set(key), common(scenario)));
    return [scenario, key, set(key).discount_rate, set(key).terminal_growth, set(key).ronic, r2(value), r4(input.price > 0 ? value / input.price - 1 : null)];
  }));
  const b = set("base");
  const grid = [-0.01, 0, 0.01].flatMap((dr) => [-0.01, 0, 0.01].map((dg) => {
    const s = { ...b, discount_rate: Number((b.discount_rate + dr).toFixed(4)), terminal_growth: Number((b.terminal_growth + dg).toFixed(4)) };
    const value = s.terminal_growth < s.discount_rate - 0.001 && s.terminal_growth < s.ronic ? valueToday(driverSchedule(input.statements.base, "base", s, common("base"))) : null;
    return [s.discount_rate, s.terminal_growth, r2(value)];
  }));
  const checks = marketCrossChecks({ price: input.price, shares: input.common.shares, bridge: input.common.bridge, pack: input.pack, fx: input.fx, schedules });
  const set$ = assembled.valuation_scenario_set;
  const weightedToday = "weighted_value_today" in set$ ? (set$.weighted_value_today as number) : null;
  const fcfTtm = input.pack ? (() => { const v = tableRows(input.pack.cash_conversion.quarterly).at(-1)?.fcf_ttm; return finite(v) ? v * input.fx : null; })() : null;
  const lenses = lensValues({ price: input.price, shares: input.common.shares, bridge: input.common.bridge,
    dcfToday: weightedToday ?? set$.value_today_base, nextNopat: input.statements.base[0]?.nopat ?? null, fcfTtm, checks });
  const sanity = sanityFlags({ schedules, statements: input.statements, set: b, common: common("base"), price: input.price, weightedToday,
    capm: input.capm, riskFree: input.riskFree, historyRoic: input.historyRoic, checks });
  const stress = stressCases({ bear: input.statements.bear, conservative: set("conservative"), common: common("bear"), price: input.price });
  const segments = lossSegments({ drivers: input.segmentDrivers, statements: input.statements.base, schedule: schedules.base, set: b });
  const reverse = reverseValuationV2({ statements: input.statements.base, set: b, common: common("base"), price: input.price }, growthBases(input.pack, input.fx));
  return {
    schedules, assembled, reverse, lenses,
    additions: {
      engine_version: "valuation-v2",
      valuation_sets: input.sets,
      valuation_matrix: { columns: ["case", "valuation_set", "discount_rate", "terminal_growth", "ronic", "value_per_share", "return_to_value"], rows: matrix,
        note: "Value per share today for every operating case under every valuation set; anchors and weights use the base set." },
      sensitivity_grid: { columns: ["discount_rate", "terminal_growth", "value_per_share"], rows: grid, case: "base",
        note: `Base operating case, base RONIC ${b.ronic} and ${b.fade_years} fade years; null where g is not below r.` },
      // tv_share_of_ev is the terminal value alone (the gated measure); value_beyond_explicit_share adds the fade years (information).
      terminal_value_share: Object.fromEntries(SCENARIOS.map((scenario) => [scenario, r4(calculateValuationSchedule(schedules[scenario]).tv_share_of_ev)])),
      value_beyond_explicit_share: Object.fromEntries(SCENARIOS.map((scenario) => [scenario, r4(valueBeyondExplicitShare(schedules[scenario]))])),
      cross_checks: checks,
      lens_values: lenses,
      sanity: sanity,
      stress_cases: stress,
      segment_cross_check: segments,
      segments_reconciled: segments.segments_reconciled,
      timing: input.timing,
    },
  };
}

// ---------------------------------------------------------------- model contract

const ValuationSetsOutput = z.object({ valuation_assumptions: z.object({
  artifact_type: z.literal("valuation_assumptions"),
  sets: z.array(z.object({
    set: z.enum(VALUATION_SETS), discount_rate: z.number().gt(0).lt(1), terminal_growth: z.number().min(-0.05).lt(0.2),
    ronic: z.number().gt(0).max(2), fade_years: z.number().int().min(0).max(10), rationale: z.string().min(1),
    ronic_rationale: z.string().nullable().optional(),
  })).length(3),
  omitted_methods: z.array(z.object({ method: z.string().min(1), reason: z.string().min(1) })).default([]),
  source_notes: z.array(z.string().min(1)).default([]),
}) });
export type ValuationSetsOutput = z.infer<typeof ValuationSetsOutput>["valuation_assumptions"];

/** The model-facing format: three valuation sets, checked against the risk-free rate and the code defaults. */
export function valuationSetsFormat(riskFree: Num, defaults: ValuationSet[]): AgentOutputFormat {
  return {
    requiredKeys: ["valuation_assumptions"],
    schema: z.toJSONSchema(ValuationSetsOutput, { target: "draft-7", io: "input", reused: "inline" }) as Record<string, unknown>,
    validate(value) {
      const parsed = ValuationSetsOutput.safeParse(value);
      if (!parsed.success) return parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
      return validateValuationSets(parsed.data.valuation_assumptions.sets as ValuationSet[], defaults, riskFree);
    },
  };
}

/** Warnings when D&A/revenue rises more than 3pt over the forecast while the margin driver also rises: confirm the margin includes the depreciation. */
export function depreciationWarnings(statements: Record<Scenario, StatementYear[]>): string[] {
  return SCENARIOS.flatMap((scenario) => {
    const s = statements[scenario], first = s[0], last = s.at(-1)!;
    const rise = last.depreciation_amortization / last.revenue - first.depreciation_amortization / first.revenue;
    return rise > 0.03 && last.operating_margin > first.operating_margin
      ? [`${scenario}: D&A rises from ${(first.depreciation_amortization / first.revenue * 100).toFixed(1)}% to ${(last.depreciation_amortization / last.revenue * 100).toFixed(1)}% of revenue (PP&E roll-forward) while the operating margin also rises; the margin drivers must already include that depreciation.`]
      : [];
  });
}
