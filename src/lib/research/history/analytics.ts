/**
 * Financial analytics pack: the economics of the filed statements, computed by code before any model
 * reasons about them. Twenty-quarter statistics, segment economics, cash conversion, working-capital
 * days and a capital-allocation ledger.
 *
 * Inputs come through MetricBook (aliases, fourth quarters derived from the fiscal-year total, TTM and
 * average balances). Nothing is estimated: a missing input leaves the value null, and the latest
 * quarter's gaps are listed with their reason.
 *
 * Conventions: amounts are currency millions, shares are millions, ratios are decimals and days are
 * days. Statistics cover the window's quarters that have a value; percentile is the share of those
 * values at or below the latest one. NOPAT applies one normalized tax rate, the median quarterly
 * effective rate in 0-50%, because single quarters swing (META: 87.5% and -23.1%).
 */
import { z } from "zod";
import { BASE_INPUTS, MetricBook, shiftPeriod, type InputValue, type PeriodRef } from "../reporting/metric-catalogue";
import { sharesAtPeriodEnd } from "@/lib/market-data/price-history";
import { computeStartPeriod, enumerateQuarters } from "./normalizer";

type Row = Record<string, any>;
type Num = number | null;
type Kind = "money" | "ratio" | "days" | "x" | "shares";

const Cell = z.union([z.number(), z.string(), z.boolean(), z.null()]);
const Table = z.array(z.record(z.string(), Cell));
export const AnalyticsStatistic = z.object({
  metric: z.string(), n: z.number().int(), median: z.number().nullable(), min: z.number().nullable(), max: z.number().nullable(),
  latest: z.number().nullable(), latest_period: z.string().nullable(), percentile: z.number().nullable(),
});
export type AnalyticsStatistic = z.infer<typeof AnalyticsStatistic>;
export const FinancialAnalytics = z.object({
  artifact_type: z.literal("financial_analytics"),
  currency: z.string().nullable(),
  units: z.string(),
  window: z.object({ start: z.string(), end: z.string(), quarters: z.number().int() }),
  tax_rate: z.object({ normalized: z.number(), quarters_used: z.number().int(), method: z.string() }),
  statistics: z.array(AnalyticsStatistic),
  quarterly: Table,
  segments: z.object({ members: Table, quarterly: Table, annual: Table }),
  cash_conversion: z.object({ quarterly: Table, incremental: Table }),
  working_capital: z.object({ quarterly: Table, notes: z.array(z.string()) }),
  capital_allocation: z.object({ quarterly: Table, share_classes: Table, notes: z.array(z.string()) }),
  definitions: z.record(z.string(), z.string()),
  derived_quarters: z.array(z.string()),
  missing: z.array(z.object({ metric: z.string(), period: z.string(), reason: z.string() })),
});
export type FinancialAnalytics = z.infer<typeof FinancialAnalytics>;

const DIGITS: Record<Kind, number> = { money: 1, ratio: 4, days: 1, x: 2, shares: 1 };
const MONEY = new Set(["revenue", "operating_income", "fcf_ttm", "fcf_after_lease_principal_ttm", "growth_capex_ttm", "nopat_ttm", "invested_capital",
  "cash", "marketable_securities", "long_term_debt", "net_cash", "buybacks_ttm", "dividends_ttm", "sbc_ttm", "market_cap",
  "change_in_revenue_ttm", "change_in_nopat_ttm", "change_in_invested_capital", "cumulative_operating_income", "revenue_ttm", "operating_income_ttm"]);
/** Unit of a pack column; fiscal_year and years round as ratios, which leaves integers unchanged. */
export function columnKind(column: string): Kind {
  if (/^(dso|dpo|dio|ccc)$/.test(column)) return "days";
  if (column === "capex_to_da" || column === "revenue_to_net_ppe") return "x";
  if (column === "shares" || column === "shares_year_ago") return "shares";
  return MONEY.has(column) ? "money" : "ratio";
}
const round = (value: Num, kind: Kind): Num => value === null || !Number.isFinite(value) ? null : Number(value.toFixed(DIGITS[kind]));
const label = (p: PeriodRef) => `${p.year}Q${p.quarter}`;
const div = (a: Num, b: Num): Num => a === null || b === null || b <= 0 ? null : a / b;
const minus = (a: Num, b: Num): Num => a === null || b === null ? null : a - b;
const millions = (value: Num): Num => value === null ? null : value / 1e6;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** "meta:RealityLabsMember" and "fb:RealityLabsMember" are one segment: RealityLabs. */
export const segmentName = (member: string) => member.replace(/^[^:]*:/, "").replace(/Member$/, "");

