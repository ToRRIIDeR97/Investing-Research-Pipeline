import assert from "node:assert/strict";
import test from "node:test";
import { MockProvider } from "../src/lib/agent-harness/providers/mock";

test("mock source-reader uses the requested asset and financial modules", async () => {
  const provider = new MockProvider();
  const prompt = JSON.stringify({
    asset: {
      assetName: "SoFi Technologies, Inc.",
      symbol: "SOFI",
      requiredModules: ["ptbv", "roe_vs_coe", "nim", "cet1"],
    },
    source_corpus: [{
      source_id: "source-1",
      document_chunk_id: "chunk-1",
      content_excerpt: "Fixture source text",
    }],
  });

  let text = "";
  for await (const event of provider.stream(
    { model: "mock", prompt, agentName: "source-reader" },
    new AbortController().signal
  )) {
    if (event.type === "text.delta") text += event.text;
  }

  const output = JSON.parse(text);
  const claims = output.evidence_claims.map((claim: Record<string, unknown>) =>
    String(claim.claim_text)
  );
  assert.ok(claims.some((claim: string) => claim.includes("SoFi Technologies, Inc. ptbv")));
  assert.ok(claims.some((claim: string) => claim.includes("SoFi Technologies, Inc. cet1")));
  assert.ok(claims.every((claim: string) => !claim.includes("MercadoLibre")));
});
