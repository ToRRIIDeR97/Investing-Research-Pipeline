/**
 * Stability across repeated runs of one asset (RQ-EVAL-7). The tails carry the instability, so each case gets
 * its own coefficient of variation, beside the model-chosen terminal multiples and discount rates.
 */
import { latest, type RunSnapshot } from "./load";

type Row = Record<string, any>;
const CASES = ["bear", "base", "bull"] as const;
const columnRows = (table: any): Row[] => Array.isArray(table?.columns) && Array.isArray(table?.rows)
  ? table.rows.map((row: unknown[]) => Object.fromEntries(table.columns.map((c: string, i: number) => [c, row[i]]))) : [];

/** Sample coefficient of variation; null below two finite values or at a zero mean. */
export function coefficientOfVariation(values: (number | null | undefined)[]) {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean === 0) return null;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Number((Math.sqrt(variance) / Math.abs(mean)).toFixed(4));
}

export function valuationSummary(snapshot: RunSnapshot) {
  const valuation = latest(snapshot.artifacts, "valuation_scenario_set");
  const facts = latest(snapshot.artifacts, "report_facts");
  const matrix = latest(snapshot.artifacts, "expected_return_matrix");
  const rows = columnRows(facts?.cases);
  const schedules: Row[] = Array.isArray(valuation?.method_inputs) ? valuation.method_inputs : [];
  const perCase = Object.fromEntries(CASES.map((c) => {
    const schedule = schedules.find((s) => s.scenario_type === c && s.method === "fcff") ?? schedules.find((s) => s.scenario_type === c);
    const terminal = schedule?.terminal;
    return [c, { pv_per_share: rows.find((r) => r.case === c)?.pv_per_share ?? null,
      terminal_anchor: typeof valuation?.[`terminal_anchor_${c}`] === "number" ? valuation[`terminal_anchor_${c}`] : null,
      discount_rate: schedule?.discount_rate ?? null,
      terminal: terminal ? (terminal.type === "multiple" ? `${terminal.multiple}x ${terminal.metric}` : `g ${terminal.growth_rate}`) : null }];
  }));
  return { run_id: snapshot.run.id, created_at: snapshot.run.created_at, cutoff: snapshot.run.cutoff, market_price: facts?.market_price ?? valuation?.current_market_price ?? null,
    weighted_pv_per_share: facts?.weighted?.pv_per_share ?? null, expected_return: matrix?.probability_weighted_return ?? null,
    permanent_loss_limit: matrix?.permanent_loss_limit ?? null, cases: perCase };
}

export function stabilityReport(snapshots: RunSnapshot[]) {
  const runs = snapshots.map(valuationSummary).filter((s) => Object.values(s.cases).some((c) => c.pv_per_share !== null || c.terminal_anchor !== null));
  const cv = (pick: (s: ReturnType<typeof valuationSummary>) => number | null) => coefficientOfVariation(runs.map(pick));
  const spread = (values: (number | null)[]) => {
    const xs = values.filter((v): v is number => typeof v === "number");
    return xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : null;
  };
  return {
    runs: runs.length,
    pv_per_share_cv: Object.fromEntries(CASES.map((c) => [c, cv((s) => s.cases[c].pv_per_share)])),
    terminal_anchor_cv: Object.fromEntries(CASES.map((c) => [c, cv((s) => s.cases[c].terminal_anchor)])),
    weighted_pv_cv: cv((s) => s.weighted_pv_per_share),
    expected_return_spread: spread(runs.map((s) => s.expected_return)),
    permanent_loss_spread: spread(runs.map((s) => s.permanent_loss_limit)),
    choices: runs.map((s) => ({ run_id: s.run_id, created_at: s.created_at,
      ...Object.fromEntries(CASES.map((c) => [c, `${s.cases[c].terminal ?? "?"} @ ${s.cases[c].discount_rate ?? "?"}`])) })),
    detail: runs,
  };
}