export function statistic(metric: string, periods: string[], values: Num[], kind: Kind): AnalyticsStatistic {
  const kept = values.flatMap((value, i) => value === null || !Number.isFinite(value) ? [] : [{ value, period: periods[i] }]);
  const sorted = kept.map((k) => k.value).sort((a, b) => a - b);
  const last = kept.at(-1);
  return {
    metric, n: sorted.length, median: sorted.length ? round(median(sorted), kind) : null,
    min: round(sorted[0] ?? null, kind), max: round(sorted.at(-1) ?? null, kind),
    latest: round(last?.value ?? null, kind), latest_period: last?.period ?? null,
    percentile: last ? Number((sorted.filter((v) => v <= last.value).length / sorted.length).toFixed(2)) : null,
  };
}

export const ANALYTICS_DEFINITIONS: Record<string, string> = {
  revenue_yoy: "Revenue ÷ revenue of the same quarter a year earlier − 1",
  gross_margin: "(Revenue − cost of revenue) ÷ revenue, quarter",
  operating_margin: "Income from operations ÷ revenue, quarter",
  fcf_margin: "(Operating cash flow − capex) ÷ revenue, quarter",
  capex_to_revenue: "Purchases of property and equipment ÷ revenue, quarter",
  sbc_to_revenue: "Stock-based compensation (cash-flow statement) ÷ revenue, quarter",
  "segments.share_of_operating_income": "Segment operating income ÷ consolidated income from operations",
  "segments.loss_to_earner_operating_income": "A burner segment's operating loss ÷ the earner segments' operating income, same period",
  "segments.role": "earner when the segment's operating income summed over the window is positive, burner otherwise",
  fcf_ttm: "Operating cash flow − capex, trailing 12 months",
  fcf_after_lease_principal_ttm: "FCF − finance-lease principal payments, trailing 12 months",
  fcf_to_net_income: "TTM FCF ÷ TTM net income",
  ocf_to_net_income: "TTM operating cash flow ÷ TTM net income",
  capex_to_da: "TTM capex ÷ TTM depreciation and amortization",
  growth_capex_ttm: "TTM capex − TTM D&A; a proxy for capex above maintenance, not a reported split",
  nopat_ttm: "TTM income from operations × (1 − normalized tax rate)",
  invested_capital: "Equity + long-term debt − cash − current marketable securities, period end",
  roic: "TTM NOPAT ÷ average invested capital (this quarter end and a year earlier)",
  revenue_to_net_ppe: "TTM revenue ÷ net property and equipment (incl. finance-lease assets where reported together)",
  incremental_operating_margin: "Change in TTM income from operations ÷ change in TTM revenue over the period",
  incremental_roic: "Change in TTM NOPAT ÷ change in invested capital over the period",
  dso: "Accounts receivable ÷ TTM revenue × 365",
  dpo: "Accounts payable ÷ TTM cost of revenue × 365; payables_basis says trade or total payables",
  dio: "Inventory ÷ TTM cost of revenue × 365",
  ccc: "DSO + DIO − DPO",
  nwc_to_revenue: "(Receivables + inventory − payables − contract liabilities) ÷ TTM revenue",
  net_cash: "Cash + current marketable securities − long-term debt (current debt and lease liabilities are not included)",
  shares: "Common shares outstanding at period end, summed over share classes",
  shares_yoy: "Period-end shares ÷ shares a year earlier − 1",
  buybacks_to_fcf: "TTM share repurchases ÷ TTM FCF; dividends_to_fcf and sbc_to_fcf likewise",
  buyback_yield: "TTM share repurchases ÷ period-end market cap; dividend_yield, fcf_yield and fcf_ex_sbc_yield likewise",
};

export type AnalyticsInput = { observations: Row[]; endFiscalYear: number; endFiscalQuarter: number; quarters?: number };

