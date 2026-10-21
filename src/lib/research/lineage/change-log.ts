/**
 * version_change_log: what changed since the asset's prior run (framework section 14), computed by code with
 * no model call. It diffs a fixed field list (valuation per case and weighted, key drivers, decision and thesis
 * status) and says whether new documents arrived, so a view change can be told apart from a method change.
 * Pure and dependency-free, so the report renderer and the UI can import it.
 */
type Row = Record<string, any>;

export const CASES = ["bear", "base", "bull"] as const;
export type CaseType = typeof CASES[number];

export interface ValuationSnapshot {
  status: string;
  currency: string | null;
  weighted_value_per_share: number | null;
  market_price: number | null;
  cases: { scenario_type: CaseType; value_per_share: number | null; probability: number | null; discount_rate: number | null;
    terminal_anchor: number | null; revenue_cagr: number | null; operating_margin: number | null }[];
}

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const latest = (artifacts: Row[], type: string): Row | null => {
  const rows = artifacts.filter(a => a.artifact_type === type);
  rows.sort((a, b) => Number(b.artifact_version ?? 0) - Number(a.artifact_version ?? 0));
  return rows[0]?.content_json ?? null;
};

/** Valuation per case, read defensively: schedules may be keyed by scenario_type or listed per scenario. */
export function valuationSnapshot(artifacts: Row[]): ValuationSnapshot | null {
  const set = latest(artifacts, "valuation_scenario_set");
  if (!set) return null;
  const operating: Row[] = latest(artifacts, "operating_scenario_set")?.scenarios ?? [];
  const schedules: Row[] = Array.isArray(set.method_schedules) ? set.method_schedules : [];
  const scenarios: Row[] = Array.isArray(set.scenarios) ? set.scenarios : [];
  const cases = CASES.map(type => {
    const schedule = schedules.find(s => s?.scenario_type === type);
    const scenario = scenarios.find(s => s?.scenario_type === type);
    const drivers = operating.find(s => s?.scenario_type === type);
    return {
      scenario_type: type,
      value_per_share: num(schedule?.value_per_share ?? scenario?.value_per_share),
      probability: num(set[`probability_${type}`] ?? scenario?.probability),
      discount_rate: num(schedule?.discount_rate ?? scenario?.discount_rate),
      terminal_anchor: num(set[`terminal_anchor_${type}`]),
      revenue_cagr: num(drivers?.revenue_cagr),
      operating_margin: num(drivers?.operating_margin),
    };
  });
  return {
    status: String(set.valuation_status ?? "complete"),
    currency: schedules.find(s => s?.currency)?.currency ?? set.currency ?? null,
    weighted_value_per_share: num(set.weighted_target),
    market_price: num(set.current_market_price),
    cases,
  };
}

export interface ChangeEntry {
  field: string;
  label: string;
  group: "valuation" | "drivers" | "decision" | "thesis";
  previous: number | string | null;
  current: number | string | null;
  /** Relative change for numbers (current / previous − 1); null for text or a missing side. */
  change: number | null;
  material: boolean;
}

export interface VersionChangeLog {
  artifact_type: "version_change_log";
  prior_run_id: string;
  prior_source_cutoff: string | null;
  source_cutoff: string | null;
  /** Documents this run uses that the prior run did not. Zero means a change came from method or model, not evidence. */
  new_documents: number;
  cause: "new_evidence" | "method_or_model";
  changes: ChangeEntry[];
  unchanged: number;
  material_changes: number;
}

/** A relative move at or above this is material; any change of a categorical field is material. */
export const MATERIAL_CHANGE = 0.1;

export interface ChangeSide { artifacts: Row[]; source_cutoff: string | null; document_ids: string[] }

