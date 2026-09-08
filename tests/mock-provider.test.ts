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

test("mock source-reader honors the batch target without dropping founder evidence", async () => {
  const provider = new MockProvider();
  const prompt = JSON.stringify({
    asset: { assetName: "SoFi Technologies, Inc." },
    batch: { claim_target: 5 },
    source_corpus: [
      {
        source_id: "founder-source",
        document_chunk_id: "founder-chunk",
        source_role: "founder_and_company_history",
        content_excerpt: "Mock founder and company history data",
      },
      {
        source_id: "filing-source",
        document_chunk_id: "filing-chunk",
        source_role: "regulatory_filing",
        content_excerpt: "Mock regulatory filing evidence data",
      },
    ],
  });

  let text = "";
  for await (const event of provider.stream(
    { model: "mock", prompt, agentName: "source-reader" },
    new AbortController().signal
  )) {
    if (event.type === "text.delta") text += event.text;
  }

  const output = JSON.parse(text);
  assert.equal(output.evidence_claims.length, 5);
  assert.ok(output.evidence_claims.some((claim: Record<string, unknown>) =>
    claim.source_id === "founder-source" && String(claim.claim_text).includes("founded")
  ));
});

test('mock coverage claims keep founder evidence on its assigned source regardless of source order', async () => {
  for (const includeFounder of [true, false]) {
    const sources = [
      { source_id: 'filing', document_chunk_id: 'filing-chunk', content_excerpt: 'Mock regulatory filing evidence data.' },
      ...(includeFounder ? [{ source_id: 'founder', document_chunk_id: 'founder-chunk', source_role: 'founder_and_company_history', content_excerpt: 'Mock founder and company history data.' }] : []),
    ];
    let text = '';
    for await (const event of new MockProvider().stream({ model: 'mock', agentName: 'source-reader', prompt: JSON.stringify({
      batch: { claim_target: 5, coverage_slots: ['consolidated_financials', 'founder_and_company_history'] }, source_corpus: sources,
    }) }, new AbortController().signal)) {
      if (event.type === 'text.delta') text += event.text;
    }
    const founderClaims = JSON.parse(text).evidence_claims.filter((claim: any) => /founder|founded|origin/.test(claim.claim_text));
    assert.equal(founderClaims.length > 0, includeFounder);
    assert.ok(founderClaims.every((claim: any) => claim.source_id === 'founder'));
  }
});
