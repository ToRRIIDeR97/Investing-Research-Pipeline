/**
 * Financial metric catalogue for the Financials Metrics view and the chart panel.
 *
 * Every value is computed from saved observations (filed statements, the historical record,
 * `market_price_history` and `employees` headcount rows). Inputs are looked up by metric key;
 * a missing or ambiguous input leaves the metric unavailable and names that input. Nothing is
 * estimated, and a missing value is never treated as zero.
 *
 * Conventions:
 * - Margins, SBC ratios, payout ratios and per-share values use flows of the same period.
 * - Returns use trailing-12-month numerators over the average of the period-end balance and the
 *   balance a year earlier. Annual views use the fiscal year and the prior year end.
 * - Price-based metrics use the period-end market cap from `market_price_history` and trailing
 *   12-month flows. A price that was not cross-checked is flagged `unverified`.
 * - When a quarterly flow is missing but the fiscal-year total and the other three quarters are
 *   saved, the quarter is derived as the annual total minus those quarters and flagged.
 */
type Row = Record<string, any>;

export type Frequency = 'quarterly' | 'annual';
export type PeriodRef = { year: number; quarter: number | null };
export type MetricKind = 'pct' | 'x' | 'money' | 'ps' | 'count' | 'per_person';
type Unit = 'currency' | 'shares' | 'persons';
type InputKind = 'flow' | 'stock' | 'point';

export type InputValue = {
  label: string;
  basis: string;
  unit: Unit;
  currency: string | null;
  value: number | null;
  /** Why the value is unavailable, naming the missing input. */
  missing: string | null;
  rows: Row[];
  notes: string[];
  /** A quarter derived as the fiscal-year total minus the other three quarters was used. */
  derivedQuarter: boolean;
  /** A period-end price that was not cross-checked was used. */
  unverified: boolean;
};

export type MetricDef = {
  key: string;
  name: string;
  group: string;
  kind: MetricKind;
  digits?: number;
  /** Higher is better (colours the year-over-year change); undefined means neutral. */
  up?: boolean;
  formula: string;
  note?: string;
  price?: boolean;
  employees?: boolean;
  inputs: (book: MetricBook, p: PeriodRef) => InputValue[];
  compute: (values: number[]) => number;
  /** Index of the input that must be positive for the ratio to mean anything. */
  denominator?: number;
};

export type MetricResult = {
  key: string;
  name: string;
  group: string;
  kind: MetricKind;
  digits?: number;
  period: PeriodRef;
  value: number | null;
  missing: string | null;
  formula: string;
  note: string;
  inputs: InputValue[];
  currency: string | null;
  derivedQuarter: boolean;
  unverified: boolean;
};

// ---------------------------------------------------------------- periods

export const periodKey = (p: PeriodRef) => (p.quarter ? `${p.year}-Q${p.quarter}` : String(p.year));
export function parsePeriod(key: string): PeriodRef {
  const [year, quarter] = key.split('-Q');
  return { year: Number(year), quarter: quarter ? Number(quarter) : null };
}
export const periodName = (p: PeriodRef) => (p.quarter ? `Q${p.quarter} ${p.year}` : `FY${p.year}`);
export function shiftPeriod(p: PeriodRef, steps: number): PeriodRef {
  if (!p.quarter) return { year: p.year + steps, quarter: null };
  const index = p.year * 4 + (p.quarter - 1) + steps;
  return { year: Math.floor(index / 4), quarter: (index % 4) + 1 };
}
/** Steps back to the same period a year earlier. */
export const yearLag = (frequency: Frequency) => (frequency === 'quarterly' ? 4 : 1);

const samePeriod = (r: Row, p: PeriodRef) => r.fiscal_year === p.year && (p.quarter ? r.fiscal_quarter === p.quarter : true);

// ---------------------------------------------------------------- base inputs

