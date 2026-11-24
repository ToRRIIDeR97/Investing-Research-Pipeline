/**
 * PragValue engine router and engines A–G (+B2), ported from pulsevalue.py `_route_engine` and `_run_engine_*`.
 * See model.ts for the data shape and the known differences from Pragma.
 */
import {
  annualSeries, clamp, currentFfoProxy, estimateBaseCagr, pyRound, rdCapRate, safeFloat, weightedEbit,
  type Engine, type EngineResult, type PragmaData,
} from "./model";

const or = (v: number | null, d: number) => (v ? v : d);

/** _route_engine */
export function routeEngine(sector: string, industry: string, ebitTtm: number | null, revenueTtm: number | null, companyName: string | null = null): Engine {
  const ind = (industry || "").toLowerCase(), sec = (sector || "").toLowerCase(), company = (companyName || "").toLowerCase();
  const isFinancialSector = sec === "financial services" || sec === "financials";
  const isBankOrInsurance = ind.includes("bank") || ind.includes("insurance");
  const isCapitalMarketsLike = ["capital markets", "asset management", "investment", "broker", "exchange", "financial data"].some((t) => ind.includes(t));
  const isNamedAssetOwner = ["brookfield", "berkshire"].some((t) => company.includes(t));
  const isAssetOwnerIndustry = ["asset management", "conglomerate", "holding", "financial conglomerate"].some((t) => ind.includes(t));
  const isDiversifiedInsurer = ind.includes("insurance") && ind.includes("diversified");
  if (isNamedAssetOwner && sec !== "energy" && sec !== "real estate") return "G";
  if (isFinancialSector && isDiversifiedInsurer) return "G";
  if (isFinancialSector && isAssetOwnerIndustry && !isBankOrInsurance) return "G";
  if (isBankOrInsurance) return "C";
  if (isFinancialSector && !isCapitalMarketsLike) return "C";
  if (isCapitalMarketsLike) {
    const ebit = ebitTtm || 0, rev = revenueTtm || 0;
    return ebit < 0 || rev < 50_000_000 ? "B" : "C";
  }
  if (ind.includes("reit") || sec === "real estate") return "D";
  if (sec === "utilities") return "E";
  if (sec === "energy") return "F";
  if (sec === "basic materials" && (ind.includes("mining") || ind.includes("metal"))) return "F";
  if (ind.includes("biotech")) {
    const rev = revenueTtm || 0, ebit = ebitTtm || 0;
    if (rev < 50_000_000 || ebit < 0) return "B2";
  }
  if (ebitTtm !== null && ebitTtm < 0) return "B";
  if (ebitTtm === null && sec === "technology") return "B";
  return "A";
}

const fmt1 = (x: number) => x.toFixed(1);

function capexY0(data: PragmaData): number {
  const v = data.cashflow.rows["Capital Expenditure"]?.[0];
  return typeof v === "number" && Number.isFinite(v) ? Math.abs(v) : 0;
}
function divYield(info: PragmaData["info"]): number {
  let d = or(safeFloat(info, "dividendYield"), 0);
  if (d > 1) d /= 100;
  return d;
}

