import type postgres from "postgres";
import type { WhatIfData } from "./whatif";
import { chooseArtifactVersions, loadArtifactMeta, loadReportPins } from "../reporting/report-pins";

type Sql = ReturnType<typeof postgres>;

const TYPES = ["valuation_scenario_set", "operating_scenario_set", "financial_analytics"] as const;

/**
 * The stored artifacts a what-if reads, for the workbench routes and the chat packet. Read only.
 *
 * When the run has a report, each artifact is the version the report was built from, so the workbench's baseline
 * equals the report's valuation. Without a report, it is the latest validated or accepted version. A validated or
 * accepted valuation stored after the report's is returned as `newerValuation` so the reader is told, not switched.
 */
export async function loadWhatIfData(sql: Sql, runId: string): Promise<WhatIfData> {
  const [meta, pins] = await Promise.all([loadArtifactMeta(sql, runId, TYPES), loadReportPins(sql, runId, TYPES)]);
  const { chosen, pinned, newer } = chooseArtifactVersions(meta, pins, (status) => status === "validated" || status === "accepted");
  const ids = Object.values(chosen);
  const rows = ids.length ? await sql`SELECT artifact_type, content_json FROM research_artifacts WHERE id = ANY(${ids})` : [];
  const content = (type: string) => (rows.find((r) => r.artifact_type === type)?.content_json ?? null) as Record<string, any> | null;
  const later = newer.valuation_scenario_set;
  return {
    valuation: content("valuation_scenario_set"), scenarios: content("operating_scenario_set"), analytics: content("financial_analytics"),
    pinnedToReport: pinned.valuation_scenario_set === true,
    newerValuation: later ? { version: later.artifact_version, createdAt: later.created_at } : null,
  };
}
