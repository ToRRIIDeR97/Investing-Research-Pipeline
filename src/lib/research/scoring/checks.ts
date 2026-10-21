/**
 * Code checks on a stored run: free, deterministic, and run by eval:score. They measure what the pipeline
 * computed and what the report did with it; the LLM judge and human ratings measure the rest.
 */
import { checkReportSubstance } from "../reporting/substance";
import { reconcileCoverage } from "../reporting/compose";
import { deriveReview, isPassing } from "../reporting/depth";
import { latest, type RunSnapshot, type ScoredArtifact } from "./load";

type Row = Record<string, any>;
export interface CheckResult { id: string; label: string; status: "pass" | "fail" | "n/a"; detail: string; value?: number | string | null }
const result = (id: string, label: string, pass: boolean | null, detail: string, value?: CheckResult["value"]): CheckResult =>
  ({ id, label, status: pass === null ? "n/a" : pass ? "pass" : "fail", detail, ...(value !== undefined ? { value } : {}) });
const columnRows = (table: any): Row[] => Array.isArray(table?.columns) && Array.isArray(table?.rows)
  ? table.rows.map((row: unknown[]) => Object.fromEntries(table.columns.map((c: string, i: number) => [c, row[i]]))) : [];
const stored = (artifacts: ScoredArtifact[], type: string) => artifacts.some((a) => a.artifact_type === type && !a.computed);

/** Reader prose: paragraphs, counterevidence and implications (tables, gaps and questions excluded). */
export const sectionProse = (section: Row): string[] => [...(section.paragraphs ?? []).map((p: Row) => String(p.text ?? "")),
  String(section.counterevidence ?? ""), String(section.implication ?? "")];

/** The JD example's analytical moves, as prose patterns. Presence is a floor, not a depth score. */
export const JD_TRAITS: { id: string; label: string; pattern: RegExp }[] = [
  { id: "history_statistics", label: "History statistics (median, percentile)", pattern: /\bmedian\b|\bpercentile\b|\b\d+-quarter (?:range|median|history)\b/i },
  { id: "segment_profit_split", label: "Segment profit split", pattern: /\bsegments?\b[^.]{0,120}\boperating (?:income|loss|profit|margin)|\boperating (?:income|loss|profit)\b[^.]{0,120}\bsegments?\b/i },
  { id: "fcf_conversion", label: "FCF conversion", pattern: /\b(?:FCF|free cash flow)\s*(?:\/|to|over)\s*net income\b|\b(?:FCF|cash) conversion\b/i },
  { id: "working_capital_days", label: "Working-capital days", pattern: /\b(?:DSO|DIO|DPO|days sales outstanding|inventory days|receivable days|payable days|cash[- ]conversion cycle)\b/i },
  { id: "net_cash", label: "Net cash", pattern: /\bnet cash\b(?! (?:from|provided|used|flows?))/i },
  { id: "share_count_change", label: "Share count change", pattern: /\b(?:share count|shares outstanding|diluted shares)\b[^.]{0,60}\b(?:fell|declined|decreased|reduced|rose|increased|grew)\b|\bbuyback yield\b|\bnet (?:share )?reduction\b/i },
  { id: "reverse_dcf_fcf_growth", label: "Reverse DCF in FCF-growth terms", pattern: /\bimpl(?:y|ies|ied)\b[^.]{0,80}\b(?:FCF|free cash flow) growth\b|\breverse (?:DCF|valuation)\b[^.]{0,120}\b(?:FCF|free cash flow)\b/i },
  { id: "fcf_yield", label: "FCF yield", pattern: /\b(?:FCF|free cash flow) yield\b/i },
  { id: "no_rerating_return", label: "No-rerating return with a figure", pattern: /\bno[- ]?re-?rating\b[^.]{0,100}-?\d+(?:\.\d+)?%/i },
  { id: "tail_below_bear", label: "Tail or impairment case below bear", pattern: /\b(?:impairment|tail|severe|permanent[- ]loss) (?:case|scenario)\b|\bbelow the bear\b/i },
  { id: "what_would_change_my_mind", label: "What would change my mind", pattern: /\bchange (?:my|our|the) (?:mind|view|conclusion)\b|\bwhat would change\b/i },
  { id: "scorecard", label: "Scorecard", pattern: /\bscorecard\b/i },
];

export function traitPresence(document: Row | null) {
  const prose = (document?.sections ?? []).flatMap(sectionProse).join("\n");
  return JD_TRAITS.map((trait) => ({ id: trait.id, label: trait.label, present: trait.pattern.test(prose) }));
}

