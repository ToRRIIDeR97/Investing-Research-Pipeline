import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import postgres from "postgres";

export const refreshScheduleHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "refresh_schedule",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      // Deterministic refresh decision: refresh after 90 days for equity deep dives,
      // 180 days for quick scans, no automatic refresh for backtest_only.
      const [run] = await sql`
        SELECT run_type FROM research_runs WHERE id = ${ctx.runId} LIMIT 1
      `;
      const runType = String(run?.run_type || "quick_scan");
      const refreshDays = runType === "deep_dive" || runType === "full_initiation_report"
        ? 90 : runType === "backtest_only" ? null : 180;

      const decision = refreshDays
        ? {
            automatic_refresh: true,
            refresh_after_days: refreshDays,
            refresh_reason: `Scheduled refresh for ${runType} research run`,
            next_refresh_at: new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000).toISOString(),
          }
        : {
            automatic_refresh: false,
            refresh_after_days: null,
            refresh_reason: "No automatic refresh scheduled for backtest_only run type",
            next_refresh_at: null,
          };

      // Idempotent: only insert if no refresh schedule exists for this run
      const existing = await sql`
        SELECT id FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type = 'refresh_schedule'
        LIMIT 1
      `;

      if (!existing[0]) {
        await sql`
          INSERT INTO research_artifacts (
            research_run_id, asset_id, artifact_type, scope_key,
            status, content_json, schema_version, validator_version,
            prompt_version, created_by
          ) VALUES (
            ${ctx.runId}, ${ctx.assetId}, 'refresh_schedule',
            ${`${ctx.assetSlug}-refresh-schedule`},
            'validated',
            ${sql.json(decision)},
            '3.0.0', '1.0.0', 'current', 'system-research-os'
          )
        `;
      }

      return decision;
    } finally {
      await sql.end();
    }
  },
  async validate(_ctx: ResearchRunContext, output: unknown): Promise<ValidationResult> {
    const out = output as Record<string, unknown> | undefined;
    const errors: string[] = [];
    if (out === undefined || out === null) errors.push("No refresh schedule output");
    return makeValidationResult(errors);
  }
};
