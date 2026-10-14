// Evidence graph writes and reads: artifact citations, contradiction edges and graph seeds.
import type postgres from "postgres";

type Sql = postgres.Sql | postgres.TransactionSql;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** Keys whose string values, at any depth, cite evidence claims. */
export const CITATION_KEYS = ["evidence_ids", "evidence_claim_ids", "supporting_claim_ids", "claim_ids"];

function strings(value: unknown, into: Set<string>) {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, into);
}

/** Claim ids an artifact cites: UUID strings under a citation key, anywhere in its content. */
export function citedClaimIds(content: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (CITATION_KEYS.includes(key)) strings(child, found);
        walk(child);
      }
    }
  };
  walk(content);
  return [...new Set([...found].filter(isUuid).map(id => id.toLowerCase()))].sort();
}

/** Link an artifact to the claims of its run that it cites. Repeated saves add nothing. */
export async function linkArtifactCitations(sql: Sql, input: { artifactId: string; runId: string; content: unknown }): Promise<number> {
  const ids = citedClaimIds(input.content);
  if (!ids.length) return 0;
  const rows = await sql`INSERT INTO research_artifact_claim_links (artifact_id, evidence_claim_id, support_type)
    SELECT ${input.artifactId}, ec.id, 'cites' FROM evidence_claims ec
    WHERE ec.id = ANY(${ids}::uuid[]) AND ec.research_run_id = ${input.runId}
    ON CONFLICT (artifact_id, evidence_claim_id, support_type) DO NOTHING
    RETURNING id`;
  return rows.length;
}

const normalizedClaim = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

function confidenceOf(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

/**
 * Write `contradicts` edges for an output's `contradictions` entries
 * ({claim_texts: [a, b], description, confidence}) whose two claims are in the output and stored
 * for the run. Entries without a confidence in [0, 1] or naming unknown claims are skipped. The
 * pair is stored in id order, so the same contradiction is one edge whichever way it is named.
 */
export async function recordContradictions(sql: Sql, input: {
  runId: string; claimTexts: string[]; contradictions: unknown; extractor: string; extractorVersion: string;
}): Promise<number> {
  if (!Array.isArray(input.contradictions) || !input.contradictions.length) return 0;
  const offered = new Map(input.claimTexts.map(text => [normalizedClaim(text), text]));
  const entries = input.contradictions.flatMap(entry => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const texts = record.claim_texts;
    const confidence = confidenceOf(record.confidence);
    if (!Array.isArray(texts) || texts.length !== 2 || !texts.every(text => typeof text === "string") || confidence === null) return [];
    const [a, b] = (texts as string[]).map(text => offered.get(normalizedClaim(text)));
    if (!a || !b || a === b) return [];
    return [{ a, b, confidence, description: typeof record.description === "string" ? record.description.slice(0, 2000) : null }];
  });
  if (!entries.length) return 0;
  const wanted = [...new Set(entries.flatMap(entry => [entry.a, entry.b]))];
  const stored = await sql`SELECT DISTINCT ON (ec.id) ec.id, ec.claim_text, sl.id AS location_id
    FROM evidence_claims ec
    LEFT JOIN evidence_links el ON el.evidence_claim_id = ec.id
    LEFT JOIN source_locations sl ON sl.id = el.source_location_id
    WHERE ec.research_run_id = ${input.runId} AND ec.claim_text = ANY(${wanted}::text[])
    ORDER BY ec.id, el.created_at ASC NULLS LAST`;
  const byText = new Map<string, { id: string; locationId: string | null }>();
  for (const row of stored) if (!byText.has(String(row.claim_text))) byText.set(String(row.claim_text), { id: String(row.id), locationId: row.location_id ? String(row.location_id) : null });
  let written = 0;
  for (const entry of entries) {
    const first = byText.get(entry.a), second = byText.get(entry.b);
    if (!first || !second || first.id === second.id) continue;
    const [from, to] = first.id < second.id ? [first, second] : [second, first];
    const locations = [from.locationId, to.locationId].filter((id): id is string => Boolean(id));
    const rows = await sql`INSERT INTO claim_relationships
      (from_claim_id, to_claim_id, relationship_type, confidence, extractor, extractor_version, evidence_location_ids, review_status, description)
      VALUES (${from.id}, ${to.id}, 'contradicts', ${entry.confidence.toString()}, ${input.extractor}, ${input.extractorVersion},
        ${sql.json(locations)}, 'unreviewed', ${entry.description})
      ON CONFLICT (from_claim_id, to_claim_id, relationship_type) DO NOTHING
      RETURNING id`;
    written += rows.length;
  }
  return written;
}

export interface GraphPassage { passageId: string; seed: boolean; /** Distinct seed claims the passage holds. */ citations: number }

/**
 * Passages of the given parses that hold the seed claims (directly, or through the claims an
 * artifact cites) or the claims one unrejected relationship away from them. At most `limit`
 * (default 50): those holding the most seed claims first, then the newest filing, then document order.
 */
export async function graphPassages(sql: Sql, input: { parseIds: string[]; seedClaimIds?: string[]; seedArtifactIds?: string[]; limit?: number }): Promise<GraphPassage[]> {
  const claimIds = (input.seedClaimIds || []).filter(isUuid);
  const artifactIds = (input.seedArtifactIds || []).filter(isUuid);
  if (!input.parseIds.length || (!claimIds.length && !artifactIds.length)) return [];
  const rows = await sql`
    WITH seed AS (
      SELECT unnest(${claimIds}::uuid[]) AS claim_id
      UNION SELECT evidence_claim_id FROM research_artifact_claim_links WHERE artifact_id = ANY(${artifactIds}::uuid[])
    ),
    hop AS (
      SELECT cr.to_claim_id AS claim_id FROM claim_relationships cr JOIN seed ON seed.claim_id = cr.from_claim_id WHERE cr.review_status <> 'rejected'
      UNION SELECT cr.from_claim_id FROM claim_relationships cr JOIN seed ON seed.claim_id = cr.to_claim_id WHERE cr.review_status <> 'rejected'
    ),
    claims AS (SELECT claim_id, true AS seed FROM seed UNION ALL SELECT claim_id, false FROM hop)
    SELECT sl.document_chunk_id AS passage_id, bool_or(claims.seed) AS seed, count(DISTINCT claims.claim_id) FILTER (WHERE claims.seed) AS citations
    FROM claims
    JOIN evidence_links el ON el.evidence_claim_id = claims.claim_id
    JOIN source_locations sl ON sl.id = el.source_location_id
    JOIN document_chunks dc ON dc.id = sl.document_chunk_id
    JOIN source_documents sd ON sd.id = dc.source_document_id
    WHERE dc.document_parse_id = ANY(${input.parseIds}::uuid[])
    GROUP BY sl.document_chunk_id, sd.period_end, sd.published_at, dc.source_document_id, dc.chunk_index
    ORDER BY citations DESC, sd.period_end DESC NULLS LAST, sd.published_at DESC NULLS LAST, dc.source_document_id, dc.chunk_index
    LIMIT ${Math.max(1, Math.floor(input.limit ?? 50))}`;
  return rows.map(row => ({ passageId: String(row.passage_id), seed: Boolean(row.seed), citations: Number(row.citations) }));
}
