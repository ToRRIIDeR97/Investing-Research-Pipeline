import type { V3RunContext, V3StageHandler, ValidationResult } from "../../v3-context";
import { v3ValidationResult } from "../../v3-context";
import { callV3Agent, v3ExactJsonPrompt } from "../../v3-context";
import postgres from "postgres";

const REVIEWER_OUTPUT_KEYS = [
  "pass_fail",
  "findings",
  "unsupported_claims",
  "contradictions",
  "category_errors",
  "missing_coverage",
  "valuation_review",
  "backtest_review",
  "escalation_recommendations",
];

export const aiReviewerHandler: V3StageHandler<unknown> = {
  stageKey: "ai_reviewer",
  async execute(ctx: V3RunContext): Promise<unknown> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const taskKey = "research-reviewer:review";
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
      };

      const promptFactory = (p: Record<string, unknown>) => v3ExactJsonPrompt({
        agentName: "research-reviewer",
        requiredKeys: REVIEWER_OUTPUT_KEYS,
        packet: p,
        extraRules: [
          "Perform a comprehensive review checking consistency and rules compliance across all generated v3 artifacts.",
        ],
      });

      const output = await callV3Agent<Record<string, unknown>>({
        sql, ctx, stageKey: "ai_reviewer", taskKey,
        taskType: "ai_review", agentName: "research-reviewer", modelTier: "cheap",
        packet, promptFactory,
      });

      return output;
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: V3RunContext, output: any): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const rows = await sql`
        SELECT output_json FROM research_tasks
        WHERE research_run_id = ${ctx.runId}
          AND task_type = 'ai_review'
          AND status = 'completed'
      `;
      const errors: string[] = [];
      if (rows.length === 0) {
        errors.push("AI reviewer has not produced review findings");
      }
      return v3ValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
