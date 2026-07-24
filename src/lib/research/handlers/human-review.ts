import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { validateHumanReviewOutcome } from "@/lib/workflow/validators";
import postgres from "postgres";

export const humanReviewHandler: StageHandler<unknown> = {
  stageKey: "human_review",
  async execute(ctx: ResearchRunContext): Promise<unknown> {
    // Stage requires human approval, so the orchestrated pipeline will transition it to waiting_for_human.
    return { status: "success" };
  },
  async validate(ctx: ResearchRunContext, output: any): Promise<ValidationResult> {
    if (process.env.SKIP_V3_CONTENT_VALIDATORS === "true") {
      return makeValidationResult([]);
    }
    return await validateHumanReviewOutcome(ctx.runId);
  }
};
