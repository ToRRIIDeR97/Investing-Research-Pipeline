/**
 * prior_research: a compact, code-built summary of the asset's previous run, carried into the next run's
 * analysis and report packets so the research builds on what was already found instead of starting over.
 * Pure: the database reads live in ./runs.ts.
 */
import { valuationSnapshot, type ValuationSnapshot } from "./change-log";

type Row = Record<string, any>;

/** Upper bound on the serialized block, so it never crowds the cached packet prefix. */
export const PRIOR_RESEARCH_MAX_BYTES = 10 * 1024;
const TEXT_LIMIT = 400;
const TITLE_LIMIT = 140;

/** Analysis stages and the report stage whose model calls carry prior_research in their shared packet prefix. */
export const PRIOR_RESEARCH_STAGES = new Set(["historical_diagnosis", "company_genesis", "business_process_analysis", "moat_analysis",
  "operating_model", "operating_scenarios", "asset_valuation", "decision_synthesis", "ai_reviewer"]);

export const PRIOR_RESEARCH_RULE = "prior_research is a code-built summary of this asset's previous run: the documents it used, the questions it left blocked, the requests it could not answer, its decision and its valuation. Start from it: work on what it left open and say where this run's view differs and why. It is context, not evidence. Cite only this run's evidence_claims and artifacts, and do not repeat a prior figure as current without this run's support. A review_status of unreviewed means no human approved the prior run.";

export interface PriorResearchInputs {
  run: { id: string; run_type: string; status: string; source_cutoff_at: string | Date | null; completed_at: string | Date | null };
  /** Latest artifacts of the prior run (validated or accepted), as { artifact_type, status, content_json }. */
  artifacts: Row[];
  documents: { id: string; title: string | null; url?: string | null; published_at?: string | Date | null }[];
  /** The prior run's approving human review, if any. */
  review: { status: string; open_questions: string | null; what_would_change_mind: string | null } | null;
}

export interface PriorResearch {
  prior_run_id: string;
  run_type: string;
  run_status: string;
  source_cutoff: string | null;
  completed_at: string | null;
  review_status: "accepted" | "unreviewed";
  human_decision: string | null;
  decision: { decision: string | null; rationale: string | null; thesis: string | null };
  valuation_summary: ValuationSnapshot | null;
  documents: { id: string; title: string }[];
  blocked_questions: { question: string; follow_up: string; materiality: string | null }[];
  unavailable_requests: { role: string | null; question: string; source_role: string | null }[];
  human_follow_up: { open_questions: string | null; what_would_change_mind: string | null } | null;
  omitted: { documents: number; blocked_questions: number; unavailable_requests: number };
}

const clip = (value: unknown, limit = TEXT_LIMIT): string | null => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};
const iso = (value: string | Date | null | undefined) => value ? new Date(value).toISOString() : null;
const latest = (artifacts: Row[], type: string): Row | null => {
  const rows = artifacts.filter(a => a.artifact_type === type);
  rows.sort((a, b) => Number(b.artifact_version ?? 0) - Number(a.artifact_version ?? 0));
  return rows[0]?.content_json ?? null;
};
export const priorResearchBytes = (block: PriorResearch) => Buffer.byteLength(JSON.stringify(block), "utf8");

/** Build the block deterministically and trim it to PRIOR_RESEARCH_MAX_BYTES (documents first, then requests, then questions). */
export function buildPriorResearch(input: PriorResearchInputs, maxBytes = PRIOR_RESEARCH_MAX_BYTES): PriorResearch {
  const { artifacts } = input;
  const decision = latest(artifacts, "decision_record");
  const thesis = latest(artifacts, "investment_thesis");
  const questions: Row[] = latest(artifacts, "question_register")?.questions ?? [];
  const requests: Row[] = latest(artifacts, "team_requests")?.requests ?? [];
  const documents = [...input.documents]
    .sort((a, b) => String(iso(b.published_at ?? null) ?? "").localeCompare(String(iso(a.published_at ?? null) ?? "")) || a.id.localeCompare(b.id))
    .map(d => ({ id: d.id, title: clip(d.title || d.url || "Untitled document", TITLE_LIMIT)! }));
  const blocked = questions.filter(q => q?.status === "blocked")
    .map(q => ({ question: clip(q.question)!, follow_up: clip(q.follow_up) ?? "", materiality: q.materiality ? String(q.materiality) : null }))
    .filter(q => q.question);
  const unavailable = requests.filter(r => r?.response?.status === "unavailable")
    .map(r => ({ role: r.role ? String(r.role) : null, question: clip(r.question)!, source_role: r.source_role ? String(r.source_role) : null }))
    .filter(r => r.question);
  const accepted = artifacts.some(a => a.status === "accepted");
  const block: PriorResearch = {
    prior_run_id: input.run.id,
    run_type: input.run.run_type,
    run_status: input.run.status,
    source_cutoff: iso(input.run.source_cutoff_at),
    completed_at: iso(input.run.completed_at),
    review_status: accepted ? "accepted" : "unreviewed",
    human_decision: input.review?.status ?? null,
    decision: { decision: decision?.decision ? String(decision.decision) : null, rationale: clip(decision?.rationale), thesis: clip(thesis?.thesis_statement) },
    valuation_summary: valuationSnapshot(artifacts),
    documents,
    blocked_questions: blocked,
    unavailable_requests: unavailable,
    human_follow_up: input.review && (input.review.open_questions || input.review.what_would_change_mind)
      ? { open_questions: clip(input.review.open_questions), what_would_change_mind: clip(input.review.what_would_change_mind) } : null,
    omitted: { documents: 0, blocked_questions: 0, unavailable_requests: 0 },
  };
  const lists = ["documents", "unavailable_requests", "blocked_questions"] as const;
  for (const list of lists) {
    while (priorResearchBytes(block) > maxBytes && block[list].length) {
      block[list].pop();
      block.omitted[list]++;
    }
  }
  // Still too large only with a pathological valuation; keep the identity and the decision.
  if (priorResearchBytes(block) > maxBytes) block.valuation_summary = null;
  if (priorResearchBytes(block) > maxBytes) block.decision = { decision: block.decision.decision, rationale: null, thesis: null };
  return block;
}
