/**
 * Depth probes: facts a run's own database holds, checked against what its report says. A probe flags a fact
 * the report calls unavailable, or never mentions, although the run stored it (GAP-3-7). SELECT-only.
 */
import type { Sql } from "../run-context";
import { sectionProse } from "./checks";

type Row = Record<string, any>;
export type ProbeData =
  | { source: "observations"; metric_key: string; segment?: string; periodicity?: string; min?: number }
  | { source: "chunks" | "claims"; text: string; also?: string; min?: number };
export interface ProbeSpec { id: string; label: string; data: ProbeData; report: { topic: string; value?: string } }
export type ProbeStatus = "reported" | "reported_unavailable" | "missed" | "not_in_data";
export interface ProbeResult { id: string; label: string; status: ProbeStatus; data_count: number; flagged: boolean; sentence?: string }

/** Language that says a fact can't be had. A topic sentence with it, about stored data, is the defect probes catch. */
export const UNAVAILABLE = /\b(?:not (?:available|disclosed|provided|reported|found|documented|quantified|computed|in the (?:reviewed|supplied|stored)\b[a-z ]*)|unavailable|undisclosed|undocumented|cannot be (?:assessed|determined|verified|confirmed|quantified|computed|evaluated)|could not be (?:found|located|verified|assessed)|no (?:data|disclosure|evidence|information) (?:on|for|of|about))\b/i;

/** Postgres and JavaScript regexes agree on the simple patterns probes use (alternation, classes, \. and ?). */
export async function probeDataCount(sql: Sql, runId: string, data: ProbeData): Promise<number> {
  if (data.source === "observations") {
    const [row] = await sql`SELECT count(*)::int AS n FROM research_artifacts a, jsonb_array_elements(a.content_json->'observations') o
      WHERE a.research_run_id = ${runId} AND a.status <> 'superseded' AND a.artifact_type IN ('historical_record', 'financial_statement_set')
        AND o->>'metric_key' ~* ${data.metric_key}
        AND (${data.segment ?? null}::text IS NULL OR COALESCE(o->>'segment', '') ~* ${data.segment ?? ""})
        AND (${data.periodicity ?? null}::text IS NULL OR o->>'periodicity' = ${data.periodicity ?? ""})`;
    return Number(row?.n ?? 0);
  }
  if (data.source === "claims") {
    const [row] = await sql`SELECT count(*)::int AS n FROM evidence_claims WHERE research_run_id = ${runId}
      AND claim_text ~* ${data.text} AND (${data.also ?? null}::text IS NULL OR claim_text ~* ${data.also ?? ""})`;
    return Number(row?.n ?? 0);
  }
  const [row] = await sql`SELECT count(*)::int AS n FROM document_chunks c WHERE c.source_document_id IN (
      SELECT id FROM source_documents WHERE research_run_id = ${runId}
      UNION SELECT source_document_id FROM research_run_sources WHERE research_run_id = ${runId})
    AND c.text ~* ${data.text} AND (${data.also ?? null}::text IS NULL OR c.text ~* ${data.also ?? ""})`;
  return Number(row?.n ?? 0);
}

/** Every reader-facing sentence: prose, gaps, research questions and coverage rationales. */
export function reportSentences(document: Row | null): string[] {
  if (!document) return [];
  const texts = [...(document.sections ?? []).flatMap((s: Row) => [...sectionProse(s), ...(s.gaps ?? [])]),
    ...(document.questions ?? []).flatMap((q: Row) => [q.question, q.answer]), ...(document.coverage ?? []).map((c: Row) => c.rationale)];
  return texts.filter(Boolean).flatMap((t: string) => String(t).split(/(?<=[.!?;])\s+/));
}

/** A topic sentence that says the fact is unavailable outranks one that reports it: the report contradicts its data. */
export function probeReport(spec: ProbeSpec, sentences: string[]): { status: "reported" | "reported_unavailable" | "absent"; sentence?: string } {
  const topic = new RegExp(spec.report.topic, "i");
  const value = spec.report.value ? new RegExp(spec.report.value, "i") : null;
  const onTopic = sentences.filter((s) => topic.test(s) || (value?.test(s) ?? false));
  const unavailable = onTopic.find((s) => UNAVAILABLE.test(s));
  if (unavailable) return { status: "reported_unavailable", sentence: unavailable };
  const reported = onTopic.find((s) => value ? value.test(s) : true);
  return reported ? { status: "reported", sentence: reported } : { status: "absent" };
}

export function probeStatus(count: number, spec: ProbeSpec, report: ReturnType<typeof probeReport>): ProbeResult {
  const present = count >= (spec.data.min ?? 1);
  const status: ProbeStatus = !present ? "not_in_data" : report.status === "absent" ? "missed" : report.status;
  return { id: spec.id, label: spec.label, status, data_count: count, flagged: status === "missed" || status === "reported_unavailable",
    ...(report.sentence ? { sentence: report.sentence.slice(0, 300) } : {}) };
}

export async function runProbes(sql: Sql, runId: string, document: Row | null, specs: ProbeSpec[]): Promise<ProbeResult[]> {
  const sentences = reportSentences(document);
  const results: ProbeResult[] = [];
  for (const spec of specs) results.push(probeStatus(await probeDataCount(sql, runId, spec.data), spec, probeReport(spec, sentences)));
  return results;
}
