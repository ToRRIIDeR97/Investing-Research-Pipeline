// Fixes for issues seen in the paid MELI (d6f3fbee) and SoFi (dd02bb41) runs of 2026-10-02.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { runResearchAgent } from "../src/lib/agent-harness/runner";
import { ProviderError } from "../src/lib/agent-harness/errors";
import { OpenAICompatibleProvider } from "../src/lib/agent-harness/providers/openai-compatible";
import type { ModelEvent, ModelProvider, ModelRequest } from "../src/lib/agent-harness/types";
import { buildHistoricalRecord } from "../src/lib/research/history/normalizer";
import type { HistoricalObservation } from "../src/lib/research/history/contracts";
import { SOURCE_META_CLAIM } from "../src/lib/research/sources/corpus";
import { ABSENCE_STATEMENT, FOUNDER_TERMS } from "../src/lib/research/handlers/evidence-extraction";
import { evidenceNeeds, FOUNDER_FILINGS_NEED, FOUNDER_ORIGIN_NEED } from "../src/lib/research/memory";

const classifier = {
  selected_profile_key: "operating_company", selected_profile_name: "Operating Company", confidence: 0.9,
  asset_kind: "equity", identity_resolution: {}, required_modules: [], rejected_profiles: [],
  classification_evidence: [], ambiguities: [], recommended_next_tasks: [],
};

class Scripted implements ModelProvider {
  readonly id = "scripted";
  requests: ModelRequest[] = [];
  constructor(private readonly respond: (request: ModelRequest, call: number) => ModelEvent[]) {}
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    for (const event of this.respond(request, this.requests.length)) yield event;
  }
}

/** A response that spends the whole output limit on reasoning and writes nothing. */
const reasoningOnly = (request: ModelRequest): ModelEvent[] => [
  { type: "response.started" },
  { type: "reasoning.delta", text: "thinking..." },
  { type: "usage", usage: { inputTokens: 100, outputTokens: request.maxTokens, reasoningTokens: request.maxTokens } },
  { type: "response.completed", finishReason: "length" },
];
const answer = (): ModelEvent[] => [
  { type: "response.started" },
  { type: "text.delta", text: JSON.stringify(classifier) },
  { type: "usage", usage: { inputTokens: 100, outputTokens: 50 } },
  { type: "response.completed", finishReason: "stop" },
];

test("a pass that spends its whole output limit on reasoning is retried with twice the limit", async () => {
  const provider = new Scripted((request, call) => call === 1 ? reasoningOnly(request) : answer());
  const result = await runResearchAgent({ agentName: "asset-classifier", title: "exhaustion", taskPacket: {}, provider,
    policy: { maxAttempts: 2, maxOutputTokens: 1_000, retryBaseDelayMs: 1 } });
  assert.deepEqual(provider.requests.map(r => r.maxTokens), [1_000, 2_000]);
  assert.equal(result.attempts[0].errorCategory, "output_exhausted");
  assert.match(result.attempts[0].errorMessage || "", /whole output limit \(1000 tokens, 1000 of them reasoning\)/);
  assert.equal(result.attempts[0].maxOutputTokens, 1_000);
  assert.equal(result.attempts[1].maxOutputTokens, 2_000);
});

test("output-limit escalation stops at RESEARCH_MAX_OUTPUT_TOKENS_CEILING", async () => {
  const prior = process.env.RESEARCH_MAX_OUTPUT_TOKENS_CEILING;
  process.env.RESEARCH_MAX_OUTPUT_TOKENS_CEILING = "1500";
  try {
    const provider = new Scripted(request => reasoningOnly(request));
    await assert.rejects(() => runResearchAgent({ agentName: "asset-classifier", title: "ceiling", taskPacket: {}, provider,
      policy: { maxAttempts: 3, maxOutputTokens: 1_000, retryBaseDelayMs: 1 } }));
    // A third attempt at 1,500 would repeat the second request, so escalation stops there.
    assert.deepEqual(provider.requests.map(r => r.maxTokens), [1_000, 1_500]);
  } finally {
    if (prior === undefined) delete process.env.RESEARCH_MAX_OUTPUT_TOKENS_CEILING;
    else process.env.RESEARCH_MAX_OUTPUT_TOKENS_CEILING = prior;
  }
});

test("an empty answer that did not reach the output limit is still a malformed stream", async () => {
  const provider = new Scripted(() => [{ type: "response.started" }, { type: "usage", usage: { inputTokens: 10, outputTokens: 3 } },
    { type: "response.completed", finishReason: "stop" }]);
  await assert.rejects(() => runResearchAgent({ agentName: "asset-classifier", title: "empty", taskPacket: {}, provider,
    policy: { maxAttempts: 1, maxOutputTokens: 1_000 } }), (e: any) => e.attempts?.[0]?.errorCategory === "malformed_stream");
});

