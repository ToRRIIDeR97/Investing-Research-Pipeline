import { z } from "zod/v4";
import { callResearchAgent, exactJsonPrompt, type ResearchRunContext, type Sql } from "./run-context";
import { outputContract, type ReportOutline } from "./reporting/contracts";
import { loadReportInputs, saveReportArtifact } from "./reporting/store";
import { TEAM_ROLES, BRIEF_ROLES, GAP_OWNER_STAGES, STAGE_DEPENDENCIES, STAGE_OWNERS, dependentStages } from "./team-plan";
import type { AgentOutputFormat } from "@/lib/agent-harness/types";
import { SOURCE_ROLES } from "./sources/roles";
import { getStageOutputContract } from "./stage-contracts";
import { getEmbeddingProvider, retrievePassages, runDocuments } from "./memory";
import { runSearches } from "./sources/collector";
import { extractEvidenceForSources } from "./handlers/evidence-extraction";
import { costOfCapitalInputs } from "./valuation/cost-of-capital";
import { latestRiskFreeRate } from "./valuation/engine";
import { REWORK_STAGES, type ReworkStage } from "./reporting/depth";

const Role = z.enum(["data", "financials", "business", "valuation"]);
export const ResearchRequest = z.object({
  role: Role, question: z.string().trim().min(10).max(1500), material: z.boolean(),
  needs_sources: z.boolean(), source_role: z.enum(SOURCE_ROLES),
  document: z.string().trim().min(5).max(200).optional()
    .describe("When needs_sources is true: the document to search for as organisation, document type and period, e.g. 'Meta Platforms 2026 proxy statement DEF 14A'. Not the question."),
});
type Request = z.infer<typeof ResearchRequest>;
export type TeamAnswer = {
  status: "answered" | "unavailable" | "needs_sources";
  answer: string;
  evidence_ids: string[];
  artifact_ids: string[];
  /** Documents linked to the run. */
  source_ids?: string[];
  /** "system:market-history" | "system:fred" for answers made from stored data. */
  resolved_by?: string;
  /** The owner asks for its stage and dependents to rerun. */
  requires_rerun?: boolean;
};
/**
 * `source_searched`: the collector already searched for this request, so it is never searched again.
 * `rework_stage`: a review finding sent this analysis stage back; code asks for its rerun, and `reworked`
 * records that the rerun was granted, so the request is then answered instead of rerun again.
 */
export type TeamRequest = Request & { id: string; response?: TeamAnswer; source_searched?: boolean;
  rework_stage?: ReworkStage; section_id?: string; reworked?: boolean };
/**
 * `rerun_stages`: analysis stages a re-run reopened; the batch waits for them before asking again.
 * `post_review_round`: the round the report review used. Pre-draft requests may use two rounds; one more is
 * kept for the review's findings, and nothing is asked after it.
 */
export interface RequestBatch { round: number; state: "queued" | "processing" | "answered"; source_escalated?: boolean;
  rerun_stages?: string[]; post_review_round?: number; requests: TeamRequest[] }
export type RequestPhase = "pre_draft" | "post_review";
export const MAX_PRE_DRAFT_ROUNDS = 2;
const MAX_REQUESTS = 5;
/** The wire schema cannot carry maxItems, so requests past the fifth are dropped locally instead of costing a full-prompt repair. */
const firstRequests = <T>(value: T): T => {
  const requests = (value as { requests?: unknown })?.requests;
  return Array.isArray(requests) && requests.length > MAX_REQUESTS ? { ...value, requests: requests.slice(0, MAX_REQUESTS) } : value;
};
const REQUESTS_SCHEMA = outputContract({ requests: z.array(ResearchRequest).max(MAX_REQUESTS) });
export const REQUEST_CONTRACT: AgentOutputFormat = { ...REQUESTS_SCHEMA, validate: value => REQUESTS_SCHEMA.validate!(firstRequests(value)) };
const BRIEF_CONTRACT = outputContract({ approach: z.string().min(1), checks: z.array(z.string().min(1)).min(1), information_needed: z.array(z.string().min(1)) });
const ANSWER_CONTRACT = { ...outputContract({ status: z.enum(["answered", "unavailable", "needs_sources"]), answer: z.string().min(1),
  evidence_ids: z.array(z.string()), artifact_ids: z.array(z.string()), source_ids: z.array(z.string()).optional(), requires_rerun: z.boolean().optional() }),
  requiredKeys: ["status", "answer", "evidence_ids", "artifact_ids"] };
/** Stages after the analysis: a re-run reopens them but does not wait for them. */
export const REQUEST_TAIL_STAGES = ["ai_reviewer", "human_review", "export", "refresh_schedule"];
export class ResearchRequestsPending extends Error {
  constructor() { super("Specialists are investigating report requests"); }
}

