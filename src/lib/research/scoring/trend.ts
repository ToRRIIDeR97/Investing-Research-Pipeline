/**
 * The research-quality trend in evals/scores.csv: per eval case, the latest scored run against the run before it.
 * Pure functions, no I/O; scripts/score-research.ts --check prints the result and fails on a regression.
 */

export type ScoreRow = Record<string, string | number | null>;

/** Columns read as numbers; everything else stays text. An empty field is null either way. */
const NUMERIC = new Set(["checks_passed", "checks_applicable", "probes_flagged", "probes_total", "traits_present", "traits_total",
  "figure_trace_rate", "reader_leaks", "human_rating_mean"]);

/** Parses the scores.csv format: a header row, then one comma-separated row per scored run (no quoted fields). */
export function parseScores(csv: string): ScoreRow[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!lines.length) return [];
  const header = lines[0].split(",").map((name) => name.trim());
  return lines.slice(1).map((line) => {
    const fields = line.split(",");
    return Object.fromEntries(header.map((name, i) => {
      const raw = (fields[i] ?? "").trim();
      if (raw === "") return [name, null];
      if (!NUMERIC.has(name)) return [name, raw];
      const value = Number(raw);
      return [name, Number.isFinite(value) ? value : null];
    }));
  });
}

export interface CaseTrend {
  case: string; runs: number; latest_run_id: string; pass_rate: number | null; previous_pass_rate: number | null;
  regressed: boolean; reasons: string[];
  /** reader_leaks of the latest and the previous run, when scored. */
  leaks: number | null; previous_leaks: number | null;
}

const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const time = (value: unknown) => { const t = Date.parse(text(value)); return Number.isFinite(t) ? t : 0; };
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const passRate = (row: ScoreRow) => {
  const passed = num(row.checks_passed), applicable = num(row.checks_applicable);
  return passed === null || !applicable ? null : passed / applicable;
};
const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;

/**
 * One entry per case, in first-seen order. A case's runs are ordered by run_created_at; a run scored more than once
 * counts once, with its latest scored_at row. A regression is a lower pass rate than the previous run, or more
 * reader leaks when both runs counted them. A case with one run never regresses.
 */
export function scoreTrend(rows: ScoreRow[]): CaseTrend[] {
  const byCase = new Map<string, Map<string, ScoreRow>>();
  for (const row of rows) {
    const id = text(row.case), runId = text(row.run_id);
    if (!id || !runId) continue;
    const runs = byCase.get(id) ?? new Map<string, ScoreRow>();
    byCase.set(id, runs);
    const kept = runs.get(runId);
    if (!kept || time(row.scored_at) >= time(kept.scored_at)) runs.set(runId, row);
  }
  return [...byCase.entries()].map(([id, runs]) => {
    const ordered = [...runs.values()].sort((a, b) => time(a.run_created_at) - time(b.run_created_at));
    const latest = ordered[ordered.length - 1], previous = ordered.length > 1 ? ordered[ordered.length - 2] : null;
    const rate = passRate(latest), previousRate = previous ? passRate(previous) : null;
    const leaks = num(latest.reader_leaks), previousLeaks = previous ? num(previous.reader_leaks) : null;
    const reasons: string[] = [];
    if (rate !== null && previousRate !== null && rate < previousRate)
      reasons.push(`pass rate fell from ${pct(previousRate)} to ${pct(rate)}`);
    if (leaks !== null && previousLeaks !== null && leaks > previousLeaks)
      reasons.push(`reader leaks rose from ${previousLeaks} to ${leaks}`);
    return { case: id, runs: ordered.length, latest_run_id: text(latest.run_id), pass_rate: rate, previous_pass_rate: previousRate,
      regressed: reasons.length > 0, reasons, leaks, previous_leaks: previousLeaks };
  });
}

/** One line per case for --check: runs, previous and latest pass rate, leaks and the verdict. */
export function formatTrend(trend: CaseTrend[]): string[] {
  const rate = (value: number | null) => (value === null ? "n/a" : pct(value));
  const leaks = (value: number | null) => (value === null ? "n/a" : String(value));
  return trend.map((c) => `${c.case.padEnd(6)} runs ${c.runs} · pass ${rate(c.previous_pass_rate)} -> ${rate(c.pass_rate)}` +
    ` · leaks ${leaks(c.previous_leaks)} -> ${leaks(c.leaks)} · ${c.regressed ? `REGRESSED: ${c.reasons.join("; ")}` : "ok"}`);
}
