/**
 * report_facts: valuation and market figures computed by code from the stored schedules and the financial
 * analytics pack, so report writers cite them instead of deriving them in prose. Schedules and the pack are
 * both in currency millions; per-share values are currency per share.
 */
import { calculateValuationSchedule, type ValuationMethodInput } from "../valuation/schedules";
import { withheldValuationReason } from "../valuation/contracts";
import { FinancialAnalytics, tableRows, type AnalyticsTable } from "../history/analytics";

type Row = Record<string, any>;
type Num = number | null;
const CASES = ["bear", "base", "bull"] as const;
const r4 = (v: Num) => v === null || !Number.isFinite(v) ? null : Number(v.toFixed(4));
const r2 = (v: Num) => v === null || !Number.isFinite(v) ? null : Number(v.toFixed(2));
const latestContent = (artifacts: Row[], type: string) => artifacts.filter((a) => a.artifact_type === type)
  .sort((a, b) => Number(b.artifact_version ?? 0) - Number(a.artifact_version ?? 0))[0]?.content_json ?? null;

export const REPORT_FACT_DEFINITIONS: Record<string, string> = {
  pv_per_share: "Today's value per share: explicit-year cash flows and the terminal value discounted to today, plus the equity bridge, over diluted shares",
  return_to_pv: "PV per share ÷ market price − 1 (not annualized)",
  terminal_price_target: "Undiscounted value per share at the end of the terminal year (the scenario anchor)",
  undiscounted_return_to_terminal: "Terminal price target ÷ market price − 1, cumulative and undiscounted",
  tv_share_of_ev: "Present value of the terminal value alone (after any fade years) ÷ enterprise value",
  value_beyond_explicit_share: "Present value of everything after the explicit forecast (fade years and terminal value) ÷ enterprise value; information, not a gate",
  explicit_cash_flow_sum: "Sum of the explicit-year cash flows, undiscounted (currency millions); fade years excluded",
  no_rerating_return: "Return to the terminal year if EV/NOPAT stays at today's level: (today's EV/NOPAT × terminal-year NOPAT + equity bridge + explicit cash flows) ÷ diluted shares ÷ market price − 1",
  no_rerating_return_annualized: "no_rerating_return compounded per explicit year",
  weighted_pv_per_share: "Probability-weighted PV per share over bear, base and bull",
  fcf_yield: "TTM free cash flow ÷ market cap at the market price",
  fcf_ex_sbc_yield: "(TTM free cash flow − TTM stock-based compensation) ÷ market cap",
  ev_to_nopat_ttm: "(Market price × diluted shares − equity bridge) ÷ TTM NOPAT at the normalized tax rate",
  ev_to_nopat_next: "The same enterprise value ÷ the base case's first forecast-year NOPAT",
};

