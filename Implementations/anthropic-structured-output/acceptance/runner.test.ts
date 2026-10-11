// AC-5 and AC-7 through runResearchAgent, with a scripted provider or anthropic-direct over a stubbed fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod/v4";
import { getProvider } from "../../../src/lib/agent-harness/providers/provider";
import { runResearchAgent } from "../../../src/lib/agent-harness/runner";
import type { ModelEvent, ModelProvider, ModelRequest } from "../../../src/lib/agent-harness/types";
import { outputContract } from "../../../src/lib/research/reporting/contracts";
import { researchTaskKey } from "../../../src/lib/research/run-context";
import { ANTHROPIC_ENV, anthropicSse, withEnv, withFetch } from "./fixtures";

/** The same zod definition as BRIEF_CONTRACT in src/lib/research/team.ts. */
const BRIEF = outputContract({
  approach: z.string().min(1),
  checks: z.array(z.string().min(1)).min(1),
  information_needed: z.array(z.string().min(1)),
});
// Conforms to the wire schema (strings are strings) but breaks the stripped minLength of 1.
const EMPTY_APPROACH = JSON.stringify({ approach: "", checks: ["Check segment margins"], information_needed: [] });
const VALID = JSON.stringify({ approach: "Trace margins by segment", checks: ["Check segment margins"], information_needed: [] });
const RUN_ENV = { ...ANTHROPIC_ENV, RESEARCH_ALL_AGENTS_MODEL: "claude-haiku-5-5" };

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  requests: ModelRequest[] = [];
  constructor(private readonly texts: string[]) {}
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    yield { type: "response.started", requestId: `req-${this.requests.length}` };
    yield { type: "text.delta", text: this.texts[this.requests.length - 1] };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 10 } };
    yield { type: "response.completed", finishReason: "end_turn" };
  }
}

const runBrief = (provider: ModelProvider) => runResearchAgent<any>({
  agentName: "asset-analyst", title: "team brief", taskPacket: { output_contract: "team_brief", role: "business" },
  outputFormat: BRIEF, provider, policy: { maxAttempts: 1, maxRepairAttempts: 1 },
});

test("AC-5: a schema-conforming response that breaks a stripped constraint still fails validation and is repaired", async () => {
  await withEnv(RUN_ENV, async () => {
    await withFetch((_call, index) => ({ text: anthropicSse(index === 0 ? EMPTY_APPROACH : VALID) }), async (calls) => {
      const result = await runBrief(getProvider("anthropic-direct"));
      assert.ok(calls[0].body.output_config, "the generation request is structured");
      assert.equal(calls.length, 2, "one generation and one repair request");
      assert.equal(result.attempts[0].repairAttempted, true);
      assert.ok(result.attempts[0].passes?.[0].validationErrors?.some((error) => error.path === "approach"),
        JSON.stringify(result.attempts[0].passes?.[0].validationErrors));
      assert.equal(result.structured.approach, "Trace margins by segment");
    });
  });
});

test("AC-7: the runner passes the task's schema to the provider on generation and repair", async () => {
  const provider = new ScriptedProvider([EMPTY_APPROACH, VALID]);
  await withEnv(RUN_ENV, () => runBrief(provider));
  assert.equal(provider.requests.length, 2);
  for (const request of provider.requests) {
    assert.deepEqual((request as unknown as { outputSchema?: unknown }).outputSchema, BRIEF.schema);
  }
});

test("AC-7: generation and repair send the same output_config; the contract, task key and repair prompt are unchanged", async () => {
  const keyRequest = { packet: { output_contract: "team_brief" }, output_format: BRIEF, agent: "asset-analyst" };
  const keyBefore = researchTaskKey("team:brief:business", keyRequest);
  const schemaBefore = JSON.stringify(BRIEF.schema);
  await withEnv(RUN_ENV, async () => {
    await withFetch((_call, index) => ({ text: anthropicSse(index === 0 ? EMPTY_APPROACH : VALID) }), async (calls) => {
      await runBrief(getProvider("anthropic-direct"));
      assert.equal(calls.length, 2);
      assert.ok(calls[0].body.output_config, "the generation request is structured");
      assert.deepEqual(calls[1].body.output_config, calls[0].body.output_config);
      const repairText = JSON.stringify(calls[1].body.messages);
      assert.ok(repairText.includes(JSON.stringify(JSON.stringify(BRIEF.schema)).slice(1, -1)),
        "the repair prompt still quotes the full contract schema, including its length limits");
    });
  });
  assert.equal(JSON.stringify(BRIEF.schema), schemaBefore, "the contract schema is not mutated");
  assert.equal(researchTaskKey("team:brief:business", keyRequest), keyBefore, "task reuse keys are unchanged");
});

// AC-8: each pass records whether output_config was sent and whether the schema fallback fired.
const TELEMETRY = outputContract({ telemetry_note: z.string().min(1) });
const TELEMETRY_FALLBACK = outputContract({ telemetry_fallback_note: z.string().min(1) });
const structuredOf = (result: any) => result.attempts[0].passes?.[0]?.structuredOutput;

test("AC-8: a structured pass records sent=true, fallback=false", async () => {
  await withEnv(RUN_ENV, async () => {
    await withFetch(() => ({ text: anthropicSse(JSON.stringify({ telemetry_note: "ok" })) }), async () => {
      const result = await runResearchAgent<any>({ agentName: "asset-analyst", title: "telemetry", taskPacket: { output_contract: "telemetry" },
        outputFormat: TELEMETRY, provider: getProvider("anthropic-direct"), policy: { maxAttempts: 1, maxRepairAttempts: 0 } });
      assert.deepEqual(structuredOf(result), { sent: true, fallback: false });
    });
  });
});

test("AC-8: a schema rejection that falls back records sent=true, fallback=true", async () => {
  await withEnv(RUN_ENV, async () => {
    const reply = (_call: unknown, index: number) => index === 0
      ? { status: 400, text: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Schema is too complex for compilation" } }) }
      : { text: anthropicSse(JSON.stringify({ telemetry_fallback_note: "ok" })) };
    await withFetch(reply, async (calls) => {
      const result = await runResearchAgent<any>({ agentName: "asset-analyst", title: "telemetry fallback", taskPacket: { output_contract: "telemetry_fallback" },
        outputFormat: TELEMETRY_FALLBACK, provider: getProvider("anthropic-direct"), policy: { maxAttempts: 1, maxRepairAttempts: 0 } });
      assert.equal(calls.length, 2);
      assert.deepEqual(structuredOf(result), { sent: true, fallback: true });
    });
  });
});

test("AC-8: a provider that never sends output_config records sent=false, fallback=false", async () => {
  const provider = new ScriptedProvider([VALID]);
  const result = await withEnv(RUN_ENV, () => runBrief(provider));
  assert.deepEqual(structuredOf(result), { sent: false, fallback: false });
});
