import { existsSync, readFileSync } from "node:fs";
import { parseStructuredOutput } from "../src/lib/agent-harness/output-parser";
import { getProvider } from "../src/lib/agent-harness/providers/provider";
import { resolveModel } from "../src/lib/agent-harness/latest-model";

/** .env.local, then .env, as the worker reads them: the first value seen wins. */
function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
}

async function main() {
  loadEnv();
  if (process.env.RUN_PROVIDER_SMOKE !== "1") throw new Error("Set RUN_PROVIDER_SMOKE=1 to authorize a paid provider smoke test");
  const provider = getProvider();
  const health = await provider.healthCheck?.();
  if (health?.status !== "healthy") throw new Error(`Provider health check failed: ${health?.message || "unknown"}`);
  const configured = process.env.RESEARCH_SMOKE_MODEL || process.env.RESEARCH_CHEAP_MODEL;
  if (!configured) throw new Error("RESEARCH_SMOKE_MODEL or RESEARCH_CHEAP_MODEL is required");
  // A latest:<family> alias becomes the concrete model, as the runner does.
  const model = await resolveModel(configured, provider);
  const started = Date.now();
  let rawText = "";
  let requestId: string | undefined;
  let outputTokens = 0;
  let completed = false;
  // One entry per request sent: whether it carried output_config (anthropic-direct with a Claude model).
  const outputConfigSent: boolean[] = [];
  for await (const event of provider.stream({
    model,
    prompt: 'Return exactly this JSON object and no Markdown: {"ok":true}',
    temperature: 0,
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  }, AbortSignal.timeout(60_000))) {
    if (event.type === "request.sent") outputConfigSent.push("output_config" in JSON.parse(event.body));
    if (event.type === "response.started") requestId = event.requestId;
    if (event.type === "text.delta") rawText += event.text;
    if (event.type === "usage") outputTokens += event.usage.outputTokens || 0;
    if (event.type === "response.completed") completed = true;
  }
  const parsed = parseStructuredOutput(rawText, ["ok"]) as { ok?: unknown };
  if (!completed || parsed.ok !== true) throw new Error("Provider did not complete the structured JSON smoke response");
  console.log(JSON.stringify({ provider: provider.id, configured, model, requestId, latencyMs: Date.now() - started, outputTokens, outputConfigSent, valid: true }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