/** Statement, history and market rows in one list, filed statements first (the Financials merge). */
export function buildFinancialAnalytics(input: AnalyticsInput): FinancialAnalytics {
  const count = input.quarters ?? 20;
  const { startFiscalYear, startFiscalQuarter } = computeStartPeriod(input.endFiscalYear, input.endFiscalQuarter, count - 1);
  const window: PeriodRef[] = enumerateQuarters(startFiscalYear, startFiscalQuarter, input.endFiscalYear, input.endFiscalQuarter)
    .map((q) => ({ year: q.fiscal_year, quarter: q.fiscal_quarter }));
  const periods = window.map(label);
  const end = window.at(-1)!;
  const rows = input.observations.filter((r) => Number.isFinite(r.value_numeric));
  const book = new MetricBook(rows, "quarterly");
  const derived = new Set<string>();
  const missing: FinancialAnalytics["missing"] = [];
  const notes = { working_capital: [] as string[], capital_allocation: [] as string[] };

  const value = (input: InputValue): Num => {
    if (input.derivedQuarter) input.notes.filter((n) => /minus the other three quarters/.test(n)).forEach((n) => derived.add(n));
    return input.value;
  };
  // Records why the latest quarter's value is missing.
  const tracked = (metric: string, p: PeriodRef, input: InputValue): Num => {
    const v = value(input);
    if (v === null && p === end && input.missing) missing.push({ metric, period: label(p), reason: input.missing });
    return v;
  };
  // An input the issuer never reports (no dividends, no debt, no inventory) counts as zero rather than missing.
  const reported = new Map<string, boolean>();
  const reports = (name: string) => {
    if (!reported.has(name)) reported.set(name, rows.some((r) => BASE_INPUTS[name].aliases.includes(r.metric_key) && !r.segment && !r.geography));
    return reported.get(name)!;
  };
  const optional = (name: string, p: PeriodRef, ttm = false): Num => reports(name) ? value(ttm ? book.ttm(name, p) : book.get(name, p)) : 0;

  // Normalized tax rate.
  const rates = window.flatMap((p) => {
    const pretax = value(book.get("pretax_income", p)), tax = value(book.get("income_tax", p));
    const rate = pretax !== null && pretax > 0 && tax !== null ? tax / pretax : null;
    return rate !== null && rate >= 0 && rate <= 0.5 ? [rate] : [];
  });
  const taxRate = rates.length ? median(rates) : 0.21;

  // Consolidated quarter economics.
  const quarterly = window.map((p) => {
    const revenue = tracked("revenue", p, book.get("revenue", p));
    const prior = value(book.get("revenue", shiftPeriod(p, -4)));
    const operatingIncome = tracked("operating_income", p, book.get("operating_income", p));
    return {
      period: label(p), revenue: millions(revenue), operating_income: millions(operatingIncome),
      revenue_yoy: prior !== null && prior > 0 && revenue !== null ? revenue / prior - 1 : null,
      gross_margin: div(tracked("gross_margin", p, book.get("gross_profit", p)), revenue),
      operating_margin: div(operatingIncome, revenue),
      fcf_margin: div(tracked("fcf_margin", p, book.get("free_cash_flow", p)), revenue),
      capex_to_revenue: div(tracked("capex_to_revenue", p, book.get("capex", p)), revenue),
      sbc_to_revenue: div(tracked("sbc_to_revenue", p, book.get("sbc", p)), revenue),
    };
  });

  // Cash conversion and returns on TTM flows.
  const ttm = (name: string, p: PeriodRef) => value(book.ttm(name, p));
  const investedCapital = (p: PeriodRef): Num => {
    const equity = value(book.get("equity", p)), cash = value(book.get("cash", p));
    if (equity === null || cash === null) return null;
    const debt = optional("long_term_debt", p), securities = optional("marketable_securities", p);
    return debt === null || securities === null ? null : equity + debt - cash - securities;
  };
  const nopat = (p: PeriodRef) => { const oi = ttm("operating_income", p); return oi === null ? null : oi * (1 - taxRate); };
  const cash_conversion = window.map((p) => {
    const fcf = tracked("fcf_ttm", p, book.ttm("free_cash_flow", p)), netIncome = ttm("net_income", p);
    const capex = ttm("capex", p), da = ttm("depreciation", p), ic = investedCapital(p), icYearAgo = investedCapital(shiftPeriod(p, -4));
    const leases = optional("finance_lease_principal", p, true);
    return {
      period: label(p), fcf_ttm: millions(fcf), fcf_after_lease_principal_ttm: millions(minus(fcf, leases)),
      fcf_to_net_income: div(fcf, netIncome), ocf_to_net_income: div(ttm("operating_cash_flow", p), netIncome),
      capex_to_da: div(capex, da), growth_capex_ttm: millions(minus(capex, da)), nopat_ttm: millions(nopat(p)),
      invested_capital: millions(ic), roic: div(nopat(p), ic === null || icYearAgo === null ? null : (ic + icYearAgo) / 2),
      revenue_to_net_ppe: div(ttm("revenue", p), value(book.get("net_ppe", p))),
    };
  });
  const incremental = [1, 2, 3].map((years) => {
    const from = shiftPeriod(end, -4 * years);
    const dRevenue = minus(ttm("revenue", end), ttm("revenue", from)), dIncome = minus(ttm("operating_income", end), ttm("operating_income", from));
    const dNopat = minus(nopat(end), nopat(from)), dCapital = minus(investedCapital(end), investedCapital(from));
    return { from: label(from), to: label(end), years, change_in_revenue_ttm: millions(dRevenue), change_in_nopat_ttm: millions(dNopat),
      change_in_invested_capital: millions(dCapital), incremental_operating_margin: div(dIncome, dRevenue), incremental_roic: div(dNopat, dCapital) };
  });

  // Working-capital days. Trade payables win; total payables fill quarters without them, labelled.
  const hasInventory = reports("inventory");
  if (!hasInventory) notes.working_capital.push("No inventory is reported, so DIO is not applicable and CCC is DSO − DPO.");
  let priorBasis: string | null = null;
  const working_capital = window.map((p) => {
    const revenue = ttm("revenue", p), cost = ttm("cost_of_revenue", p);
    const receivables = tracked("dso", p, book.get("receivables", p));
    const trade = value(book.get("trade_payables", p));
    const payables = trade ?? (reports("accounts_payable") ? value(book.get("accounts_payable", p)) : null);
    const basis = trade !== null ? "trade" : payables !== null ? "total" : null;
    if (basis && priorBasis && basis !== priorBasis) notes.working_capital.push(`Payables switch from ${priorBasis} to ${basis} accounts payable in ${label(p)}; DPO is not comparable across the switch.`);
    if (basis) priorBasis = basis;
    if (payables === null && p === end) missing.push({ metric: "dpo", period: label(p), reason: "Accounts payable at the quarter end is not captured" });
    const inventory = hasInventory ? value(book.get("inventory", p)) : 0;
    const contract = optional("contract_liabilities", p);
    const dso = div(receivables, revenue) === null ? null : div(receivables, revenue)! * 365;
    const dpo = div(payables, cost) === null ? null : div(payables, cost)! * 365;
    const dio = hasInventory && div(inventory, cost) !== null ? div(inventory, cost)! * 365 : null;
    const nwc = receivables === null || payables === null || inventory === null || contract === null ? null : receivables + inventory - payables - contract;
    return { period: label(p), dso, dpo, dio, ccc: dso === null || dpo === null || (hasInventory && dio === null) ? null : dso + (dio ?? 0) - dpo,
      nwc_to_revenue: div(nwc, revenue), payables_basis: basis };
  });

  // Capital allocation: net cash, period-end shares over classes, TTM cash returns and yields.
  const periodEnds = new Map<string, string>();
  for (const r of rows) if (r.periodicity === "quarterly" && r.period_end && r.metadata_json?.statement === "balance" && Number.isInteger(r.fiscal_quarter)) {
    const key = `${r.fiscal_year}Q${r.fiscal_quarter}`;
    if (!periodEnds.has(key) || String(r.period_end) > periodEnds.get(key)!) periodEnds.set(key, String(r.period_end));
  }
  const shareCount = (p: PeriodRef) => { const at = periodEnds.get(label(p)); return at ? sharesAtPeriodEnd(rows, at) : null; };
  if (!reports("long_term_debt")) notes.capital_allocation.push("No long-term debt is reported; net cash counts it as zero.");
  const capital_allocation = window.map((p) => {
    const cash = tracked("net_cash", p, book.get("cash", p)), securities = optional("marketable_securities", p), debt = optional("long_term_debt", p);
    const shares = shareCount(p), yearAgo = shareCount(shiftPeriod(p, -4));
    const fcf = ttm("free_cash_flow", p), sbc = ttm("sbc", p);
    const buybacks = optional("buybacks", p, true), dividends = optional("dividends", p, true);
    const marketCap = value(book.get("market_cap", p));
    return {
      period: label(p), cash: millions(cash), marketable_securities: millions(securities), long_term_debt: millions(debt),
      net_cash: millions(cash === null || securities === null || debt === null ? null : cash + securities - debt),
      shares: millions(shares?.value ?? null), shares_yoy: shares && yearAgo ? shares.value / yearAgo.value - 1 : null,
      buybacks_ttm: millions(buybacks), dividends_ttm: millions(dividends), sbc_ttm: millions(sbc),
      buybacks_to_fcf: div(buybacks, fcf), dividends_to_fcf: div(dividends, fcf), sbc_to_fcf: div(sbc, fcf),
      market_cap: millions(marketCap), buyback_yield: div(buybacks, marketCap), dividend_yield: div(dividends, marketCap),
      fcf_yield: div(fcf, marketCap), fcf_ex_sbc_yield: div(minus(fcf, sbc), marketCap),
    };
  });
  const endShares = shareCount(end), priorShares = shareCount(shiftPeriod(end, -4));
  if (endShares && endShares.basis !== "shares_outstanding") notes.capital_allocation.push(`Shares at ${label(end)}: ${endShares.label}.`);
  const classShares = (count: ReturnType<typeof shareCount>) => new Map((count?.inputs ?? []).map((r) => [segmentName(String(r.segment ?? "Common")), Number(r.value_numeric)]));
  const nowClasses = classShares(endShares), thenClasses = classShares(priorShares);
  const share_classes = [...nowClasses].map(([name, shares]) => ({ class: name, period: label(end), shares: round(shares / 1e6, "shares"),
    shares_year_ago: thenClasses.has(name) ? round(thenClasses.get(name)! / 1e6, "shares") : null }));

  const segments = segmentEconomics(rows, window, periods, window.map((p) => book.get("operating_income", p).value), input.endFiscalYear, input.endFiscalQuarter, startFiscalYear);

  const series = <T extends Row>(table: T[], key: keyof T) => table.map((row) => row[key] as Num);
  const statistics = [
    ...(["revenue_yoy", "gross_margin", "operating_margin", "fcf_margin", "capex_to_revenue", "sbc_to_revenue"] as const)
      .map((key) => statistic(key, periods, series(quarterly, key), "ratio")),
    statistic("fcf_ttm", periods, series(cash_conversion, "fcf_ttm"), "money"),
    ...(["fcf_to_net_income", "ocf_to_net_income", "capex_to_da", "roic"] as const).map((key) => statistic(key, periods, series(cash_conversion, key), columnKind(key))),
    ...(["dso", "dpo", "dio", "ccc", "nwc_to_revenue"] as const).map((key) => statistic(key, periods, series(working_capital, key), columnKind(key))),
    ...(["net_cash", "shares_yoy", "buyback_yield", "fcf_yield"] as const).map((key) => statistic(key, periods, series(capital_allocation, key), columnKind(key))),
    ...segments.statistics,
  ].filter((s) => s.n > 0);

  const tidy = (table: Row[]) => table.map((row) => Object.fromEntries(Object.entries(row).map(([key, v]) => [key, typeof v === "number" ? round(v, columnKind(key)) : v])));
  return {
    artifact_type: "financial_analytics",
    currency: book.get("revenue", end).currency ?? rows.find((r) => /^[A-Z]{3}$/.test(r.currency ?? ""))?.currency ?? null,
    units: "Amounts in currency millions, shares in millions, ratios as decimals, days as days.",
    window: { start: periods[0], end: periods.at(-1)!, quarters: periods.length },
    tax_rate: { normalized: Number(taxRate.toFixed(4)), quarters_used: rates.length,
      method: rates.length ? "Median quarterly effective tax rate (tax ÷ pretax income) over the window, quarters outside 0-50% excluded" : "No usable quarterly tax rate; 21% statutory default" },
    statistics,
    quarterly: tidy(quarterly),
    segments: { members: segments.members, quarterly: tidy(segments.quarterly), annual: tidy(segments.annual) },
    cash_conversion: { quarterly: tidy(cash_conversion), incremental: tidy(incremental) },
    working_capital: { quarterly: tidy(working_capital), notes: [...new Set(notes.working_capital)] },
    capital_allocation: { quarterly: tidy(capital_allocation), share_classes, notes: notes.capital_allocation },
    definitions: ANALYTICS_DEFINITIONS,
    derived_quarters: [...derived].sort(),
    missing,
  };
}

