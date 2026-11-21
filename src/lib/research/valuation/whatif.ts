/**
 * Valuation what-if: recompute a stored v2 FCFF valuation under changed assumptions, in code, with no model call and
 * no write. Used by the valuation workbench (`/api/research-runs/:id/workbench`) and `scripts/valuation-whatif.ts`.
 *
 * Changes are typed (`WorkbenchChange`): valuation-set overrides (discount rate, terminal growth, RONIC, fade years),
 * yearly operating-driver overrides per case (revenue growth, operating margin) and case probabilities. They are
 * checked against the same rules as the valuation contract (`validateValuationSets`), so an edit the analyst could not
 * have made is refused rather than computed.
 */
import { z } from "zod";
import { calculateValuationSchedule } from "./schedules";
import { SCENARIOS, type Scenario, type StatementYear } from "./engine";
import { VALUATION_SETS, buildFcffValuation, validateValuationSets, type SegmentDriver, type ValuationSet, type ValuationSetKey } from "./v2";
import { withheldValuationReason } from "./contracts";
import { FinancialAnalytics } from "../history/analytics";

type Row = Record<string, any>;
const rate = z.number().finite().min(-0.5).max(1);

export const WorkbenchChange = z.object({
  sets: z.partialRecord(z.enum(VALUATION_SETS as unknown as [ValuationSetKey, ...ValuationSetKey[]]), z.object({
    discount_rate: z.number().finite().min(0).max(0.5).optional(), terminal_growth: z.number().finite().min(-0.05).max(0.1).optional(),
    ronic: z.number().finite().min(0).max(2).optional(), fade_years: z.number().int().min(0).max(20).optional(),
  }).strict()).optional(),
  drivers: z.partialRecord(z.enum(SCENARIOS as unknown as [Scenario, ...Scenario[]]), z.array(z.object({
    fiscal_year: z.number().int().min(1990).max(2100), revenue_growth: rate.optional(), operating_margin: rate.optional(),
  }).strict()).max(20)).optional(),
  probabilities: z.object({ bear: z.number().min(0).max(1), base: z.number().min(0).max(1), bull: z.number().min(0).max(1) }).strict()
    .refine((p) => Math.abs(p.bear + p.base + p.bull - 1) < 0.001, "Probabilities must add up to 100%").optional(),
}).strict();
export type WorkbenchChange = z.infer<typeof WorkbenchChange>;

/** The stored artifacts a what-if reads. */
export interface WhatIfData { valuation: Row | null; scenarios: Row | null; analytics: Row | null }

export type WhatIfAvailability = { available: true } | { available: false; reason: string };
/** Whether the workbench can recompute this run's valuation; when not, a reason a reader can act on. */
export function whatIfAvailability(data: WhatIfData): WhatIfAvailability {
  const v = data.valuation;
  if (!v) return { available: false, reason: "This run has no valuation yet." };
  const withheld = withheldValuationReason(v);
  if (withheld) return { available: false, reason: `The valuation was withheld: ${withheld}` };
  if (v.engine_version !== "valuation-v2" || !v.scenario_statements || !Array.isArray(v.valuation_sets))
    return { available: false, reason: "This run was valued with a model-built schedule (for example a bank's FCFE) or an older engine, which the workbench cannot recompute. A new research run values it with the current engine." };
  if (!SCENARIOS.every((s) => Array.isArray(v.scenario_statements[s]) && v.scenario_statements[s].length))
    return { available: false, reason: "The stored valuation lacks one case's yearly statements." };
  return { available: true };
}

/**
 * Re-derives a case's statements after driver edits. Years before the first edit are kept exactly. From there the
 * revenue chain follows the new growth, operating income the new margin, NOPAT the stored tax rate; capex and D&A keep
 * their stored share of revenue and working capital its stored ratio to the revenue change. FCFF follows from those.
 */
export function editStatements(stored: StatementYear[], edits: { fiscal_year: number; revenue_growth?: number; operating_margin?: number }[] = []): StatementYear[] {
  const byYear = new Map(edits.map((e) => [e.fiscal_year, e]));
  for (const year of byYear.keys()) if (!stored.some((s) => s.fiscal_year === year)) throw new WhatIfError(`FY${year} is outside the forecast (FY${stored[0].fiscal_year}-FY${stored.at(-1)!.fiscal_year}).`);
  let changed = false;
  let priorStored = stored[0].revenue / (1 + stored[0].revenue_growth), priorNew = priorStored;
  return stored.map((year) => {
    const edit = byYear.get(year.fiscal_year);
    if (edit && (edit.revenue_growth !== undefined || edit.operating_margin !== undefined)) changed = true;
    const storedPrior = priorStored;
    priorStored = year.revenue;
    if (!changed) { priorNew = year.revenue; return year; }
    const growth = edit?.revenue_growth ?? year.revenue_growth, margin = edit?.operating_margin ?? year.operating_margin;
    const revenue = priorNew * (1 + growth);
    const scale = year.revenue !== 0 ? revenue / year.revenue : 1;
    const storedDelta = year.revenue - storedPrior;
    const nwcRatio = storedDelta !== 0 ? year.change_in_net_working_capital / storedDelta : 0;
    const operating_income = revenue * margin, nopat = operating_income * (1 - year.tax_rate);
    const depreciation_amortization = year.depreciation_amortization * scale, capital_expenditures = year.capital_expenditures * scale;
    const change_in_net_working_capital = nwcRatio * (revenue - priorNew);
    const net_reinvestment = capital_expenditures - depreciation_amortization + change_in_net_working_capital;
    priorNew = revenue;
    return { ...year, revenue, revenue_growth: growth, operating_income, operating_margin: margin, nopat, depreciation_amortization, capital_expenditures,
      change_in_net_working_capital, fcff: nopat + depreciation_amortization - capital_expenditures - change_in_net_working_capital,
      maintenance_capex: Math.min(capital_expenditures, depreciation_amortization), growth_capex: Math.max(0, capital_expenditures - depreciation_amortization),
      net_reinvestment, net_ppe_closing: null, invested_capital_closing: null, roic: null, incremental_roic: null };
  });
}

