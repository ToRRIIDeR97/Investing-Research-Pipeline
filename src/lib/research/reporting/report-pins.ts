import type postgres from "postgres";

/**
 * The artifact versions a run's report was built from. A report document stores a copy of every artifact it used
 * (`report_document.artifacts`, each with its id). Views that sit beside the report (the research memo, the valuation
 * workbench and the chat's scenario packet) read those versions, so their numbers match the report even when a later
 * repair or re-valuation stored a newer version. A newer usable version is reported, never silently used.
 */

type Sql = ReturnType<typeof postgres>;

export interface ArtifactMeta { artifact_type: string; id: string; artifact_version: number; status: string; created_at: string | Date }
export interface NewerVersion { artifact_type: string; id: string; artifact_version: number; created_at: string }
export interface ChosenVersions {
  /** Artifact id to read for each type. */
  chosen: Record<string, string>;
  /** Types whose chosen id is the version the report recorded. */
  pinned: Record<string, boolean>;
  /** For pinned types, the newest usable version stored after the pinned one, if any. */
  newer: Record<string, NewerVersion>;
}

const time = (value: string | Date) => new Date(value).getTime();
const later = (a: ArtifactMeta, b: ArtifactMeta) => a.artifact_version !== b.artifact_version ? a.artifact_version > b.artifact_version : time(a.created_at) > time(b.created_at);

/**
 * Per artifact type: the version the report pinned when it is still stored (whatever its status), else the latest
 * usable version. For a pinned type, a usable version newer than the pin is returned in `newer`.
 */
export function chooseArtifactVersions(candidates: ArtifactMeta[], pins: Record<string, string>, usable: (status: string) => boolean): ChosenVersions {
  const out: ChosenVersions = { chosen: {}, pinned: {}, newer: {} };
  const types = [...new Set(candidates.map((c) => c.artifact_type))];
  for (const type of types) {
    const rows = candidates.filter((c) => c.artifact_type === type);
    const latestUsable = rows.filter((c) => usable(c.status)).reduce<ArtifactMeta | null>((best, c) => !best || later(c, best) ? c : best, null);
    const pin = pins[type] ? rows.find((c) => c.id === pins[type]) : undefined;
    if (pin) {
      out.chosen[type] = pin.id;
      out.pinned[type] = true;
      if (latestUsable && latestUsable.id !== pin.id && later(latestUsable, pin))
        out.newer[type] = { artifact_type: type, id: latestUsable.id, artifact_version: latestUsable.artifact_version, created_at: new Date(latestUsable.created_at).toISOString() };
    } else if (latestUsable) {
      out.chosen[type] = latestUsable.id;
      out.pinned[type] = false;
    }
  }
  return out;
}

/** Ids the run's current report document recorded for the given artifact types (empty when there is no report). */
export async function loadReportPins(sql: Sql, runId: string, types: readonly string[]): Promise<Record<string, string>> {
  const rows = await sql`
    SELECT COALESCE(a ->> 'artifact_type', a ->> 'type') AS artifact_type, a ->> 'id' AS id
    FROM (
      SELECT content_json FROM research_artifacts
      WHERE research_run_id = ${runId} AND artifact_type = 'report_document' AND status <> 'superseded'
      ORDER BY artifact_version DESC, created_at DESC LIMIT 1
    ) d,
    LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.content_json -> 'artifacts') = 'array' THEN d.content_json -> 'artifacts' ELSE '[]'::jsonb END) a
    WHERE COALESCE(a ->> 'artifact_type', a ->> 'type') = ANY(${types as string[]}) AND a ->> 'id' IS NOT NULL
  `;
  return Object.fromEntries(rows.map((r) => [String(r.artifact_type), String(r.id)]));
}

/** Version metadata (no bodies) for the given types. */
export async function loadArtifactMeta(sql: Sql, runId: string, types: readonly string[]): Promise<ArtifactMeta[]> {
  const rows = await sql`SELECT artifact_type, id, artifact_version, status, created_at FROM research_artifacts
    WHERE research_run_id = ${runId} AND artifact_type = ANY(${types as string[]})`;
  return rows.map((r) => ({ artifact_type: String(r.artifact_type), id: String(r.id), artifact_version: Number(r.artifact_version), status: String(r.status), created_at: r.created_at }));
}
