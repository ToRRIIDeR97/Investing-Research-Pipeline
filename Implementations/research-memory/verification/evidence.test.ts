import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { storeDiscoveredSources } from "../../../src/lib/research/sources/corpus";
import { evidenceExtractionHandler } from "../../../src/lib/research/handlers/evidence-extraction";
import { getStageSourceRequests, saveStageSourceRequests, SourceRequestsPending } from "../../../src/lib/research/sources/source-requests";
import { corpusContext, handlerContext, loadEnv, newRun, removeRuns, sections, skipDb as skip, source } from "./fixtures";

loadEnv();
process.env.RESEARCH_MODEL_PROVIDER = "mock";
delete process.env.RESEARCH_EMBEDDING_PROVIDER;

const padding = Array.from({ length: 40 }, (_, i) => [`Topic ${i + 1}`, `Routine operating commentary number ${i + 1} about logistics, staffing and seasonal demand patterns across regions.`] as [string, string]);
const longAboutPage = (nonce: string) => sections([...padding, ["Our Story", `Ana Ruiz founded Andes Payments in 2011 because small shops could not accept cards. ${nonce}`]]);
const modelCalls = async (sql: postgres.Sql, runId: string) => Number((await sql`SELECT COUNT(*)::int AS n FROM model_call_logs WHERE research_run_id = ${runId}`)[0].n);

test("AC-6: a founder story deep inside a plain-text page reaches the source reader, and a resumed stage makes no new calls", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    await storeDiscoveredSources(sql, corpusContext(run) as any, [
      source("About us", longAboutPage(run.runId), "text/plain", "founder_and_company_history"),
      source("Annual results", sections([["Results", "Total payment volume rose 40 percent."]]), "text/plain", "earnings_release"),
    ]);
    await evidenceExtractionHandler.execute(handlerContext(run));
    const tasks = await sql`SELECT input_json FROM research_tasks WHERE research_run_id = ${run.runId} AND agent_name = 'source-reader'`;
    const chunks = tasks.flatMap(t => (t.input_json?.packet?.source_corpus || []) as any[]);
    const story = chunks.find(c => String(c.content_excerpt).includes("Ana Ruiz"));
    assert.ok(story);
    assert.deepEqual(story.section_path, ["Our Story"]);
    assert.equal(story.need, "founder_origin");
    const before = await modelCalls(sql, run.runId);
    await evidenceExtractionHandler.execute(handlerContext(run));
    assert.equal(await modelCalls(sql, run.runId), before, "a rerun reuses completed source-reader tasks");
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});

test("AC-14: no founder documents at all also escalates, and a pending round is not queued twice", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    await storeDiscoveredSources(sql, corpusContext(run) as any, [source("Annual results", sections([["Results", `Volume rose. ${run.runId}`]]), "text/plain", "earnings_release")]);
    await assert.rejects(() => evidenceExtractionHandler.execute(handlerContext(run)), (e: unknown) => e instanceof SourceRequestsPending);
    await assert.rejects(() => evidenceExtractionHandler.execute(handlerContext(run)), (e: unknown) => e instanceof SourceRequestsPending);
    const ledger = await getStageSourceRequests(sql, run.runId, "evidence_extraction");
    assert.equal(ledger!.rounds.length, 1, "the queued round is reused while it waits");
    assert.match(ledger!.rounds[0].requests[0].query, /Andes Payments Verification/);
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});

test("AC-14: once the collector fetches a founder document, extraction proceeds without asking again", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    await storeDiscoveredSources(sql, corpusContext(run) as any, [source("Annual results", sections([["Results", `Volume rose. ${run.runId}`]]), "text/plain", "earnings_release")]);
    await assert.rejects(() => evidenceExtractionHandler.execute(handlerContext(run)), (e: unknown) => e instanceof SourceRequestsPending);
    const ledger = (await getStageSourceRequests(sql, run.runId, "evidence_extraction"))!;
    const [fetched] = await storeDiscoveredSources(sql, corpusContext(run) as any, [source("Founder interview", longAboutPage(run.runId), "text/plain", "founder_and_company_history")]);
    await saveStageSourceRequests(sql, run, { ...ledger, rounds: ledger.rounds.map(r => ({ ...r, state: "fetched" as const,
      requests: r.requests.map(q => ({ ...q, status: "fetched" as const, documents: [{ source_id: fetched.sourceId, title: fetched.title, url: fetched.url || null }] })) })) });
    const output = await evidenceExtractionHandler.execute(handlerContext(run));
    assert.equal(output.status, "success");
    const after = (await getStageSourceRequests(sql, run.runId, "evidence_extraction"))!;
    assert.equal(after.rounds.length, 1, "no further collector round");
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});
