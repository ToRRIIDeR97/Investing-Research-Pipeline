// Every research asset with its newest run and the key numbers of its newest run that has report_facts, for the
// home feed and the Research list. Reads only the small, code-computed artifacts (report_facts, the target path,
// the KPI dashboard and the price fields of valuation_scenario_set), never a report body.
import { sqlClient } from "@/db";
import { assetSnapshot, type AssetSnapshot } from "./asset-snapshot";

export interface AssetOverview {
  id: string; canonical_name: string; slug: string; asset_kind: string; sector: string | null; status: string | null;
  ticker: string | null;
  /** `waiting_stage_key`: the stage the latest run waits at for a person (prefers research_plan or human_review), else null. */
  latest_run: { id: string; status: string; run_type: string; created_at: string; waiting_stage_key: string | null } | null;
  snapshot: AssetSnapshot | null;
  snapshot_run: { id: string; status: string; created_at: string } | null;
}

export async function listAssetOverviews(): Promise<AssetOverview[]> {
  const assets = await sqlClient`
    SELECT a.id, a.canonical_name, a.slug, a.asset_kind, a.sector, a.status,
      (SELECT l.symbol FROM listings l JOIN instruments i ON i.id = l.instrument_id WHERE i.asset_id = a.id
       ORDER BY l.is_primary DESC, l.created_at ASC LIMIT 1) AS ticker,
      latest.id AS run_id, latest.status AS run_status, latest.run_type, latest.created_at AS run_created_at,
      (SELECT s.stage_key FROM research_stages s WHERE s.research_run_id = latest.id AND s.status = 'waiting_for_human'
       ORDER BY (s.stage_key IN ('research_plan', 'human_review')) DESC, s.stage_order ASC LIMIT 1) AS waiting_stage_key,
      valued.id AS valued_id, valued.status AS valued_status, valued.created_at AS valued_created_at
    FROM assets a
    LEFT JOIN LATERAL (SELECT rr.id, rr.status, rr.run_type, rr.created_at FROM research_runs rr WHERE rr.asset_id = a.id
      ORDER BY rr.created_at DESC LIMIT 1) latest ON true
    LEFT JOIN LATERAL (SELECT rr.id, rr.status, rr.created_at FROM research_runs rr WHERE rr.asset_id = a.id
      AND EXISTS (SELECT 1 FROM research_artifacts ra WHERE ra.research_run_id = rr.id AND ra.artifact_type = 'report_facts' AND ra.status <> 'superseded')
      ORDER BY rr.created_at DESC LIMIT 1) valued ON true
    WHERE a.status IS DISTINCT FROM 'reference'
    ORDER BY a.canonical_name ASC`;
  const runIds = assets.map((a) => a.valued_id).filter(Boolean) as string[];
  const artifacts = runIds.length ? await sqlClient`
    SELECT DISTINCT ON (research_run_id, artifact_type) research_run_id, artifact_type,
      CASE WHEN artifact_type = 'valuation_scenario_set'
        THEN jsonb_build_object('current_market_price', content_json->'current_market_price',
          'current_market_price_source', jsonb_build_object('verified', content_json->'current_market_price_source'->'verified'))
        ELSE content_json END AS content_json
    FROM research_artifacts
    WHERE research_run_id = ANY(${runIds}::uuid[]) AND status <> 'superseded'
      AND artifact_type IN ('report_facts', 'annual_price_target_path', 'monitoring_dashboard', 'valuation_scenario_set')
    ORDER BY research_run_id, artifact_type, artifact_version DESC, created_at DESC` : [];
  const byRun = new Map<string, { type: string; content_json: unknown }[]>();
  for (const row of artifacts) {
    const list = byRun.get(String(row.research_run_id)) ?? [];
    list.push({ type: String(row.artifact_type), content_json: row.content_json });
    byRun.set(String(row.research_run_id), list);
  }
  const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
  return assets.map((a) => ({
    id: String(a.id), canonical_name: String(a.canonical_name), slug: String(a.slug), asset_kind: String(a.asset_kind),
    sector: (a.sector as string | null) ?? null, status: (a.status as string | null) ?? null,
    ticker: a.asset_kind === "equity" && a.ticker ? String(a.ticker) : null,
    latest_run: a.run_id ? { id: String(a.run_id), status: String(a.run_status), run_type: String(a.run_type), created_at: iso(a.run_created_at),
    waiting_stage_key: a.waiting_stage_key == null ? null : String(a.waiting_stage_key) } : null,
    snapshot: a.valued_id ? assetSnapshot(byRun.get(String(a.valued_id)) ?? []) : null,
    snapshot_run: a.valued_id ? { id: String(a.valued_id), status: String(a.valued_status), created_at: iso(a.valued_created_at) } : null,
  }));
}
