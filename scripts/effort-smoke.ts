/**
 * Paid smoke test for model tiering and effort (a few cents). Sends one tiny structured-output call per tier
 * (cheap, mid, premium) through anthropic-direct on claude-haiku-5-5, so all three effort levels are exercised on the
 * cheapest model, and prints for each: the model, output_config.effort and thinking that went on the wire, whether
 * the answer parsed, tokens, latency and cost. It also checks that no budget_tokens is sent.
 *
 * Usage (needs RUN_PROVIDER_SMOKE=1 and an Anthropic key in .env.local or the environment):
 *   RUN_PROVIDER_SMOKE=1 RESEARCH_MODEL_PROVIDER=anthropic-direct RESEARCH_MODEL_BASE_URL=https://api.anthropic.com/v1 \
 *     RESEARCH_MODEL_ALLOWED_HOSTS=api.anthropic.com npx tsx scripts/effort-smoke.ts
 * Optional: SMOKE_MODEL=claude-sonnet-5-5 (or claude-opus-5-5) to check another model.
 */
import { existsSync, readFileSync } from "node:fs";
import { runResearchAgent } from "../src/lib/agent-harness/runner";
import type { AgentOutputFormat } from "../src/lib/agent-harness/types";
import { taskExecution } from "../src/lib/research/model-tiering";

if (process.env.RUN_PROVIDER_SMOKE !== "1") throw new Error("Paid smoke test: set RUN_PROVIDER_SMOKE=1 to run it.");
if (existsSync(".env.local")) for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
}
if (process.env.RESEARCH_MODEL_PROVIDER !== "anthropic-direct") throw new Error("Set RESEARCH_MODEL_PROVIDER=anthropic-direct: effort is sent only there.");
const model = process.env.SMOKE_MODEL || "claude-haiku-5-5";
for (const tier of ["PREMIUM", "MID", "CHEAP"]) process.env[`RESEARCH_${tier}_MODEL`] = model;

// Captures the wire body's effort fields only; prompts and credentials are never printed.
const sent: Record<string, unknown>[] = [];
const original = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  try {
    const body = JSON.parse(String(init?.body ?? "{}"));
    sent.push({ model: body.model, effort: body.output_config?.effort ?? null, thinking: body.thinking ?? null,
      format: Boolean(body.output_config?.format), max_tokens: body.max_tokens, budget_tokens: JSON.stringify(body).includes("budget_tokens") });
  } catch { /* not JSON */ }
  return original(input, init);
}) as typeof fetch;

const format: AgentOutputFormat = {
  requiredKeys: ["answer"],
  schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
  validate: (value) => typeof (value as { answer?: unknown })?.answer === "string" ? [] : [{ path: "answer", message: "string required" }],
};

async function main() {
  let total = 0;
  for (const tier of ["cheap", "mid", "premium"]) {
    const execution = taskExecution({ agentName: "asset-analyst", modelTier: tier, stageKey: "effort_smoke" });
    const before = sent.length;
    const result = await runResearchAgent<{ answer: string }>({
      agentName: "asset-analyst", title: `effort smoke ${tier}`, taskPacket: { question: "In one word, what colour is the sky on a clear day?" },
      prompt: 'Answer the question in the packet. Return {"answer": "<word>"}. Packet: {"question": "In one word, what colour is the sky on a clear day?"}',
      model: execution.model, fallbackModel: null, policy: { ...execution.policy, maxOutputTokens: 2_048, maxAttempts: 1 }, outputFormat: format,
    });
    total += result.usage.costUsd;
    console.log(JSON.stringify({ tier, expected_effort: execution.effort, wire: sent.slice(before), answer: result.structured?.answer,
      input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens, latency_ms: result.usage.latencyMs, cost_usd: result.usage.costUsd }));
  }
  const failures = sent.filter((body) => body.budget_tokens || !body.effort || (body.thinking as { type?: string } | null)?.type !== "adaptive");
  console.log(JSON.stringify({ requests: sent.length, total_cost_usd: Number(total.toFixed(6)), shape_ok: failures.length === 0 }));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
