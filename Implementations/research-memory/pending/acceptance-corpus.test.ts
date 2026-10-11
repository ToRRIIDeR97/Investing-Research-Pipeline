import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { callResearchAgent, exactJsonPrompt } from "../../../src/lib/research/run-context";
import { storeDiscoveredSources } from "../../../src/lib/research/sources/corpus";
import type { AgentOutputFormat, ModelEvent, ModelProvider, ModelRequest } from "../../../src/lib/agent-harness/types";
import { cleanup, corpusCtx, createRun, loadEnv, payload, skipDb as skip, stageCtx, type Ctx } from "../acceptance/fixtures";

loadEnv();
// Never fall through to a paid provider if the scripted provider option is ignored.
process.env.RESEARCH_MODEL_PROVIDER = "mock";

class Scripted implements ModelProvider {
  readonly id = "scripted";
  requests: ModelRequest[] = [];
  constructor(private readonly respond: (call: number, request: ModelRequest) => Record<string, unknown>) {}
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    yield { type: "response.started", requestId: `scripted-${this.requests.length}` };
    yield { type: "text.delta", text: JSON.stringify(this.respond(this.requests.length, request)) };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20, costUsd: 0 } };
    yield { type: "response.completed", finishReason: "stop" };
  }
}

const answer: AgentOutputFormat = { requiredKeys: ["answer"], validate: (v: any) => typeof v?.answer === "string" ? [] : [{ path: "answer", message: "required" }] };
const question = { question: "Who founded the company and in which year?", reason: "The moat history needs the founding facts.", source_role: "company_investor_relations" };
const fullPrompt = (r: ModelRequest) => `${r.system || ""}\n${r.prompt}`;

async function seedCorpus(sql: postgres.Sql, run: Ctx) {
  await storeDiscoveredSources(sql, corpusCtx(run) as any, [payload({ title: "Company page", mimeType: "text/plain", role: "company_investor_relations",
    content: `Our History\n\nMarcos Galperín founded the company in 1999 while studying at Stanford. Fixture ${run.runId}.\n\nProducts\n\nWe run a marketplace.` })]);
}

const ask = (sql: postgres.Sql, run: Ctx, provider: ModelProvider) => callResearchAgent<Record<string, unknown>>({
  sql, ctx: stageCtx(run), stageKey: "moat_analysis", taskKey: "moat:analysis", taskType: "moat_analysis",
  agentName: "asset-analyst", modelTier: "mid", packet: { asset: { name: run.assetName }, output_contract: "moat_fixture" },
  outputFormat: answer, provider,
  promptFactory: (p: Record<string, unknown>) => exactJsonPrompt({ agentName: "asset-analyst", requiredKeys: ["answer"], packet: p }),
} as any);

test("AC-13: a specialist's corpus question is answered from the run's passages and the task reruns with the answer", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    await seedCorpus(sql, run);
    const provider = new Scripted(call => call === 1 ? { answer: "draft", corpus_questions: [question] } : { answer: "final" });
    const output = await ask(sql, run, provider);
    assert.equal(provider.requests.length, 2);
    assert.deepEqual(output, { answer: "final" });
    assert.match(fullPrompt(provider.requests[0]), /corpus_questions/, "the first prompt offers corpus questions");
    assert.match(fullPrompt(provider.requests[1]), /corpus_answers/);
    assert.match(fullPrompt(provider.requests[1]), /Marcos Galperín founded the company in 1999/);
    const [ledger] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${run.runId}
      AND artifact_type = 'corpus_requests' AND scope_key = 'moat_analysis' AND status = 'validated' ORDER BY artifact_version DESC LIMIT 1`;
    assert.ok(ledger, "a corpus_requests ledger is saved");
    const round = ledger.content_json.rounds[0];
    assert.equal(round.questions[0].question, question.question);
    assert.ok(round.questions[0].passages.length >= 1);
    assert.ok(round.questions[0].passages[0].passage_id);

    const replay = new Scripted(() => { throw new Error("a replayed task must not call the model"); });
    assert.deepEqual(await ask(sql, run, replay), { answer: "final" });
    assert.equal(replay.requests.length, 0);
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-13: a task chain gets at most two corpus rounds", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    await seedCorpus(sql, run);
    let n = 0;
    const provider = new Scripted(call => ({ answer: `attempt ${call}`, corpus_questions: [{ ...question, question: `${question.question} Variant ${++n}.` }] }));
    const output = await ask(sql, run, provider);
    assert.equal(provider.requests.length, 3, "initial call plus two corpus reruns");
    assert.equal(output.answer, "attempt 3");
    assert.equal(output.corpus_questions, undefined);
    assert.match(fullPrompt(provider.requests[2]), /do not (return|ask)[^.]*corpus_questions/i);
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});
