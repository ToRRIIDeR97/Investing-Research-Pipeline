import { existsSync, readFileSync } from "node:fs";
import { runResearchAgent } from "../src/lib/agent-harness/runner";
import { createSourceReaderBatches, mergeSourceReaderOutputs } from "../src/lib/research/source-reader-batching";

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
  if (process.env.RUN_SOURCE_READER_SMOKE !== "1") {
    throw new Error("Set RUN_SOURCE_READER_SMOKE=1 to authorize the paid source-reader smoke test");
  }
  const facts = [
    "Commerce revenue increased during the reported period.",
    "Fintech payment volume increased during the reported period.",
    "The credit portfolio carried an explicit allowance for expected losses.",
    "Operating cash flow remained positive during the reported period.",
    "Management identified currency volatility as a material operating risk.",
  ];
  const chunks = facts.map((fact, index) => ({
    source_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    document_parse_id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    document_chunk_id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    source_type: "smoke_fixture",
    title: `Smoke source ${index + 1}`,
    chunk_index: 0,
    char_start: 0,
    char_end: fact.length,
    content_excerpt: fact,
  }));
  const packet = { asset: { symbol: "MELI" }, source_corpus: chunks };
  const result = await runResearchAgent<Record<string, unknown>>({
    agentName: "source-reader",
    title: "MELI bounded source-reader smoke",
    taskPacket: packet,
    promptFactory: (value) => [
      "Return exactly one JSON object with keys evidence_claims, contradictions, source_gaps, low_confidence_items, rejected_candidates.",
      "Return five evidence_claims, one per source_corpus item. Each claim requires claim_text (at least 20 characters), claim_type, claim_category='fact', confidence, source_id, document_chunk_id, char_start, and char_end copied exactly from the item.",
      "All other top-level fields must be arrays. Do not return Markdown.",
      JSON.stringify(value),
    ].join("\n\n"),
    policy: { totalTimeoutMs: 90_000, inactivityTimeoutMs: 30_000, maxAttempts: 1 },
  });
  const batches = createSourceReaderBatches(chunks);
  const merged = mergeSourceReaderOutputs([result.structured], batches);
  if (merged.evidence_claims.length !== 5) {
    throw new Error(`Source-reader smoke returned ${merged.evidence_claims.length}/5 source-validated claims`);
  }
  console.log(JSON.stringify({
    provider: result.usage.provider,
    model: result.usage.model,
    latencyMs: result.usage.latencyMs,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    reasoningTokens: result.usage.reasoningTokens,
    costUsd: result.usage.costUsd,
    validClaims: merged.evidence_claims.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
