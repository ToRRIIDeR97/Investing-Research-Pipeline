import { Outline, Section, COVERAGE, CoverageResult, type ReportOutline, type ReportSection, type CoverageCheck } from "./contracts";
import { createReport, type ReportInput, type ReportDocument } from "./report";
import { mapWithConcurrency } from "../pipeline-helpers";
import { checkReportSubstance } from "./substance";
import { deriveReview, depthFindings, isPassing, type DepthCheck, type DerivedReview } from "./depth";

const isConclusion = (plan: { coverage: string[] }) => plan.coverage.includes("conclusion");

export interface ReportReview extends Record<string, unknown> {
  review_summary: string; findings: Record<string, any>[]; quality_score: number;
  recommendations: Record<string, any>[]; review_verdict: string; depth_checks?: DepthCheck[];
}
/** A written section; the report's last conclusion also returns the final coverage, reconciled with what the chapters did. */
export type WrittenSection = ReportSection & { final_coverage?: CoverageCheck[] };
export interface CompositionActions {
  plan(feedback: Record<string, any>[]): Promise<ReportOutline>;
  /** `coverage` is set for the last conclusion: the provisional coverage it must return reconciled. */
  write(plan: ReportOutline["sections"][number], outline: ReportOutline, feedback: Record<string, any>[], completed: ReportSection[],
    options?: { coverage?: CoverageCheck[] }): Promise<WrittenSection>;
  review(document: ReportDocument): Promise<ReportReview>;
  /**
   * After the first review is saved: ask the owning specialists about its findings, at most once per run. It may
   * pause the run for their answers; on resume it returns them as repair feedback.
   */
  rework?(review: ReportReview & DerivedReview): Promise<Record<string, any>[]>;
  save(type: string, scope: string, value: Record<string, any>): Promise<unknown>;
}

const latestContent = (artifacts: ReportInput["artifacts"], type: string) => artifacts.filter(a => a.artifact_type === type)
  .sort((a, b) => b.artifact_version - a.artifact_version)[0]?.content_json ?? null;
