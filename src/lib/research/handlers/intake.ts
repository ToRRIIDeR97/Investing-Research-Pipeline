import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";

export const intakeHandler: StageHandler<unknown> = {
  stageKey: "intake",
  async execute(ctx: ResearchRunContext): Promise<unknown> {
    if (!ctx.assetId) {
      throw new Error("Intake failed: missing assetId");
    }
    if (!ctx.runType) {
      throw new Error("Intake failed: missing runType");
    }
    if (!ctx.researchQuestion) {
      throw new Error("Intake failed: missing researchQuestion");
    }
    return { status: "success", validatedAt: new Date().toISOString() };
  },
  async validate(ctx: ResearchRunContext, output: any): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.assetId) errors.push("Missing assetId");
    if (!ctx.runType) errors.push("Missing runType");
    if (!ctx.researchQuestion) errors.push("Missing researchQuestion");
    return makeValidationResult(errors);
  }
};
