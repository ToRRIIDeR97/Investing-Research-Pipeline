import { z } from "zod/v4";
import { callResearchAgent, exactJsonPrompt, type ResearchRunContext, type Sql } from "./run-context";
import { outputContract, type ReportOutline } from "./reporting/contracts";
import { loadReportInputs, saveReportArtifact } from "./reporting/store";
import { TEAM_ROLES, BRIEF_ROLES, GAP_OWNER_STAGES, dependentStages } from "./team-plan";
import { SOURCE_ROLES } from "./sources/roles";
import { getStageOutputContract } from "./stage-contracts";

const Role = z.enum(["data", "financials", "business", "valuation"]);
export const ResearchRequest = z.object({
  role: Role, question: z.string().trim().min(10).max(1500), material: z.boolean(),
  needs_sources: z.boolean(), source_role: z.enum(SOURCE_ROLES),
});
type Request = z.infer<typeof ResearchRequest>;
type Answer = { status: "answered" | "unavailable" | "needs_sources"; answer: string; evidence_ids: string[]; artifact_ids: string[] };
export type TeamRequest = Request & { id: string; response?: Answer };
export interface RequestBatch { round: number; state: "queued" | "processing" | "answered"; source_escalated?: boolean; requests: TeamRequest[] }
const REQUEST_CONTRACT = outputContract({ requests: z.array(ResearchRequest).max(5) });
const BRIEF_CONTRACT = outputContract({ approach: z.string().min(1), checks: z.array(z.string().min(1)).min(1), information_needed: z.array(z.string().min(1)) });
const ANSWER_CONTRACT = outputContract({ status: z.enum(["answered", "unavailable", "needs_sources"]), answer: z.string().min(1), evidence_ids: z.array(z.string()), artifact_ids: z.array(z.string()) });
export class ResearchRequestsPending extends Error {
  constructor() { super("Specialists are investigating report requests"); }
}