/** The facts writers cite; withheld valuations give only the market block. Null when nothing is stored. */
export function buildReportFacts(artifacts: Row[]) {
  const valuation = latestContent(artifacts, "valuation_scenario_set");
  const parsed = FinancialAnalytics.safeParse(latestContent(artifacts, "financial_analytics"));
  const pack = parsed.success ? parsed.data : null;
  if (!valuation && !pack) return null;
  const withheld = valuation ? withheldValuationReason(valuation) : null;
  const price = Number(valuation?.current_market_price) > 0 ? Number(valuation.current_market_price) : null;
  const schedules: ValuationMethodInput[] = Array.isArray(valuation?.method_inputs) ? valuation.method_inputs : [];
  const schedule = (type: string) => schedules.find((s) => s.scenario_type === type && s.method === "fcff") ?? schedules.find((s) => s.scenario_type === type);
  const latest = (table: AnalyticsTable) => tableRows(table).at(-1) ?? {};
  const cash = pack ? latest(pack.cash_conversion.quarterly) : {}, capital = pack ? latest(pack.capital_allocation.quarterly) : {};
  const nopatTtm = typeof cash.nopat_ttm === "number" ? cash.nopat_ttm : null;
  const fcfTtm = typeof cash.fcf_ttm === "number" ? cash.fcf_ttm : null;
  const sbcTtm = typeof capital.sbc_ttm === "number" ? capital.sbc_ttm : null;

  const base = schedule("base");
  const shares = base?.diluted_shares ?? null, bridge = base?.equity_bridge ?? null;
  const marketCap = price !== null && shares !== null ? price * shares : null;
  const ev = marketCap !== null && bridge !== null ? marketCap - bridge : null;
  const multiple = ev !== null && nopatTtm !== null && nopatTtm > 0 ? ev / nopatTtm : null;
  const firstNopat = base?.years?.[0]?.build?.starting_profit ?? null;

  const unrounded = new Map<string, number>();
  const cases = withheld ? [] : CASES.flatMap((type) => {
    const s = schedule(type);
    if (!s) return [];
    let calc: ReturnType<typeof calculateValuationSchedule>;
    try { calc = calculateValuationSchedule(s); } catch { return []; }
    // Fade years (valuation v2) are valued but are not part of the explicit forecast.
    const explicitYears = calc.years.filter((y) => !y.fade);
    const explicitPv = explicitYears.reduce((n, y) => n + y.present_value, 0);
    const enterprise = calc.years.reduce((n, y) => n + y.present_value, 0) + calc.terminal_present_value;
    const explicit = explicitYears.reduce((n, y) => n + ((y as { counted_cash_flow?: number }).counted_cash_flow ?? y.cash_flow), 0);
    const lastNopat = explicitYears.at(-1)?.build?.starting_profit ?? null;
    // The valuation stage's own no-rerating figure wins when it computed one.
    const staged = valuation?.cross_checks?.no_rerating?.[type]?.return;
    const noRerating = typeof staged === "number" ? staged : price !== null && multiple !== null && lastNopat !== null
      ? (multiple * lastNopat + calc.equity_bridge + explicit) / calc.diluted_shares / price - 1 : null;
    const anchor = Number(valuation?.[`terminal_anchor_${type}`]);
    unrounded.set(type, calc.value_per_share);
    return [{
      case: type, probability: r4(Number.isFinite(Number(valuation?.[`probability_${type}`])) ? Number(valuation[`probability_${type}`]) : null),
      method: s.method, discount_rate: s.discount_rate,
      terminal: s.terminal.type === "multiple" ? `${s.terminal.multiple}x ${s.terminal.metric}` : `perpetuity growth ${s.terminal.growth_rate}`,
      pv_per_share: r2(calc.value_per_share), return_to_pv: r4(price ? calc.value_per_share / price - 1 : null),
      terminal_year: explicitYears.at(-1)!.fiscal_year,
      terminal_price_target: r2(Number.isFinite(anchor) ? anchor : null),
      undiscounted_return_to_terminal: r4(price && Number.isFinite(anchor) ? anchor / price - 1 : null),
      tv_share_of_ev: r4(enterprise > 0 ? calc.terminal_present_value / enterprise : null),
      value_beyond_explicit_share: r4(enterprise > 0 ? (enterprise - explicitPv) / enterprise : null),
      explicit_cash_flow_sum: r2(explicit),
      no_rerating_return: r4(noRerating),
      no_rerating_return_annualized: r4(noRerating !== null && noRerating > -1 ? (1 + noRerating) ** (1 / explicitYears.length) - 1 : null),
    }];
  });
  const weights = cases.map((c) => c.probability);
  const weighted = cases.length === 3 && weights.every((w) => w !== null) && Math.abs(weights.reduce((a, b) => a! + b!, 0)! - 1) <= 0.001
    ? cases.reduce((n, c) => n + unrounded.get(c.case)! * c.probability!, 0) : null;
  return {
    artifact_type: "report_facts",
    note: "Computed by code from valuation_scenario_set and financial_analytics. Per-share values are currency per share; amounts are currency millions. Cite these instead of deriving figures.",
    valuation_status: withheld ? "withheld" : valuation ? "complete" : "missing",
    ...(withheld ? { withheld_reason: withheld } : {}),
    currency: base?.currency ?? pack?.currency ?? null,
    market_price: price,
    cases: { columns: ["case", "probability", "method", "discount_rate", "terminal", "pv_per_share", "return_to_pv", "terminal_year",
      "terminal_price_target", "undiscounted_return_to_terminal", "tv_share_of_ev", "value_beyond_explicit_share", "explicit_cash_flow_sum", "no_rerating_return", "no_rerating_return_annualized"],
      rows: cases.map((c) => Object.values(c)) },
    weighted: { pv_per_share: r2(weighted), return_to_pv: r4(weighted !== null && price ? weighted / price - 1 : null) },
    market: {
      analytics_period: typeof cash.period === "string" ? cash.period : null,
      diluted_shares: shares, equity_bridge: bridge, market_cap: r2(marketCap), enterprise_value: r2(ev),
      fcf_ttm: fcfTtm, nopat_ttm: nopatTtm,
      fcf_yield: r4(marketCap && fcfTtm !== null ? fcfTtm / marketCap : null),
      fcf_ex_sbc_yield: r4(marketCap && fcfTtm !== null && sbcTtm !== null ? (fcfTtm - sbcTtm) / marketCap : null),
      ev_to_nopat_ttm: r2(multiple),
      ev_to_nopat_next: r2(ev !== null && firstNopat !== null && firstNopat > 0 ? ev / firstNopat : null),
    },
    definitions: REPORT_FACT_DEFINITIONS,
  };
}
