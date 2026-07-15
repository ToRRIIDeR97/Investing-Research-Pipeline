import { existsSync, readFileSync } from "node:fs";
import { getProvider } from "../src/lib/agent-harness/providers/provider";
import { runResearchAgent } from "../src/lib/agent-harness/runner";

function loadEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

async function main() {
  loadEnv();
  if (process.env.RUN_PROVIDER_SMOKE !== "1") throw new Error("Set RUN_PROVIDER_SMOKE=1 to authorize a paid provider smoke test");
  const provider = getProvider();
  const health = await provider.healthCheck?.();
  if (health?.status !== "healthy") throw new Error(`Provider health check failed: ${health?.message || "unknown"}`);
  const result = await runResearchAgent<any>({
    agentName: "asset-classifier", title: "Provider smoke test", provider,
    taskPacket: { asset: { symbol: "MELI", kind: "equity" }, instruction: "Classify the asset with minimal output." },
    policy: { totalTimeoutMs: 60_000, inactivityTimeoutMs: 20_000, maxOutputTokens: 800, maxResponseBytes: 20_000, maxAttempts: 1 },
  });
  console.log(JSON.stringify({ provider: result.usage.provider, model: result.usage.model, requestId: result.usage.requestId, latencyMs: result.usage.latencyMs, outputTokens: result.usage.outputTokens, valid: Boolean(result.structured) }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
