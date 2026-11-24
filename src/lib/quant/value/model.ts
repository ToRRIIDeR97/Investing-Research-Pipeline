/**
 * PragValue (Pragma's PulseValue™ v2), ported from `pragma-web/api/app/services/pulsevalue.py`.
 *
 * Input is Pragma's own data shape (yfinance-style `info` fields plus annual statements keyed by yfinance row
 * names, newest period first), so the port can be checked against the Python on identical inputs
 * (Implementations/quant-page/fixtures). Line-for-line where it matters for the numbers. Known differences:
 * - Industry revenue growth from S&P 500 peers is not fetched: like Pragma when that lookup fails, scenario exits
 *   use the stock's own historical multiples (min, mean, max).
 * - Engine B's "ramped" DCF branch is not ported. In Pragma it never runs: its guard compares the metric label to
 *   "EV/Revenue", which no metric has, and its call passes keyword arguments the function does not accept.
 * - The Credit Impact Scalar takes a credit z-score when one is supplied; without it the scalar is 1.0, as in
 *   Pragma when its indicator cache is empty.
 */

export type Series = (number | null)[];
export type Statement = { periods: string[]; rows: Record<string, Series> };
export type PragmaData = {
  info: Record<string, number | string | null | undefined>;
  income: Statement;
  income_quarterly: Statement;
  balance: Statement;
  cashflow: Statement;
  /** Daily closes, oldest first. */
  history: { day: string; close: number }[];
};

export type Engine = "A" | "B" | "B2" | "C" | "D" | "E" | "F" | "G";

// ── Constants (pulsevalue.py) ────────────────────────────────────────────────
export const EBIT_WEIGHTS = [0.35, 0.25, 0.2, 0.12, 0.08];
export const DISCOUNT_RATE = 0.1;
export const TERMINAL_GROWTH = 0.03;
export const GROWTH_REVERSION_SPEED = 0.75;

const RD_CAP_RATES: Record<string, number> = {
  "Software": 0.6, "Software—Infrastructure": 0.6, "Software—Application": 0.6, "Information Technology Services": 0.4,
  "Semiconductors": 0.5, "Semiconductor Equipment & Materials": 0.5, "Electronic Components": 0.4, "Computer Hardware": 0.4,
  "Communication Equipment": 0.4, "Aerospace & Defense": 0.45, "Drug Manufacturers—General": 0.3,
  "Drug Manufacturers—Specialty & Generic": 0.3, "Biotechnology": 0.3, "Medical Devices": 0.3, "Diagnostics & Research": 0.3,
  "Specialty Industrial Machinery": 0.2, "Industrial Products": 0.2, "Specialty Chemicals": 0.2,
  "Household & Personal Products": 0.1, "Packaged Foods": 0.1, "Beverages—Non-Alcoholic": 0.1,
};
const RD_CAP_SECTOR_FALLBACK: Record<string, number> = {
  "Technology": 0.5, "Healthcare": 0.3, "Industrials": 0.2, "Basic Materials": 0.2, "Consumer Defensive": 0.1,
};
export const FAIR_MULTIPLES: Record<Engine, Record<string, number>> = {
  A: {
    "Software": 28, "Software—Infrastructure": 28, "Software—Application": 28, "Semiconductors": 20,
    "Semiconductor Equipment & Materials": 20, "Computer Hardware": 16, "Electronic Components": 16, "Communication Equipment": 14,
    "Industrials": 14, "Consumer Electronics": 16, "Consumer Defensive": 16, "Consumer Cyclical": 13, "Auto Manufacturers": 13,
    "Basic Materials": 12, "Healthcare": 17, "Drug Manufacturers—General": 17, "Drug Manufacturers—Specialty & Generic": 15,
    "Medical Devices": 22, "Diagnostics & Research": 22, "Communication Services": 14, "_default": 15,
  },
  B: {
    "Technology": 6, "Software": 8, "Software—Infrastructure": 8, "Software—Application": 8, "Healthcare": 5,
    "Consumer Cyclical": 3, "Consumer Defensive": 3, "Communication Services": 4, "_default": 4,
  },
  B2: {},
  C: {
    "Banks—Diversified": 1.4, "Banks—Regional": 1.2, "Insurance—Diversified": 1.3, "Insurance—Life": 1.3,
    "Insurance—Property & Casualty": 1.3, "Capital Markets": 2.0, "Financial Data & Stock Exchanges": 2.5, "_default": 1.4,
  },
  D: {
    "REIT—Diversified": 20, "REIT—Residential": 22, "REIT—Industrial": 24, "REIT—Retail": 16, "REIT—Office": 14,
    "REIT—Healthcare Facilities": 18, "_default": 20,
  },
  E: {
    "Utilities—Regulated Electric": 11, "Utilities—Diversified": 11, "Utilities—Renewable": 13,
    "Utilities—Independent Power Producers": 9, "_default": 11,
  },
  F: {
    "Oil & Gas Integrated": 10, "Oil & Gas E&P": 10, "Oil & Gas Midstream": 12, "Oil & Gas Refining & Marketing": 8, "Gold": 12,
    "Copper": 10, "Steel": 8, "Other Industrial Metals & Mining": 9, "_default": 10,
  },
  G: {
    "Asset Management": 14, "Insurance—Diversified": 12, "Insurance - Diversified": 12, "Financial Conglomerates": 13,
    "Conglomerates": 13, "_default": 13,
  },
};