/** Per-segment revenue, operating income, margins, profit-pool shares and the earner/burner split. */
function segmentEconomics(rows: Row[], window: PeriodRef[], periods: string[], consolidatedIncome: Num[], endYear: number, endQuarter: number, startYear: number) {
  // Latest filing wins when the fb: and meta: members (or recasts) report the same period.
  const latest = new Map<string, Row>();
  for (const r of rows) {
    if (r.metadata_json?.statement !== "segment" || !r.segment || r.geography) continue;
    const row = { ...r, segment: null, segment_name: segmentName(String(r.segment)) };
    const key = JSON.stringify([row.segment_name, r.metric_key, r.periodicity, r.fiscal_year, r.fiscal_quarter, r.unit]);
    const prior = latest.get(key);
    if (!prior || String(r.available_at ?? "") > String(prior.available_at ?? "")) latest.set(key, row);
  }
  const names = [...new Set([...latest.values()].map((r) => r.segment_name as string))].sort();
  const books = new Map(names.map((name) => {
    const own = [...latest.values()].filter((r) => r.segment_name === name);
    return [name, { quarterly: new MetricBook(own, "quarterly"), annual: new MetricBook(own, "annual") }];
  }));
  const income = (name: string, p: PeriodRef) => books.get(name)!.quarterly.get("operating_income", p).value;
  const revenue = (name: string, p: PeriodRef) => books.get(name)!.quarterly.get("revenue", p).value;
  const cumulative = new Map(names.map((name) => [name, window.reduce((sum, p) => sum + (income(name, p) ?? 0), 0)]));
  const role = (name: string) => cumulative.get(name)! >= 0 ? "earner" : "burner";
  const earners = names.filter((n) => role(n) === "earner");
  const earnerIncome = (at: (name: string) => Num): Num => {
    const values = earners.map(at);
    return values.length && values.every((v) => v !== null) ? (values as number[]).reduce((a, b) => a + b, 0) : null;
  };
  const lossShare = (name: string, own: Num, earned: Num) => role(name) === "burner" && own !== null && earned !== null && earned > 0 ? -own / earned : null;

  const quarterly = window.flatMap((p, i) => names.map((name) => {
    const rev = revenue(name, p), oi = income(name, p), total = consolidatedIncome[i];
    return { period: label(p), segment: name, revenue: millions(rev), operating_income: millions(oi), operating_margin: div(oi, rev),
      share_of_operating_income: total !== null && total > 0 && oi !== null ? oi / total : null,
      loss_to_earner_operating_income: lossShare(name, oi, earnerIncome((n) => income(n, p))) };
  }));
  const lastYear = endQuarter === 4 ? endYear : endYear - 1;
  const annual = names.flatMap((name) => Array.from({ length: Math.max(0, lastYear - startYear + 1) }, (_, i) => startYear + i).flatMap((year) => {
    const p = { year, quarter: null };
    const rev = books.get(name)!.annual.get("revenue", p).value, oi = books.get(name)!.annual.get("operating_income", p).value;
    if (rev === null && oi === null) return [];
    return [{ fiscal_year: year, segment: name, revenue: millions(rev), operating_income: millions(oi), operating_margin: div(oi, rev),
      loss_to_earner_operating_income: lossShare(name, oi, earnerIncome((n) => books.get(n)!.annual.get("operating_income", p).value)) }];
  }));
  const end = window.at(-1)!;
  const members = names.map((name) => {
    const book = books.get(name)!.quarterly;
    const rev = book.ttm("revenue", end).value, oi = book.ttm("operating_income", end).value;
    const lastFour = consolidatedIncome.slice(-4);
    const totalIncome = lastFour.length === 4 && lastFour.every((v) => v !== null) ? (lastFour as number[]).reduce((a, b) => a + b, 0) : null;
    return { segment: name, role: role(name), quarters_with_operating_income: window.filter((p) => income(name, p) !== null).length,
      cumulative_operating_income: round(millions(cumulative.get(name)!), "money"),
      revenue_ttm: round(millions(rev), "money"), operating_income_ttm: round(millions(oi), "money"), operating_margin_ttm: round(div(oi, rev), "ratio"),
      share_of_operating_income_ttm: round(totalIncome !== null && totalIncome > 0 && oi !== null ? oi / totalIncome : null, "ratio"),
      loss_to_earner_operating_income_ttm: round(lossShare(name, oi, earnerIncome((n) => books.get(n)!.quarterly.ttm("operating_income", end).value)), "ratio") };
  });
  const statistics = names.flatMap((name) => {
    const own = quarterly.filter((q) => q.segment === name);
    return [statistic(`segment.${name}.operating_margin`, periods, own.map((q) => q.operating_margin), "ratio"),
      ...(role(name) === "burner" ? [statistic(`segment.${name}.loss_to_earner_operating_income`, periods, own.map((q) => q.loss_to_earner_operating_income), "ratio")] : [])];
  });
  return { members, quarterly, annual, statistics };
}

