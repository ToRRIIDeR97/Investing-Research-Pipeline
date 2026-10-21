/**
 * Read-only valuation what-if: recomputes a stored run's FCFF valuation with valuation engine v2, with no model call
 * and no database write.
 *
 * Usage: DATABASE_URL=... npx tsx scripts/valuation-whatif.ts <run-id> [--rebuild] [--set base|conservative|aggressive]
 *          [--discount-rate 0.10] [--terminal-growth 0.02] [--ronic 0.2] [--fade-years 7] [--grid] [--json]
 *
 * A run valued by v2 is recomputed from its stored statements, valuation sets and timing. A run valued before v2,
 * or any run with --rebuild, is rebuilt from its stored operating scenarios, captured statements, market price and
 * cost-of-capital inputs, under the code-default valuation sets (CAPM, RONIC from history and the explicit forecast).
 * Overrides change one set (default base). The forecast horizon is the stored one: more explicit years need new drivers.
 */
import postgres from "postgres";
import { calculateValuationSchedule } from "../src/lib/research/valuation/schedules";
import { valuationFinancialInputs } from "../src/lib/research/valuation/financial-inputs";
import { SCENARIOS, buildScenarioStatements, equityBridge, historyRatios, operatingModelFirstYear, type Scenario, type StatementYear } from "../src/lib/research/valuation/engine";
import {
  VALUATION_SETS, buildFcffValuation, defaultValuationSets, ronicDefault, valuationTiming, type SegmentDriver, type ValuationSet, type ValuationSetKey,
} from "../src/lib/research/valuation/v2";
import { FinancialAnalytics, buildFinancialAnalytics, tableRows } from "../src/lib/research/history/analytics";
import { mergeObservations } from "../src/lib/research/reporting/data-views";
import { costOfCapitalInputs } from "../src/lib/research/valuation/cost-of-capital";

const args = process.argv.slice(2);
const runId = args[0];
if (!runId || !process.env.DATABASE_URL) throw new Error("Usage: DATABASE_URL=... tsx scripts/valuation-whatif.ts <run-id> [--rebuild] [--set base] [--discount-rate r] [--terminal-growth g] [--ronic x] [--fade-years n] [--grid] [--json]");
const flag = (name: string) => args.includes(name);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const number = (name: string) => { const value = option(name); if (value === undefined) return undefined; const n = Number(value); if (!Number.isFinite(n)) throw new Error(`${name} needs a number`); return n; };

type Row = Record<string, any>;
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

async function load(tx: postgres.TransactionSql) {
  const latest = async (type: string) => (await tx`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId}
    AND artifact_type = ${type} ORDER BY artifact_version DESC, created_at DESC LIMIT 1`)[0]?.content_json ?? null;
  return {
    valuation: await latest("valuation_scenario_set"), scenarios: await latest("operating_scenario_set"), model: await latest("operating_model"),
    statements: await latest("financial_statement_set"), market: await latest("market_price_history"), record: await latest("historical_record"),
    analytics: await latest("financial_analytics"),
  };
}

function analyticsPack(stored: Row | null, set: Row | null, record: Row | null, market: Row | null) {
  const parsed = FinancialAnalytics.safeParse(stored);
  if (parsed.success) return parsed.data;
  if (!set) return null;
  const end = [...(set.tables ?? [])].filter((t: Row) => t.statement !== "segment").sort((a: Row, b: Row) => a.period_end.localeCompare(b.period_end)).at(-1);
  if (!end) return null;
  return FinancialAnalytics.parse(buildFinancialAnalytics({ observations: mergeObservations(set.observations ?? [], record?.observations ?? [], market?.observations ?? []),
    endFiscalYear: end.fiscal_year, endFiscalQuarter: end.fiscal_quarter }));
}