export function engineA(data: PragmaData, sector: string, industry: string): EngineResult {
  const { income, info } = data;
  const ebit = annualSeries(income, "EBIT", 5), rd = annualSeries(income, "Research Development", 5);
  const cap = rdCapRate(industry, sector);
  const flags: string[] = [], qf: string[] = [];
  let dq: EngineResult["data_quality"] = "High";
  const adj = ebit.map((e, i) => (e !== null ? e + (rd[i] ?? 0) * cap : null));
  const years = adj.filter((e) => e !== null).length;
  if (years < 3) { dq = "Low"; flags.push("Fewer than 3 years of EBIT history"); }
  if (cap > 0 && rd.every((r) => r === null || r === 0)) {
    // Pragma: `min(dq, "Medium") if dq == "High"` compares strings, so "High" stays "High". Kept for parity.
    flags.push("R&D spend unavailable — no capitalisation applied");
  }
  let norm = weightedEbit(adj);
  if (norm === 0) norm = ebit[0] ?? 0;
  const mcap = or(safeFloat(info, "marketCap"), 0), debt = or(safeFloat(info, "totalDebt"), 0), cash = or(safeFloat(info, "totalCash"), 0);
  let ev = mcap + debt - cash;
  if (ev <= 0) ev = mcap || 1;
  const yieldCore = ev > 0 ? norm / ev : 0;
  const shares = or(safeFloat(info, "sharesOutstanding"), 1);
  const price = or(safeFloat(info, "currentPrice", "regularMarketPrice"), 0);
  let qm = 0;
  if (adj[0] !== null && adj[2] !== null) {
    const rev = annualSeries(income, "Total Revenue", 5);
    if (rev[0] && rev[0] > 0 && rev[2] && rev[2] > 0) {
      const diff = (adj[0] / rev[0] - adj[2] / rev[2]) * 10000;
      if (diff > 200) { qm += 0.1; qf.push("Margin improving >200bps"); }
      else if (diff < -200) { qm -= 0.1; qf.push("Margin declining >200bps"); }
    }
  }
  const fcf = or(safeFloat(info, "freeCashflow"), 0);
  if (norm > 0) {
    const conv = fcf / norm;
    if (conv > 0.85) { qm += 0.1; qf.push("Strong FCF conversion >85%"); }
    else if (conv < 0.6) { qm -= 0.15; qf.push("Weak FCF conversion <60%"); }
    const lev = (debt - cash) / norm;
    if (lev < 1) { qm += 0.1; qf.push("Low leverage <1x"); }
    else if (lev > 5) { qm -= 0.2; qf.push("High leverage >5x"); }
    else if (lev > 3.5) { qm -= 0.1; qf.push("Elevated leverage >3.5x"); }
  }
  const qAdj = clamp(qm * 0.1, -0.03, 0.03);
  return {
    metric_weights: { "EV/EBIT": 0.3, "P/E": 0.2, "P/FCF": 0.2, "EV/EBITDA": 0.15, "P/OCF": 0.1, "P/S": 0.05 },
    quality_growth_adj: pyRound(qAdj, 4),
    primary_metric: cap === 0 ? "EBIT/EV" : "Adj EBIT/EV", primary_value: pyRound(yieldCore * 100, 2), primary_industry_pct: 50,
    secondary_metric: "FCF Conversion", secondary_value: pyRound(norm > 0 ? (fcf / norm) * 100 : 0, 1),
    quality_flags: qf, structural_flags: flags, data_quality: dq,
    engine_note: `Engine A — Normalised EBIT/EV with ${years}-year weighted average${cap > 0 ? ` and ${Math.trunc(cap * 100)}% R&D capitalisation` : ""}`,
    dcf_inputs: { base_cf: norm, cf_label: "EBIT", base_cagr: estimateBaseCagr(info, adj, 0.04), net_debt: debt - cash, shares, current_price: price, exit_metric: "EV/EBIT" },
  };
}

export function engineB(data: PragmaData): EngineResult {
  const { income, info } = data;
  const flags: string[] = [], qf: string[] = [];
  let dq: EngineResult["data_quality"] = "High";
  const revTtm = or(safeFloat(info, "totalRevenue"), 0), mcap = or(safeFloat(info, "marketCap"), 0);
  const debt = or(safeFloat(info, "totalDebt"), 0), cash = or(safeFloat(info, "totalCash"), 0);
  let ev = mcap + debt - cash;
  if (ev <= 0) ev = mcap || 1;
  const evRev = revTtm > 0 ? ev / revTtm : 0;
  const rev = annualSeries(income, "Total Revenue", 5);
  const y0 = rev[0] || revTtm, y3 = rev.length > 3 ? rev[3] : null;
  let cagr = 0;
  if (y0 && y3 && y3 > 0 && y0 > 0) cagr = (y0 / y3) ** (1 / 3) - 1;
  else { dq = "Medium"; flags.push("Revenue CAGR unavailable — insufficient history"); }
  const ocf = or(safeFloat(info, "operatingCashflow"), 0);
  const fcfMargin = revTtm > 0 ? (ocf - capexY0(data)) / revTtm : 0;
  const rule40 = (cagr ? cagr * 100 : 0) + fcfMargin * 100;
  const gp = or(safeFloat(info, "grossProfits"), 0);
  const gm = revTtm > 0 ? gp / revTtm : 0;
  let qAdj = 0;
  if (cash > 0 && ocf < 0) {
    const burn = Math.abs(ocf) / 4;
    if (burn > 0 && cash / burn < 6) { qAdj -= 0.03; qf.push("Liquidity Risk — <6 quarters cash runway"); }
  }
  if (gm < 0.4) { qAdj -= 0.02; qf.push("Low Margin Structure — Gross margin <40%"); }
  qAdj = clamp(qAdj, -0.03, 0.03);
  return {
    metric_weights: { "P/S": 0.3, "P/GP": 0.25, "EV/EBITDA": 0.15, "P/FCF": 0.15, "P/OCF": 0.1, "EV/EBIT": 0.05 },
    quality_growth_adj: pyRound(qAdj, 4),
    primary_metric: "EV/Revenue", primary_value: pyRound(evRev, 2), primary_industry_pct: 50,
    secondary_metric: "Rule of 40", secondary_value: pyRound(rule40, 1),
    quality_flags: qf, structural_flags: flags, data_quality: dq,
    engine_note: `Engine B — Revenue + Growth composite (EV/Rev: ${fmt1(evRev)}x, Rule of 40: ${rule40.toFixed(0)})`,
    dcf_inputs: {
      base_cf: gp > 0 ? gp : Math.max(gp, 1), cf_label: "Gross Profit (ramped FCF)", base_cagr: estimateBaseCagr(info, rev, 0.1),
      net_debt: debt - cash, shares: or(safeFloat(info, "sharesOutstanding"), 1), current_price: or(safeFloat(info, "currentPrice", "regularMarketPrice"), 0),
      exit_metric: "EV/Revenue", ramp: [0.2, 0.4, 0.6, 0.8, 1], rev_y0: revTtm,
    },
  };
}

