import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { callResearchAgent, exactJsonPrompt } from "../../../src/lib/research/run-context";
import { storeDiscoveredSources } from "../../../src/lib/research/sources/corpus";
import type { AgentOutputFormat, ModelEvent, ModelProvider, ModelRequest } from "../../../src/lib/agent-harness/types";
import { corpusContext, handlerContext, loadEnv, newRun, removeRuns, sections, skipDb as skip, source, type Run } from "./fixtures";

loadEnv();
// Never fall through to a paid provider if the scripted provider option is ignored.
process.env.RESEARCH_MODEL_PROVIDER = "mock";
delete process.env.RESEARCH_EMBEDDING_PROVIDER;

class Script implements ModelProvider {
  readonly id = "verify-script";
  requests: ModelRequest[] = [];
  constructor(private readonly outputs: Array<Record<string, unknown>>) {}
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const output = this.outputs[Math.min(this.requests.length, this.outputs.length) - 1];
    yield { type: "response.started" };
    yield { type: "text.delta", text: JSON.stringify(output) };
    yield { type: "usage", usage: { inputTokens: 50, outputTokens: 10, costUsd: 0 } };
    yield { type: "response.completed", finishReason: "stop" };
  }
}

const format: AgentOutputFormat = { requiredKeys: ["answer"], validate: (v: any) => typeof v?.answer === "string" ? [] : [{ path: "answer", message: "required" }] };
const q = (question: string, extra: Record<string, unknown> = {}) => ({ question, reason: "Needed for the analysis at hand.", ...extra });
const promptOf = (r: ModelRequest) => `${r.system || ""}\n${r.prompt}`;

async function corpus(sql: postgres.Sql, run: Run) {
  await storeDiscoveredSources(sql, corpusContext(run) as any, [source("About", sections([["Our Story", `Ana Ruiz founded Andes Payments in 2011. ${run.runId}`]]), "text/plain", "company_investor_relations")]);
}

const call = (sql: postgres.Sql, run: Run, provider: ModelProvider, over: Record<string, unknown> = {}) => callResearchAgent<Record<string, unknown>>({
  sql, ctx: handlerContext(run), stageKey: "moat_analysis", taskKey: "moat:verify", taskType: "moat_analysis", agentName: "asset-analyst", modelTier: "mid",
  packet: { asset: { name: run.assetName }, output_contract: "verify" }, outputFormat: format, provider,
  promptFactory: (p: Record<string, unknown>) => exactJsonPrompt({ agentName: "asset-analyst", requiredKeys: ["answer"], packet: p }), ...over,
} as any);

test("AC-13: a repeated question is not answered again and ends the chain", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    await corpus(sql, run);
    const same = q("Who founded Andes Payments and when?");
    const provider = new Script([{ answer: "one", corpus_questions: [same] }, { answer: "two", corpus_questions: [same] }]);
    const output = await call(sql, run, provider);
    assert.equal(provider.requests.length, 2);
    assert.deepEqual(output, { answer: "two" });
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});

test("AC-13: invalid items are ignored, at most three questions are answered, and all-invalid asks cause no rerun", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql), other = await newRun(sql);
  try {
    await corpus(sql, run);
    const asks = [q("short"), q("Who founded the company?"), q("When was the wallet licensed?"), q("What is the merchant discount rate?"), q("How large was the Series B round?")];
    const provider = new Script([{ answer: "draft", corpus_questions: asks }, { answer: "done" }]);
    await call(sql, run, provider);
    const [ledger] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${run.runId} AND artifact_type = 'corpus_requests' ORDER BY artifact_version DESC LIMIT 1`;
    const answered = ledger.content_json.rounds[0].questions.map((x: any) => x.question);
    assert.ok(answered.length <= 3);
    assert.ok(!answered.includes("short"));

    await corpus(sql, other);
    const invalidOnly = new Script([{ answer: "only", corpus_questions: [q("tiny"), { reason: "no question field" }] }]);
    const output = await call(sql, other, invalidOnly);
    assert.equal(invalidOnly.requests.length, 1);
    assert.equal(output.answer, "only");
  } finally { await removeRuns(sql, [run, other]); await sql.end(); }
});

test("AC-13: team tasks and stages outside the source-request roles never get corpus rounds", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    await corpus(sql, run);
    const ask = { answer: "x", corpus_questions: [q("Who founded the company and why?")] };
    const team = new Script([ask]);
    await call(sql, run, team, { taskKey: "team:brief:business", taskType: "team_brief" });
    assert.equal(team.requests.length, 1);
    const reviewer = new Script([ask]);
    await call(sql, run, reviewer, { stageKey: "ai_reviewer", taskKey: "review:verify", taskType: "ai_review", agentName: "research-reviewer" });
    assert.equal(reviewer.requests.length, 1);
    assert.doesNotMatch(promptOf(reviewer.requests[0]), /corpus_questions/);
    const [ledger] = await sql`SELECT id FROM research_artifacts WHERE research_run_id = ${run.runId} AND artifact_type = 'corpus_requests'`;
    assert.equal(ledger, undefined);
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});

test("AC-13: a role-scoped question with no documents for that role records the gap", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    await corpus(sql, run);
    const provider = new Script([{ answer: "draft", corpus_questions: [q("What were third quarter results?", { source_role: "earnings_release" })] }, { answer: "final" }]);
    await call(sql, run, provider);
    const [ledger] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${run.runId} AND artifact_type = 'corpus_requests' ORDER BY artifact_version DESC LIMIT 1`;
    const entry = ledger.content_json.rounds[0].questions[0];
    assert.deepEqual(entry.passages, []);
    assert.equal(entry.gaps[0].reason, "no_documents_for_role");
    assert.match(promptOf(provider.requests[1]), /no_documents_for_role/);
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});