/** Everything buildFcffValuation needs, rebuilt from the stored inputs as the stage would build it. */
function rebuild(data: Awaited<ReturnType<typeof load>>) {
  const v = data.valuation, priceSource = v?.current_market_price_source ?? {};
  const price = Number(v?.current_market_price);
  const base = (v?.method_inputs ?? []).find((m: Row) => m.scenario_type === "base");
  if (!(price > 0) || !base) throw new Error("The stored valuation has no market price or base schedule to rebuild from.");
  const cutoff = new Date(String(priceSource.trading_date ?? v.cost_of_capital_inputs?.as_of ?? new Date().toISOString()));
  const fi = valuationFinancialInputs({ statementObservations: data.statements?.observations ?? [], marketObservations: data.market?.observations ?? [],
    cutoff: new Date(cutoff.getTime() + 86_400_000) });
  const ratios = historyRatios(fi);
  const horizon: number[] = (data.scenarios?.forecast_horizon?.years ?? []).map(Number);
  const baseRevenue = ratios.base_year?.revenue;
  if (!baseRevenue || !horizon.length) throw new Error("No base-year revenue or stored forecast horizon.");
  const firstYear = operatingModelFirstYear(data.model, baseRevenue);
  const drivers = (scenario: Scenario) => (data.scenarios?.scenarios ?? []).find((s: Row) => s.scenario_type === scenario)?.yearly_drivers ?? [];
  const statements = Object.fromEntries(SCENARIOS.map((scenario) => [scenario, buildScenarioStatements({ baseRevenue, baseYear: horizon[0] - 1, ratios,
    drivers: drivers(scenario).filter((d: Row) => horizon.includes(d.fiscal_year)), firstYear: scenario === "base" ? firstYear : null })])) as Record<Scenario, StatementYear[]>;
  const bridge = equityBridge(fi);
  const pack = analyticsPack(data.analytics, data.statements, data.record, data.market);
  const roicStat = pack ? tableRows(pack.statistics).find((row) => row.metric === "roic") : undefined;
  const historyRoic = typeof roicStat?.median === "number" ? roicStat.median : null;
  // Runs valued before cost_of_capital_inputs existed get them computed as the stage does now: stored beta, dated ERP.
  const costOfCapital = v.cost_of_capital_inputs ?? costOfCapitalInputs({ beta: data.market?.beta ?? null, riskFreeRate: v.risk_free_rate ?? null, cutoffAt: cutoff });
  const capm = costOfCapital?.capm_cost_of_equity?.rate ?? null, riskFree = v.risk_free_rate?.rate ?? null;
  const rate = defaultValuationSets({ capm, riskFree, ronic: 0.1 })[1].discount_rate;
  const ronic = ronicDefault({ historyRoic, baseStatements: statements.base, discountRate: rate });
  const at = (row: unknown[], key: string) => { const i = fi!.columns.indexOf(key); return i >= 0 && typeof row[i] === "number" ? row[i] as number : null; };
  const fyEnd = String([...(fi?.annual ?? [])].reverse().find((row) => Number(row[1]) === horizon[0] - 1)?.[0] ?? "").slice(5) || "12-31";
  const timing = valuationTiming({ valuationDate: cutoff.toISOString().slice(0, 10), firstYearEnd: `${horizon[0]}-${fyEnd}`, taxRate: ratios.tax_rate,
    reportedQuarters: (fi?.quarterly ?? []).filter((row) => Number(row[1]) === horizon[0]).map((row) => ({ period_end: String(row[0]),
      operating_income: at(row, "operating_income"), depreciation_amortization: at(row, "depreciation_amortization"), capital_expenditures: at(row, "capital_expenditures") })) });
  return {
    statements, sets: defaultValuationSets({ capm, riskFree, ronic: ronic.ronic }), ronic, price, timing, pack, capm, riskFree, historyRoic,
    cost_of_capital: { capm: costOfCapital?.capm_cost_of_equity ?? null, gaps: costOfCapital?.gaps ?? [], recomputed: !v.cost_of_capital_inputs },
    currency: base.currency, fiscalYearEnd: fyEnd, probabilities: v, segmentDrivers: drivers("base") as SegmentDriver[],
    common: { bridge: bridge?.amount ?? 0, shares: base.diluted_shares, currency: base.currency, sourceNotes: ["What-if rebuild; no model call."],
      bridgeExplanation: bridge ? `Rebuilt bridge at ${bridge.period_end}: ${JSON.stringify(bridge.components)}; operating leases excluded.` : "No bridge items." },
    bridge,
  };
}

function storedSummary(v: Row) {
  const schedules: Row[] = (v?.method_inputs ?? []).filter((m: Row) => m.method === "fcff");
  return Object.fromEntries(schedules.map((m) => {
    const calc = calculateValuationSchedule(m);
    return [m.scenario_type, { value_today: Number(calc.value_per_share.toFixed(2)), anchor: Number(Number(v[`terminal_anchor_${m.scenario_type}`]).toFixed(2)),
      discount_rate: m.discount_rate, terminal: m.terminal.type === "multiple" ? `${m.terminal.multiple}x NOPAT` : m.terminal.type === "value_driver" ? `g ${m.terminal.growth_rate}, RONIC ${m.terminal.ronic}` : `g ${m.terminal.growth_rate}` }];
  }));
}

