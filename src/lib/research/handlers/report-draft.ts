import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { pipelineSql } from "@/db/pipeline-sql";
import { draftReport } from "../reporting/runtime";
import { saveVersionChangeLog } from "../lineage/runs";

/** The artifacts a finished draft leaves for the review stage. */
export const REPORT_DRAFT_ARTIFACTS = ["report_outline", "question_register", "report_section", "report_document"];

/** A plan with a report standard gets the adaptive report; an older plan gets the single-call review in ai_reviewer. */
export async function isAdaptiveReport(sql: ReturnType<typeof pipelineSql>, runId: string) {
  // The same test ai_reviewer has always made: some current research_plan carries a report_standard.
  const plans = await sql`SELECT content_json->'report_standard' AS standard FROM research_artifacts WHERE research_run_id = ${runId}
    AND artifact_type = 'research_plan' AND status IN ('validated', 'accepted')`;
  return plans.some(plan => Boolean(plan.standard));
}

export const reportDraftHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "report_draft",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = pipelineSql();
    if (!(await isAdaptiveReport(sql, ctx.runId))) {
      // The legacy review has no draft and makes no model call here; ai_reviewer reviews the artifacts directly.
      await saveVersionChangeLog(sql, ctx);
      return { drafted: false };
    }
    const draft = await draftReport(sql, ctx);
    return { drafted: true, sections: draft.sections.length, content_hash: draft.document.content_hash };
  },
  async validate(ctx: ResearchRunContext, output?: Record<string, unknown>): Promise<ValidationResult> {
    if (output && output.drafted === false) return makeValidationResult([]);
    const sql = pipelineSql();
    const rows = await sql`SELECT DISTINCT artifact_type FROM research_artifacts WHERE research_run_id = ${ctx.runId}
      AND artifact_type = ANY(${REPORT_DRAFT_ARTIFACTS}::text[]) AND status IN ('validated', 'accepted')`;
    const present = new Set(rows.map(row => String(row.artifact_type)));
    const [stage] = await sql`SELECT completion_criteria_json ? 'report_draft' AS saved FROM research_stages
      WHERE research_run_id = ${ctx.runId} AND stage_key = 'report_draft'`;
    const errors = REPORT_DRAFT_ARTIFACTS.filter(type => !present.has(type)).map(type => `Missing required artifact: ${type}`);
    if (!stage?.saved) errors.push("The report draft state was not saved");
    return makeValidationResult(errors);
  },
};