type MetricDef = { label: string; ev_based: boolean; is_flow: boolean; income_row?: string; balance_row?: string; cashflow_row?: string; custom?: "ffo"; min: number; max: number };
export const METRIC_DEFS: MetricDef[] = [
  { label: "EV/EBIT", ev_based: true, is_flow: true, income_row: "EBIT", min: 1, max: 100 },
  { label: "P/E", ev_based: false, is_flow: true, income_row: "Net Income", min: 1, max: 100 },
  { label: "P/S", ev_based: false, is_flow: false, income_row: "Total Revenue", min: 0.1, max: 50 },
  { label: "P/GP", ev_based: false, is_flow: false, income_row: "Gross Profit", min: 0.1, max: 80 },
  { label: "P/B", ev_based: false, is_flow: false, balance_row: "Total Stockholders Equity", min: 0.2, max: 30 },
  { label: "P/TBV", ev_based: false, is_flow: false, balance_row: "Tangible Book Value", min: 0.2, max: 30 },
  { label: "P/FCF", ev_based: false, is_flow: true, cashflow_row: "Free Cash Flow", min: 1, max: 120 },
  { label: "P/OCF", ev_based: false, is_flow: true, cashflow_row: "Operating Cash Flow", min: 1, max: 100 },
  { label: "P/FFO", ev_based: false, is_flow: true, custom: "ffo", min: 1, max: 120 },
  { label: "EV/EBITDA", ev_based: true, is_flow: true, income_row: "EBITDA", min: 1, max: 80 },
];

export const DEVIATION_BAND_CUTOFFS: [string, number][] = [
  ["A+", -0.4], ["A", -0.25], ["A-", -0.15], ["B+", -0.08], ["B", -0.03], ["B-", 0.03], ["C+", 0.08], ["C", 0.15], ["C-", 0.25], ["D", 0.4],
];

// ── Numeric helpers (numpy / pandas semantics) ───────────────────────────────
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const stdSample = (xs: number[]) => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
/**
 * Python round(x, n): rounds the exact binary value, ties to even. For n > 0 the scaled product x·10ⁿ can land on .5
 * when the true value is just below it (2.675 is 2.67499999…), so digits come from the exact decimal expansion
 * (`toFixed(100)` is exact for doubles at these magnitudes) rather than from the product.
 */
export function pyRound(x: number, n = 0): number {
  if (!Number.isFinite(x)) return x;
  if (n <= 0) {
    const f = 10 ** n;
    const y = x * f;
    const r = Math.round(y);
    const tie = Math.abs(y - Math.trunc(y)) === 0.5;
    return (tie ? (r % 2 === 0 ? r : r - Math.sign(y)) : r) / f;
  }
  if (Math.abs(x) >= 1e21) return x;
  const [int, frac] = Math.abs(x).toFixed(100).split(".");
  const keep = frac.slice(0, n), rest = frac.slice(n);
  const beyond = /[1-9]/.test(rest.slice(1));
  const last = Number((int + keep).slice(-1));
  const up = rest[0] > "5" || (rest[0] === "5" && (beyond || last % 2 === 1));
  // Add one unit in the last kept place by decimal string arithmetic (no BigInt on the ES2017 target).
  const digits = (int + keep).split("").map(Number);
  if (up) { let i = digits.length - 1; while (i >= 0 && digits[i] === 9) digits[i--] = 0; if (i >= 0) digits[i]++; else digits.unshift(1); }
  const all = digits.join("");
  const v = Number(`${all.slice(0, all.length - n)}.${all.slice(all.length - n)}`);
  return x < 0 ? -v : v; // Python keeps the sign: round(-0.001, 2) is -0.0
}
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/**
 * Python 3.12+ `sum()` of floats: Neumaier-compensated. Pragma's weighted sums use it, and a plain JS reduce can land
 * one ulp away (0.3 + 0.2 + 0.05 + 0.15 is 0.7 in Python, 0.7000000000000001 in JS), which flips a weighted median
 * sitting on the 0.5 boundary.
 */
export function pySum(values: number[]): number {
  let sum = 0, c = 0;
  for (const x of values) {
    const t = sum + x;
    c += Math.abs(sum) >= Math.abs(x) ? (sum - t) + x : (x - t) + sum;
    sum = t;
  }
  return sum + c;
}

