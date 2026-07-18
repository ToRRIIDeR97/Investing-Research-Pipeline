import type { V3RunContext, V3StageHandler, ValidationResult } from "../../v3-context";
import { v3ValidationResult } from "../../v3-context";
import { validateHumanReviewOutcome } from "@/lib/workflow/validators";
import postgres from "postgres";

export const humanReviewHandler: V3StageHandler<unknown> = {
  stageKey: "human_review",
  async execute(ctx: V3RunContext): Promise<unknown> {
    // Stage requires human approval, so the orchestrated pipeline will transition it to waiting_for_human.
    return { status: "success" };
  },
  async validate(ctx: V3RunContext, output: any): Promise<ValidationResult> {
    return await validateHumanReviewOutcome(ctx.runId);
  }
};