export async function getTeamRequests(sql: Sql, runId: string): Promise<RequestBatch | null> {
  const [row] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId}
    AND artifact_type = 'team_requests' AND status = 'validated' ORDER BY artifact_version DESC LIMIT 1`;
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
    AND artifact_type = 'agent_brief' AND status = 'validated'`;
  const scopes = new Set(existing.map(r => r.scope_key));
  if (BRIEF_ROLES.every(role => scopes.has(role))) return;
  const [review] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${ctx.runId}
    AND artifact_type = 'source_review' AND status = 'validated' ORDER BY artifact_version DESC LIMIT 1`;
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
      taskKey: `team:brief:${role}`, taskType: "team_brief", agentName: definition.agent, modelTier: "mid", packet,
      outputFormat: BRIEF_CONTRACT, promptFactory: p => exactJsonPrompt({ agentName: definition.agent,
        requiredKeys: BRIEF_CONTRACT.requiredKeys!, packet: p, extraRules: [definition.purpose,
          "Prepare a company-specific work plan and completeness checks against the collected corpus. You are planning, not claiming to have found evidence. Explain what information your specialist needs that the corpus does not contain; the specialist can ask the collector for named documents while it works."] }) });
    await saveReportArtifact(sql, ctx, "agent_brief", role, { role, ...brief });
  }));
  const failed = results.find(r => r.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

/** The report owner decides what is missing, using the complete current input snapshot. */
export async function requestMissingResearch(sql: Sql, ctx: ResearchRunContext, findings: Record<string, any>[] = []) {
  const previous = await getTeamRequests(sql, ctx.runId);
  if (previous && previous.state !== "answered") throw new ResearchRequestsPending();
  // Persisted limit survives worker restarts. Unavailable material answers stay blocked.
  if ((previous?.round || 0) >= 2) return;
  const inputs = await loadReportInputs(sql, ctx.runId, ctx.cutoffAt.toISOString());
  const packet = { asset: { name: ctx.assetName, symbol: ctx.symbol }, ...inputs, previous_requests: previous?.requests || [],
    findings, role: "report", output_contract: "team_requests" };
  const result = await callResearchAgent<{ requests: Request[] }>({ sql, ctx, stageKey: "ai_reviewer",
    taskKey: `team:requests:${previous?.round || 0}`, taskType: "team_requests", agentName: "export-writer", modelTier: "mid",
    packet, outputFormat: REQUEST_CONTRACT, promptFactory: p => exactJsonPrompt({ agentName: "export-writer",
      requiredKeys: ["requests"], packet: p, extraRules: [TEAM_ROLES.report.purpose,
        "Request only specific unanswered investment questions or material inconsistencies. Return an empty requests array when the supplied research is adequate. Do not request information already present or repeat answered/unavailable requests.",
        "Route financial extraction/reconciliation to financials, management/operations/scenarios to business, valuation calculations to valuation, and missing documents to data. Set needs_sources when new external evidence is required; source_role tells the collector where to search. The collector can obtain new documents and the dependent analyses will rerun.",
        "role names the specialist and must be exactly one of: data, financials, business, valuation. Document types such as regulatory_filing or market_data belong in source_role, never in role."] }) });
  const oldQuestions = new Set(previous?.requests.map(r => r.question.trim().toLowerCase()));
  const fresh = result.requests.filter(r => {
    const key = r.question.trim().toLowerCase();
    if (oldQuestions.has(key)) return false;
    oldQuestions.add(key);
    return true;
  });
  if (!fresh.length) return;
  const round = (previous?.round || 0) + 1;
  await saveReportArtifact(sql, ctx, "team_requests", "requests", { round, state: "queued",
    requests: [...(previous?.requests || []), ...fresh.map((r, i) => ({ ...r, id: `request-${round}-${i + 1}` }))] });
  throw new ResearchRequestsPending();
}

/**
 * Citations outside the current inputs are dropped rather than failing the answer: a model can copy an
 * ID from an upstream artifact whose source is not report-eligible. An answer left without support is invalid.
 */
export function keepCurrentReferences(answer: Answer, inputs: { evidence: { id: string }[]; artifacts: { id: string }[] }): Answer {
  const evidence = new Set(inputs.evidence.map(e => e.id));
  const artifacts = new Set(inputs.artifacts.map(a => a.id));
  return { ...answer, evidence_ids: answer.evidence_ids.filter(id => evidence.has(id)),
    artifact_ids: answer.artifact_ids.filter(id => artifacts.has(id)) };
}

export function requestStageRoots(requests: TeamRequest[]): string[] {
  return [...new Set(requests.filter(r => !r.response).map(r =>
    r.needs_sources || r.role === "data" ? "source_discovery" : TEAM_ROLES[r.role].stage))];
}

/** Reopen affected branches atomically with the request state, then let normal stage validation run. */
export async function processResearchRequests(sql: Sql, ctx: ResearchRunContext) {
  let batch = await getTeamRequests(sql, ctx.runId);
  if (!batch || batch.state === "answered") return false;
  const roots = requestStageRoots(batch.requests);
  const affected = dependentStages(roots);
  if (batch.state === "queued") {
    await sql.begin(async tx => {
      const [run] = await tx`SELECT status FROM research_runs WHERE id = ${ctx.runId} FOR UPDATE`;
      if (run?.status !== "running") throw new Error("Research requests cannot bypass a human gate");
      const types = [...new Set(affected.flatMap(key => getStageOutputContract(key)?.requiredKeys || [])),
        "report_outline", "report_section", "report_document", "report_review", "question_register"];
      if (affected.includes("historical_record")) types.push("historical_record", "financial_statement_set", "market_price_history");
      await tx`UPDATE research_stages SET status = 'pending', started_at = NULL, completed_at = NULL,
        validation_result_json = NULL, failure_reason = NULL, updated_at = NOW()
        WHERE research_run_id = ${ctx.runId} AND stage_key = ANY(${affected}::text[]) AND status != 'skipped'`;
      await tx`UPDATE research_tasks SET validation_status = 'invalid', updated_at = NOW()
        WHERE research_run_id = ${ctx.runId} AND stage_id IN
          (SELECT id FROM research_stages WHERE research_run_id = ${ctx.runId} AND stage_key = ANY(${affected}::text[]))
          AND task_type != 'team_brief'`;
      await tx`UPDATE research_artifacts SET status = 'needs_more_work', updated_at = NOW()
        WHERE research_run_id = ${ctx.runId} AND artifact_type = ANY(${types}::text[]) AND status IN ('validated', 'accepted')`;
      await tx`UPDATE research_runs SET metadata_json = metadata_json - 'report_approval', updated_at = NOW() WHERE id = ${ctx.runId}`;
      // Gaps written by reopened stages describe inputs that are about to be rebuilt. Their reruns
      // record any gap that still applies; stale ones must not block the earlier stages meanwhile.
      const owners = Object.entries(GAP_OWNER_STAGES).filter(([, stage]) => affected.includes(stage)).map(([owner]) => owner);
      if (owners.length) await tx`UPDATE source_gaps SET status = 'resolved', resolved_at = NOW(),
        resolution_note = ${`Superseded: its owning stage was reopened by team request round ${batch!.round}.`}
        WHERE research_run_id = ${ctx.runId} AND status = 'open' AND owner = ANY(${owners}::text[])`;
      await tx`UPDATE research_artifacts SET content_json = jsonb_set(content_json, '{state}', '"processing"'::jsonb), updated_at = NOW()
        WHERE research_run_id = ${ctx.runId} AND artifact_type = 'team_requests' AND status = 'validated'`;
    });
    return true;
  }
  const unfinished = await sql`SELECT stage_key FROM research_stages WHERE research_run_id = ${ctx.runId}
    AND stage_key = ANY(${affected.filter(k => !["ai_reviewer", "human_review", "export", "refresh_schedule"].includes(k))}::text[])
    AND status NOT IN ('completed', 'skipped')`;
  if (unfinished.length) return false;
  const inputs = await loadReportInputs(sql, ctx.runId, ctx.cutoffAt.toISOString());
  const results = await Promise.allSettled(batch.requests.map(async request => {
    if (request.response) return request;
    const owner = TEAM_ROLES[request.role];
    const packet = { asset: { name: ctx.assetName, symbol: ctx.symbol }, ...inputs, request, role: request.role,
      output_contract: "team_answer", source_search_attempted: request.needs_sources || batch!.source_escalated };
    const response = await callResearchAgent<Answer>({ sql, ctx, stageKey: owner.stage,
      taskKey: `team:answer:${request.id}`, taskType: "team_answer", agentName: owner.agent, modelTier: "mid", packet,
      outputFormat: { ...ANSWER_CONTRACT, validate(value) {
        const errors = ANSWER_CONTRACT.validate?.(value) || [];
        if (errors.length) return errors;
        const answer = keepCurrentReferences(value as Answer, inputs);
        if (answer.status === "answered" && !answer.evidence_ids.length && !answer.artifact_ids.length) errors.push({ path: "references", message: "An answer requires supporting evidence or artifacts from the supplied current references" });
        return errors;
      } }, promptFactory: p => exactJsonPrompt({ agentName: owner.agent, requiredKeys: ANSWER_CONTRACT.requiredKeys!, packet: p,
        extraRules: [owner.purpose, "Answer the report agent's exact question using the refreshed artifacts and quoted evidence. Use supplied IDs. If it cannot be answered from this corpus, return needs_sources to send it to the collector. If a search has already been attempted without sufficient disclosure, return unavailable and explain the remaining gap. Never treat a search attempt or a finished stage as proof of an answer."] }) });
    return { ...request, response: keepCurrentReferences(response, inputs) };
  }));
  const failure = results.find(r => r.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  const answered = results.map(r => (r as PromiseFulfilledResult<TeamRequest>).value);
  const escalate = !batch.source_escalated && answered.some(r => r.response?.status === "needs_sources" && !r.needs_sources);
  batch = { ...batch, state: escalate ? "queued" : "answered", source_escalated: batch.source_escalated || escalate,
    requests: answered.map(r => r.response?.status !== "needs_sources" ? r :
      escalate && !r.needs_sources ? { ...r, needs_sources: true, response: undefined } :
        { ...r, response: { ...r.response, status: "unavailable" } }) };
  await saveReportArtifact(sql, ctx, "team_requests", "requests", batch);
  return batch.state === "queued";
}

export function includeUnansweredQuestions(outline: ReportOutline, batch: RequestBatch | null): ReportOutline {
  const gaps = batch?.requests.filter(r => r.response?.status !== "answered") || [];
  const ids = new Set(gaps.map(r => r.id));
  return { ...outline, questions: [...outline.questions.filter(q => !ids.has(q.id)), ...gaps.map(r => ({ id: r.id, question: r.question,
    materiality: r.material ? "material" as const : "supporting" as const, status: r.material ? "blocked" as const : "qualified" as const,
    answer: r.response?.answer || "The requested information remains unavailable.", evidence_ids: [], artifact_ids: [], follow_up: r.question }))] };
}
