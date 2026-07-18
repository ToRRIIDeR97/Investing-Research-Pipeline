import type { V3RunContext, V3StageHandler, ValidationResult } from "../../v3-context";
import { v3ValidationResult } from "../../v3-context";
import postgres from "postgres";

export const researchPlanHandler: V3StageHandler<unknown> = {
  stageKey: "research_plan",
  async execute(ctx: V3RunContext): Promise<unknown> {
    // Stage requires human approval, so the orchestrated pipeline will transition it to waiting_for_human.
    // If we do execute, we just return success.
    return { status: "success" };
  },
  async validate(ctx: V3RunContext, output: any): Promise<ValidationResult> {
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
      return v3ValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
