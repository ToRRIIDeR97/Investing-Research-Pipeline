import type postgres from "postgres";
import type { WhatIfData } from "./whatif";

type Sql = ReturnType<typeof postgres>;

/**
 * The stored artifacts a what-if reads (the latest validated or accepted version of each), for the workbench routes
 * and the chat packet. Read only.
 */
export async function loadWhatIfData(sql: Sql, runId: string): Promise<WhatIfData> {
  const rows = await sql`SELECT DISTINCT ON (artifact_type) artifact_type, content_json FROM research_artifacts
    WHERE research_run_id = ${runId} AND status IN ('validated', 'accepted')
      AND artifact_type IN ('valuation_scenario_set', 'operating_scenario_set', 'financial_analytics')
    ORDER BY artifact_type, artifact_version DESC, created_at DESC`;
  const content = (type: string) => (rows.find((r) => r.artifact_type === type)?.content_json ?? null) as Record<string, any> | null;
  return { valuation: content("valuation_scenario_set"), scenarios: content("operating_scenario_set"), analytics: content("financial_analytics") };
}