/**
 * The compact view analysis stages get in their cached packet prefix: every statistic and segment total,
 * plus the last eight quarters of each table. Report packets get the whole pack.
 */
export function analyticsDigest(pack: FinancialAnalytics, artifactId?: string, quarters = 8) {
  const recent = (table: Row[]) => table.slice(-quarters);
  const segmentQuarters = new Set(pack.quarterly.slice(-quarters).map((q) => q.period));
  return {
    ...(artifactId ? { artifact_id: artifactId } : {}),
    note: `Code-computed from the filed statements (window ${pack.window.start}-${pack.window.end}). Tables show the last ${quarters} quarters; statistics cover the whole window. The full pack is the financial_analytics artifact.`,
    currency: pack.currency, units: pack.units, window: pack.window, tax_rate: pack.tax_rate,
    statistics: pack.statistics,
    quarterly: recent(pack.quarterly),
    segments: { members: pack.segments.members, annual: pack.segments.annual,
      quarterly: pack.segments.quarterly.filter((q) => segmentQuarters.has(String(q.period))) },
    cash_conversion: { quarterly: recent(pack.cash_conversion.quarterly), incremental: pack.cash_conversion.incremental },
    working_capital: { quarterly: recent(pack.working_capital.quarterly), notes: pack.working_capital.notes },
    capital_allocation: { quarterly: recent(pack.capital_allocation.quarterly), share_classes: pack.capital_allocation.share_classes, notes: pack.capital_allocation.notes },
    definitions: pack.definitions,
    missing: pack.missing,
  };
}

