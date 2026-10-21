/**
 * npm run eval:judge -- <run-id> [dimension,...]: the opt-in LLM judge. Paid: it refuses to run without
 * RUN_PAID_EVAL=1. One call per rubric dimension on the configured provider; RESEARCH_EVAL_JUDGE_MODEL picks a
 * higher tier than the writers (it overrides RESEARCH_ALL_AGENTS_MODEL for this process only). Reads the run
 * read-only and writes evals/results/<case>/<run-id>.judge.json, with agreement against the human ratings.
 */
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runResearchAgent } from "../src/lib/agent-harness/runner";
import { exactJsonPrompt, type Sql } from "../src/lib/research/run-context";
import { loadRunSnapshot } from "../src/lib/research/scoring/load";
import { JUDGE_RULES, JudgeScore, judgeContract, judgePacket } from "../src/lib/research/scoring/judge";
import { RUBRIC_DIMENSIONS, ratingAgreement } from "../src/lib/research/scoring/rubric";

if (process.env.RUN_PAID_EVAL !== "1") throw new Error("The judge sends paid model calls: set RUN_PAID_EVAL=1");
for (const file of [".env.local", ".env"]) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const [key, ...rest] = line.trim().split("=");
    if (key && !key.startsWith("#") && rest.length && !process.env[key]) process.env[key] = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
  }
}
if (process.env.RESEARCH_EVAL_JUDGE_MODEL) process.env.RESEARCH_ALL_AGENTS_MODEL = process.env.RESEARCH_EVAL_JUDGE_MODEL;
const [runId, only] = process.argv.slice(2);
if (!runId || !process.env.DATABASE_URL) throw new Error("Usage: RUN_PAID_EVAL=1 npm run eval:judge -- <run-id> [dimension,...]");
const sql = postgres(process.env.DATABASE_URL, { max: 2, connection: { default_transaction_read_only: true } }) as unknown as Sql;

async function main() {
  const snapshot = await loadRunSnapshot(sql, runId);
  if (!snapshot.document) throw new Error("The run has no report_document to judge");
  const dimensions = RUBRIC_DIMENSIONS.filter((d) => !only || only.split(",").includes(d.id));
  const scope = `research-judge-${randomUUID()}`;
  const scores: Record<string, JudgeScore & { cost_usd: number }> = {};
  for (const dimension of dimensions) {
    const packet = judgePacket(dimension, snapshot.document, snapshot.artifacts);
    const contract = judgeContract(packet);
    const result = await runResearchAgent<JudgeScore>({ agentName: "research-reviewer", title: `research judge ${dimension.id}`, taskPacket: packet,
      cacheScope: scope, outputFormat: contract,
      promptFactory: (p) => exactJsonPrompt({ agentName: "research-reviewer", requiredKeys: contract.requiredKeys, packet: p, extraRules: JUDGE_RULES }) });
    const cost = result.attempts.flatMap((a) => a.passes ?? []).reduce((n, pass) => n + Number(pass.costUsd ?? 0), 0);
    scores[dimension.id] = { ...JudgeScore.parse(result.structured), cost_usd: Number(cost.toFixed(6)) };
    console.log(`${dimension.id}: ${scores[dimension.id].score} (${scores[dimension.id].rationale.slice(0, 120)})`);
  }
  const human: Record<string, number> = snapshot.run.metadata?.review_rubric?.ratings ?? {};
  const judged = Object.fromEntries(Object.entries(scores).map(([id, s]) => [id, s.score]));
  const output = { run_id: runId, asset: snapshot.run.asset_slug, judged_at: new Date().toISOString(), model: process.env.RESEARCH_ALL_AGENTS_MODEL ?? "agent default",
    scores, mean: Object.values(judged).length ? Object.values(judged).reduce((a, b) => a + b, 0) / Object.values(judged).length : null,
    human_ratings: human, agreement_within_one: ratingAgreement(judged, human),
    cost_usd: Number(Object.values(scores).reduce((n, s) => n + s.cost_usd, 0).toFixed(6)) };
  const dir = resolve(process.cwd(), "evals", "results", snapshot.run.asset_slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${runId}.judge.json`), JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify({ mean: output.mean, agreement_within_one: output.agreement_within_one, cost_usd: output.cost_usd }));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => (sql as unknown as { end: () => Promise<void> }).end());