export class WhatIfError extends Error { constructor(message: string) { super(message); this.name = "WhatIfError"; } }

/** The inputs `buildFcffValuation` needs, from a stored v2 valuation. */
function storedInputs(data: WhatIfData) {
  const v = data.valuation!;
  const base = v.method_inputs.find((m: Row) => m.scenario_type === "base");
  const pack = FinancialAnalytics.safeParse(data.analytics);
  return {
    statements: v.scenario_statements as Record<Scenario, StatementYear[]>, sets: v.valuation_sets as ValuationSet[], price: Number(v.current_market_price),
    timing: v.timing ?? null, pack: pack.success ? pack.data : null, capm: v.cost_of_capital_inputs?.capm_cost_of_equity?.rate ?? null,
    riskFree: v.risk_free_rate?.rate ?? null, historyRoic: v.ronic_default?.history_roic ?? null, currency: String(base?.currency ?? "USD"),
    probabilities: { probability_bear: v.probability_bear, probability_base: v.probability_base, probability_bull: v.probability_bull },
    segmentDrivers: ((data.scenarios?.scenarios ?? []).find((s: Row) => s.scenario_type === "base")?.yearly_drivers ?? []) as SegmentDriver[],
    common: { bridge: base?.equity_bridge ?? 0, shares: base?.diluted_shares, currency: String(base?.currency ?? "USD"), sourceNotes: ["What-if; no model call."],
      bridgeExplanation: String(base?.equity_bridge_explanation ?? "") },
  };
}

const r2 = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? Number(n.toFixed(2)) : null;
const r4 = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? Number(n.toFixed(4)) : null;

export type WhatIfResult = {
  currency: string; price: number; terminal_year: number | null;
  value_today: Record<Scenario | "weighted", number | null>; return_today: Record<Scenario | "weighted", number | null>;
  anchors: Record<Scenario | "weighted", number | null>; probabilities: Record<Scenario, number | null>;
  terminal_value_share: Record<Scenario, number | null>; sets: ValuationSet[];
  drivers: Record<Scenario, { fiscal_year: number; revenue_growth: number; operating_margin: number; revenue: number; fcff: number }[]>;
  matrix: { columns: string[]; rows: unknown[][] }; sensitivity: { columns: string[]; rows: unknown[][] };
  flags: string[];
};

/** The editable starting point: the stored sets, probabilities and each case's yearly drivers. */
export function workbenchInputs(data: WhatIfData) {
  const inputs = storedInputs(data);
  return { sets: inputs.sets, probabilities: { bear: Number(inputs.probabilities.probability_bear ?? 0), base: Number(inputs.probabilities.probability_base ?? 0), bull: Number(inputs.probabilities.probability_bull ?? 0) },
    drivers: Object.fromEntries(SCENARIOS.map((s) => [s, inputs.statements[s].map((y) => ({ fiscal_year: y.fiscal_year, revenue_growth: r4(y.revenue_growth)!, operating_margin: r4(y.operating_margin)! }))])) as Record<Scenario, { fiscal_year: number; revenue_growth: number; operating_margin: number }[]> };
}

/**
 * Recomputes the stored valuation with a change applied. With no change it reproduces the stored valuation. Throws
 * WhatIfError, with a reader-facing message, when the change breaks a valuation rule or the run cannot be recomputed.
 */