export async function getTeamRequests(sql: Sql, runId: string): Promise<RequestBatch | null> {
  const [row] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId}
    AND artifact_type = 'team_requests' AND status IN ('validated', 'accepted') ORDER BY artifact_version DESC LIMIT 1`;
  return row?.content_json || null;
}

/**
 * Specialists plan only after the collector has declared the corpus sufficient, so each plan is
 * grounded in the documents actually collected. Independent planning calls then start together.
 */
export async function prepareResearchTeam(sql: Sql, ctx: ResearchRunContext) {
  const [discovery] = await sql`SELECT status FROM research_stages WHERE research_run_id = ${ctx.runId} AND stage_key = 'source_discovery'`;
  if (discovery?.status !== "completed") return;
  const existing = await sql`SELECT scope_key FROM research_artifacts WHERE research_run_id = ${ctx.runId}
    AND artifact_type = 'agent_brief' AND status IN ('validated', 'accepted')`;
  const scopes = new Set(existing.map(r => r.scope_key));
  if (BRIEF_ROLES.every(role => scopes.has(role))) return;
  const [review] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${ctx.runId}
    AND artifact_type = 'source_review' AND status IN ('validated', 'accepted') ORDER BY artifact_version DESC LIMIT 1`;
  const documents = await sql`SELECT d.title, d.url, d.source_type FROM source_documents d
    JOIN research_run_sources r ON r.source_document_id = d.id WHERE r.research_run_id = ${ctx.runId}
    ORDER BY r.created_at, d.id LIMIT 80`;
  const corpus = { assessment: review?.content_json?.assessment || null, covered_roles: review?.content_json?.covered_roles || [],
    missing_required_roles: review?.content_json?.missing_required_roles || [], documents };
  const results = await Promise.allSettled(BRIEF_ROLES.map(async role => {
    const definition = TEAM_ROLES[role];
    if (scopes.has(role)) return;
    const packet = { asset: { name: ctx.assetName, symbol: ctx.symbol }, research_question: ctx.researchQuestion,
      profile: ctx.composedProfile, role, purpose: definition.purpose, corpus, output_contract: "team_brief" };
    const brief = await callResearchAgent<Record<string, unknown>>({ sql, ctx, stageKey: definition.stage,
      taskKey: `team:brief:${role}`, taskType: "team_brief", agentName: definition.agent, modelTier: "cheap", packet,
      outputFormat: BRIEF_CONTRACT, promptFactory: p => exactJsonPrompt({ agentName: definition.agent,
        requiredKeys: BRIEF_CONTRACT.requiredKeys!, packet: p, extraRules: [definition.purpose,
          "Prepare a company-specific work plan and completeness checks against the collected corpus. You are planning, not claiming to have found evidence. Explain what information your specialist needs that the corpus does not contain; the specialist can ask the collector for named documents while it works."] }) });
    await saveReportArtifact(sql, ctx, "agent_brief", role, { role, ...brief });
  }));
  const failed = results.find(r => r.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

/**
 * Only briefed roles read the briefs, so ingestion and evidence extraction (data-owned) run while they
 * are written; the first stage whose owner is briefed waits, and a brief failure surfaces then or at
 * the next pass. drain() waits for brief calls still in flight, so the run lock outlives them.
 */
export function teamBriefScheduler(prepare: (ctx: ResearchRunContext) => Promise<void>) {
  type Pending = { settled: boolean; failure?: { error: unknown }; done: Promise<void> };
  let pending: Pending | null = null;
  const collect = async () => {
    const entry = pending;
    pending = null;
    await entry?.done;
    if (entry?.failure) throw entry.failure.error;
  };
  return {
    async before(ctx: ResearchRunContext, stages: string[]) {
      if (pending?.settled) await collect();
      if (!pending) {
        const entry: Pending = { settled: false, done: Promise.resolve() };
        entry.done = prepare(ctx).then(() => undefined, (error: unknown) => { entry.failure = { error }; })
          .finally(() => { entry.settled = true; });
        pending = entry;
      }
      if (stages.some(key => { const role = STAGE_OWNERS[key]; return role !== undefined && BRIEF_ROLES.includes(role); })) await collect();
    },
    async drain() {
      await pending?.done;
      pending = null;
    },
  };
}

/**
 * The next round: at most two before drafting and one after the review, repeated questions dropped, per-run
 * flags carried. Null when there is nothing new or the phase has no round left.
 */
export function nextRequestBatch(previous: RequestBatch | null, proposed: (Request & Partial<TeamRequest>)[], phase: RequestPhase = "pre_draft"): RequestBatch | null {
  if (!roundAvailable(previous, phase)) return null;
  const asked = new Set(previous?.requests.map(r => r.question.trim().toLowerCase()));
  const fresh = proposed.filter(r => {
    const key = r.question.trim().toLowerCase();
    if (asked.has(key)) return false;
    asked.add(key);
    return true;
  });
  if (!fresh.length) return null;
  const round = (previous?.round || 0) + 1;
  return { round, state: "queued", ...(previous?.source_escalated !== undefined ? { source_escalated: previous.source_escalated } : {}),
    ...(phase === "post_review" ? { post_review_round: round } : {}),
    requests: [...(previous?.requests || []), ...fresh.map((r, i) => ({ ...r, id: `request-${round}-${i + 1}` }))] };
}

const roundAvailable = (previous: RequestBatch | null, phase: RequestPhase) =>
  !previous?.post_review_round && (phase === "post_review" || (previous?.round || 0) < MAX_PRE_DRAFT_ROUNDS);
const inRound = (request: TeamRequest, round: number | undefined) => Boolean(round) && request.id.startsWith(`request-${round}-`);

/** Requests asked before drafting: writers and the outline read only these, so post-review answers leave their cached calls intact. */
export function preDraftRequests(batch: RequestBatch | null): TeamRequest[] {
  return (batch?.requests || []).filter(r => !inRound(r, batch?.post_review_round));
}
export const preDraftBatch = (batch: RequestBatch | null): RequestBatch | null => batch && { ...batch, requests: preDraftRequests(batch) };

/** The review round's requests with their answers, as repair feedback for the sections they name. */
export function postReviewAnswers(batch: RequestBatch | null): Record<string, any>[] {
  return (batch?.requests || []).filter(r => inRound(r, batch?.post_review_round) && r.response).map(r => ({
    source: "team_answer", category: "team_answer", ...(r.section_id ? { section_id: r.section_id } : {}), question: r.question,
    status: r.response!.status, answer: r.response!.answer, evidence_ids: r.response!.evidence_ids, artifact_ids: r.response!.artifact_ids }));
}

const REWORK_ROLE: Partial<Record<ReworkStage, Request["role"]>> = { asset_valuation: "valuation" };
/** One rework request per owning stage from the review's analysis_rework findings. */
export function reworkRequests(findings: Record<string, any>[]): (Request & Pick<TeamRequest, "rework_stage" | "section_id">)[] {
  const byStage = new Map<ReworkStage, Record<string, any>>();
  for (const f of findings) {
    const stage = f.owner_stage as ReworkStage;
    if (f.category === "analysis_rework" && (REWORK_STAGES as readonly string[]).includes(stage) && !byStage.has(stage)) byStage.set(stage, f);
  }
  return [...byStage].map(([stage, f]) => {
    const issue = String(f.issue ?? f.message ?? f.description ?? f.repair ?? "").trim();
    return { role: REWORK_ROLE[stage] ?? "business", material: true, needs_sources: false, source_role: "regulatory_filing" as const,
      question: `Rework ${stage}: ${issue || "the reviewer found the analysis incomplete"}`.slice(0, 1500),
      rework_stage: stage, ...(f.section_id ? { section_id: String(f.section_id) } : {}) };
  });
}

/**
 * The report owner decides what is missing, using the complete current input snapshot. The post-review phase also
 * turns analysis_rework findings into rerun requests for their owning stages.
 */
export async function requestMissingResearch(sql: Sql, ctx: ResearchRunContext, findings: Record<string, any>[] = [], phase: RequestPhase = "pre_draft") {
  const previous = await getTeamRequests(sql, ctx.runId);
  if (previous && previous.state !== "answered") throw new ResearchRequestsPending();
  // Persisted limit survives worker restarts. Unavailable material answers stay blocked.
  if (!roundAvailable(previous, phase)) return;
  const inputs = await loadReportInputs(sql, ctx.runId, ctx.cutoffAt.toISOString());
  const packet = { asset: { name: ctx.assetName, symbol: ctx.symbol }, ...inputs, previous_requests: previous?.requests || [],
    findings, role: "report", output_contract: "team_requests" };
  const result = await callResearchAgent<{ requests: Request[] }>({ sql, ctx, stageKey: "ai_reviewer",
    taskKey: `team:requests:${previous?.round || 0}`, taskType: "team_requests", agentName: "export-writer", modelTier: "cheap",
    packet, outputFormat: REQUEST_CONTRACT, promptFactory: p => exactJsonPrompt({ agentName: "export-writer",
      requiredKeys: ["requests"], packet: p, extraRules: [TEAM_ROLES.report.purpose,
        "Request only specific unanswered investment questions or material inconsistencies, at most 5, most material first. Return an empty requests array when the supplied research is adequate. Do not request information already present or repeat answered/unavailable requests.",
        "Route financial extraction/reconciliation to financials, management/operations/scenarios to business, valuation calculations to valuation, and missing documents to data. Set needs_sources when new external evidence is required; source_role tells the collector where to search. Stored price history and the FRED 10-year Treasury series are answered directly from the run's data. Owners answer from the run's documents without rerunning their analysis; the collector searches once for a missing document, and a stage reruns only when its owner says its own output must be recomputed.",
        "role names the specialist and must be exactly one of: data, financials, business, valuation. Document types such as regulatory_filing or market_data belong in source_role, never in role.",
        "When needs_sources is true, set document to the specific document the collector should search for: the organisation, the document type and the period, in at most 200 characters. The collector searches document, not the question."] }) });
  const batch = nextRequestBatch(previous, [...(phase === "post_review" ? reworkRequests(findings) : []), ...firstRequests(result).requests], phase);
  if (!batch) return;
  await saveReportArtifact(sql, ctx, "team_requests", "requests", batch);
  throw new ResearchRequestsPending();
}

/**
 * Citations outside the current inputs are dropped rather than failing the answer: a model can copy an
 * ID from an upstream artifact whose source is not report-eligible. An answer left without support is invalid.
 */
export function keepCurrentReferences(answer: TeamAnswer,
  inputs: { evidence: { id: string }[]; artifacts: { id: string }[]; sources?: { id: string }[] }): TeamAnswer {
  const evidence = new Set(inputs.evidence.map(e => e.id));
  const artifacts = new Set(inputs.artifacts.map(a => a.id));
  const sources = new Set((inputs.sources || []).map(s => s.id));
  return { ...answer, evidence_ids: answer.evidence_ids.filter(id => evidence.has(id)),
    artifact_ids: answer.artifact_ids.filter(id => artifacts.has(id)),
    ...(answer.source_ids ? { source_ids: answer.source_ids.filter(id => sources.has(id)) } : {}) };
}

/** Facts the run already stores, answered without a model call. */
export interface SystemFacts {
  marketHistory?: { id: string; content: Record<string, any> } | null;
  fred?: { sourceId: string; csv: string } | null;
}
const MARKET_TERMS = /price|market cap/i;
// Cost-of-capital phrasing only: a bare "beta" or "ERP" also names product betas and ERP software.
const BETA_TERMS = new RegExp([String.raw`\b(?:equity|levered|unlevered|regression|stock|market|adjusted|raw)\s+betas?\b`,
  String.raw`\bbetas?\s+(?:of|for)\s+(?:the\s+)?(?:stock|shares|company|equity)\b`, "equity risk premium", "cost of equity", String.raw`\bcapm\b`,
  String.raw`\bbetas?\b[^.?!]*\b(?:discount rates?|wacc|cost of capital)\b`, String.raw`\b(?:discount rates?|wacc|cost of capital)\b[^.?!]*\bbetas?\b`].join("|"), "i");
const RATE_TERMS = /dgs10|(?:10|ten)[- ]year treasury|treasury yields?|risk[- ]free rates?|discount rates?/i;
const withThousands = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The latest non-blank DGS10 observation; holidays are stored as blank rows. */
function latestFredObservation(csv: string) {
  const rows = csv.split(/\r?\n/).map(line => line.split(",").map(cell => cell.trim())).filter(([day]) => /^\d{4}-\d{2}-\d{2}$/.test(day || ""));
  for (const [day, value] of rows.reverse()) if (value && value !== ".") return { day, value };
  return null;
}

/**
 * Beta and ERP requests to the valuation owner or for market data are checked first (they also cite DGS10), then market history before FRED,
 * so a price request that also names DGS10 cites the stored bars.
 */
export function systemAnswer(request: TeamRequest, facts: SystemFacts): TeamAnswer | null {
  const history = facts.marketHistory?.content;
  const beta = history?.beta;
  if (facts.marketHistory && beta?.status === "computed" && (request.role === "valuation" || request.source_role === "market_data")
    && BETA_TERMS.test(request.question)) {
    const riskFree = facts.fred ? latestRiskFreeRate(facts.fred.csv, String(history!.market_data_cutoff || new Date().toISOString())) : null;
    const inputs = costOfCapitalInputs({ beta, riskFreeRate: riskFree, cutoffAt: new Date(String(history!.market_data_cutoff)) });
    const erp = inputs.equity_risk_premium;
    const answer = [`Regression beta of ${beta.stock_symbol} against the ${beta.benchmark.name} (${beta.benchmark.symbol}): ${beta.adjusted_beta} adjusted (raw ${beta.raw_beta}, R² ${beta.r_squared}, standard error ${beta.standard_error}) from ${beta.observations} weekly returns, ${beta.window_start} to ${beta.window_end} (${beta.verified ? "verified" : "unverified"} closes).`,
      ...(erp ? [`Implied equity risk premium ${erp.rate} as of ${erp.as_of} (${erp.publisher}, ${erp.url}).`] : []),
      ...(inputs.capm_cost_of_equity ? [`CAPM cost of equity ${inputs.capm_cost_of_equity.rate} = ${inputs.capm_cost_of_equity.formula}.`] : [])].join(" ");
    return { status: "answered", answer, evidence_ids: [], artifact_ids: [facts.marketHistory.id], ...(riskFree ? { source_ids: [facts.fred!.sourceId] } : {}), resolved_by: "system:cost-of-capital" };
  }
  const bars = Number(history?.bars_available || 0);
  if (facts.marketHistory && bars > 0 && (request.source_role === "market_data" || (request.role === "data" && MARKET_TERMS.test(request.question)))) {
    const check = history!.cross_check || {};
    const verified = Number(check.verified_periods || 0), unverified = Number(check.unverified_periods || 0);
    const checker = String(check.provider || "stooq").replace(/^./, letter => letter.toUpperCase());
    const price = history!.valuation_price;
    const answer = [`Stored daily prices for ${history!.provider_symbol}: ${withThousands(bars)} bars from ${history!.first_trading_day} to ${history!.last_trading_day} (${history!.provider}).`,
      `${checker} cross-check: ${verified} of ${verified + unverified} period-end closes verified, ${unverified ? `${unverified} unverified` : "0 not verified"}.`,
      ...(check.status === "unavailable" ? [`${checker} did not run in this run's price sync${check.reason ? `: ${check.reason}` : ""}.`] : []),
      ...(price?.price != null ? [`Valuation price ${[price.price, price.currency].filter(Boolean).join(" ")} on ${price.trading_date} (${price.verified ? "verified" : "unverified"}).`] : [])].join(" ");
    return { status: "answered", answer, evidence_ids: [], artifact_ids: [facts.marketHistory.id], resolved_by: "system:market-history" };
  }
  const latest = facts.fred ? latestFredObservation(facts.fred.csv) : null;
  if (latest && RATE_TERMS.test(request.question)) {
    return { status: "answered", evidence_ids: [], artifact_ids: [], source_ids: [facts.fred!.sourceId], resolved_by: "system:fred",
      answer: `The run's stored FRED DGS10 series (10-year Treasury constant-maturity yield) was ${latest.value}% on ${latest.day}, its latest non-blank observation.` };
  }
  return null;
}

async function loadSystemFacts(sql: Sql, runId: string): Promise<SystemFacts> {
  const [history] = await sql`SELECT id, content_json FROM research_artifacts WHERE research_run_id = ${runId}
    AND artifact_type = 'market_price_history' AND status IN ('validated', 'accepted') ORDER BY artifact_version DESC, created_at DESC LIMIT 1`;
  const [fred] = await sql`SELECT sd.id, (SELECT string_agg(dc.text, '' ORDER BY dc.chunk_index) FROM document_chunks dc
      WHERE dc.document_parse_id = (SELECT dp.id FROM document_parses dp WHERE dp.source_document_id = sd.id
        AND dp.parser_name = 'system-source-payload' AND dp.status = 'completed' ORDER BY dp.completed_at DESC NULLS LAST LIMIT 1)) AS csv
    FROM source_documents sd
    WHERE (sd.research_run_id = ${runId} OR sd.id IN (SELECT source_document_id FROM research_run_sources WHERE research_run_id = ${runId}))
      AND sd.source_type = 'macro_context' AND sd.metadata_json->>'source' = 'fred' AND sd.metadata_json->>'series_id' = 'DGS10'
    ORDER BY sd.retrieved_at DESC, sd.created_at DESC LIMIT 1`;
  return { marketHistory: history ? { id: String(history.id), content: history.content_json } : null,
    fred: fred?.csv ? { sourceId: String(fred.id), csv: String(fred.csv) } : null };
}

/** Only an owner's requires_rerun names a root; data requests never reopen source discovery. Rework requests name their stage. */
export function requestStageRoots(requests: TeamRequest[]): string[] {
  return [...new Set(rerunRequests(requests).map(r => r.rework_stage ?? TEAM_ROLES[r.role].stage))];
}
const rerunRequests = (requests: TeamRequest[]) => requests.filter(r => r.response?.requires_rerun === true && r.role !== "data");

export interface RequestResetPlan { mode: "none" | "auto" | "approval"; stages: string[]; analysis_stages: string[]; request_ids: string[] }
function autoResetLimit() {
  const raw = process.env.RESEARCH_MAX_AUTO_RESET_STAGES?.trim();
  const value = Number(raw);
  return raw && Number.isInteger(value) && value >= 0 ? value : 6;
}

/** One automatic re-run of at most maxAutoStages analysis stages per run; anything else waits for a reviewer. */
export function requestResetPlan(requests: TeamRequest[], stages: { stage_key: string; status: string }[],
  opts: { autoResetUsed: boolean; maxAutoStages?: number }): RequestResetPlan {
  const roots = requestStageRoots(requests);
  if (!roots.length) return { mode: "none", stages: [], analysis_stages: [], request_ids: [] };
  const skipped = new Set(stages.filter(s => s.status === "skipped").map(s => s.stage_key));
  const reset = dependentStages(roots).filter(key => !skipped.has(key));
  const analysis = reset.filter(key => !REQUEST_TAIL_STAGES.includes(key));
  const auto = !opts.autoResetUsed && analysis.length <= (opts.maxAutoStages ?? autoResetLimit());
  return { mode: auto ? "auto" : "approval", stages: reset, analysis_stages: analysis, request_ids: rerunRequests(requests).map(r => r.id) };
}

async function writeTeamRequests(tx: Sql, runId: string, batch: RequestBatch) {
  await tx`UPDATE research_artifacts SET content_json = ${JSON.stringify(batch)}::text::jsonb, updated_at = NOW()
    WHERE research_run_id = ${runId} AND artifact_type = 'team_requests' AND status = 'validated'`;
}

/**
 * The reset an automatic or approved re-run shares: reopen the stages, invalidate their outputs and stale
 * report approval, supersede gaps their owners will re-evaluate, and wait for the analysis stages before the
 * re-run requests are answered again. Runs inside the caller's transaction.
 */
export async function rerunRequestStages(tx: Sql, runId: string, batch: RequestBatch,
  reset: { stages: string[]; request_ids: string[] }, note: string) {
  const affected = reset.stages;
  const types = [...new Set(affected.flatMap(key => getStageOutputContract(key)?.requiredKeys || [])),
    "report_outline", "report_section", "report_document", "report_review", "question_register"];
  if (affected.includes("historical_record")) types.push("historical_record", "financial_statement_set", "market_price_history", "financial_analytics", "financial_statement_summary");
  await tx`UPDATE research_stages SET status = 'pending', started_at = NULL, completed_at = NULL,
    validation_result_json = NULL, failure_reason = NULL, updated_at = NOW()
    WHERE research_run_id = ${runId} AND stage_key = ANY(${affected}::text[]) AND status != 'skipped'`;
  await tx`UPDATE research_tasks SET validation_status = 'invalid', updated_at = NOW()
    WHERE research_run_id = ${runId} AND stage_id IN
      (SELECT id FROM research_stages WHERE research_run_id = ${runId} AND stage_key = ANY(${affected}::text[]))
      AND task_type != 'team_brief'`;
  await tx`UPDATE research_artifacts SET status = 'needs_more_work', updated_at = NOW()
    WHERE research_run_id = ${runId} AND artifact_type = ANY(${types}::text[]) AND status IN ('validated', 'accepted')`;
  await tx`UPDATE research_runs SET metadata_json = metadata_json - 'report_approval', updated_at = NOW() WHERE id = ${runId}`;
  // Gaps written by reopened stages describe inputs that are about to be rebuilt. Their reruns
  // record any gap that still applies; stale ones must not block the earlier stages meanwhile.
  const owners = Object.entries(GAP_OWNER_STAGES).filter(([, stage]) => affected.includes(stage)).map(([owner]) => owner);
  if (owners.length) await tx`UPDATE source_gaps SET status = 'resolved', resolved_at = NOW(), resolution_note = ${note}
    WHERE research_run_id = ${runId} AND status = 'open' AND owner = ANY(${owners}::text[])`;
  const ids = new Set(reset.request_ids);
  await writeTeamRequests(tx, runId, { ...batch, state: "processing", rerun_stages: affected.filter(key => !REQUEST_TAIL_STAGES.includes(key)),
    requests: batch.requests.map(request => {
      if (!ids.has(request.id)) return request;
      const { response: _, ...asked } = request;
      return asked.rework_stage ? { ...asked, reworked: true } : asked;
    }) });
}

/** A reviewer declined the re-run: its requests become open questions and the report continues. */
export async function skipRequestRerun(tx: Sql, runId: string, batch: RequestBatch, requestIds: string[]) {
  const ids = new Set(requestIds);
  const { rerun_stages: _, ...rest } = batch;
  await writeTeamRequests(tx, runId, { ...rest, state: "answered", requests: batch.requests.map(r => !ids.has(r.id) ? r : { ...r, response: {
    status: "unavailable", evidence_ids: r.response?.evidence_ids || [], artifact_ids: r.response?.artifact_ids || [],
    answer: `Skipped by reviewer: re-run not approved.${r.response?.answer ? ` The owner's answer was: ${r.response.answer}` : ""}` } }) });
}

type RequestPassage = { passage_id: string; source_id: string; source_role: string | null; title: string; section_path: string[]; page: number | null; text: string };
/** The researched company's own documents, searched when the request's role has none or none match. */
const ISSUER_ROLES = ["regulatory_filing", "earnings_release", "company_investor_relations", "proxy_and_governance"];
/**
 * Research-memory passages of the request's source role from this run's documents (keyword ranking unless
 * embeddings are on). The owner's own stage artifacts seed the graph, so passages holding the claims they cite
 * take a quarter of the slots, more when keyword matches run short. A search is worth running first when no
 * passage matched the question or it names a period no document in scope covers; any word of the question
 * matches, so a non-empty result alone proves little, and cited passages say nothing about what is missing.
 */
export async function requestPassages(sql: Sql, runId: string, request: TeamRequest): Promise<{ passages: RequestPassage[]; searchFirst: boolean }> {
  const seedArtifactIds = await ownedArtifactIds(sql, runId, request.role);
  const embeddings = getEmbeddingProvider();
  const need = { key: request.id, query: request.question, sourceRoles: [request.source_role], seedArtifactIds };
  const scoped = await retrievePassages(sql, { runId, need, embeddings });
  const matched = (r: typeof scoped) => r.passages.some(p => p.matched !== "graph");
  // A governance or filing question is often answered in the 10-K's risk factors although it was tagged with a role
  // the run has no matching documents for (proxy_and_governance): search the issuer's own documents once more.
  let result = scoped;
  if (!matched(scoped)) {
    const wider = await retrievePassages(sql, { runId, need: { ...need, sourceRoles: ISSUER_ROLES.filter(role => role !== request.source_role) }, embeddings });
    if (matched(wider)) result = wider;
  }
  return { passages: result.passages.map(p => ({ passage_id: p.passage_id, source_id: p.source_id, source_role: p.source_role, title: p.title,
    section_path: p.section_path, page: p.page, text: p.text })),
    // Whether to search first is judged on the request's own role: issuer passages do not stand in for a peer's filing.
    searchFirst: !matched(scoped) || scoped.gaps.some(gap => gap.reason === "no_documents_for_period") };
}

/** Current validated or accepted artifacts of the stages a role owns: the work a request to that owner concerns. */
async function ownedArtifactIds(sql: Sql, runId: string, role: Request["role"]): Promise<string[]> {
  const types = [...stageArtifactTypes(Object.keys(STAGE_OWNERS).filter(key => STAGE_OWNERS[key] === role))];
  if (!types.length) return [];
  const rows = await sql`SELECT DISTINCT ON (artifact_type, scope_key) id FROM research_artifacts
    WHERE research_run_id = ${runId} AND status IN ('validated', 'accepted') AND artifact_type = ANY(${types}::text[])
    ORDER BY artifact_type, scope_key, artifact_version DESC, created_at DESC`;
  return rows.map(row => String(row.id));
}

/** What the collector searches for a request: the named document, or the question when the requester gave none. */
export function requestSearchQuery(request: Pick<TeamRequest, "question" | "document">): string {
  return (request.document || request.question).replace(/\s+/g, " ").trim();
}

/** One collector search for a request; evidence is read only from documents new to the run. */
async function searchForRequest(sql: Sql, ctx: ResearchRunContext, request: TeamRequest) {
  const known = new Set((await runDocuments(sql, ctx.runId)).map(doc => doc.id));
  // The collector's constrainSearch anchors own-company roles to the asset and rejects generic external queries.
  const query = requestSearchQuery(request);
  const [result] = await runSearches(sql, ctx, [{ source_role: request.source_role, query, reason: `Report request ${request.id}` }],
    `team:${request.role}`, { request_id: request.id });
  await extractEvidenceForSources(sql, ctx, result.documents.map(doc => doc.source_id).filter(id => !known.has(id)));
}

/**
 * Artifact types an owner answers from: the outputs of every stage its role owns, plus what its home
 * stage reads (as its stage call receives them), so the valuation owner also sees operating scenarios.
 */
export function ownerArtifactTypes(role: Request["role"]): Set<string> {
  const owned = Object.keys(STAGE_OWNERS).filter(key => STAGE_OWNERS[key] === role);
  const types = stageArtifactTypes([...owned, ...(STAGE_DEPENDENCIES[TEAM_ROLES[role].stage] || [])]);
  // Other owners read history through financial_analytics, as their stage calls do.
  if (!owned.includes("historical_record")) types.delete("historical_record");
  return types;
}

function stageArtifactTypes(stages: string[]): Set<string> {
  const types = new Set(stages.flatMap(key => getStageOutputContract(key)?.requiredKeys || []));
  if (stages.includes("historical_record")) ["historical_record", "financial_analytics", "financial_statement_summary"].forEach(type => types.add(type));
  return types;
}

async function ownerAnswer(sql: Sql, ctx: ResearchRunContext, request: TeamRequest, searched: boolean, retrieved?: RequestPassage[]): Promise<TeamAnswer> {
  const owner = TEAM_ROLES[request.role];
  const inputs = await loadReportInputs(sql, ctx.runId, ctx.cutoffAt.toISOString());
  // The owner reads its own slice of the archive; citations are still checked against all current inputs.
  const references = { ...inputs, sources: await runDocuments(sql, ctx.runId) };
  const types = ownerArtifactTypes(request.role);
  const { id, role, question, material, needs_sources, source_role } = request;
  const passages = retrieved ?? (await requestPassages(sql, ctx.runId, request)).passages;
  const packet = { asset: { name: ctx.assetName, symbol: ctx.symbol }, artifacts: inputs.artifacts.filter(a => types.has(a.artifact_type)),
    evidence: inputs.evidence, role: request.role, output_contract: "team_answer",
    request: { id, role, question, material, needs_sources, source_role }, source_search_attempted: searched, passages };
  const response = await callResearchAgent<TeamAnswer>({ sql, ctx, stageKey: owner.stage,
    taskKey: `team:answer:${request.id}`, taskType: "team_answer", agentName: owner.agent, modelTier: "cheap", packet,
    perCallKeys: ["request", "source_search_attempted", "passages"], outputFormat: { ...ANSWER_CONTRACT, validate(value) {
      const errors = ANSWER_CONTRACT.validate?.(value) || [];
      if (errors.length) return errors;
      const answer = keepCurrentReferences(value as TeamAnswer, references);
      if (answer.status === "answered" && !answer.evidence_ids.length && !answer.artifact_ids.length && !answer.source_ids?.length) errors.push({ path: "references", message: "An answer requires supporting evidence, artifacts or passage sources from the supplied current references" });
      return errors;
    } }, promptFactory: p => exactJsonPrompt({ agentName: owner.agent, requiredKeys: ANSWER_CONTRACT.requiredKeys, packet: p,
      extraRules: [owner.purpose,
        "Answer the report agent's exact question from the refreshed artifacts, quoted evidence and passages. passages are excerpts of this run's stored documents for the request's source role; cite a passage by adding its source_id to the optional source_ids array. Use only supplied IDs.",
        "If the question cannot be answered from these inputs and source_search_attempted is false, return needs_sources to send it to the collector once. If source_search_attempted is true, return unavailable and explain the remaining gap. Never treat a search attempt or a finished stage as proof of an answer.",
        "Set the optional requires_rerun to true only when your own stage's output is wrong and must be recomputed; your stage and its dependents then rerun before you answer again. Omit it when the answer stands on its own."] }) });
  const kept = keepCurrentReferences(response, references);
  return { status: kept.status, answer: kept.answer, evidence_ids: kept.evidence_ids, artifact_ids: kept.artifact_ids,
    ...(kept.source_ids ? { source_ids: kept.source_ids } : {}), ...(kept.requires_rerun === true ? { requires_rerun: true } : {}) };
}

/**
 * Answer the batch without resetting stages: stored market history and FRED first, then each owner from
 * research-memory passages, with one collector search per request at most. Stages reopen only when an
 * owner sets requires_rerun: automatically once per run within the limit, otherwise after a reviewer approves.
 */
export async function processResearchRequests(sql: Sql, ctx: ResearchRunContext) {
  let batch = await getTeamRequests(sql, ctx.runId);
  if (!batch || batch.state === "answered") return false;
  if (batch.state === "queued") {
    batch = { ...batch, state: "processing" };
    await saveReportArtifact(sql, ctx, "team_requests", "requests", batch);
  }
  if (batch.rerun_stages?.length && (await sql`SELECT 1 FROM research_stages WHERE research_run_id = ${ctx.runId}
    AND stage_key = ANY(${batch.rerun_stages}::text[]) AND status NOT IN ('completed', 'skipped') LIMIT 1`).length) return false;
  const escalated = Boolean(batch.source_escalated);
  const set = (request: TeamRequest) => { batch = { ...batch!, requests: batch!.requests.map(r => r.id === request.id ? request : r) }; };
  const save = () => saveReportArtifact(sql, ctx, "team_requests", "requests", batch!);
  // Passages retrieved for the early-search test go to the owner, unless a search ran after them.
  const retrieved = new Map<string, RequestPassage[]>();
  const settle = async (requests: TeamRequest[], searched: (r: TeamRequest) => boolean) => {
    const results = await Promise.allSettled(requests.map(r => ownerAnswer(sql, ctx, r, searched(r), retrieved.get(r.id))));
    return { answers: results.map(r => r.status === "fulfilled" ? r.value : null), failure: results.find(r => r.status === "rejected") };
  };

  const facts = await loadSystemFacts(sql, ctx.runId);
  const open: TeamRequest[] = [];
  let changed = false;
  for (const request of batch.requests.filter(r => !r.response)) {
    if (request.rework_stage) { set({ ...request, response: reworkAnswer(request) }); changed = true; continue; }
    const system = systemAnswer(request, facts);
    if (system) { set({ ...request, response: system }); changed = true; continue; }
    if (request.needs_sources && !request.source_searched) {
      const found = await requestPassages(sql, ctx.runId, request);
      if (found.searchFirst) {
        await searchForRequest(sql, ctx, request);
        set({ ...request, source_searched: true }); changed = true;
      } else retrieved.set(request.id, found.passages);
    }
    open.push(batch.requests.find(r => r.id === request.id)!);
  }
  if (changed) await save();

  const first = await settle(open, r => Boolean(r.source_searched) || escalated);
  const retry: TeamRequest[] = [];
  open.forEach((request, i) => {
    const response = first.answers[i];
    if (!response) return;
    if (response.status !== "needs_sources") set({ ...request, response });
    else if (request.source_searched || escalated) set({ ...request, response: { ...response, status: "unavailable" } });
    else retry.push(request);
  });
  if (first.failure?.status === "rejected") { await save(); throw first.failure.reason; }
  if (retry.length) {
    // An owner's needs_sources escalates once per run; the next answer is final.
    for (const request of retry) {
      await searchForRequest(sql, ctx, request);
      retrieved.delete(request.id);
      set({ ...request, source_searched: true });
    }
    batch = { ...batch, source_escalated: true };
    await save();
    const retried = retry.map(r => ({ ...r, source_searched: true }));
    const second = await settle(retried, () => true);
    retried.forEach((request, i) => {
      const response = second.answers[i];
      if (response) set({ ...request, response: response.status === "needs_sources" ? { ...response, status: "unavailable" } : response });
    });
    if (second.failure?.status === "rejected") { await save(); throw second.failure.reason; }
  }

  const stages = await sql`SELECT stage_key, status FROM research_stages WHERE research_run_id = ${ctx.runId}`;
  const [run] = await sql`SELECT metadata_json FROM research_runs WHERE id = ${ctx.runId}`;
  const plan = requestResetPlan(batch.requests, stages.map(s => ({ stage_key: String(s.stage_key), status: String(s.status) })),
    { autoResetUsed: Boolean(run?.metadata_json?.request_auto_reset) });
  if (plan.mode === "none") {
    const { rerun_stages: _, ...rest } = batch;
    batch = { ...rest, state: "answered" };
    await save();
    return false;
  }
  const final = batch;
  await sql.begin(async tx => {
    const [locked] = await tx`SELECT status FROM research_runs WHERE id = ${ctx.runId} FOR UPDATE`;
    if (locked?.status !== "running") throw new Error("Research requests cannot bypass a human gate");
    const record = { stages: plan.stages, request_ids: plan.request_ids };
    if (plan.mode === "auto") {
      await rerunRequestStages(tx as unknown as Sql, ctx.runId, final, record,
        `Superseded: its owning stage was reopened by team request round ${final.round}.`);
      // Only automatic resets use up the run's one automatic re-run.
      await tx`UPDATE research_runs SET metadata_json = (CASE WHEN jsonb_typeof(metadata_json) = 'object' THEN metadata_json ELSE '{}'::jsonb END)
        || ${tx.json({ request_auto_reset: { ...record, round: final.round, at: new Date().toISOString() } })}, updated_at = NOW() WHERE id = ${ctx.runId}`;
      return;
    }
    const [{ cost }] = await tx`SELECT COALESCE(SUM(m.cost_usd), 0) AS cost FROM model_call_logs m
      JOIN research_stages s ON s.id = m.stage_id WHERE m.research_run_id = ${ctx.runId} AND s.stage_key = ANY(${plan.stages}::text[])`;
    const { rerun_stages: _, ...rest } = final;
    await writeTeamRequests(tx as unknown as Sql, ctx.runId, { ...rest, state: "processing" });
    await tx`UPDATE research_stages SET status = 'waiting_for_human', updated_at = NOW()
      WHERE research_run_id = ${ctx.runId} AND stage_key = 'ai_reviewer'`;
    await tx`UPDATE research_runs SET status = 'waiting_for_human',
      metadata_json = (CASE WHEN jsonb_typeof(metadata_json) = 'object' THEN metadata_json ELSE '{}'::jsonb END)
        || ${tx.json({ request_reset: { ...record, estimated_cost_usd: Number(cost) } })}, updated_at = NOW() WHERE id = ${ctx.runId}`;
  });
  return true;
}

/** A rework request asks for its stage's rerun once; after the rerun it is answered by the recomputed artifacts. */
export function reworkAnswer(request: TeamRequest): TeamAnswer {
  return request.reworked
    ? { status: "answered", answer: `${request.rework_stage} was rerun for this review finding.`, evidence_ids: [], artifact_ids: [], resolved_by: "system:rework" }
    : { status: "answered", answer: `The review sent ${request.rework_stage} back for rework.`, evidence_ids: [], artifact_ids: [], resolved_by: "system:rework", requires_rerun: true };
}

export function includeUnansweredQuestions(outline: ReportOutline, batch: RequestBatch | null): ReportOutline {
  const gaps = batch?.requests.filter(r => r.response?.status !== "answered") || [];
  const ids = new Set(gaps.map(r => r.id));
  return { ...outline, questions: [...outline.questions.filter(q => !ids.has(q.id)), ...gaps.map(r => ({ id: r.id, question: r.question,
    materiality: r.material ? "material" as const : "supporting" as const, status: r.material ? "blocked" as const : "qualified" as const,
    answer: r.response?.answer || "The requested information remains unavailable.", evidence_ids: [], artifact_ids: [], follow_up: r.question }))] };
}