async function main() {
  const data = await sql.begin("READ ONLY", (tx) => load(tx));
  const v = data.valuation;
  if (!v) throw new Error("The run has no valuation_scenario_set.");
  if (v.valuation_status === "withheld") throw new Error(`The stored valuation is withheld: ${v.withheld_reason}`);
  const stored = v.engine_version === "valuation-v2" && !flag("--rebuild");
  const inputs = stored ? (() => {
    const base = v.method_inputs.find((m: Row) => m.scenario_type === "base");
    return { statements: v.scenario_statements as Record<Scenario, StatementYear[]>, sets: v.valuation_sets as ValuationSet[], price: Number(v.current_market_price),
      timing: v.timing ?? null, pack: analyticsPack(data.analytics, null, null, null), capm: v.cost_of_capital_inputs?.capm_cost_of_equity?.rate ?? null,
      riskFree: v.risk_free_rate?.rate ?? null, historyRoic: v.ronic_default?.history_roic ?? null, currency: base.currency, fiscalYearEnd: undefined,
      probabilities: v, segmentDrivers: ((data.scenarios?.scenarios ?? []).find((s: Row) => s.scenario_type === "base")?.yearly_drivers ?? []) as SegmentDriver[],
      common: { bridge: base.equity_bridge, shares: base.diluted_shares, currency: base.currency, sourceNotes: ["What-if; no model call."], bridgeExplanation: base.equity_bridge_explanation },
      ronic: v.ronic_default ?? null, bridge: v.equity_bridge_detail ?? null };
  })() : rebuild(data);
  const key = (option("--set") ?? "base") as ValuationSetKey;
  if (!VALUATION_SETS.includes(key)) throw new Error(`--set must be one of ${VALUATION_SETS.join(", ")}`);
  const overrides = Object.fromEntries(Object.entries({ discount_rate: number("--discount-rate"), terminal_growth: number("--terminal-growth"),
    ronic: number("--ronic"), fade_years: number("--fade-years") }).filter(([, value]) => value !== undefined));
  const sets = inputs.sets.map((set) => set.set === key ? { ...set, ...overrides, rationale: `${set.rationale} What-if: ${JSON.stringify(overrides)}.` } : set);
  const built = buildFcffValuation({ ...inputs, sets, fx: 1, fiscalYearEnd: inputs.fiscalYearEnd });
  const set$ = built.assembled.valuation_scenario_set as Row;
  const result = {
    run: runId, mode: stored ? "stored v2 inputs" : "rebuilt from stored inputs, code-default sets", overrides: { set: key, ...overrides },
    market_price: inputs.price, ronic_default: inputs.ronic, bridge: inputs.bridge,
    cost_of_capital: "cost_of_capital" in inputs ? inputs.cost_of_capital : null,
    stored_valuation: storedSummary(v), stored_weighted: { weighted_target: v.weighted_target ?? null, weighted_value_today: v.weighted_value_today ?? null },
    sets,
    value_today: { bear: set$.value_today_bear, base: set$.value_today_base, bull: set$.value_today_bull, weighted: set$.weighted_value_today ?? null },
    anchors: { terminal_year: set$.terminal_year, bear: set$.terminal_anchor_bear, base: set$.terminal_anchor_base, bull: set$.terminal_anchor_bull, weighted: set$.weighted_target ?? null },
    terminal_value_share: built.additions.terminal_value_share,
    value_beyond_explicit_share: built.additions.value_beyond_explicit_share,
    matrix: built.additions.valuation_matrix.rows,
    ...(flag("--grid") ? { sensitivity_grid: built.additions.sensitivity_grid.rows } : {}),
    reverse: built.reverse, cross_checks: built.additions.cross_checks, lenses: built.lenses,
    sanity: built.additions.sanity, stress_cases: built.additions.stress_cases, segments: built.additions.segment_cross_check, timing: built.additions.timing,
  };
  console.log(flag("--json") ? JSON.stringify(result, null, 2) : JSON.stringify(result, (k, value) => typeof value === "number" ? Number(value.toFixed(4)) : value, 2));
}

main().finally(() => sql.end());