export function computeWhatIf(data: WhatIfData, change: WorkbenchChange = {}): WhatIfResult {
  const availability = whatIfAvailability(data);
  if (!availability.available) throw new WhatIfError(availability.reason);
  const parsed = WorkbenchChange.safeParse(change);
  if (!parsed.success) throw new WhatIfError(parsed.error.issues[0]?.message ?? "The change is not valid.");
  const c = parsed.data;
  const inputs = storedInputs(data);
  if (!(inputs.price > 0)) throw new WhatIfError("The stored valuation has no market price to compare with.");
  const sets = inputs.sets.map((set) => {
    const over = c.sets?.[set.set];
    return over && Object.keys(over).length ? { ...set, ...over, rationale: `${set.rationale} Workbench change.`, ...(over.ronic !== undefined ? { ronic_rationale: "Set in the valuation workbench." } : {}) } : set;
  });
  const defaults = (data.valuation!.default_valuation_sets as ValuationSet[] | undefined) ?? inputs.sets;
  const problems = validateValuationSets(sets, defaults, inputs.riskFree);
  if (problems.length) throw new WhatIfError(problems[0].message.replace(/valuation_assumptions\.sets\.?\d*\.?/g, "").replace(/\bronic_rationale\b/g, "a reason"));
  const statements = Object.fromEntries(SCENARIOS.map((s) => [s, editStatements(inputs.statements[s], c.drivers?.[s])])) as Record<Scenario, StatementYear[]>;
  const probabilities = c.probabilities ? { probability_bear: c.probabilities.bear, probability_base: c.probabilities.base, probability_bull: c.probabilities.bull } : inputs.probabilities;
  const built = buildFcffValuation({ ...inputs, statements, sets, probabilities, fx: 1 });
  const v = built.assembled.valuation_scenario_set as Row;
  const today = (s: Scenario) => r2(calculateValuationSchedule(built.schedules[s]).value_per_share);
  const weighted = r2(v.weighted_value_today);
  const ret = (value: number | null) => value === null ? null : r4(value / inputs.price - 1);
  const value_today = { bear: today("bear"), base: today("base"), bull: today("bull"), weighted };
  const sanity = built.additions.sanity as Row;
  const flags = Array.isArray(sanity?.flags) ? sanity.flags.map((f: Row) => String(f.message ?? f.flag ?? f)).filter(Boolean) : [];
  return {
    currency: inputs.currency, price: inputs.price, terminal_year: v.terminal_year ?? null,
    value_today, return_today: { bear: ret(value_today.bear), base: ret(value_today.base), bull: ret(value_today.bull), weighted: ret(weighted) },
    anchors: { bear: r2(v.terminal_anchor_bear), base: r2(v.terminal_anchor_base), bull: r2(v.terminal_anchor_bull), weighted: r2(v.weighted_target) },
    probabilities: { bear: r4(probabilities.probability_bear), base: r4(probabilities.probability_base), bull: r4(probabilities.probability_bull) },
    terminal_value_share: built.additions.terminal_value_share as Record<Scenario, number | null>, sets,
    drivers: Object.fromEntries(SCENARIOS.map((s) => [s, statements[s].map((y) => ({ fiscal_year: y.fiscal_year, revenue_growth: r4(y.revenue_growth)!,
      operating_margin: r4(y.operating_margin)!, revenue: r2(y.revenue)!, fcff: r2(y.fcff)! }))])) as WhatIfResult["drivers"],
    matrix: { columns: built.additions.valuation_matrix.columns, rows: built.additions.valuation_matrix.rows },
    sensitivity: { columns: built.additions.sensitivity_grid.columns, rows: built.additions.sensitivity_grid.rows }, flags,
  };
}

/** What a saved scenario keeps of a result: values, returns, anchors and weights (already rounded by `computeWhatIf`). */
export type ScenarioSummary = Pick<WhatIfResult, "value_today" | "return_today" | "anchors" | "probabilities">;
export function scenarioSummary(result: WhatIfResult): ScenarioSummary {
  return { value_today: { ...result.value_today }, return_today: { ...result.return_today }, anchors: { ...result.anchors }, probabilities: { ...result.probabilities } };
}

export const MAX_SCENARIO_PROPOSALS = 3;
/** One scenario the chat proposes: a name, why, and a typed change the workbench applies. */
export const ScenarioProposal = z.object({
  name: z.string().trim().min(1).max(80), rationale: z.string().trim().min(1).max(1000), change: WorkbenchChange,
}).strict();
export type ScenarioProposal = z.infer<typeof ScenarioProposal>;

/**
 * Checks the chat's scenario proposals: an array of at most three strict `{ name, rationale, change }` objects whose
 * changes compute against this run's stored valuation. Each error names its proposal (`"<name>: <reason>"`); an empty
 * array means valid.
 */
export function scenarioProposalErrors(proposals: unknown, data: WhatIfData): string[] {
  if (!Array.isArray(proposals)) return ["scenario_proposals must be an array."];
  const errors: string[] = [];
  if (proposals.length > MAX_SCENARIO_PROPOSALS) errors.push(`scenario_proposals has ${proposals.length} entries; at most ${MAX_SCENARIO_PROPOSALS} are allowed.`);
  const seen = new Set<string>();
  proposals.forEach((raw, index) => {
    const label = raw && typeof raw === "object" && typeof (raw as Row).name === "string" && (raw as Row).name.trim() ? String((raw as Row).name).trim().slice(0, 80) : `Proposal ${index + 1}`;
    const parsed = ScenarioProposal.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      errors.push(`${label}: ${issue?.path.length ? `${issue.path.join(".")} ` : ""}${issue?.message ?? "is not a valid proposal"}`);
      return;
    }
    const key = parsed.data.name.toLowerCase();
    if (seen.has(key)) { errors.push(`${label}: another proposal has the same name.`); return; }
    seen.add(key);
    try { computeWhatIf(data, parsed.data.change); }
    catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  });
  return errors;
}
