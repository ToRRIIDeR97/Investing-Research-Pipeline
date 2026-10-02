/**
 * Paid smoke test for provider prompt caching. Sends a few small research-agent calls
 * through the configured provider and reports what the provider served from cache:
 *   1. two calls in one run with the same instructions and a shared evidence prefix,
 *   2. a forced schema repair, which repeats its generation request,
 *   3. a control: the same prompt sent from two different runs (different sessions).
 * Every scenario starts with a fresh nonce, so earlier smoke runs cannot warm the cache.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { runResearchAgent } from "../src/lib/agent-harness/runner";
import { calculateCost } from "../src/lib/agent-harness/telemetry";
import type { AgentOutputFormat, AgentResult } from "../src/lib/agent-harness/types";
import { exactJsonPrompt } from "../src/lib/research/run-context";

function loadEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

// Records what the provider actually received and reported, without printing credentials or content.
const wire: Array<{ session: string | null; usage: unknown }> = [];
function observeProviderTraffic() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await original(input, init);
    const entry = { session: new Headers(init?.headers).get("x-opencode-session"), usage: null as unknown };
    wire.push(entry);
    response.clone().text().then((body) => {
      for (const line of body.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        try {
          const payload = JSON.parse(line.slice(5).trim());
          const usage = payload.usage ?? payload.message?.usage;
          if (usage) entry.usage = usage;
        } catch {}
      }
    }).catch(() => undefined);
    return response;
  }) as typeof fetch;
}

const SECTORS = ["lending", "deposits", "card", "technology platform", "investment", "home loans", "personal loans"];
function evidence(nonce: string) {
  return Array.from({ length: 60 }, (_, index) => ({
    id: `ev-${nonce}-${index}`,
    source_document_id: `doc-${index % 9}`,
    claim_type: index % 3 ? "source_fact" : "management_statement",
    claim_text: `Synthetic filing excerpt ${index}: the ${SECTORS[index % SECTORS.length]} segment reported period-over-period changes in originations, funding cost, net interest margin, credit losses and fee income. Management attributed the movement to pricing, product mix and member growth, and disclosed that comparability is affected by a reclassification of servicing fees and a change in the fair-value marks on loans held for sale. Period ${2019 + (index % 6)}, quarter ${1 + (index % 4)}.`,
    confidence: 0.6 + (index % 4) / 10,
  }));
}

const answerFormat: AgentOutputFormat = {
  requiredKeys: ["answer", "evidence_ids"],
  validate: (value) => {
    const output = value as { answer?: unknown; evidence_ids?: unknown };
    return typeof output?.answer === "string" && Array.isArray(output.evidence_ids) ? [] : [{ path: "root", message: "answer and evidence_ids are required" }];
  },
};

function call(scope: string, nonce: string, question: string, outputFormat = answerFormat, extraRules: string[] = []) {
  return runResearchAgent<Record<string, unknown>>({
    agentName: "asset-analyst",
    title: `cache smoke ${nonce}`,
    taskPacket: { output_contract: "cache_smoke", question, asset: { name: `Synthetic Lender ${nonce}`, symbol: "SYN" }, evidence_claims: evidence(nonce) },
    promptFactory: (packet) => exactJsonPrompt({ agentName: "asset-analyst", requiredKeys: outputFormat.requiredKeys, packet,
      extraRules: ["Answer the packet question in at most two sentences, citing evidence ids.", ...extraRules] }),
    outputFormat,
    cacheScope: scope,
    policy: { maxAttempts: 2, maxOutputTokens: 16_384, totalTimeoutMs: 240_000 },
  });
}

const short = (value?: string | null) => value ? createHash("sha256").update(value).digest("hex").slice(0, 10) : null;

function report(label: string, result: AgentResult<Record<string, unknown>>, firstWire: number) {
  const attempt = result.attempts.at(-1)!;
  // Requests from earlier failed attempts precede this attempt's requests.
  const offset = result.attempts.slice(0, -1).reduce((count, earlier) => count + (earlier.passes?.length || 0), 0);
  return (attempt.passes || []).map((pass, index) => {
    const traffic = wire[firstWire + offset + index];
    return {
      call: `${label}${attempt.passes!.length > 1 ? `/${pass.kind}` : ""}`,
      model: attempt.model,
      session: short(traffic?.session),
      input: pass.inputTokens,
      cacheRead: pass.cacheReadTokens ?? "not reported",
      output: pass.outputTokens,
      costUsd: pass.costUsd,
      uncachedCostUsd: calculateCost(attempt.model, pass.inputTokens, pass.outputTokens),
      sharedPrefixTokens: pass.cache?.commonPrefixEstimatedTokens,
      missReason: pass.cache?.cacheMissReason ?? "n/a",
      rawUsage: traffic?.usage,
    };
  });
}

async function main() {
  loadEnv();
  if (process.env.RUN_PAID_RESEARCH !== "1") throw new Error("Set RUN_PAID_RESEARCH=1 to authorize a paid provider cache test");
  process.env.RESEARCH_ALL_AGENTS_MODEL = process.env.RESEARCH_SMOKE_MODEL || "deepseek-v4.1-flash";
  observeProviderTraffic();
  const rows: ReturnType<typeof report> = [];
  const run = async (label: string, work: () => Promise<AgentResult<Record<string, unknown>>>) => {
    const firstWire = wire.length;
    const result = await work();
    await new Promise((resolve) => setTimeout(resolve, 200)); // let the usage tee finish
    rows.push(...report(label, result, firstWire));
  };

  const runA = `smoke-run-${randomUUID()}`;
  const nonceA = randomUUID().slice(0, 8);
  await run("1a same run", () => call(runA, nonceA, "Which segment shows the largest change in funding cost?"));
  await run("1b same run", () => call(runA, nonceA, "What comparability limits does management disclose?"));

  const nonceR = randomUUID().slice(0, 8);
  const code = `R-${nonceR}`;
  const repairFormat: AgentOutputFormat = {
    requiredKeys: ["answer", "evidence_ids", "review_code"],
    validate: (value) => (value as { review_code?: unknown })?.review_code === code ? [] : [{ path: "review_code", message: `must equal "${code}"` }],
  };
  await run("2 repair", () => call(runA, nonceR, "Summarize the credit-loss evidence.", repairFormat,
    ["Set review_code to the review code for this task."]));

  const nonceC = randomUUID().slice(0, 8);
  await run("3a control run X", () => call(`smoke-run-${randomUUID()}`, nonceC, "Which segment shows the largest change in funding cost?"));
  await run("3b control run Y", () => call(`smoke-run-${randomUUID()}`, nonceC, "Which segment shows the largest change in funding cost?"));

  console.log(JSON.stringify(rows, null, 2));
  const total = rows.reduce((sum, row) => sum + row.costUsd, 0);
  const uncached = rows.reduce((sum, row) => sum + row.uncachedCostUsd, 0);
  console.log(JSON.stringify({ calls: rows.length, estimatedCostUsd: Number(total.toFixed(6)), withoutCacheUsd: Number(uncached.toFixed(6)) }));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