export function engineB2(data: PragmaData): EngineResult {
  const { info } = data;
  const flags = ["Pipeline phase unknown — default score applied"], qf: string[] = [];
  const mcap = or(safeFloat(info, "marketCap"), 0), cash = or(safeFloat(info, "totalCash"), 0), debt = or(safeFloat(info, "totalDebt"), 0);
  const netCash = cash - debt, ocf = or(safeFloat(info, "operatingCashflow"), 0);
  let runway = 0;
  if (ocf < 0) { const burn = Math.abs(ocf) / 4; if (burn > 0) runway = cash / burn; } else runway = 99;
  const cashFactor = Math.min(runway / 8, 1);
  if (runway < 4) qf.push("Critical liquidity — <4 quarters cash runway");
  else if (runway < 6) qf.push("Limited runway — <6 quarters");
  const premium = mcap > 0 ? (mcap - netCash) / mcap : 1;
  const raw = premium <= 0 ? 3 : clamp(0.3 * cashFactor * (1 / Math.max(premium, 0.1)) - 1, -3, 3);
  return {
    metric_weights: {}, quality_growth_adj: 0, fallback_score: pyRound(raw, 3),
    primary_metric: "EV/Cash Premium", primary_value: pyRound(premium * 100, 1), primary_industry_pct: 50,
    secondary_metric: "Cash Runway (Quarters)", secondary_value: pyRound(runway, 1),
    quality_flags: qf, structural_flags: flags, data_quality: "Low",
    engine_note: "Engine B2 — Speculative Pipeline. Score relative to pre-revenue biotech peers only.",
    dcf_inputs: null,
  };
}

