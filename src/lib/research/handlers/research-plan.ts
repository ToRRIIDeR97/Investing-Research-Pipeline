import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import postgres from "postgres";

export const researchPlanHandler: StageHandler<unknown> = {
  stageKey: "research_plan",
  async execute(ctx: ResearchRunContext): Promise<unknown> {
    // Stage requires human approval, so the orchestrated pipeline will transition it to waiting_for_human.
    // If we do execute, we just return success.
    return { status: "success" };
  },
  async validate(ctx: ResearchRunContext, output: any): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const rows = await sql`
        SELECT completion_criteria_json
        FROM research_stages
        WHERE research_run_id = ${ctx.runId} AND stage_key = 'research_plan'
      `;
      const errors: string[] = [];
      if (rows.length === 0 || !rows[0].completion_criteria_json) {
        errors.push("Research plan JSON not found in stage completion criteria");
      }
      return makeValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