test("a spent provider usage limit fails fast instead of being retried", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(429, { "content-type": "application/json", "retry-after": "18000" });
    response.end(JSON.stringify({ type: "error", error: { type: "GoUsageLimitError", message: "Go usage limit exceeded" }, metadata: { limitName: "5 hour" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let requests = 0;
  server.on("request", () => { requests += 1; });
  try {
    const provider = new OpenAICompatibleProvider({ mode: "local", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` });
    await assert.rejects(async () => { for await (const _ of provider.stream({ model: "m", prompt: "x" }, new AbortController().signal)) { /* drain */ } },
      (e: unknown) => e instanceof ProviderError && e.category === "quota_exceeded");
    requests = 0;
    await assert.rejects(() => runResearchAgent({ agentName: "asset-classifier", title: "quota", taskPacket: {}, provider,
      policy: { maxAttempts: 3, retryBaseDelayMs: 1 } }), (e: any) => e.attempts?.length === 1 && e.attempts[0].errorCategory === "quota_exceeded");
    assert.equal(requests, 1, "no retries against a spent limit");
  } finally { server.close(); }
});

const observation = (metric_key: string, fiscal_year: number, fiscal_quarter: number, extra: Partial<HistoricalObservation> = {}): HistoricalObservation => ({
  metric_key, fiscal_year, fiscal_quarter, periodicity: "quarterly", reporting_basis: "gaap", metric_type: "reported", value_numeric: 1,
  confidence: 1, restatement_version: 0, comparability_status: "comparable", metadata_json: {}, ...extra,
});

test("coverage counts metric families through statement categories and line-item names", () => {
  const record = buildHistoricalRecord({
    asset_id: "00000000-0000-0000-0000-000000000001",
    observations: [
      observation("revenue", 2026, 2, { metadata_json: { metric_category: "income_statement" } }),
      observation("us_gaap_Assets", 2026, 2, { metadata_json: { metric_category: "balance_sheet" } }),
      observation("us_gaap_WeightedAverageNumberOfDilutedSharesOutstanding", 2026, 2, { unit: "shares" }),
      observation("us_gaap_PaymentsForRepurchaseOfCommonStock", 2026, 1),
    ],
    requiredMetricKeys: ["income_statement", "balance_sheet", "share_count", "capital_allocation", "deposits"],
    endFiscalYear: 2026, endFiscalQuarter: 2,
  });
  const present = record.coverage.cells.filter(c => c.present).map(c => `${c.metric_key}:${c.fiscal_year}Q${c.fiscal_quarter}`).sort();
  assert.deepEqual(present, ["balance_sheet:2026Q2", "capital_allocation:2026Q1", "income_statement:2026Q2", "share_count:2026Q2"]);
  assert.equal(record.coverage.quarters_present, 4);
});

test("claims about the supplied excerpt are recognised, real facts with similar words are not", () => {
  for (const meta of [
    "The supplied passage identifies Chamath Palihapitiya as a SPAC sponsor but does not name SoFi's founder.",
    "The supplied source chunk consists of the cover page and table of contents of MercadoLibre, Inc.'s final prospectus.",
    "The chunk contains no founder, founding-team, or company-origin narrative.",
  ]) assert.match(meta, SOURCE_META_CLAIM, meta);
  for (const fact of ["The company does not pay dividends on its common stock.", "The passage of the Dodd-Frank Act raised compliance costs for banks."]) {
    assert.doesNotMatch(fact, SOURCE_META_CLAIM, fact);
  }
});

test("only affirmative founder claims satisfy the founder check", () => {
  const counts = (text: string) => FOUNDER_TERMS.test(text) && !ABSENCE_STATEMENT.test(text) && !SOURCE_META_CLAIM.test(text);
  assert.equal(counts("Marcos Galperín, co-founder and Chief Executive Officer, wrote MercadoLibre's business plan in March 1999."), true);
  assert.equal(counts("SoFi is a financial services platform that was founded in 2011 to offer student loan refinancing."), true);
  assert.equal(counts("The filing does not name SoFi's founders or explain why the company was started."), false);
  assert.equal(counts("Founder motivation is unknown from the available material."), false);
  assert.equal(counts("The supplied passage names Mike Cagney as founder."), false);
});

test("founder needs come first, and filings are searched for the founding even without founder documents", () => {
  const needs = evidenceNeeds(["regulatory_filing", "founder_and_company_history", "earnings_release"], { name: "SoFi" });
  assert.deepEqual(needs.slice(0, 2).map(n => n.key), [FOUNDER_ORIGIN_NEED.key, FOUNDER_FILINGS_NEED.key]);
  assert.deepEqual(evidenceNeeds(["regulatory_filing"], { name: "SoFi" }).map(n => n.key), [FOUNDER_FILINGS_NEED.key, "governance", "role:regulatory_filing"]);
  assert.deepEqual(evidenceNeeds(["earnings_release"], { name: "SoFi" }).map(n => n.key), ["role:earnings_release"]);
});