type BaseDef = { label: string; unit: Unit; kind: InputKind; aliases: string[] };
export const BASE_INPUTS: Record<string, BaseDef> = {
  revenue: { label: 'Revenue', unit: 'currency', kind: 'flow', aliases: ['revenue', 'net_revenue', 'us_gaap_Revenues', 'us_gaap_RevenueFromContractWithCustomerExcludingAssessedTax', 'contract_revenue'] },
  cost_of_revenue: { label: 'Cost of revenue', unit: 'currency', kind: 'flow', aliases: ['us_gaap_CostOfRevenue', 'us_gaap_CostOfGoodsAndServicesSold', 'cost_of_revenue'] },
  reported_gross_profit: { label: 'Gross profit', unit: 'currency', kind: 'flow', aliases: ['gross_profit', 'us_gaap_GrossProfit'] },
  reported_sga: { label: 'Selling, general and administrative', unit: 'currency', kind: 'flow', aliases: ['sga', 'selling_general_administrative', 'us_gaap_SellingGeneralAndAdministrativeExpense'] },
  selling: { label: 'Marketing and sales', unit: 'currency', kind: 'flow', aliases: ['us_gaap_SellingAndMarketingExpense', 'us_gaap_SellingExpense'] },
  administrative: { label: 'General and administrative', unit: 'currency', kind: 'flow', aliases: ['us_gaap_GeneralAndAdministrativeExpense'] },
  operating_income: { label: 'Income from operations', unit: 'currency', kind: 'flow', aliases: ['operating_income', 'us_gaap_OperatingIncomeLoss'] },
  pretax_income: { label: 'Income before income taxes', unit: 'currency', kind: 'flow', aliases: ['pretax_income', 'us_gaap_IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'us_gaap_IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'] },
  income_tax: { label: 'Provision for income taxes', unit: 'currency', kind: 'flow', aliases: ['income_tax_expense', 'us_gaap_IncomeTaxExpenseBenefit'] },
  net_income: { label: 'Net income', unit: 'currency', kind: 'flow', aliases: ['net_income', 'us_gaap_NetIncomeLoss', 'us_gaap_ProfitLoss'] },
  depreciation: { label: 'Depreciation and amortization', unit: 'currency', kind: 'flow', aliases: ['us_gaap_DepreciationDepletionAndAmortization', 'us_gaap_DepreciationAndAmortization', 'us_gaap_DepreciationAmortizationAndAccretionNet', 'depreciation_and_amortization'] },
  sbc: { label: 'Stock-based compensation', unit: 'currency', kind: 'flow', aliases: ['us_gaap_ShareBasedCompensation', 'us_gaap_AllocatedShareBasedCompensationExpense', 'stock_based_compensation'] },
  operating_cash_flow: { label: 'Operating cash flow', unit: 'currency', kind: 'flow', aliases: ['operating_cash_flow', 'us_gaap_NetCashProvidedByUsedInOperatingActivities'] },
  capex: { label: 'Capital expenditure', unit: 'currency', kind: 'flow', aliases: ['us_gaap_PaymentsToAcquirePropertyPlantAndEquipment', 'us_gaap_PaymentsToAcquireProductiveAssets', 'capital_expenditure'] },
  dividends: { label: 'Dividends paid', unit: 'currency', kind: 'flow', aliases: ['us_gaap_PaymentsOfDividends', 'us_gaap_PaymentsOfDividendsCommonStock', 'dividends_paid'] },
  buybacks: { label: 'Share repurchases', unit: 'currency', kind: 'flow', aliases: ['us_gaap_PaymentsForRepurchaseOfCommonStock', 'share_repurchases'] },
  research_development: { label: 'Research and development', unit: 'currency', kind: 'flow', aliases: ['us_gaap_ResearchAndDevelopmentExpense', 'research_and_development'] },
  finance_lease_principal: { label: 'Finance lease principal payments', unit: 'currency', kind: 'flow', aliases: ['us_gaap_FinanceLeasePrincipalPayments'] },
  receivables: { label: 'Accounts receivable', unit: 'currency', kind: 'stock', aliases: ['us_gaap_AccountsReceivableNetCurrent', 'accounts_receivable'] },
  // Trade payables and total accounts payable are separate inputs: issuers switch between the two concepts.
  trade_payables: { label: 'Accounts payable (trade)', unit: 'currency', kind: 'stock', aliases: ['us_gaap_AccountsPayableTradeCurrent'] },
  accounts_payable: { label: 'Accounts payable (total)', unit: 'currency', kind: 'stock', aliases: ['us_gaap_AccountsPayableCurrent', 'accounts_payable'] },
  inventory: { label: 'Inventory', unit: 'currency', kind: 'stock', aliases: ['us_gaap_InventoryNet', 'inventory'] },
  contract_liabilities: { label: 'Contract liabilities (deferred revenue)', unit: 'currency', kind: 'stock', aliases: ['us_gaap_ContractWithCustomerLiabilityCurrent', 'us_gaap_DeferredRevenueCurrent'] },
  net_ppe: { label: 'Property and equipment, net', unit: 'currency', kind: 'stock', aliases: ['us_gaap_PropertyPlantAndEquipmentNet', 'us_gaap_PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization'] },
  long_term_debt: { label: 'Long-term debt', unit: 'currency', kind: 'stock', aliases: ['us_gaap_LongTermDebtNoncurrent', 'long_term_debt'] },
  cash: { label: 'Cash and cash equivalents', unit: 'currency', kind: 'stock', aliases: ['us_gaap_CashAndCashEquivalentsAtCarryingValue', 'cash_and_cash_equivalents', 'cash'] },
  marketable_securities: { label: 'Marketable securities', unit: 'currency', kind: 'stock', aliases: ['us_gaap_MarketableSecuritiesCurrent', 'us_gaap_AvailableForSaleSecuritiesDebtSecuritiesCurrent', 'us_gaap_ShortTermInvestments', 'marketable_securities'] },
  total_assets: { label: 'Total assets', unit: 'currency', kind: 'stock', aliases: ['total_assets', 'us_gaap_Assets'] },
  current_liabilities: { label: 'Current liabilities', unit: 'currency', kind: 'stock', aliases: ['us_gaap_LiabilitiesCurrent', 'current_liabilities'] },
  equity: { label: "Shareholders' equity", unit: 'currency', kind: 'stock', aliases: ['stockholders_equity', 'us_gaap_StockholdersEquity'] },
  diluted_shares: { label: 'Diluted shares', unit: 'shares', kind: 'point', aliases: ['us_gaap_WeightedAverageNumberOfDilutedSharesOutstanding', 'diluted_shares'] },
  market_cap: { label: 'Market cap', unit: 'currency', kind: 'point', aliases: ['market_cap'] },
  employees: { label: 'Total employees', unit: 'persons', kind: 'point', aliases: ['employees'] },
};

function unitMatches(r: Row, unit: Unit) {
  if (unit === 'currency') return r.unit === r.currency && /^[A-Z]{3}$/.test(r.unit ?? '');
  return r.unit === unit;
}

const empty = (label: string, basis: string, unit: Unit, missing: string): InputValue =>
  ({ label, basis, unit, currency: null, value: null, missing, rows: [], notes: [], derivedQuarter: false, unverified: false });

/** Lookup of saved inputs for one frequency. Values are cached per input and period. */
export class MetricBook {
  readonly frequency: Frequency;
  private readonly rows: Row[];
  private readonly cache = new Map<string, InputValue>();
  constructor(observations: Row[], frequency: Frequency) {
    this.frequency = frequency;
    this.rows = observations.filter((r) => !r.segment && !r.geography && Number.isFinite(r.value_numeric));
  }

  private basis(kind: InputKind) {
    if (kind === 'stock') return this.frequency === 'quarterly' ? 'Balance at quarter end' : 'Balance at fiscal year end';
    if (kind === 'point') return this.frequency === 'quarterly' ? 'At quarter end' : 'At fiscal year end';
    return this.frequency === 'quarterly' ? 'Quarter' : 'Fiscal year';
  }

  /** One saved value for an input, or null with the reason. Statement rows win over other rows. */
  private reported(def: BaseDef, p: PeriodRef, periodicity: Frequency): { row: Row | null; reason: string | null } {
    for (const alias of def.aliases) {
      const candidates = this.rows.filter((r) => r.metric_key === alias && r.periodicity === periodicity && samePeriod(r, p) && unitMatches(r, def.unit));
      if (!candidates.length) continue;
      const filed = candidates.filter((r) => r.metadata_json?.statement);
      const set = filed.length ? filed : candidates;
      if (new Set(set.map((r) => r.value_numeric)).size > 1) return { row: null, reason: `${def.label} has conflicting values for ${periodName(p)}` };
      return { row: set[0], reason: null };
    }
    return { row: null, reason: null };
  }

  private base(name: string, p: PeriodRef): InputValue {
    const def = BASE_INPUTS[name];
    const basis = this.basis(def.kind);
    const found = this.reported(def, p, this.frequency);
    const make = (row: Row, value: number, rows: Row[], notes: string[], derivedQuarter: boolean): InputValue => ({
      label: def.label, basis, unit: def.unit, currency: def.unit === 'currency' ? row.currency : null, value, missing: null, rows, notes, derivedQuarter,
      unverified: name === 'market_cap' && row.metadata_json?.verified !== true,
    });
    if (found.row) {
      const notes = name === 'market_cap' && found.row.formula_or_adjustment ? [String(found.row.formula_or_adjustment)] : [];
      return make(found.row, found.row.value_numeric, [found.row], notes, false);
    }
    if (found.reason) return empty(def.label, basis, def.unit, found.reason);
    // A missing quarterly flow can be recovered from the fiscal-year total and the other quarters.
    if (def.kind === 'flow' && p.quarter) {
      const annual = this.reported(def, { year: p.year, quarter: null }, 'annual').row;
      const others = [1, 2, 3, 4].filter((q) => q !== p.quarter).map((q) => this.reported(def, { year: p.year, quarter: q }, 'quarterly').row);
      if (annual && others.every(Boolean) && others.every((r) => r!.currency === annual.currency)) {
        const value = annual.value_numeric - others.reduce((sum, r) => sum + r!.value_numeric, 0);
        return make(annual, value, [annual, ...(others as Row[])], [`${def.label} for ${periodName(p)} is the FY${p.year} total minus the other three quarters.`], true);
      }
    }
    const what = def.kind === 'stock' ? `${def.label} at the end of ${periodName(p)}` : `${def.label} for ${periodName(p)}`;
    return empty(def.label, basis, def.unit, `${what} is not captured`);
  }

  /** Value of a base or composite input for one period (quarter, fiscal year or period end). */
  get(name: string, p: PeriodRef): InputValue {
    const key = `${name}|${periodKey(p)}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const value = BASE_INPUTS[name] ? this.base(name, p) : COMPOSITES[name](this, p);
    this.cache.set(key, value);
    return value;
  }

  /** Trailing 12 months: the sum of four consecutive quarters, or the fiscal year itself. */
  ttm(name: string, p: PeriodRef): InputValue {
    const at = this.get(name, p);
    if (this.frequency === 'annual') return { ...at, basis: 'Fiscal year' };
    const quarters = [3, 2, 1, 0].map((n) => this.get(name, shiftPeriod(p, -n)));
    return { ...combine(at.label, at.unit, quarters, (v) => v.reduce((a, b) => a + b, 0)), basis: 'Trailing 12 months' };
  }

  /** Average of the period-end balance and the balance a year earlier. */
  average(name: string, p: PeriodRef): InputValue {
    const now = this.get(name, p), before = this.get(name, shiftPeriod(p, -yearLag(this.frequency)));
    return { ...combine(now.label, now.unit, [now, before], ([a, b]) => (a + b) / 2), basis: this.frequency === 'quarterly' ? 'Average of this quarter end and a year earlier' : 'Average of this and the prior fiscal year end' };
  }
}

/** Combine inputs; the first missing input names why the result is unavailable. */
function combine(label: string, unit: Unit, parts: InputValue[], fn: (values: number[]) => number): InputValue {
  const currencies = new Set(parts.filter((p) => p.unit === 'currency' && p.currency).map((p) => p.currency));
  const merged = {
    label, basis: parts[0]?.basis ?? '', unit,
    currency: unit === 'currency' ? (parts.find((p) => p.currency)?.currency ?? null) : null,
    rows: [...new Set(parts.flatMap((p) => p.rows))],
    notes: [...new Set(parts.flatMap((p) => p.notes))],
    derivedQuarter: parts.some((p) => p.derivedQuarter),
    unverified: parts.some((p) => p.unverified),
  };
  const missing = parts.find((p) => p.value === null)?.missing ?? (currencies.size > 1 ? 'Inputs are reported in different currencies' : null);
  if (missing) return { ...merged, value: null, missing };
  const value = fn(parts.map((p) => p.value!));
  return Number.isFinite(value) ? { ...merged, value, missing: null } : { ...merged, value: null, missing: `${label} is not meaningful for these inputs` };
}

const COMPOSITES: Record<string, (book: MetricBook, p: PeriodRef) => InputValue> = {
  gross_profit: (b, p) => {
    const reported = b.get('reported_gross_profit', p);
    if (reported.value !== null) return reported;
    const value = combine('Gross profit', 'currency', [b.get('revenue', p), b.get('cost_of_revenue', p)], ([r, c]) => r - c);
    return { ...value, notes: [...value.notes, 'Gross profit is not reported, so it is revenue minus cost of revenue.'] };
  },
  sga: (b, p) => {
    const reported = b.get('reported_sga', p);
    if (reported.value !== null) return reported;
    const value = combine('Selling, general and administrative', 'currency', [b.get('selling', p), b.get('administrative', p)], ([s, a]) => s + a);
    return { ...value, notes: [...value.notes, 'There is no combined SG&A line, so it is marketing and sales plus general and administrative.'] };
  },
  ebitda: (b, p) => combine('EBITDA', 'currency', [b.get('operating_income', p), b.get('depreciation', p)], ([o, d]) => o + d),
  free_cash_flow: (b, p) => combine('Free cash flow', 'currency', [b.get('operating_cash_flow', p), b.get('capex', p)], ([o, c]) => o - c),
  ocf_ex_sbc: (b, p) => combine('Operating cash flow excl. SBC', 'currency', [b.get('operating_cash_flow', p), b.get('sbc', p)], ([o, s]) => o - s),
  fcf_ex_sbc: (b, p) => combine('Free cash flow excl. SBC', 'currency', [b.get('free_cash_flow', p), b.get('sbc', p)], ([f, s]) => f - s),
  nopat: (b, p) => {
    const parts = [b.get('operating_income', p), b.get('income_tax', p), b.get('pretax_income', p)];
    if (parts[2].value !== null && parts[2].value <= 0) return { ...combine('After-tax operating profit', 'currency', parts, () => NaN), missing: `The tax rate for ${periodName(p)} is undefined: income before taxes is zero or negative` };
    return combine('After-tax operating profit', 'currency', parts, ([o, t, pre]) => o * (1 - t / pre));
  },
  capital_employed: (b, p) => combine('Capital employed', 'currency', [b.get('total_assets', p), b.get('current_liabilities', p)], ([a, l]) => a - l),
  invested_capital: (b, p) => combine('Invested capital', 'currency', ['equity', 'long_term_debt', 'cash', 'marketable_securities'].map((n) => b.get(n, p)), ([e, d, c, s]) => e + d - c - s),
  enterprise_value: (b, p) => combine('Enterprise value', 'currency', ['market_cap', 'long_term_debt', 'cash', 'marketable_securities'].map((n) => b.get(n, p)), ([m, d, c, s]) => m + d - c - s),
};

// ---------------------------------------------------------------- catalogue

const div = ([a, b]: number[]) => a / b;
const q = (name: string) => (b: MetricBook, p: PeriodRef) => b.get(name, p);
const t = (name: string) => (b: MetricBook, p: PeriodRef) => b.ttm(name, p);
const avg = (name: string) => (b: MetricBook, p: PeriodRef) => b.average(name, p);
const ins = (...fns: ((b: MetricBook, p: PeriodRef) => InputValue)[]) => (b: MetricBook, p: PeriodRef) => fns.map((f) => f(b, p));
const priceRatio = (key: string, name: string, input: string, inputName: string): MetricDef => ({
  key, name, group: 'Valuation', kind: 'x', price: true, formula: `Market cap ÷ ${inputName} (trailing 12 months)`,
  inputs: ins(q('market_cap'), t(input)), compute: div, denominator: 1,
});
const perEmployee = (key: string, name: string, input: string, inputName: string): MetricDef => ({
  key, name, group: 'Per employee', kind: 'per_person', up: true, employees: true, formula: `${inputName} (trailing 12 months) ÷ total employees at period end`,
  note: 'Headcount is the company-wide count reported for the period end.', inputs: ins(t(input), q('employees')), compute: div, denominator: 1,
});

export const METRIC_GROUPS = ['Margins', 'Valuation', 'Returns', 'Shareholder returns', 'Stock-based compensation', 'Yields', 'Per share', 'Per employee', 'Leverage'] as const;

export const METRICS: MetricDef[] = [
  { key: 'gross_margin', name: 'Gross margin', group: 'Margins', kind: 'pct', up: true, formula: '(Revenue − cost of revenue) ÷ revenue', inputs: ins(q('gross_profit'), q('revenue')), compute: div, denominator: 1 },
  { key: 'sga_margin', name: 'SG&A margin', group: 'Margins', kind: 'pct', up: false, formula: '(Marketing and sales + general and administrative) ÷ revenue', inputs: ins(q('sga'), q('revenue')), compute: div, denominator: 1 },
  { key: 'operating_margin', name: 'Operating margin', group: 'Margins', kind: 'pct', up: true, formula: 'Income from operations ÷ revenue', note: 'Both values are for the same period, as filed.', inputs: ins(q('operating_income'), q('revenue')), compute: div, denominator: 1 },
  { key: 'ebitda_margin', name: 'EBITDA margin', group: 'Margins', kind: 'pct', up: true, formula: '(Income from operations + depreciation and amortization) ÷ revenue', note: 'Depreciation and amortization come from the cash-flow statement.', inputs: ins(q('ebitda'), q('revenue')), compute: div, denominator: 1 },
  { key: 'net_margin', name: 'Net margin', group: 'Margins', kind: 'pct', up: true, formula: 'Net income ÷ revenue', inputs: ins(q('net_income'), q('revenue')), compute: div, denominator: 1 },
  { key: 'fcf_margin', name: 'Free cash flow margin', group: 'Margins', kind: 'pct', up: true, formula: '(Operating cash flow − capital expenditure) ÷ revenue', note: 'Capital expenditure is purchases of property and equipment.', inputs: ins(q('free_cash_flow'), q('revenue')), compute: div, denominator: 1 },
  { key: 'ocf_margin', name: 'Operating cash flow margin', group: 'Margins', kind: 'pct', up: true, formula: 'Operating cash flow ÷ revenue', inputs: ins(q('operating_cash_flow'), q('revenue')), compute: div, denominator: 1 },

  { key: 'market_cap', name: 'Market cap', group: 'Valuation', kind: 'money', price: true, formula: 'Period-end share price × shares outstanding at period end', note: 'From the saved price history: the close on the last trading day on or before the period end.', inputs: ins(q('market_cap')), compute: ([m]) => m },
  { key: 'enterprise_value', name: 'Enterprise value', group: 'Valuation', kind: 'money', price: true, formula: 'Market cap + long-term debt − cash − marketable securities', note: 'Lease liabilities are left out.', inputs: ins(q('market_cap'), q('long_term_debt'), q('cash'), q('marketable_securities')), compute: ([m, d, c, s]) => m + d - c - s },
  priceRatio('price_to_sales', 'Price to sales', 'revenue', 'revenue'),
  priceRatio('price_to_gross_profit', 'Price to gross profit', 'gross_profit', 'gross profit'),
  priceRatio('price_to_ocf', 'Price to operating cash flow', 'operating_cash_flow', 'operating cash flow'),
  priceRatio('price_to_ocf_ex_sbc', 'Price to operating cash flow excl. SBC', 'ocf_ex_sbc', '(operating cash flow − stock-based compensation)'),
  priceRatio('price_to_operating_income', 'Price to operating income', 'operating_income', 'income from operations'),
  priceRatio('price_to_earnings', 'Price to earnings', 'net_income', 'net income'),
  priceRatio('price_to_fcf', 'Price to free cash flow', 'free_cash_flow', 'free cash flow'),
  priceRatio('price_to_fcf_ex_sbc', 'Price to free cash flow excl. SBC', 'fcf_ex_sbc', '(free cash flow − stock-based compensation)'),

  { key: 'roa', name: 'Return on assets', group: 'Returns', kind: 'pct', up: true, formula: 'Net income (trailing 12 months) ÷ average total assets', note: 'Trailing 12 months over the average of the period-end balance and the balance a year earlier, so it is already an annual rate.', inputs: ins(t('net_income'), avg('total_assets')), compute: div, denominator: 1 },
  { key: 'roce', name: 'Return on capital employed', group: 'Returns', kind: 'pct', up: true, formula: 'Income from operations (trailing 12 months) ÷ average (total assets − current liabilities)', inputs: ins(t('operating_income'), avg('capital_employed')), compute: div, denominator: 1 },
  { key: 'roe', name: 'Return on equity', group: 'Returns', kind: 'pct', up: true, formula: "Net income (trailing 12 months) ÷ average shareholders' equity", inputs: ins(t('net_income'), avg('equity')), compute: div, denominator: 1 },
  { key: 'roic', name: 'Return on invested capital', group: 'Returns', kind: 'pct', up: true, formula: 'After-tax operating profit (trailing 12 months) ÷ average invested capital', note: "After-tax operating profit is income from operations × (1 − the period's effective tax rate). Invested capital is shareholders' equity + long-term debt − cash − marketable securities.", inputs: ins(t('nopat'), avg('invested_capital')), compute: div, denominator: 1 },

  { key: 'dividends_per_share', name: 'Dividends per share (approx.)', group: 'Shareholder returns', kind: 'ps', up: true, formula: 'Dividends paid ÷ diluted shares', note: 'Approximated from cash dividends paid; the declared dividend per share is not captured.', inputs: ins(q('dividends'), q('diluted_shares')), compute: div, denominator: 1 },
  { key: 'fcf_payout_ratio', name: 'Free cash flow payout ratio', group: 'Shareholder returns', kind: 'pct', formula: 'Dividends paid ÷ free cash flow', inputs: ins(q('dividends'), q('free_cash_flow')), compute: div, denominator: 1 },
  { key: 'payout_ratio', name: 'Payout ratio', group: 'Shareholder returns', kind: 'pct', formula: 'Dividends paid ÷ net income', inputs: ins(q('dividends'), q('net_income')), compute: div, denominator: 1 },

  { key: 'sbc_to_fcf', name: 'SBC as % of free cash flow', group: 'Stock-based compensation', kind: 'pct', up: false, formula: 'Stock-based compensation ÷ free cash flow', note: 'Above 100% means share-based pay was larger than the cash kept after capital expenditure.', inputs: ins(q('sbc'), q('free_cash_flow')), compute: div, denominator: 1 },
  { key: 'sbc_to_ocf', name: 'SBC as % of operating cash flow', group: 'Stock-based compensation', kind: 'pct', up: false, formula: 'Stock-based compensation ÷ operating cash flow', inputs: ins(q('sbc'), q('operating_cash_flow')), compute: div, denominator: 1 },
  { key: 'sbc_to_revenue', name: 'SBC as % of revenue', group: 'Stock-based compensation', kind: 'pct', up: false, formula: 'Stock-based compensation ÷ revenue', inputs: ins(q('sbc'), q('revenue')), compute: div, denominator: 1 },

  { key: 'fcf_ex_sbc_yield', name: 'FCF excl. SBC yield', group: 'Yields', kind: 'pct', up: true, price: true, formula: '(Free cash flow − stock-based compensation, trailing 12 months) ÷ market cap', inputs: ins(t('fcf_ex_sbc'), q('market_cap')), compute: div, denominator: 1 },
  { key: 'ocf_ex_sbc_yield', name: 'OCF excl. SBC yield', group: 'Yields', kind: 'pct', up: true, price: true, formula: '(Operating cash flow − stock-based compensation, trailing 12 months) ÷ market cap', inputs: ins(t('ocf_ex_sbc'), q('market_cap')), compute: div, denominator: 1 },

  { key: 'fcf_per_share', name: 'Free cash flow per share', group: 'Per share', kind: 'ps', up: true, formula: 'Free cash flow ÷ diluted shares', note: 'Fourth quarters have no diluted share count in the capture (the 10-K reports only the annual figure), so they stay unavailable.', inputs: ins(q('free_cash_flow'), q('diluted_shares')), compute: div, denominator: 1 },
  { key: 'ocf_per_share', name: 'Operating cash flow per share', group: 'Per share', kind: 'ps', up: true, formula: 'Operating cash flow ÷ diluted shares', inputs: ins(q('operating_cash_flow'), q('diluted_shares')), compute: div, denominator: 1 },
  { key: 'revenue_per_share', name: 'Revenue per share', group: 'Per share', kind: 'ps', up: true, formula: 'Revenue ÷ diluted shares', inputs: ins(q('revenue'), q('diluted_shares')), compute: div, denominator: 1 },

  { key: 'employees', name: 'Total employees', group: 'Per employee', kind: 'count', employees: true, formula: 'Company-wide headcount reported for the period end', note: 'Read from filing text that states a company-wide count with an as-of date.', inputs: ins(q('employees')), compute: ([e]) => e },
  perEmployee('revenue_per_employee', 'Revenue per employee', 'revenue', 'Revenue'),
  perEmployee('ebit_per_employee', 'EBIT per employee', 'operating_income', 'Income from operations'),
  perEmployee('earnings_per_employee', 'Earnings per employee', 'net_income', 'Net income'),
  perEmployee('ocf_per_employee', 'Operating cash flow per employee', 'operating_cash_flow', 'Operating cash flow'),
  perEmployee('fcf_per_employee', 'Free cash flow per employee', 'free_cash_flow', 'Free cash flow'),

  { key: 'debt_to_ebitda', name: 'Debt to EBITDA', group: 'Leverage', kind: 'x', digits: 2, up: false, formula: 'Long-term debt ÷ EBITDA (trailing 12 months)', note: 'Long-term debt only; lease liabilities are excluded.', inputs: ins(q('long_term_debt'), t('ebitda')), compute: div, denominator: 1 },
];

/** Rows derived inside the income statement table (not part of the 39-metric catalogue). */
export const STATEMENT_DERIVED: MetricDef[] = [
  { key: 'gross_profit', name: 'Gross profit', group: 'Statement', kind: 'money', formula: 'Revenue − cost of revenue', inputs: ins(q('gross_profit')), compute: ([g]) => g },
];

const ALL = new Map([...METRICS, ...STATEMENT_DERIVED].map((m) => [m.key, m]));
export const metricDef = (key: string) => ALL.get(key);

export function evaluateMetric(book: MetricBook, def: MetricDef, p: PeriodRef): MetricResult {
  const inputs = def.inputs(book, p);
  const missingInput = inputs.find((i) => i.value === null);
  const currencies = new Set(inputs.filter((i) => i.unit === 'currency' && i.currency).map((i) => i.currency));
  let value: number | null = null, missing: string | null = null;
  if (missingInput) missing = missingInput.missing;
  else if (currencies.size > 1) missing = 'Inputs are reported in different currencies';
  else if (def.denominator !== undefined && inputs[def.denominator].value! <= 0) missing = `Not meaningful: ${inputs[def.denominator].label.toLowerCase()} is zero or negative`;
  else {
    const raw = def.compute(inputs.map((i) => i.value!));
    if (Number.isFinite(raw)) value = raw; else missing = 'Not meaningful for these inputs';
  }
  const notes = [def.note, ...new Set(inputs.flatMap((i) => i.notes))].filter(Boolean) as string[];
  return {
    key: def.key, name: def.name, group: def.group, kind: def.kind, digits: def.digits, period: p, value, missing,
    formula: def.formula, note: notes.join(' '), inputs,
    currency: inputs.find((i) => i.currency)?.currency ?? null,
    derivedQuarter: inputs.some((i) => i.derivedQuarter), unverified: inputs.some((i) => i.unverified),
  };
}

/** Sorted fiscal periods with saved observations for a frequency. */
export function observedPeriods(observations: Row[], frequency: Frequency): PeriodRef[] {
  const keys = new Set<string>();
  for (const r of observations) {
    if (r.periodicity !== frequency || !Number.isInteger(r.fiscal_year)) continue;
    if (frequency === 'quarterly' && !(r.fiscal_quarter >= 1 && r.fiscal_quarter <= 4)) continue;
    keys.add(periodKey({ year: r.fiscal_year, quarter: frequency === 'quarterly' ? r.fiscal_quarter : null }));
  }
  return [...keys].sort().map(parsePeriod);
}

/** Every metric evaluated for each period. */
export function metricCatalogue(observations: Row[], frequency: Frequency, periods: PeriodRef[], defs: MetricDef[] = METRICS) {
  const book = new MetricBook(observations, frequency);
  return defs.map((def) => ({ def, results: periods.map((p) => evaluateMetric(book, def, p)) }));
}

// ---------------------------------------------------------------- formatting

function currencyPrefix(currency: string | null) { return !currency || currency === 'USD' ? '$' : `${currency} `; }
export function formatMoney(v: number, currency: string | null = 'USD') {
  const sign = v < 0 ? '−' : '', a = Math.abs(v), c = currencyPrefix(currency);
  if (a >= 1e12) return `${sign}${c}${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}${c}${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}${c}${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}${c}${(a / 1e3).toFixed(1)}K`;
  return `${sign}${c}${a.toFixed(0)}`;
}
export function formatMetric(value: number | null, kind: MetricKind, currency: string | null = 'USD', digits?: number): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  const sign = value < 0 ? '−' : '', a = Math.abs(value);
  switch (kind) {
    case 'pct': return `${sign}${(a * 100).toFixed(digits ?? 1)}%`;
    case 'x': return `${sign}${a.toFixed(digits ?? 1)}×`;
    case 'ps': return `${sign}${currencyPrefix(currency)}${a.toFixed(2)}`;
    case 'count': return `${sign}${Math.round(a).toLocaleString('en-US')}`;
    case 'money': case 'per_person': return formatMoney(value, currency);
  }
}
export function formatInput(input: InputValue): string {
  if (input.value === null) return 'not captured';
  if (input.unit === 'shares') return `${(input.value / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })}M shares`;
  if (input.unit === 'persons') return `${Math.round(input.value).toLocaleString('en-US')} people`;
  return formatMoney(input.value, input.currency);
}

/** Change against the same period a year earlier: points for percentages, % otherwise. */
export function yearOverYear(now: number | null, before: number | null, kind: MetricKind): { text: string; diff: number } | null {
  if (now === null || before === null) return null;
  if (kind === 'pct') { const diff = (now - before) * 100; return { diff, text: `${diff >= 0 ? '↑ +' : '↓ −'}${Math.abs(diff).toFixed(1)} pts` }; }
  if (before === 0) return null;
  const diff = (now / Math.abs(before) - Math.sign(before)) * 100;
  return { diff, text: `${diff >= 0 ? '↑ +' : '↓ −'}${Math.abs(diff).toFixed(1)}%` };
}
