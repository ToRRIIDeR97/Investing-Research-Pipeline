/**
 * Investment checklists (Implementations/research-workspace P3): items measured by code from a run's stored data or
 * judged by the model with cited evidence; a score of met weight over evaluated weight. Pure; the routes in
 * `src/lib/api/checklists.ts` store checklists and evaluations and make the one model call.
 */
import { z } from "zod";
import { MEASURES, MEASURE_KEYS, formatMeasure, measureValue, type ChecklistArtifact, type MeasureKey } from "./measures";

export { MEASURES, MEASURE_KEYS, formatMeasure, measureValue, type ChecklistArtifact, type MeasureKey, type MeasureResult, type MeasureUnit } from "./measures";

// Control characters and line or paragraph separators become spaces.
const CONTROL = new RegExp("[\u0000-\u001f\u007f-\u009f\u2028\u2029]", "g");
const text = (min: number, max: number) => z.string().transform((s) => s.replace(CONTROL, " ").replace(/\s+/g, " ").trim()).pipe(z.string().min(min).max(max));
const itemBase = { id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "Use letters, digits, - or _ (at most 40)"), label: text(1, 200), weight: z.number().int().min(1).max(3) };

export const ChecklistItem = z.discriminatedUnion("kind", [
  z.object({ ...itemBase, kind: z.literal("measure"), measure: z.enum(MEASURE_KEYS), op: z.enum([">=", "<="]), threshold: z.number().finite() }).strict(),
  z.object({ ...itemBase, kind: z.literal("judgement"), question: text(1, 500) }).strict(),
]);
export type ChecklistItem = z.infer<typeof ChecklistItem>;
export type MeasureItem = Extract<ChecklistItem, { kind: "measure" }>;
export type JudgementItem = Extract<ChecklistItem, { kind: "judgement" }>;

export const Checklist = z.object({ name: text(1, 120), items: z.array(ChecklistItem).min(1).max(30) }).strict()
  .refine((c) => new Set(c.items.map((i) => i.id)).size === c.items.length, { message: "Each item needs its own id", path: ["items"] });
export type Checklist = z.infer<typeof Checklist>;

export type ItemStatus = "met" | "not_met" | "unknown";
export type MeasureItemResult = { status: ItemStatus; value: number | null; display: string; reason: string };

/** A measure item's result: met or not against its threshold, or unknown with the reason the value is missing. */
export function evaluateMeasureItem(item: MeasureItem, artifacts: ChecklistArtifact[]): MeasureItemResult {
  const measured = measureValue(item.measure, artifacts);
  if (measured.value === null) return { status: "unknown", value: null, display: "—", reason: "reason" in measured ? measured.reason : "No value." };
  const met = item.op === ">=" ? measured.value >= item.threshold : measured.value <= item.threshold;
  const bar = `${item.op === ">=" ? "at least" : "at most"} ${formatMeasure(MEASURES[item.measure].unit, item.threshold)}`;
  return { status: met ? "met" : "not_met", value: measured.value, display: measured.display, reason: `${measured.display}, against ${bar}.` };
}

/** Met weight over evaluated weight; unknown items count in neither. `percent` is rounded to one decimal, null when nothing was evaluated. */
export function scoreChecklist(results: { weight: number; status: ItemStatus }[]) {
  let score = 0, max = 0, unknown = 0;
  for (const r of results) {
    if (r.status === "unknown") { unknown += 1; continue; }
    max += r.weight;
    if (r.status === "met") score += r.weight;
  }
  return { score, max, percent: max > 0 ? Math.round((score / max) * 1000) / 10 : null, unknown };
}

/** The model's answer for the judgement items. `unclear` scores as unknown. */
export const JudgementOutput = z.object({
  results: z.array(z.object({ id: z.string(), status: z.enum(["met", "not_met", "unclear"]), rationale: z.string().trim().min(1).max(600),
    evidence_ids: z.array(z.string()).max(20) }).strict()).max(30),
}).strict();
export type JudgementOutput = z.infer<typeof JudgementOutput>;

/**
 * Problems with the model's judgement output: its shape, an item it judged that is not a judgement item, one judged
 * twice or not at all, and evidence that is not this run's. An empty array means valid.
 */