const UNTESTABLE = /\bthresholds?\b[^.]*\b(?:cannot|can't|could not|not) be (?:tested|computed|measured|monitored)|\buntestable\b/i;

/**
 * The planner's coverage, with the statuses and rationales the last conclusion writer returned (it read every
 * chapter), then checked against what code knows: downside cannot be satisfied without a computed no-rerating
 * return unless a downside chapter's gap says so, and monitoring cannot be satisfied while a review finding says
 * its thresholds can't be tested. Section links stay the planner's, which the chapters were written to.
 */
export function reconcileCoverage(planned: CoverageCheck[], returned: CoverageCheck[] | undefined,
  context: { artifacts: ReportInput["artifacts"]; sections: ReportSection[]; findings?: Record<string, any>[] }): CoverageCheck[] {
  const merged = planned.map(p => {
    const r = returned?.find(c => c.key === p.key);
    return r ? { ...p, status: r.status, rationale: r.rationale } : { ...p };
  });
  const facts = latestContent(context.artifacts, "report_facts");
  const sectionsOf = (check: CoverageCheck) => context.sections.filter(s => check.section_ids.includes(s.id));
  const downside = merged.find(c => c.key === "downside");
  if (facts && downside && ["satisfied", "qualified"].includes(downside.status)) {
    const columns: string[] = facts.cases?.columns ?? [];
    const at = columns.indexOf("no_rerating_return");
    const computed = at >= 0 && (facts.cases?.rows ?? []).some((row: unknown[]) => typeof row[at] === "number");
    const stated = sectionsOf(downside).some(s => s.gaps.some(g => /no[- ]?re-?rating/i.test(g)));
    if (!computed && !stated) Object.assign(downside, { status: "qualified", rationale: `${downside.rationale} The no-rerating return is not computed.` });
  }
  const monitoring = merged.find(c => c.key === "monitoring");
  if (monitoring?.status === "satisfied" && (context.findings ?? []).some(f =>
    (!f.section_id || monitoring.section_ids.includes(f.section_id)) && UNTESTABLE.test(Object.values(f).filter(v => typeof v === "string").join(" "))))
    Object.assign(monitoring, { status: "qualified", rationale: `${monitoring.rationale} A review finding says the thresholds cannot yet be tested.` });
  return merged;
}

/** The conclusion writer's coverage as the report would use it; throws when it doesn't validate against the report. */
export function checkFinalCoverage(input: Omit<ReportInput, "sections" | "coverage" | "questions">, outline: ReportOutline,
  sections: ReportSection[], returned: CoverageCheck[]) {
  const keys = new Set(outline.coverage.map(c => c.key));
  const extra = returned.filter(c => !keys.has(c.key)).map(c => c.key);
  if (extra.length) throw new Error(`coverage keys must be the outline's: unknown ${extra.join(", ")}`);
  if (new Set(returned.map(c => c.key)).size !== returned.length) throw new Error("coverage lists a key twice");
  returned.forEach(c => CoverageResult.parse(c));
  createReport({ ...input, ...outline, sections, coverage: reconcileCoverage(outline.coverage, returned, { artifacts: input.artifacts, sections }) });
}

const severe = (f: Record<string, any>) => ["high", "critical"].includes(String(f.severity ?? "").toLowerCase());

/** One repair round, even after restart: callers cache calls by input content. */
export async function composeReviewedReport(input: Omit<ReportInput, "sections" | "coverage" | "questions">, actions: CompositionActions) {
  let outline = Outline.parse(await actions.plan([]));
  await actions.save("report_outline", "outline", outline);
  await actions.save("question_register", "questions", { questions: outline.questions });
  const sections: ReportSection[] = [];
  let finalCoverage: CoverageCheck[] | undefined;
  async function write(plan: ReportOutline["sections"][number], feedback: Record<string, any>[], completed = sections, last = false) {
    const written = await actions.write(plan, outline, feedback, completed, last ? { coverage: outline.coverage } : undefined);
    const section = Section.parse(written);
    if (section.id !== plan.id || JSON.stringify(section.coverage) !== JSON.stringify(plan.coverage)) throw new Error("Writer changed section identity or coverage");
    if (last && Array.isArray(written.final_coverage)) finalCoverage = written.final_coverage;
    await actions.save("report_section", section.id, section);
    return section;
  }
  // The outline may start with the executive conclusion; write it after the body. Body sections never
  // read each other, so they are written together (results in outline order); each conclusion reads
  // every section finished before it, and the last one also returns the final coverage.
  const body = (plans: ReportOutline["sections"]) => plans.filter(plan => !isConclusion(plan));
  const conclusions = (plans: ReportOutline["sections"]) => plans.filter(isConclusion);
  const writeConclusions = async (plans: ReportOutline["sections"], feedback: Record<string, any>[], done: ReportSection[]) => {
    const list = conclusions(plans);
    for (const [i, plan] of list.entries()) done.push(await write(plan, feedback, done, i === list.length - 1));
  };
  sections.push(...await mapWithConcurrency(body(outline.sections), plan => write(plan, [], [])));
  await writeConclusions(outline.sections, [], sections);
  sections.sort((a,b) => outline.sections.findIndex(s => s.id === a.id) - outline.sections.findIndex(s => s.id === b.id));
  let priorFindings: Record<string, any>[] = [];
  for (let round = 0; round <= 1; round++) {
    const coverage = reconcileCoverage(outline.coverage, finalCoverage, { artifacts: input.artifacts, sections, findings: priorFindings });
    const document = createReport({ ...input, ...outline, coverage, sections });
    await actions.save("report_document", "document", document);
    // Substance findings join the reviewer's, so a passed review with thin or leaking sections still gets the one repair.
    const reviewed = await actions.review(document);
    // Question and coverage leaks are shown to the reviewer; only section text can be repaired by a writer.
    const leaks = checkReportSubstance(document.sections, { questions: document.questions, coverage: document.coverage });
    const substance = leaks.filter(f => f.section_id);
    const derived = deriveReview(reviewed, input.artifacts);
    const review = { ...reviewed, findings: [...reviewed.findings, ...leaks], ...derived };
    await actions.save("report_review", `review-${document.content_hash}`, { ...review, report_hash: document.content_hash, input_hash: document.input_hash, round });
    // Open high or critical findings get the repair even under conditional_pass; the model's severity is enough to try once.
    const passed = isPassing(review.effective_verdict) && !reviewed.findings.some(severe);
    if ((passed && !substance.length) || round === 1) return { document, review };
    priorFindings = review.findings;
    const answers = !passed && actions.rework ? await actions.rework(review) : [];
    const findings = [...review.findings.filter(f => f.source !== "substance_check" || f.section_id), ...depthFindings(review.depth_checks, outline.sections)];
    const feedback = [...findings, ...answers];
    // A passed review repairs only the substance findings: no outline re-plan, only the flagged sections and conclusions.
    const researchFindings = passed ? [] : findings.filter(f => f.category === "research_gap");
    if (researchFindings.length) {
      // Re-investigate the existing corpus once. Missing disclosures must become
      // qualified/blocked questions, not facts invented by the section writer.
      outline = Outline.parse(await actions.plan(researchFindings));
      await actions.save("report_outline", "outline", outline);
      await actions.save("question_register", "questions", { questions: outline.questions });
      const revised: ReportSection[] = await mapWithConcurrency(body(outline.sections), plan => {
        const prior = sections.find(s => s.id === plan.id);
        const affected = findings.some(f => !f.section_id || f.section_id === plan.id);
        return prior && !affected && JSON.stringify(prior.coverage) === JSON.stringify(plan.coverage)
          ? Promise.resolve(prior) : write(plan, feedback, []);
      });
      await writeConclusions(outline.sections, feedback, revised);
      revised.sort((a,b) => outline.sections.findIndex(s => s.id === a.id) - outline.sections.findIndex(s => s.id === b.id));
      sections.splice(0, sections.length, ...revised);
      continue;
    }
    const writingFindings = passed ? substance : findings;
    const affected = new Set(writingFindings.map(f => f.section_id).filter(Boolean));
    const planOf = (i: number) => outline.sections.find(s => s.id === sections[i].id)!;
    const indexes = sections.map((_, i) => i);
    const repairBody = indexes.filter(i => !isConclusion(sections[i]) && (!affected.size || affected.has(sections[i].id)));
    const repairFeedback = passed ? substance : feedback;
    (await mapWithConcurrency(repairBody, i => write(planOf(i), repairFeedback, []))).forEach((section, k) => { sections[repairBody[k]] = section; });
    const last = indexes.filter(i => isConclusion(sections[i])).at(-1);
    for (const i of indexes.filter(i => isConclusion(sections[i]))) sections[i] = await write(planOf(i), repairFeedback, sections, i === last);
  }
  throw new Error("Report review did not finish");
}

export const REQUIRED_COVERAGE = Object.keys(COVERAGE);
