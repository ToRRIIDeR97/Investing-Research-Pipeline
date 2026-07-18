import type { V3RunContext, V3StageHandler, ValidationResult } from "../../v3-context";
import { v3ValidationResult } from "../../v3-context";

export const intakeHandler: V3StageHandler<unknown> = {
  stageKey: "intake",
  async execute(ctx: V3RunContext): Promise<unknown> {
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
  async validate(ctx: V3RunContext, output: any): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.assetId) errors.push("Missing assetId");
    if (!ctx.runType) errors.push("Missing runType");
    if (!ctx.researchQuestion) errors.push("Missing researchQuestion");
    return v3ValidationResult(errors);
  }
};