export type AnalyticsMetric = { metric: string; kind: Kind; value: number; period: string; median: Num; percentile: Num };

/**
 * Latest value of a pack metric by key: a statistic key ("operating_margin", "segment.RealityLabs.operating_margin")
 * or a quarterly table column ("fcf_ttm", "segment.RealityLabs.operating_income"). Statistics add median and percentile.
 */
export function analyticsMetrics(pack: FinancialAnalytics): Map<string, AnalyticsMetric> {
  const out = new Map<string, AnalyticsMetric>();
  const add = (key: string, table: Row[]) => {
    for (const column of Object.keys(table[0] ?? {})) {
      if (["period", "segment", "payables_basis"].includes(column)) continue;
      const last = [...table].reverse().find((row) => typeof row[column] === "number");
      if (last) out.set(key ? `${key}.${column}` : column, { metric: key ? `${key}.${column}` : column, kind: columnKind(column), value: last[column], period: String(last.period), median: null, percentile: null });
    }
  };
  for (const table of [pack.quarterly, pack.cash_conversion.quarterly, pack.working_capital.quarterly, pack.capital_allocation.quarterly]) add("", table);
  for (const name of new Set(pack.segments.quarterly.map((q) => String(q.segment)))) add(`segment.${name}`, pack.segments.quarterly.filter((q) => q.segment === name));
  for (const s of pack.statistics) {
    const known = out.get(s.metric);
    if (known && s.latest_period === known.period) out.set(s.metric, { ...known, median: s.median, percentile: s.percentile });
  }
  return out;
}