export function engineC(data: PragmaData, industry: string): EngineResult {
  const { info } = data;
  const insurance = (industry || "").toLowerCase().includes("insurance");
  const price = or(safeFloat(info, "currentPrice", "regularMarketPrice"), 0), shares = or(safeFloat(info, "sharesOutstanding"), 0);
  const book = or(safeFloat(info, "bookValue"), 0);
  const pTbv = book > 0 ? price / book : 0;
  const roe = or(safeFloat(info, "returnOnEquity"), 0);
  let note: string, secMetric: string, secValue: number;
  if (insurance) {
    note = `Engine C2 — Insurance. P/TBV: ${pTbv.toFixed(2)}x, ROE: ${fmt1(roe * 100)}%`; secMetric = "ROE"; secValue = pyRound(roe * 100, 1);
  } else {
    const beta = or(safeFloat(info, "beta"), 1);
    const coe = 0.045 + beta * 0.055;
    note = `Engine C1 — Bank/Financial. P/TBV: ${pTbv.toFixed(2)}x, ROE: ${fmt1(roe * 100)}%, COE: ${fmt1(coe * 100)}%`;
    secMetric = "ROE-COE Spread"; secValue = pyRound((roe - coe) * 100, 1);
  }
  const qAdj = clamp((roe - 0.1) * 0.15, -0.03, 0.03);
  const ni = or(safeFloat(info, "netIncomeToCommon"), 0);
  const dy = divYield(info);
  const niPs = shares > 0 ? ni / shares : 0.01;
  let payout = niPs > 0 ? (dy * price) / Math.max(niPs, 0.01) : 0.4;
  payout = clamp(payout, 0, 0.95);
  let cagr = roe * (1 - payout);
  const fEps = (() => { const f = safeFloat(info, "forwardEps"), t = safeFloat(info, "trailingEps", "epsTrailingTwelveMonths"); return f !== null && t !== null && f > 0 && t > 0 ? f / t - 1 : null; })();
  if (fEps !== null) cagr = 0.4 * cagr + 0.6 * fEps;
  else {
    const vals = ["earningsGrowth", "revenueGrowth"].map((k) => safeFloat(info, k)).filter((v): v is number => v !== null).map((v) => (Math.abs(v) > 2 ? v / 100 : v));
    if (vals.length) { const s = [...vals].sort((a, b) => a - b); const g = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; cagr = 0.75 * cagr + 0.25 * g; }
  }
  const cfY0 = ni > 0 ? ni : Math.max(book * shares * roe, 1);
  return {
    metric_weights: { "P/TBV": 0.35, "P/B": 0.25, "P/E": 0.3, "P/OCF": 0.1 },
    quality_growth_adj: pyRound(qAdj, 4),
    primary_metric: "P/Tangible Book", primary_value: pyRound(pTbv, 2), primary_industry_pct: 50,
    secondary_metric: secMetric, secondary_value: secValue, quality_flags: [], structural_flags: [], data_quality: "High", engine_note: note,
    dcf_inputs: { base_cf: cfY0, cf_label: "Net Income (ROE x Book)", base_cagr: cagr, net_debt: 0, shares, current_price: price, exit_metric: "P/TBV" },
  };
}

export function engineD(data: PragmaData): EngineResult {
  const { income, cashflow, info } = data;
  const flags: string[] = [], qf: string[] = [];
  let dq: EngineResult["data_quality"] = "High";
  const price = or(safeFloat(info, "currentPrice", "regularMarketPrice"), 0), shares = or(safeFloat(info, "sharesOutstanding"), 1);
  const ni = or(safeFloat(info, "netIncomeToCommon"), 0);
  let da = 0;
  if (cashflow.periods.length && "Depreciation And Amortization" in cashflow.rows) { const v = cashflow.rows["Depreciation And Amortization"][0]; if (typeof v === "number" && Number.isFinite(v)) da = v; }
  else if (income.periods.length && "Depreciation And Amortization" in income.rows) { const v = income.rows["Depreciation And Amortization"][0]; if (typeof v === "number" && Number.isFinite(v)) da = v; }
  const ffo = ni + da, ffoPs = shares > 0 ? ffo / shares : 0;
  if (da === 0) { dq = "Medium"; flags.push("FFO Estimated — D&A unavailable"); }
  const pFfo = ffoPs > 0 ? price / ffoPs : 0;
  const dy = divYield(info);
  const debt = or(safeFloat(info, "totalDebt"), 0), ebitda = or(safeFloat(info, "ebitda"), 1);
  const lev = ebitda > 0 ? debt / ebitda : 0;
  let qAdj = 0;
  if (lev > 6) { qAdj = -0.02; qf.push(`High REIT leverage: ${fmt1(lev)}x Debt/EBITDA`); } else if (lev < 3) qAdj = 0.01;
  let affo = ffo - da * 0.1;
  if (affo <= 0) affo = Math.max(affo, 1);
  return {
    metric_weights: { "P/FFO": 0.35, "P/OCF": 0.25, "P/FCF": 0.2, "P/B": 0.1, "EV/EBITDA": 0.1 },
    quality_growth_adj: pyRound(qAdj, 4),
    primary_metric: "P/FFO", primary_value: pyRound(pFfo, 2), primary_industry_pct: 50,
    secondary_metric: "Dividend Yield", secondary_value: pyRound(dy * 100, 1), quality_flags: qf, structural_flags: flags, data_quality: dq,
    engine_note: `Engine D — REIT. P/FFO: ${fmt1(pFfo)}x, Div Yield: ${fmt1(dy * 100)}%`,
    dcf_inputs: {
      base_cf: affo, cf_label: "AFFO", base_cagr: estimateBaseCagr(info, annualSeries(income, "Net Income", 5), 0.03),
      net_debt: debt - or(safeFloat(info, "totalCash"), 0), shares, current_price: price, exit_metric: "P/AFFO",
    },
  };
}