export function buildVersionChangeLog(priorRunId: string, prior: ChangeSide, current: ChangeSide): VersionChangeLog {
  const entries: ChangeEntry[] = [];
  let unchanged = 0;
  const add = (field: string, label: string, group: ChangeEntry["group"], previous: unknown, now: unknown, numeric = true) => {
    const a = numeric ? num(previous) : previous == null ? null : String(previous);
    const b = numeric ? num(now) : now == null ? null : String(now);
    if (a === b) { unchanged++; return; }
    if (numeric && typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a))) { unchanged++; return; }
    const change = numeric && typeof a === "number" && typeof b === "number" && a !== 0 ? b / a - 1 : null;
    const material = !numeric || a === null || b === null || change === null || Math.abs(change) >= MATERIAL_CHANGE;
    entries.push({ field, label, group, previous: a, current: b, change, material });
  };
  const before = valuationSnapshot(prior.artifacts), after = valuationSnapshot(current.artifacts);
  add("valuation.status", "Valuation status", "valuation", before?.status ?? null, after?.status ?? null, false);
  add("valuation.weighted_value_per_share", "Probability-weighted value per share", "valuation", before?.weighted_value_per_share, after?.weighted_value_per_share);
  for (const type of CASES) {
    const was = before?.cases.find(c => c.scenario_type === type), is = after?.cases.find(c => c.scenario_type === type);
    const name = `${type[0].toUpperCase()}${type.slice(1)} case`;
    add(`valuation.${type}.value_per_share`, `${name} value per share`, "valuation", was?.value_per_share, is?.value_per_share);
    add(`valuation.${type}.probability`, `${name} probability`, "valuation", was?.probability, is?.probability);
    add(`drivers.${type}.discount_rate`, `${name} discount rate`, "drivers", was?.discount_rate, is?.discount_rate);
    add(`drivers.${type}.terminal_anchor`, `${name} terminal anchor`, "drivers", was?.terminal_anchor, is?.terminal_anchor);
    add(`drivers.${type}.revenue_cagr`, `${name} revenue growth (CAGR)`, "drivers", was?.revenue_cagr, is?.revenue_cagr);
    add(`drivers.${type}.operating_margin`, `${name} operating margin`, "drivers", was?.operating_margin, is?.operating_margin);
  }
  const decision = (side: ChangeSide) => latest(side.artifacts, "decision_record")?.decision ?? null;
  const thesis = (side: ChangeSide) => latest(side.artifacts, "investment_thesis")?.thesis_statement ?? null;
  const returns = (side: ChangeSide) => latest(side.artifacts, "expected_return_matrix")?.status ?? null;
  add("decision.decision", "Decision", "decision", decision(prior), decision(current), false);
  add("thesis.expected_return_status", "Expected return status", "thesis", returns(prior), returns(current), false);
  const clip = (text: unknown) => {
    const value = String(text ?? "").replace(/\s+/g, " ").trim();
    return !value ? null : value.length > 160 ? `${value.slice(0, 159)}…` : value;
  };
  const [was, is] = [thesis(prior), thesis(current)];
  if (String(was ?? "").trim() === String(is ?? "").trim()) unchanged++;
  else entries.push({ field: "thesis.statement", label: "Thesis statement", group: "thesis", previous: clip(was), current: clip(is), change: null, material: true });
  const priorDocs = new Set(prior.document_ids);
  const newDocuments = current.document_ids.filter(id => !priorDocs.has(id)).length;
  return {
    artifact_type: "version_change_log",
    prior_run_id: priorRunId,
    prior_source_cutoff: prior.source_cutoff,
    source_cutoff: current.source_cutoff,
    new_documents: newDocuments,
    cause: newDocuments > 0 ? "new_evidence" : "method_or_model",
    changes: entries,
    unchanged,
    material_changes: entries.filter(e => e.material).length,
  };
}

const escapeCell = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/([\\`*_[\]#|])/g, "\\$1").replace(/\r?\n/g, " ");
/** Rates and probabilities as %, other numbers to two decimals. */
export function changeValue(field: string, value: number | string | null): string {
  if (value === null) return "—";
  if (typeof value === "string") return value;
  if (/probability|discount_rate|revenue_cagr|operating_margin/.test(field)) return `${(value * 100).toFixed(1)}%`;
  return value.toFixed(2);
}
export const changeText = (entry: ChangeEntry) => entry.change === null ? (entry.material ? "Changed" : "—") : `${entry.change >= 0 ? "+" : "−"}${Math.abs(entry.change * 100).toFixed(1)}%`;

/** The report's "Changes since the prior run" section. */
export function changeLogMarkdown(log: VersionChangeLog): string[] {
  const cutoff = log.prior_source_cutoff ? log.prior_source_cutoff.slice(0, 10) : "an unknown date";
  const cause = log.cause === "new_evidence"
    ? `${log.new_documents} document${log.new_documents === 1 ? "" : "s"} in this run were not in the prior run.`
    : "This run uses no document the prior run lacked, so differences come from method or model changes, not new evidence.";
  const lines = ["## Changes since the prior run", "", `Compared with run ${escapeCell(log.prior_run_id)} (research cutoff ${escapeCell(cutoff)}). ${cause}`, ""];
  if (!log.changes.length) return [...lines, "No tracked valuation, driver, decision or thesis field changed.", ""];
  return [...lines, "| Item | Prior run | This run | Change | Material |", "| --- | --- | --- | --- | --- |",
    ...log.changes.map(e => `| ${escapeCell(e.label)} | ${escapeCell(changeValue(e.field, e.previous))} | ${escapeCell(changeValue(e.field, e.current))} | ${escapeCell(changeText(e))} | ${e.material ? "Yes" : "No"} |`),
    "", `${log.unchanged} other tracked field${log.unchanged === 1 ? "" : "s"} unchanged.`, ""];
}