export function judgementErrors(output: unknown, items: ChecklistItem[], evidenceIds: Set<string>): string[] {
  const parsed = JudgementOutput.safeParse(output);
  if (!parsed.success) return parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "output"}: ${i.message}`);
  const judged = items.filter((i) => i.kind === "judgement").map((i) => i.id);
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const r of parsed.data.results) {
    if (!judged.includes(r.id)) errors.push(`${r.id}: not a judgement item of this checklist.`);
    else if (seen.has(r.id)) errors.push(`${r.id}: judged more than once.`);
    seen.add(r.id);
    for (const e of r.evidence_ids) if (!evidenceIds.has(e)) errors.push(`${r.id}: evidence ${e} is not this run's.`);
  }
  for (const id of judged) if (!seen.has(id)) errors.push(`${id}: missing; judge every judgement item once.`);
  return errors;
}

/**
 * The default checklist, after the method in Nanalyze's theme videos: pure-play exposure, net debt repaid within three
 * years of free cash flow, a growth bar, an investment-grade balance sheet, a segment that tracks the theme,
 * management that met its targets, a dividend record and a valuation cutoff. Code measures what the stored data
 * holds (payback, growth over the history, P/E, terminal-value share); the model judges the rest from the report and
 * its evidence.
 */
export const DEFAULT_CHECKLIST: Checklist = {
  name: "Theme stock checklist",
  items: [
    { id: "pure_play", label: "Pure-play exposure to the theme", weight: 3, kind: "judgement",
      question: "Does most of the company's revenue (well over half) come from the theme it is held for, rather than from unrelated businesses?" },
    { id: "net_debt_payback", label: "Net debt repaid within three years of free cash flow", weight: 3, kind: "measure", measure: "net_debt_payback_years", op: "<=", threshold: 3 },
    { id: "growth_bar", label: "Revenue growth of at least 10% a year over the history", weight: 2, kind: "measure", measure: "revenue_yoy_median", op: ">=", threshold: 10 },
    { id: "balance_sheet", label: "Investment-grade balance sheet", weight: 2, kind: "judgement",
      question: "Is the balance sheet investment grade: rated BBB- or better, or with leverage and coverage consistent with that?" },
    { id: "theme_segment", label: "A reported segment that tracks the theme", weight: 2, kind: "judgement",
      question: "Does the company report a segment whose revenue tracks the theme, so exposure can be followed in its filings?" },
    { id: "management_targets", label: "Management met its prior targets", weight: 2, kind: "judgement",
      question: "Has management met or beaten the financial targets it set in prior years?" },
    { id: "dividend_record", label: "A record of paying and raising dividends", weight: 1, kind: "judgement",
      question: "Does the company have a record of paying a dividend and raising it?" },
    { id: "valuation_cutoff", label: "Trailing P/E at most 30x", weight: 2, kind: "measure", measure: "pe_ttm", op: "<=", threshold: 30 },
    { id: "terminal_share", label: "Terminal value at most 75% of enterprise value", weight: 1, kind: "measure", measure: "tv_share_of_ev", op: "<=", threshold: 75 },
  ],
};

export type ItemResult = { id: string; label: string; kind: "measure" | "judgement"; weight: number; status: ItemStatus;
  value: number | null; display: string; reason: string; evidence: { id: string; source_title: string; claim_text: string }[] };

/** Every item's result: measures from the artifacts; judgements from the model's checked output, or unknown with `judgementReason`. */
export function evaluateChecklist(checklist: Checklist, artifacts: ChecklistArtifact[], judgement: JudgementOutput | null, judgementReason: string,
  evidence: Map<string, { source_title: string; claim_text: string }> = new Map()): { results: ItemResult[]; score: ReturnType<typeof scoreChecklist> } {
  const results = checklist.items.map((item): ItemResult => {
    if (item.kind === "measure") {
      const r = evaluateMeasureItem(item, artifacts);
      return { id: item.id, label: item.label, kind: "measure", weight: item.weight, ...r, evidence: [] };
    }
    const answer = judgement?.results.find((r) => r.id === item.id);
    if (!answer) return { id: item.id, label: item.label, kind: "judgement", weight: item.weight, status: "unknown", value: null, display: "—", reason: judgementReason, evidence: [] };
    return { id: item.id, label: item.label, kind: "judgement", weight: item.weight, status: answer.status === "unclear" ? "unknown" : answer.status,
      value: null, display: answer.status === "met" ? "Yes" : answer.status === "not_met" ? "No" : "Unclear", reason: answer.rationale,
      evidence: answer.evidence_ids.map((id) => ({ id, source_title: evidence.get(id)?.source_title ?? "", claim_text: evidence.get(id)?.claim_text ?? "" })) };
  });
  return { results, score: scoreChecklist(results) };
}

export const isMeasureKey = (key: string): key is MeasureKey => (MEASURE_KEYS as readonly string[]).includes(key);