export function engineG(data: PragmaData): EngineResult {
  const { income, cashflow, info } = data;
  const flags: string[] = [], qf: string[] = [];
  let dq: EngineResult["data_quality"] = "High";
  const price = or(safeFloat(info, "currentPrice", "regularMarketPrice"), 0), shares = or(safeFloat(info, "sharesOutstanding"), 1);
  const debt = or(safeFloat(info, "totalDebt"), 0), cash = or(safeFloat(info, "totalCash"), 0), netDebt = debt - cash;
  let ffo = currentFfoProxy(data);
  if (ffo === null || ffo <= 0) { dq = "Low"; flags.push("FFO unavailable — fallback to OCF"); ffo = or(safeFloat(info, "operatingCashflow"), 0); }
  if (ffo <= 0) { dq = "Low"; flags.push("OCF unavailable — fallback to net income proxy"); let ni = or(safeFloat(info, "netIncomeToCommon"), 0); if (ni <= 0) ni = 1; ffo = ni; }
  const ffoPs = shares > 0 ? ffo / shares : 0, pFfo = ffoPs > 0 ? price / ffoPs : 0;
  const ndFfo = ffo > 0 ? netDebt / ffo : 0;
  let qAdj = 0;
  if (ndFfo > 5) { qAdj -= 0.02; qf.push(`High leverage vs FFO: ${fmt1(ndFfo)}x`); } else if (ndFfo < 2) qAdj += 0.01;
  const ocf = or(safeFloat(info, "operatingCashflow"), 0), ni = or(safeFloat(info, "netIncomeToCommon"), 0);
  if (ni > 0 && ocf > 0) {
    const conv = ocf / ni;
    if (conv < 0.8) { qAdj -= 0.01; qf.push("Weak cash conversion vs net income"); } else if (conv > 1.2) qAdj += 0.01;
  }
  qAdj = clamp(qAdj, -0.03, 0.03);
  let series = annualSeries(cashflow, "Operating Cash Flow", 5);
  if (series.every((v) => v === null)) series = annualSeries(income, "Net Income", 5);
  return {
    metric_weights: { "P/FFO": 0.4, "P/OCF": 0.25, "P/FCF": 0.15, "P/B": 0.1, "P/TBV": 0.1 },
    quality_growth_adj: pyRound(qAdj, 4),
    primary_metric: "P/FFO", primary_value: pyRound(pFfo, 2), primary_industry_pct: 50,
    secondary_metric: "Net Debt / FFO", secondary_value: pyRound(ndFfo, 2), quality_flags: qf, structural_flags: flags, data_quality: dq,
    engine_note: `Engine G — Asset Owner (FFO-led). P/FFO: ${fmt1(pFfo)}x, Net Debt/FFO: ${fmt1(ndFfo)}x`,
    dcf_inputs: { base_cf: ffo, cf_label: "FFO (asset-owner proxy)", base_cagr: estimateBaseCagr(info, series, 0.04), net_debt: netDebt, shares, current_price: price, exit_metric: "P/FFO" },
  };
}

