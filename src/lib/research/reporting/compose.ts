import { Outline, Section, COVERAGE, type ReportOutline, type ReportSection } from "./contracts";
import { createReport, type ReportInput, type ReportDocument } from "./report";
import { mapWithConcurrency } from "../pipeline-helpers";
import { checkReportSubstance } from "./substance";

const isConclusion = (plan: { coverage: string[] }) => plan.coverage.includes("conclusion");

export interface ReportReview extends Record<string, unknown> {
  review_summary: string; findings: Record<string, any>[]; quality_score: number;
  recommendations: Record<string, any>[]; review_verdict: string;
}
export interface CompositionActions {
  plan(feedback: Record<string, any>[]): Promise<ReportOutline>;
  write(plan: ReportOutline["sections"][number], outline: ReportOutline, feedback: Record<string, any>[], completed: ReportSection[]): Promise<ReportSection>;
  review(document: ReportDocument): Promise<ReportReview>;
  save(type: string, scope: string, value: Record<string, any>): Promise<unknown>;
}

/** One repair round, even after restart: callers cache calls by input content. */
export async function composeReviewedReport(input: Omit<ReportInput, "sections" | "coverage" | "questions">, actions: CompositionActions) {
  let outline = Outline.parse(await actions.plan([]));
  await actions.save("report_outline", "outline", outline);
  await actions.save("question_register", "questions", { questions: outline.questions });
  const sections: ReportSection[] = [];
  async function write(plan: ReportOutline["sections"][number], feedback: Record<string, any>[], completed = sections) {
    const section = Section.parse(await actions.write(plan, outline, feedback, completed));
    if (section.id !== plan.id || JSON.stringify(section.coverage) !== JSON.stringify(plan.coverage)) throw new Error("Writer changed section identity or coverage");
    await actions.save("report_section", section.id, section);
    return section;
  }
  // The outline may start with the executive conclusion; write it after the body. Body sections never
  // read each other, so they are written together (results in outline order); each conclusion reads
  // every section finished before it.
  const body = (plans: ReportOutline["sections"]) => plans.filter(plan => !isConclusion(plan));
  const conclusions = (plans: ReportOutline["sections"]) => plans.filter(isConclusion);
  sections.push(...await mapWithConcurrency(body(outline.sections), plan => write(plan, [], [])));
  for (const plan of conclusions(outline.sections)) sections.push(await write(plan, []));
  sections.sort((a,b) => outline.sections.findIndex(s => s.id === a.id) - outline.sections.findIndex(s => s.id === b.id));
  for (let round = 0; round <= 1; round++) {
    const document = createReport({ ...input, ...outline, sections });
    await actions.save("report_document", "document", document);
    // Substance findings join the reviewer's, so a passed review with thin or leaking sections still gets the one repair.
    const reviewed = await actions.review(document);
    const substance = checkReportSubstance(document.sections);
    const review = substance.length ? { ...reviewed, findings: [...reviewed.findings, ...substance] } : reviewed;
    await actions.save("report_review", `review-${document.content_hash}`, { ...review, report_hash: document.content_hash, input_hash: document.input_hash, round });
    if ((["pass", "conditional_pass"].includes(review.review_verdict) && !substance.length) || round === 1) return { document, review };
    const researchFindings = review.findings.filter(f => f.category === "research_gap");
    if (researchFindings.length) {
      // Re-investigate the existing corpus once. Missing disclosures must become
      // qualified/blocked questions, not facts invented by the section writer.
      outline = Outline.parse(await actions.plan(researchFindings));
      await actions.save("report_outline", "outline", outline);
      await actions.save("question_register", "questions", { questions: outline.questions });
      const revised: ReportSection[] = await mapWithConcurrency(body(outline.sections), plan => {
        const prior = sections.find(s => s.id === plan.id);
        const affected = review.findings.some(f => !f.section_id || f.section_id === plan.id);
        return prior && !affected && JSON.stringify(prior.coverage) === JSON.stringify(plan.coverage)
          ? Promise.resolve(prior) : write(plan, review.findings, []);
      });
      for (const plan of conclusions(outline.sections)) revised.push(await write(plan, review.findings, revised));
      revised.sort((a,b) => outline.sections.findIndex(s => s.id === a.id) - outline.sections.findIndex(s => s.id === b.id));
      sections.splice(0, sections.length, ...revised);
      continue;
    }
    const writingFindings = review.findings;
    const affected = new Set(writingFindings.map(f => f.section_id).filter(Boolean));
    const planOf = (i: number) => outline.sections.find(s => s.id === sections[i].id)!;
    const indexes = sections.map((_, i) => i);
    const repairBody = indexes.filter(i => !isConclusion(sections[i]) && (!affected.size || affected.has(sections[i].id)));
    (await mapWithConcurrency(repairBody, i => write(planOf(i), writingFindings, []))).forEach((section, k) => { sections[repairBody[k]] = section; });
    for (const i of indexes.filter(i => isConclusion(sections[i]))) sections[i] = await write(planOf(i), writingFindings);
  }
  throw new Error("Report review did not finish");
}

export const REQUIRED_COVERAGE = Object.keys(COVERAGE);
