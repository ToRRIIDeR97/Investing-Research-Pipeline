// Independent runner checks: client-side validation and repair stay in charge (AC-5), and the
// structured request is consistent across passes without collateral changes (AC-7).
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod/v4";
import { ResearchAgentRunError } from "../../../src/lib/agent-harness/errors";
import { MockProvider } from "../../../src/lib/agent-harness/providers/mock";
import { getProvider } from "../../../src/lib/agent-harness/providers/provider";
import { runResearchAgent } from "../../../src/lib/agent-harness/runner";
import { outputContract } from "../../../src/lib/research/reporting/contracts";
import { researchTaskKey } from "../../../src/lib/research/run-context";
import { COMPANY_GENESIS_CONTRACT } from "../../../src/lib/research/stage-contracts";
import { DIRECT_ENV, queuedFetch, scopedEnv, sse } from "./fixtures";

const PEERS = outputContract({
  peers: z.array(z.object({ name: z.string(), weight: z.number().min(0).max(1) })).min(2),
  note: z.string().nullable(),
});
const ONE_HEAVY_PEER = JSON.stringify({ peers: [{ name: "Peer A", weight: 1.5 }], note: null });
const TWO_PEERS = JSON.stringify({ peers: [{ name: "Peer A", weight: 0.6 }, { name: "Peer B", weight: 0.4 }], note: "sized by revenue" });

const runPeers = () => runResearchAgent<any>({
  agentName: "valuation-analyst", title: "peer weights", taskPacket: { output_contract: "peer_weights" },
  outputFormat: PEERS, provider: getProvider("anthropic-direct"), policy: { maxAttempts: 1, maxRepairAttempts: 1 },
});

test("AC-5: too few items and an out-of-range number pass the wire schema but still enter repair", async () => {
  await scopedEnv(DIRECT_ENV, async () => {
    await queuedFetch([[200, sse(ONE_HEAVY_PEER)], [200, sse(TWO_PEERS)]], async (sent) => {
      const result = await runPeers();
      assert.equal(sent.length, 2);
      assert.ok(sent[0].json.output_config && sent[1].json.output_config, "both passes are structured");
      const wire = JSON.stringify(sent[0].json.output_config);
      assert.ok(!wire.includes("maximum") && !wire.includes('"minItems":2'), "the wire schema omits the constraints the client enforces");
      const paths = (result.attempts[0].passes?.[0].validationErrors || []).map((error) => error.path);
      assert.ok(paths.includes("peers") && paths.includes("peers.0.weight"), JSON.stringify(paths));
      assert.equal(result.structured.peers.length, 2);
    });
  });
});

test("AC-5: a repaired response that still breaks the contract fails the task as before", async () => {
  await scopedEnv(DIRECT_ENV, async () => {
    await queuedFetch([[200, sse(ONE_HEAVY_PEER)]], async (sent) => {
      const failure = await runPeers().then(() => null, (error) => error);
      assert.ok(sent[0].json.output_config, "the generation pass is structured");
      assert.equal(sent.length, 2, "one generation, one repair, no extra passes");
      assert.ok(failure instanceof ResearchAgentRunError, String(failure));
      assert.equal((failure as ResearchAgentRunError).responseMetadata.error_type, "schema_validation");
    });
  });
});