export function engineE(data: PragmaData): EngineResult {
  const { income, info } = data;
  const qf: string[] = [];
  const mcap = or(safeFloat(info, "marketCap"), 0), debt = or(safeFloat(info, "totalDebt"), 0), cash = or(safeFloat(info, "totalCash"), 0);
  const ev = mcap + debt - cash, ebitda = or(safeFloat(info, "ebitda"), 0);
  const evEbitda = ebitda > 0 ? ev / ebitda : 0;
  const dy = divYield(info);
  let ebit = or(safeFloat(info, "ebit"), 0);
  const e0 = income.rows["EBIT"]?.[0];
  if (income.periods.length && "EBIT" in income.rows && typeof e0 === "number" && Number.isFinite(e0)) ebit = e0;
  let interest = 0;
  const i0 = income.rows["Interest Expense"]?.[0];
  if (income.periods.length && "Interest Expense" in income.rows && typeof i0 === "number" && Number.isFinite(i0)) interest = Math.abs(i0);
  const cover = interest > 0 ? ebit / interest : 10;
  let qAdj = 0;
  if (cover < 2) { qAdj = -0.02; qf.push(`Weak interest coverage: ${fmt1(cover)}x`); } else if (cover > 5) qAdj = 0.01;
  const tax = clamp(or(safeFloat(info, "effectiveTaxRate"), 0.21), 0, 0.4);
  let cf = (ebitda - capexY0(data) * 0.6) * (1 - tax);
  if (cf <= 0) cf = Math.max(cf, 1);
  let series = annualSeries(income, "EBITDA", 5);
  if (series.every((v) => v === null)) series = annualSeries(income, "EBIT", 5);
  return {
    metric_weights: { "EV/EBITDA": 0.35, "P/E": 0.25, "P/OCF": 0.2, "P/FCF": 0.1, "P/B": 0.1 },
    quality_growth_adj: pyRound(qAdj, 4),
    primary_metric: "EV/EBITDA", primary_value: pyRound(evEbitda, 2), primary_industry_pct: 50,
    secondary_metric: "Dividend Yield", secondary_value: pyRound(dy * 100, 1), quality_flags: qf, structural_flags: [], data_quality: "High",
    engine_note: `Engine E — Utility. EV/EBITDA: ${fmt1(evEbitda)}x, Interest Coverage: ${fmt1(cover)}x`,
    dcf_inputs: {
      base_cf: cf, cf_label: "EBITDA - Maint Capex - Tax", base_cagr: estimateBaseCagr(info, series, 0.03), net_debt: debt - cash,
      shares: or(safeFloat(info, "sharesOutstanding"), 1), current_price: or(safeFloat(info, "currentPrice", "regularMarketPrice"), 0), exit_metric: "EV/EBITDA",
    },
  };
}

export function engineF(data: PragmaData): EngineResult {
  const { income, info } = data;
  const flags: string[] = [];
  let dq: EngineResult["data_quality"] = "High";
  const mcap = or(safeFloat(info, "marketCap"), 0), debt = or(safeFloat(info, "totalDebt"), 0), cash = or(safeFloat(info, "totalCash"), 0);
  let ev = mcap + debt - cash;
  if (ev <= 0) ev = mcap || 1;
  const ebit = annualSeries(income, "EBIT", 5);
  const years = ebit.filter((e) => e !== null).length;
  if (years < 3) { dq = "Low"; flags.push("Fewer than 3 years of EBIT — mid-cycle unreliable"); }
  let norm = weightedEbit(ebit);
  if (norm === 0) norm = ebit[0] ?? 0;
  const core = ev > 0 ? norm / ev : 0;
  const fcf = or(safeFloat(info, "freeCashflow"), 0), fcfYield = mcap > 0 ? fcf / mcap : 0;
  const qAdj = fcfYield > 0.1 ? 0.02 : fcfYield < 0.03 ? -0.02 : 0;
  return {
    metric_weights: { "EV/EBIT": 0.3, "P/FCF": 0.25, "EV/EBITDA": 0.2, "P/OCF": 0.15, "P/S": 0.1 },
    quality_growth_adj: pyRound(qAdj, 4),
    primary_metric: "Mid-Cycle EBIT/EV", primary_value: pyRound(core * 100, 2), primary_industry_pct: 50,
    secondary_metric: "FCF Yield", secondary_value: pyRound(fcfYield * 100, 1), quality_flags: [], structural_flags: flags, data_quality: dq,
    engine_note: `Engine F — Mid-cycle normalised (${years}yr weighted). Core yield: ${fmt1(core * 100)}%, FCF yield: ${fmt1(fcfYield * 100)}%`,
    dcf_inputs: {
      base_cf: norm, cf_label: "Mid-Cycle EBIT", base_cagr: estimateBaseCagr(info, annualSeries(income, "Total Revenue", 5), 0.02),
      net_debt: debt - cash, shares: or(safeFloat(info, "sharesOutstanding"), 1), current_price: or(safeFloat(info, "currentPrice", "regularMarketPrice"), 0),
      exit_metric: "EV/EBIT (mid-cycle)",
    },
  };
}

export function runEngine(engine: Engine, data: PragmaData, sector: string, industry: string): EngineResult {
  switch (engine) {
    case "A": return engineA(data, sector, industry);
    case "B": return engineB(data);
    case "B2": return engineB2(data);
    case "C": return engineC(data, industry);
    case "D": return engineD(data);
    case "E": return engineE(data);
    case "F": return engineF(data);
    case "G": return engineG(data);
  }
}