/** _safe_float: the first finite numeric info value among the keys. */
export function safeFloat(info: PragmaData["info"], ...keys: string[]): number | null {
  for (const k of keys) {
    const v = info[k];
    if (v === null || v === undefined) continue;
    // Python's float("") raises and Pragma skipped the key; JavaScript's Number("") is 0.
    if (typeof v === "string" && v.trim() === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
    if (typeof v === "number" && Number.isNaN(v)) continue;
  }
  return null;
}
/** `x or default` on a Python float: 0 and None both fall through. */
const or = (v: number | null, d: number) => (v ? v : d);

function hasRow(st: Statement, row: string) { return Object.prototype.hasOwnProperty.call(st.rows, row); }
function isEmpty(st: Statement) { return !st.periods.length || !Object.keys(st.rows).length; }

/** _extract_annual_series: [Y0, Y-1, ...] padded with null. */
export function annualSeries(st: Statement, row: string, n = 5): Series {
  if (isEmpty(st) || !hasRow(st, row)) return Array(n).fill(null);
  const values = st.rows[row].slice(0, Math.min(n, st.periods.length)).map((v) => (isNum(v) ? v : null));
  while (values.length < n) values.push(null);
  return values;
}
function cellAt(st: Statement, row: string, col: number): number | null {
  if (isEmpty(st) || !hasRow(st, row) || col >= st.periods.length) return null;
  const v = st.rows[row][col];
  return isNum(v) ? v : null;
}
const firstCell = (st: Statement, row: string) => cellAt(st, row, 0);

export function exitMultiple(engine: Engine, industry: string, sector: string): number {
  const m = FAIR_MULTIPLES[engine] ?? {};
  if (industry in m) return m[industry];
  if (sector in m) return m[sector];
  return m._default ?? 15;
}

function histDebtCash(balance: Statement, col: number): [number, number] {
  let debt = 0, cash = 0;
  for (const r of ["Total Debt", "Long Term Debt"]) { const v = cellAt(balance, r, col); if (hasRow(balance, r) && v !== null) { debt = v; break; } }
  for (const r of ["Cash And Cash Equivalents", "Cash Cash Equivalents And Short Term Investments"]) { const v = cellAt(balance, r, col); if (hasRow(balance, r) && v !== null) { cash = v; break; } }
  return [debt, cash];
}

function historicalFfo(income: Statement, cashflow: Statement, col: number): number | null {
  let ni: number | null = null;
  for (const r of ["Net Income", "Net Income Common Stockholders", "Net Income Including Noncontrolling Interests"]) { ni = cellAt(income, r, col); if (ni !== null) break; }
  let da: number | null = null;
  for (const r of ["Depreciation And Amortization", "Depreciation", "Amortization"]) {
    da = cellAt(cashflow, r, col);
    if (da === null) da = cellAt(income, r, col);
    if (da !== null) break;
  }
  if (ni === null && da === null) return null;
  const ffo = (ni ?? 0) + Math.max(da ?? 0, 0);
  return ffo <= 0 ? null : ffo;
}

export function currentFfoProxy(data: PragmaData): number | null {
  const { income, cashflow, info } = data;
  let ni = safeFloat(info, "netIncomeToCommon", "netIncome");
  if (ni === null && !isEmpty(income)) {
    for (const r of ["Net Income", "Net Income Common Stockholders", "Net Income Including Noncontrolling Interests"]) {
      if (hasRow(income, r)) { const v = firstCell(income, r); if (v !== null) { ni = v; break; } }
    }
  }
  let da: number | null = null;
  if (!isEmpty(cashflow)) for (const r of ["Depreciation And Amortization", "Depreciation", "Amortization"]) { if (hasRow(cashflow, r)) { const v = firstCell(cashflow, r); if (v !== null) { da = v; break; } } }
  if (da === null && !isEmpty(income)) for (const r of ["Depreciation And Amortization", "Depreciation", "Amortization"]) { if (hasRow(income, r)) { const v = firstCell(income, r); if (v !== null) { da = v; break; } } }
  let ocf = safeFloat(info, "operatingCashflow");
  if (ocf === null && !isEmpty(cashflow) && hasRow(cashflow, "Operating Cash Flow")) ocf = firstCell(cashflow, "Operating Cash Flow");
  const ffoGaap = ni !== null || da !== null ? (ni ?? 0) + Math.max(da ?? 0, 0) : null;
  const opIncome = !isEmpty(income) && hasRow(income, "Operating Income") ? firstCell(income, "Operating Income") : null;
  const ffoAlt = opIncome !== null && opIncome > 0 ? opIncome + Math.max(da ?? 0, 0) : null;
  if (ocf !== null && ocf > 0 && ffoGaap !== null && ffoGaap > 0) return 0.7 * ocf + 0.3 * ffoGaap;
  if (ffoAlt !== null && ffoAlt > 0) return ffoAlt;
  if (ocf !== null && ocf > 0) return ocf;
  if (ffoGaap !== null && ffoGaap > 0) return ffoGaap;
  if (opIncome !== null && opIncome > 0) return opIncome;
  return null;
}

function metricDenominator(def: MetricDef, income: Statement, balance: Statement, cashflow: Statement, col: number): number | null {
  if (def.custom === "ffo") return historicalFfo(income, cashflow, col);
  if (def.income_row) { const v = cellAt(income, def.income_row, col); return v !== null && v > 0 ? v : null; }
  if (def.balance_row) {
    const v = cellAt(balance, def.balance_row, col);
    if (v !== null && v > 0) return v;
    if (def.label === "P/TBV") { const f = cellAt(balance, "Total Stockholders Equity", col); if (f !== null && f > 0) return f; }
    return null;
  }
  if (def.cashflow_row) { const v = cellAt(cashflow, def.cashflow_row, col); return v !== null && v > 0 ? v : null; }
  return null;
}

/** _compute_all_historical_multiples, plus the fiscal dates each multiple belongs to (for the band chart). */
export function historicalMultiples(data: PragmaData): { values: Record<string, number[]>; dated: Record<string, { period: string; multiple: number }[]> } {
  const { history, income, balance, cashflow, info } = data;
  const values: Record<string, number[]> = {}, dated: Record<string, { period: string; multiple: number }[]> = {};
  if (!history.length || isEmpty(income)) return { values, dated };
  const ms = history.map((h) => ({ t: Date.parse(`${h.day}T00:00:00Z`), close: h.close }));
  income.periods.forEach((period, col) => {
    const t = Date.parse(`${period}T00:00:00Z`);
    const window = ms.filter((h) => h.t >= t - 30 * 86_400_000 && h.t <= t + 30 * 86_400_000);
    if (!window.length) return;
    const avgPrice = mean(window.map((h) => h.close));
    let shares: number | null = null;
    for (const label of ["Basic Average Shares", "Diluted Average Shares"]) { const v = cellAt(income, label, col); if (v !== null && v > 0) { shares = v; break; } }
    if (shares === null) shares = or(safeFloat(info, "sharesOutstanding"), 1);
    const mktCap = avgPrice * shares;
    const [debt, cash] = histDebtCash(balance, col);
    const ev = mktCap + debt - cash;
    for (const def of METRIC_DEFS) {
      const denom = metricDenominator(def, income, balance, cashflow, col);
      if (denom === null || denom <= 0) continue;
      let mult: number;
      if (def.ev_based) { if (ev <= 0) continue; mult = ev / denom; } else mult = mktCap / denom;
      if (def.min < mult && mult < def.max) {
        (values[def.label] ??= []).push(mult);
        (dated[def.label] ??= []).push({ period, multiple: mult });
      }
    }
  });
  return { values, dated };
}

/** _get_current_metric_values */
export function currentMetricValues(data: PragmaData): Record<string, [number, boolean]> {
  const { income, balance, cashflow, info } = data;
  const out: Record<string, [number, boolean]> = {};
  const fallbacks: Record<string, string[]> = {
    "EV/EBIT": ["ebit"], "P/E": ["netIncomeToCommon"], "P/S": ["totalRevenue"], "P/GP": ["grossProfits"],
    "P/FCF": ["freeCashflow"], "P/OCF": ["operatingCashflow"], "P/FFO": ["operatingCashflow"], "EV/EBITDA": ["ebitda"],
  };
  for (const def of METRIC_DEFS) {
    if (def.custom === "ffo") { const f = currentFfoProxy(data); if (f !== null && f > 0) out[def.label] = [f, def.ev_based]; continue; }
    let val: number | null = null;
    if (def.income_row && !isEmpty(income) && hasRow(income, def.income_row)) { const v = firstCell(income, def.income_row); if (v !== null && v > 0) val = v; }
    if (def.balance_row && val === null && !isEmpty(balance) && hasRow(balance, def.balance_row)) {
      const v = firstCell(balance, def.balance_row); if (v !== null && v > 0) val = v;
      if (val === null && def.label === "P/TBV" && hasRow(balance, "Total Stockholders Equity")) { const e = firstCell(balance, "Total Stockholders Equity"); if (e !== null && e > 0) val = e; }
    }
    if (def.cashflow_row && val === null && !isEmpty(cashflow) && hasRow(cashflow, def.cashflow_row)) { const v = firstCell(cashflow, def.cashflow_row); if (v !== null && v > 0) val = v; }
    if (val === null) for (const key of fallbacks[def.label] ?? []) { const v = safeFloat(info, key); if (v && v > 0) { val = v; break; } }
    if (val !== null && val > 0) out[def.label] = [val, def.ev_based];
  }
  return out;
}

const ENGINE_PRIMARY_METRIC: Record<Engine, string> = { A: "EV/EBIT", B: "P/S", B2: "P/S", C: "P/TBV", D: "P/FFO", E: "EV/EBITDA", F: "EV/EBIT", G: "P/FFO" };
export const primaryMetricFor = (engine: Engine) => ENGINE_PRIMARY_METRIC[engine];

function historicalExitMultiple(engine: Engine, data: PragmaData, industry: string, sector: string, hist: Record<string, number[]>): number {
  const industryMult = exitMultiple(engine, industry, sector);
  const vals = hist[ENGINE_PRIMARY_METRIC[engine]] ?? [];
  if (vals.length < 2) return industryMult;
  return pyRound(0.7 * median(vals) + 0.3 * industryMult, 2);
}

export function weightedEbit(series: Series): number {
  const available = EBIT_WEIGHTS.map((w, i) => [w, series[i]] as const).filter(([, e]) => e !== null && e !== undefined && !Number.isNaN(e)) as [number, number][];
  if (!available.length) return 0;
  const total = pySum(available.map(([w]) => w));
  if (total === 0) return 0;
  return pySum(available.map(([w, e]) => (w / total) * e));
}
export const rdCapRate = (industry: string, sector: string) => (industry in RD_CAP_RATES ? RD_CAP_RATES[industry] : RD_CAP_SECTOR_FALLBACK[sector] ?? 0);

// ── Growth ──────────────────────────────────────────────────────────────────
function deriveGrowthRates(base: number): [number, number, number] {
  return base >= 0 ? [base * 0.7, base, base * 1.3] : [base * 1.3, base, base * 0.7];
}
export function cagrFromSeries(values: Series): number {
  const clean = values.map((v, i) => [i, v] as const).filter(([, v]) => v !== null && v > 0) as [number, number][];
  if (clean.length < 2) return 0;
  const [newestIdx, newestVal] = clean[0];
  const [oldestIdx, oldestVal] = clean[clean.length - 1];
  const years = oldestIdx - newestIdx;
  if (years <= 0 || oldestVal <= 0) return 0;
  return (newestVal / oldestVal) ** (1 / years) - 1;
}
function forwardGrowthSignal(info: PragmaData["info"], keys = ["earningsGrowth", "revenueGrowth"]): number | null {
  const vals: number[] = [];
  for (const key of keys) {
    let v = safeFloat(info, key);
    if (v === null || !Number.isFinite(v)) continue;
    if (Math.abs(v) > 2) v /= 100;
    vals.push(v);
  }
  return vals.length ? median(vals) : null;
}
function forwardEpsGrowthSignal(info: PragmaData["info"]): number | null {
  const f = safeFloat(info, "forwardEps"), t = safeFloat(info, "trailingEps", "epsTrailingTwelveMonths");
  if (f === null || t === null || f <= 0 || t <= 0) return null;
  return f / t - 1;
}
export function estimateBaseCagr(info: PragmaData["info"], series: Series, defaultGrowth = 0.03, maxGrowth = 0.25): number {
  const hasLong = series.filter((v) => v !== null && v > 0).length >= 2;
  const short = series.slice(0, 4);
  const hasShort = short.filter((v) => v !== null && v > 0).length >= 2;
  const longCagr = cagrFromSeries(series), shortCagr = cagrFromSeries(short);
  const fEps = forwardEpsGrowthSignal(info), fG = forwardGrowthSignal(info);
  const parts: [number, number][] = [];
  if (fEps !== null) {
    parts.push([fEps, 0.6]);
    if (hasLong && hasShort) { parts.push([longCagr, 0.3]); parts.push([shortCagr, 0.1]); }
    else if (hasLong) parts.push([longCagr, 0.4]);
    else if (hasShort) parts.push([shortCagr, 0.4]);
  } else {
    if (hasLong) parts.push([longCagr, 0.6]);
    if (hasShort) parts.push([shortCagr, 0.2]);
    if (fG !== null) parts.push([fG, 0.2]);
  }
  if (!parts.length) return defaultGrowth;
  const tw = pySum(parts.map(([, w]) => w));
  return Math.min(pySum(parts.map(([v, w]) => v * w)) / tw, maxGrowth);
}

function marketShareAdjustedExit(hist: number[], industryFair: number, companyRevCagr: number | null, industryRevGrowth: number | null): [number, number, number] {
  if (!hist.length) return [0, 0, 0];
  const hMean = mean(hist), hMin = Math.min(...hist), hMax = Math.max(...hist);
  const nRecent = Math.max(Math.floor(hist.length / 3), 2);
  const recent = hist.slice(0, nRecent);
  const recentMean = recent.length >= 2 ? mean(recent) : hMean;
  const compression = hMean > 0 ? recentMean / hMean : 1;
  if (companyRevCagr === null || industryRevGrowth === null) return [Math.max(hMin, 0), Math.max(hMean, 0), Math.max(hMax, 0, hMean)];
  const diff = companyRevCagr - industryRevGrowth;
  const compressing = compression < 0.85;
  let baseExit: number;
  if (diff > 0.02) baseExit = compressing ? Math.max(recentMean, industryFair) : Math.max(hMean, industryFair);
  else if (diff < -0.02) {
    const sd = hist.length > 1 ? stdSample(hist) : 0;
    const discounted = industryFair - sd;
    baseExit = compressing ? (discounted <= 0 ? recentMean : Math.min(recentMean, discounted)) : (discounted <= 0 ? hMean : Math.min(hMean, discounted));
  } else baseExit = compressing ? Math.min(recentMean, industryFair) : industryFair;
  let bear = Math.max(hMin, 0), base = baseExit;
  let bull = Math.max(hMax, baseExit);
  if (base < bear) bear = Math.max(base * 0.7, 0);
  base = Math.max(base, bear);
  bull = Math.max(bull, base);
  return [bear, base, bull];
}

export function operatingLeverageProfile(income: Statement, quarterly: Statement): [string, number] {
  if (isEmpty(income) && isEmpty(quarterly)) return ["Unavailable", 0];
  const pick = (st: Statement, n: number) => {
    let op = annualSeries(st, "Operating Income", n);
    if (op.every((v) => v === null)) op = annualSeries(st, "EBIT", n);
    if (op.every((v) => v === null)) op = annualSeries(st, "Net Income", n);
    const rev = annualSeries(st, "Total Revenue", n);
    return op.map((o, i) => [o, rev[i]] as const).filter(([o, r]) => o !== null && r !== null && r > 0).map(([o, r]) => o! / r!);
  };
  const annual = isEmpty(income) ? [] : pick(income, 5);
  let trend = "Unavailable";
  if (annual.length >= 3) {
    let sd = stdSample(annual); if (!Number.isFinite(sd)) sd = 0;
    const delta = annual[0] - annual[annual.length - 1];
    const threshold = Math.max(0.005, sd * 0.25);
    trend = delta > threshold ? "Increasing" : delta < -threshold ? "Decreasing" : "Flat";
  }
  const q = isEmpty(quarterly) ? [] : pick(quarterly, 4);
  if (q.length >= 3 && q[0] < q[1] && q[1] < q[2]) trend = "Decreasing";
  const source = annual.length >= 3 ? annual : q;
  if (source.length < 3) return [trend, 0];
  let sd = stdSample(source); if (!Number.isFinite(sd)) sd = 0;
  return [trend, Math.abs(sd)];
}

function weightedMedian(values: number[], weights: number[]): number {
  if (!values.length) return 0;
  if (!weights.length || weights.length !== values.length) return median(values);
  const total = pySum(weights);
  if (total <= 0) return median(values);
  const pairs = values.map((v, i) => [v, weights[i]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cum = 0;
  for (const [v, w] of pairs) { cum += w / total; if (cum >= 0.5) return v; }
  return pairs[pairs.length - 1][0];
}

export function projectWithReversion(base: number, growth: number, years: number, terminal = TERMINAL_GROWTH, speed = GROWTH_REVERSION_SPEED): number {
  let p = base;
  for (let y = 1; y <= years; y++) p *= 1 + (terminal + (growth - terminal) * Math.exp(-speed * (y - 1)));
  return p;
}

// ── DCF ─────────────────────────────────────────────────────────────────────
export type YearTarget = { year: number; bear_target: number; base_target: number; bull_target: number; bear_return: number; base_return: number; bull_return: number };
export type DcfResult = {
  price_targets: YearTarget[];
  intrinsic_value_bear: number; intrinsic_value_base: number; intrinsic_value_bull: number;
  mos_bear: number; mos_base: number; mos_bull: number;
  growth_rate_bear: number; growth_rate_base: number; growth_rate_bull: number;
  growth_base_input: number; growth_quality_adjustment: number; growth_base_adjusted: number;
  growth_reversion_speed: number; terminal_growth_rate: number;
  operating_leverage_trend: string; operating_margin_std: number;
  discount_rate: number; exit_multiple_used: number; exit_metric: string;
  exit_multiple_bear: number; exit_multiple_base: number; exit_multiple_bull: number;
  dcf_base_cf_y0: number; dcf_base_cf_label: string;
  dcf_skipped: boolean; dcf_skip_reason: string;
  /** Per metric, the inputs and values behind the weighted median (not in Pragma's output; used for the value build). */
  metrics: { label: string; weight: number; cf_y0: number; is_flow: boolean; net_debt: number; exits: [number, number, number]; iv: [number, number, number] }[];
};
type Scenario = [growth: number, exit: number];

function targetsFor(flow: boolean, cfY0: number, sc: Record<"bear" | "base" | "bull", Scenario>, netDebt: number, sharesIn: number, price: number, discount: number) {
  const shares = sharesIn <= 0 ? 1 : sharesIn;
  const cf0 = cfY0 <= 0 ? Math.max(cfY0, 0.01) : cfY0;
  const valueAt = (g: number, exit: number, n: number) => {
    let pvCfs = 0;
    if (flow) for (let y = 1; y <= n; y++) pvCfs += projectWithReversion(cf0, g, y) / (1 + discount) ** y;
    const tv = projectWithReversion(cf0, g, n) * exit;
    const pvTv = tv / (1 + discount) ** n;
    return Math.max((pvCfs + pvTv - netDebt) / shares, 0);
  };
  const ladder: YearTarget[] = [];
  for (let n = 1; n <= 5; n++) {
    const t: Record<string, number> = {}, r: Record<string, number> = {};
    for (const label of ["bear", "base", "bull"] as const) {
      const ps = valueAt(sc[label][0], sc[label][1], n);
      t[label] = pyRound(ps, 2);
      r[label] = price > 0 && ps > 0 ? pyRound((ps / price) ** (1 / n) - 1, 4) : 0;
    }
    ladder.push({ year: n, bear_target: t.bear, base_target: t.base, bull_target: t.bull, bear_return: r.bear, base_return: r.base, bull_return: r.bull });
  }
  const iv: Record<string, number> = {}, mos: Record<string, number> = {};
  for (const label of ["bear", "base", "bull"] as const) {
    const ps = valueAt(sc[label][0], sc[label][1], 5);
    iv[label] = pyRound(ps, 2);
    mos[label] = ps > 0 ? pyRound((ps - price) / ps, 4) : 0;
  }
  return { ladder, iv, mos };
}

export type EngineResult = {
  metric_weights: Record<string, number>; quality_growth_adj: number; fallback_score?: number;
  primary_metric: string; primary_value: number; primary_industry_pct: number;
  secondary_metric: string; secondary_value: number; quality_flags: string[]; structural_flags: string[];
  data_quality: "High" | "Medium" | "Low"; engine_note: string;
  dcf_inputs: null | { base_cf: number; cf_label: string; base_cagr: number; net_debt: number; shares: number; current_price: number; exit_metric: string; ramp?: number[]; rev_y0?: number };
};

function skippedDcf(reason: string): DcfResult {
  return {
    price_targets: [], intrinsic_value_bear: 0, intrinsic_value_base: 0, intrinsic_value_bull: 0, mos_bear: 0, mos_base: 0, mos_bull: 0,
    growth_rate_bear: 0, growth_rate_base: 0, growth_rate_bull: 0, growth_base_input: 0, growth_quality_adjustment: 0, growth_base_adjusted: 0,
    growth_reversion_speed: GROWTH_REVERSION_SPEED, terminal_growth_rate: TERMINAL_GROWTH, operating_leverage_trend: "Unavailable", operating_margin_std: 0,
    discount_rate: DISCOUNT_RATE, exit_multiple_used: 0, exit_metric: "N/A", exit_multiple_bear: 0, exit_multiple_base: 0, exit_multiple_bull: 0,
    dcf_base_cf_y0: 0, dcf_base_cf_label: "N/A", dcf_skipped: true, dcf_skip_reason: reason, metrics: [],
  };
}

export function computeDcf(engine: Engine, data: PragmaData, er: EngineResult, industry: string, sector: string, cisAdj = 1): DcfResult {
  const inputs = er.dcf_inputs;
  if (!inputs) return skippedDcf("No DCF inputs — engine skipped DCF");
  try {
    const baseCagr = inputs.base_cagr, netDebt = inputs.net_debt, price = inputs.current_price;
    let shares = inputs.shares;
    if (!isEmpty(data.income)) for (const label of ["Diluted Average Shares", "Basic Average Shares"]) {
      if (hasRow(data.income, label)) { const v = firstCell(data.income, label); if (v !== null && v > 0) { shares = v; break; } }
    }
    const discount = clamp(DISCOUNT_RATE + (1 - cisAdj) * 0.04, 0.06, 0.16);
    const [trend, marginStd] = operatingLeverageProfile(data.income, data.income_quarterly);
    const qAdj = er.quality_growth_adj;
    const adjusted = baseCagr + qAdj;
    const growth = deriveGrowthRates(adjusted);
    let bearG = growth[0];
    const baseG = growth[1], bullG = growth[2];
    if (trend === "Decreasing") bearG -= marginStd;
    const companyRevCagr = isEmpty(data.income) ? null : cagrFromSeries(annualSeries(data.income, "Total Revenue", 4));
    const industryRevGrowth: number | null = null; // peer universe not fetched (see module comment)
    const hist = historicalMultiples(data).values;
    const current = currentMetricValues(data);
    const weights = er.metric_weights ?? {};
    const hasWeights = Object.keys(weights).length > 0;
    const bears: number[] = [], bases: number[] = [], bulls: number[] = [], ws: number[] = [];
    const results: { label: string; exitBase: number; ladder: YearTarget[]; iv: Record<string, number>; mos: Record<string, number>; exits: [number, number, number] }[] = [];
    const metrics: DcfResult["metrics"] = [];
    for (const def of METRIC_DEFS) {
      const label = def.label;
      if (!(label in current)) continue;
      const w = label in weights ? weights[label] : hasWeights ? 0 : 1;
      if (w <= 0) continue;
      const [cfY0, evBased] = current[label];
      const effNetDebt = evBased ? netDebt : 0;
      const hv = hist[label] ?? [];
      if (hv.length < 2) continue;
      const exits = marketShareAdjustedExit(hv, exitMultiple(engine, industry, sector), companyRevCagr, industryRevGrowth);
      const { ladder, iv, mos } = targetsFor(def.is_flow, cfY0, { bear: [bearG, exits[0]], base: [baseG, exits[1]], bull: [bullG, exits[2]] }, effNetDebt, shares, price, discount);
      if (iv.base > 0) {
        bears.push(iv.bear); bases.push(iv.base); bulls.push(iv.bull); ws.push(w);
        results.push({ label, exitBase: exits[1], ladder, iv, mos, exits });
        metrics.push({ label, weight: w, cf_y0: cfY0, is_flow: def.is_flow, net_debt: effNetDebt, exits, iv: [iv.bear, iv.base, iv.bull] });
      }
    }
    const common = {
      growth_rate_bear: pyRound(bearG, 4), growth_rate_base: pyRound(baseG, 4), growth_rate_bull: pyRound(bullG, 4),
      growth_base_input: pyRound(baseCagr, 4), growth_quality_adjustment: pyRound(qAdj, 4), growth_base_adjusted: pyRound(adjusted, 4),
      growth_reversion_speed: GROWTH_REVERSION_SPEED, terminal_growth_rate: TERMINAL_GROWTH,
      operating_leverage_trend: trend, operating_margin_std: pyRound(marginStd, 4), discount_rate: pyRound(discount, 4),
      dcf_skipped: false, dcf_skip_reason: "",
    };
    if (!bases.length) {
      let cf = inputs.base_cf;
      if (cf <= 0) cf = Math.max(cf, 0.01);
      const fallbackExit = historicalExitMultiple(engine, data, industry, sector, hist);
      const hv = hist[inputs.exit_metric] ?? [];
      const exits: [number, number, number] = hv.length >= 2
        ? marketShareAdjustedExit(hv, exitMultiple(engine, industry, sector), companyRevCagr, industryRevGrowth)
        : [fallbackExit, fallbackExit, fallbackExit];
      const { ladder, iv, mos } = targetsFor(true, cf, { bear: [bearG, exits[0]], base: [baseG, exits[1]], bull: [bullG, exits[2]] }, netDebt, shares, price, discount);
      return {
        ...common, price_targets: ladder,
        intrinsic_value_bear: iv.bear, intrinsic_value_base: iv.base, intrinsic_value_bull: iv.bull,
        mos_bear: mos.bear, mos_base: mos.base, mos_bull: mos.bull,
        exit_multiple_used: exits[1], exit_multiple_bear: exits[0], exit_multiple_base: exits[1], exit_multiple_bull: exits[2],
        exit_metric: inputs.exit_metric, dcf_base_cf_y0: pyRound(cf, 2), dcf_base_cf_label: inputs.cf_label,
        metrics: [{ label: inputs.exit_metric, weight: 1, cf_y0: cf, is_flow: true, net_debt: netDebt, exits, iv: [iv.bear, iv.base, iv.bull] }],
      };
    }
    const mBear = weightedMedian(bears, ws), mBase = weightedMedian(bases, ws), mBull = weightedMedian(bulls, ws);
    const mos = (v: number) => (v > 0 ? pyRound((v - price) / v, 4) : 0);
    const best = results.reduce((a, b) => (Math.abs(b.iv.base - mBase) < Math.abs(a.iv.base - mBase) ? b : a));
    const labels = results.map((r) => r.label).join(", ");
    return {
      ...common, price_targets: best.ladder,
      intrinsic_value_bear: pyRound(mBear, 2), intrinsic_value_base: pyRound(mBase, 2), intrinsic_value_bull: pyRound(mBull, 2),
      mos_bear: mos(mBear), mos_base: mos(mBase), mos_bull: mos(mBull),
      exit_multiple_used: best.exitBase, exit_multiple_bear: best.exits[0], exit_multiple_base: best.exits[1], exit_multiple_bull: best.exits[2],
      exit_metric: `Median of ${results.length} metrics (${labels})`,
      dcf_base_cf_y0: pyRound(mBase, 2), dcf_base_cf_label: `${results.length}-metric consensus (ladder: ${best.label})`,
      metrics,
    };
  } catch (error) {
    return skippedDcf(`DCF computation error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