// Figures with three or more significant digits; four-digit years alone are skipped.
const FIGURE = /(?<![\w.])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\w])|(?<![\w.,])-?\d+\.\d+(?![\w])|(?<![\w.,])-?\d{3,}(?![\w,])/g;
const SCALES = [1, 1e2, 1e-2, 1e3, 1e-3, 1e6, 1e-6, 1e9, 1e-9];
const figures = (text: string) => [...text.matchAll(FIGURE)].map((m) => m[0]).filter((raw) => {
  const plain = raw.replace(/[,-]/g, "");
  if (/^(?:19|20)\d{2}$/.test(plain)) return false;
  return plain.replace(".", "").replace(/^0+/, "").length >= 3;
});
const decimals = (raw: string) => raw.includes(".") ? raw.split(".")[1].length : 0;
const numeric = (raw: string) => Number(raw.replace(/,/g, ""));

/** Every number a cited input holds, keyed at each display precision and unit scale, so a figure's lookup is O(1). */
function numberKeys(value: unknown, keys = new Set<string>()): Set<string> {
  const addNumber = (n: number) => {
    if (!Number.isFinite(n)) return;
    for (const scale of SCALES) for (let d = 0; d <= 3; d++) keys.add(`${d}:${(n * scale).toFixed(d)}`);
  };
  const walk = (v: unknown) => {
    if (typeof v === "number") addNumber(v);
    else if (typeof v === "string") { for (const raw of v.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? []) addNumber(numeric(raw)); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return keys;
}

/**
 * Figures in report paragraphs traced to the inputs that paragraph cites, at displayed precision. Unmatched
 * figures in fact paragraphs are the ones a writer computed or mis-cited (RQ-EVAL-5).
 */
export function figureTrace(document: Row | null) {
  if (!document?.sections) return null;
  const artifactKeys = new Map<string, Set<string>>();
  const evidence = new Map<string, Row>((document.evidence ?? []).map((e: Row) => [String(e.id), e]));
  const artifacts = new Map<string, Row>((document.artifacts ?? []).map((a: Row) => [String(a.id), a]));
  const keysFor = (id: string) => {
    if (!artifactKeys.has(id)) artifactKeys.set(id, numberKeys(artifacts.get(id)?.content_json ?? null));
    return artifactKeys.get(id)!;
  };
  let total = 0, matched = 0;
  const unmatchedFacts: { section_id: string; figure: string }[] = [];
  for (const section of document.sections) for (const p of section.paragraphs ?? []) {
    const found = figures(String(p.text ?? ""));
    if (!found.length) continue;
    const local = numberKeys((p.evidence_ids ?? []).map((id: string) => [evidence.get(id)?.claim_text, evidence.get(id)?.quote]));
    const cited = (p.artifact_ids ?? []).map(keysFor);
    for (const raw of found) {
      total++;
      const key = `${decimals(raw)}:${numeric(raw).toFixed(decimals(raw))}`;
      if (local.has(key) || cited.some((keys: Set<string>) => keys.has(key))) matched++;
      else if (p.kind === "fact") unmatchedFacts.push({ section_id: String(section.id), figure: raw });
    }
  }
  return { figures: total, matched, rate: total ? matched / total : null, unmatched_fact_figures: unmatchedFacts.length, unmatched_examples: unmatchedFacts.slice(0, 12) };
}

export function runChecks(snapshot: RunSnapshot): CheckResult[] {
  const { artifacts, document, review } = snapshot;
  const record = latest(artifacts, "historical_record");
  const facts = latest(artifacts, "report_facts");
  const matrix = latest(artifacts, "expected_return_matrix");
  const cases = columnRows(facts?.cases);
  const checks: CheckResult[] = [];
  const ttm = Array.isArray(record?.ttm_series) ? record.ttm_series.length : 0;
  const stats = record?.statistics && typeof record.statistics === "object" ? Object.keys(record.statistics).length : 0;
  checks.push(result("ttm_statistics", "historical_record has TTM series and statistics", record ? ttm > 0 && stats > 0 : null,
    `${ttm} TTM rows, ${stats} statistics keys`, ttm));
  checks.push(result("analytics_pack", "financial_analytics saved by the run", stored(artifacts, "financial_analytics"),
    stored(artifacts, "financial_analytics") ? "stored" : latest(artifacts, "financial_analytics") ? "absent; computed in memory for these checks" : "absent"));
  checks.push(result("report_facts", "report_facts saved by the run", document ? stored(artifacts, "report_facts") : null,
    stored(artifacts, "report_facts") ? "stored" : facts ? "absent; computed in memory for these checks" : "absent"));
  const valued = facts?.valuation_status === "complete" && cases.length > 0;
  checks.push(result("no_rerating_return", "No-rerating return computed for every case", valued ? cases.every((c) => typeof c.no_rerating_return === "number") : null,
    cases.map((c) => `${c.case} ${c.no_rerating_return ?? "null"}`).join(", ") || "no valuation cases"));
  checks.push(result("fcf_yield", "FCF yield computed", facts ? typeof facts.market?.fcf_yield === "number" : null, `fcf_yield ${facts?.market?.fcf_yield ?? "null"}`, facts?.market?.fcf_yield ?? null));
  const tv = cases.map((c) => c.tv_share_of_ev).filter((v): v is number => typeof v === "number");
  checks.push(result("terminal_share", "Terminal value at most 85% of EV in every case", tv.length ? Math.max(...tv) <= 0.85 : null,
    cases.map((c) => `${c.case} ${c.tv_share_of_ev ?? "null"}`).join(", "), tv.length ? Math.max(...tv) : null));
  checks.push(result("tail_below_bear", "A permanent-loss case sits below bear", matrix && typeof matrix.permanent_loss_limit === "number"
    ? matrix.permanent_loss_limit !== matrix.bear_return : null, `permanent_loss_limit ${matrix?.permanent_loss_limit ?? "null"}, bear_return ${matrix?.bear_return ?? "null"}`));
  const derived = review ? deriveReview({ ...review, review_verdict: review.model_verdict ?? review.review_verdict }, artifacts) : null;
  checks.push(result("review_depth_checks", "Final review answered the depth checks", review ? Array.isArray(review.depth_checks) && review.depth_checks.length > 0 : null,
    Array.isArray(review?.depth_checks) ? `${review!.depth_checks.length} checks` : "no depth_checks (review predates them)"));
  const missing = (review?.depth_checks ?? []).filter((c: Row) => c.critical && c.status === "missing");
  checks.push(result("depth_critical_missing", "No decision-critical depth check missing", Array.isArray(review?.depth_checks) ? missing.length === 0 : null,
    missing.map((c: Row) => c.id).join(", ") || "none", missing.length));
  checks.push(result("effective_verdict", "Effective verdict allows position approval", derived ? isPassing(derived.effective_verdict) : null,
    derived ? `model ${derived.model_verdict}, effective ${derived.effective_verdict}; ${derived.blocking.map((b) => b.reason).join("; ") || "no blocking findings"}` : "no review",
    derived?.effective_verdict ?? null));
  if (document) {
    const reconciled = reconcileCoverage(document.coverage ?? [], undefined, { artifacts: artifacts as any, sections: document.sections ?? [], findings: review?.findings ?? [] });
    const changed = reconciled.filter((c, i) => c.status !== document.coverage[i]?.status).map((c) => c.key);
    checks.push(result("coverage_consistent", "Completeness table agrees with computed facts and review findings", changed.length === 0,
      changed.length ? `overstated: ${changed.join(", ")}` : "consistent"));
    const leaks = checkReportSubstance(document.sections ?? [], { questions: document.questions ?? [], coverage: document.coverage ?? [] });
    checks.push(result("reader_leaks", "No pipeline narration in reader-facing text", leaks.length === 0, `${leaks.length} hits`, leaks.length));
    const trace = figureTrace(document);
    checks.push(result("figure_trace", "Fact-paragraph figures trace to their cited inputs", trace ? trace.unmatched_fact_figures === 0 : null,
      trace ? `${trace.matched}/${trace.figures} traced (${trace.rate === null ? "n/a" : (trace.rate * 100).toFixed(0)}%), ${trace.unmatched_fact_figures} unmatched in fact paragraphs` : "no report",
      trace?.rate === null || !trace ? null : Number(trace.rate.toFixed(3))));
  } else checks.push(result("report_document", "Run has a report document", false, "no report_document"));
  checks.push(result("hygiene_after_cutoff", "No accepted claim from a document published after the cutoff", snapshot.hygiene.claims_after_cutoff === 0,
    `${snapshot.hygiene.claims_after_cutoff} of ${snapshot.hygiene.accepted_claims}; ${snapshot.hygiene.undated_claims} undated`, snapshot.hygiene.claims_after_cutoff));
  return checks;
}
