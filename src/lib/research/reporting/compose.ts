import { Outline, Section, COVERAGE, type ReportOutline, type ReportSection } from "./contracts";
import { createReport, type ReportInput, type ReportDocument } from "./report";

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
  // The outline may start with the executive conclusion; write it after the body.
  for (const plan of [...outline.sections].sort((a,b) => Number(a.coverage.includes("conclusion")) - Number(b.coverage.includes("conclusion")))) {
    sections.push(await write(plan, []));
  }
  sections.sort((a,b) => outline.sections.findIndex(s => s.id === a.id) - outline.sections.findIndex(s => s.id === b.id));
  for (let round = 0; round <= 1; round++) {
    const document = createReport({ ...input, ...outline, sections });
    await actions.save("report_document", "document", document);
    const review = await actions.review(document);
    await actions.save("report_review", `review-${document.content_hash}`, { ...review, report_hash: document.content_hash, input_hash: document.input_hash, round });
    if (["pass", "conditional_pass"].includes(review.review_verdict) || round === 1) return { document, review };
    const researchFindings = review.findings.filter(f => f.category === "research_gap");
    if (researchFindings.length) {
      // Re-investigate the existing corpus once. Missing disclosures must become
      // qualified/blocked questions, not facts invented by the section writer.
      outline = Outline.parse(await actions.plan(researchFindings));
      await actions.save("report_outline", "outline", outline);
      await actions.save("question_register", "questions", { questions: outline.questions });
      const revised: ReportSection[] = [];
      for (const plan of [...outline.sections].sort((a,b) => Number(a.coverage.includes("conclusion")) - Number(b.coverage.includes("conclusion")))) {
        const prior = sections.find(s => s.id === plan.id);
        const affected = review.findings.some(f => !f.section_id || f.section_id === plan.id);
        revised.push(prior && !affected && !plan.coverage.includes("conclusion") &&
          JSON.stringify(prior.coverage) === JSON.stringify(plan.coverage) ? prior : await write(plan, review.findings, revised));
      }
      revised.sort((a,b) => outline.sections.findIndex(s => s.id === a.id) - outline.sections.findIndex(s => s.id === b.id));
      sections.splice(0, sections.length, ...revised);
      continue;
    }
    const writingFindings = review.findings;
    const affected = new Set(writingFindings.map(f => f.section_id).filter(Boolean));
    const repairOrder = sections.map((_, i) => i).sort((a,b) => Number(sections[a].coverage.includes("conclusion")) - Number(sections[b].coverage.includes("conclusion")));
    for (const i of repairOrder) {
      if (!affected.size || affected.has(sections[i].id) || sections[i].coverage.includes("conclusion")) {
        sections[i] = await write(outline.sections.find(s => s.id === sections[i].id)!, writingFindings);
      }
    }
  }
  throw new Error("Report review did not finish");
}

export const REQUIRED_COVERAGE = Object.keys(COVERAGE);