test("AC-7: a real stage contract keeps one output_config across generation and repair, without collateral changes", async () => {
  const packet = { output_contract: "company_genesis", asset: { assetName: "Example company" } };
  let raw = "";
  for await (const event of new MockProvider().stream({ model: "mock", agentName: "asset-analyst", prompt: JSON.stringify(packet) }, new AbortController().signal)) {
    if (event.type === "text.delta") raw += event.text;
  }
  const valid = JSON.parse(raw);
  const invalid = structuredClone(valid);
  invalid.company_genesis.material_claims[0].confidence = 2; // a number; only the stripped maximum forbids it
  const keyInput = { packet, output_format: COMPANY_GENESIS_CONTRACT, agent: "asset-analyst", model: "claude-haiku-5-5" };
  const keyBefore = researchTaskKey("company_genesis:primary", keyInput);
  const schemaBefore = JSON.stringify(COMPANY_GENESIS_CONTRACT.schema);

  await scopedEnv(DIRECT_ENV, async () => {
    await queuedFetch([[200, sse(JSON.stringify(invalid))], [200, sse(JSON.stringify(valid))]], async (sent) => {
      const result = await runResearchAgent<any>({
        agentName: "asset-analyst", title: "genesis", taskPacket: packet, outputFormat: COMPANY_GENESIS_CONTRACT,
        provider: getProvider("anthropic-direct"), policy: { maxAttempts: 1 },
      });
      assert.equal(sent.length, 2);
      assert.equal(sent[0].json.output_config?.format?.type, "json_schema");
      assert.deepEqual(sent[1].json.output_config, sent[0].json.output_config);
      assert.equal(result.attempts[0].repairAttempted, true);
      assert.ok(JSON.stringify(sent[1].json.messages).includes(JSON.stringify(schemaBefore).slice(1, -1)),
        "the repair prompt quotes the unmodified contract schema");
      const { output_config: _a, ...generation } = sent[0].json;
      assert.equal(generation.system?.[0]?.text ?? generation.system, sent[1].json.system?.[0]?.text ?? sent[1].json.system,
        "the instructions are the same on both passes");
    });
  });
  assert.equal(JSON.stringify(COMPANY_GENESIS_CONTRACT.schema), schemaBefore);
  assert.equal(researchTaskKey("company_genesis:primary", keyInput), keyBefore);
});

test("AC-7: an agent without an output contract uses its registry schema, which is not sent", async () => {
  const classifier = {
    selected_profile_key: "operating_company", selected_profile_name: "Operating Company", confidence: 0.9,
    asset_kind: "equity", identity_resolution: {}, required_modules: [], rejected_profiles: [],
    classification_evidence: [], ambiguities: [], recommended_next_tasks: [],
  };
  await scopedEnv(DIRECT_ENV, async () => {
    await queuedFetch([[200, sse(JSON.stringify(classifier))]], async (sent) => {
      const result = await runResearchAgent<any>({
        agentName: "asset-classifier", title: "classify", taskPacket: { asset: "Example" },
        provider: getProvider("anthropic-direct"), policy: { maxAttempts: 1 },
      });
      assert.equal(sent.length, 1);
      assert.equal(sent[0].text.includes("output_config"), false);
      assert.equal(result.structured.selected_profile_key, "operating_company");
    });
  });
});

// AC-8 (independent): the repair pass records its own structured-output state, and the mock records none.
test("AC-8: generation and repair passes each carry structuredOutput", async () => {
  const contract = outputContract({ verification_telemetry: z.string().min(2) });
  await scopedEnv(DIRECT_ENV, async () => {
    await queuedFetch([[200, sse(JSON.stringify({ verification_telemetry: "x" }))], [200, sse(JSON.stringify({ verification_telemetry: "long enough" }))]], async () => {
      const result = await runResearchAgent<any>({ agentName: "valuation-analyst", title: "telemetry repair", taskPacket: { output_contract: "verification_telemetry" },
        outputFormat: contract, provider: getProvider("anthropic-direct"), policy: { maxAttempts: 1, maxRepairAttempts: 1 } });
      const passes = result.attempts[0].passes ?? [];
      assert.deepEqual(passes.map((pass: any) => pass.kind), ["generation", "repair"]);
      assert.ok(passes.every((pass: any) => pass.structuredOutput?.sent === true && pass.structuredOutput?.fallback === false), JSON.stringify(passes.map((p: any) => p.structuredOutput)));
    });
  });
});

test("AC-8: the mock provider's passes record sent=false", async () => {
  const contract = outputContract({ mock_telemetry: z.string() });
  const provider = new MockProvider({ scenario: "success" } as any);
  const result = await runResearchAgent<any>({ agentName: "asset-analyst", title: "mock telemetry", taskPacket: { output_contract: "mock_telemetry" },
    outputFormat: contract, provider, policy: { maxAttempts: 1, maxRepairAttempts: 1 } }).catch((error: any) => error.attempts ? { attempts: error.attempts } : { attempts: [] });
  const pass = result.attempts?.[0]?.passes?.[0];
  assert.ok(pass, "the mock produced a pass");
  assert.deepEqual(pass.structuredOutput, { sent: false, fallback: false });
});
