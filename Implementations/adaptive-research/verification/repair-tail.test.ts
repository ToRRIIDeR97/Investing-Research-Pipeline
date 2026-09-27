import test from "node:test";
import assert from "node:assert/strict";
import { runResearchAgent } from "../../../src/lib/agent-harness/runner";
import type { ModelProvider, ModelEvent } from "../../../src/lib/agent-harness/types";

test("AC-L2: a late field survives repair of an earlier validation error", async () => {
  const prompts: string[] = [];
  const source = { answer: "wrong", explanation: "x".repeat(13_000), supporting_claim_id: "tail-evidence-987" };
  const provider: ModelProvider = { id: "fixture", async *stream(request): AsyncGenerator<ModelEvent> {
    prompts.push(request.prompt);
    yield { type: "text.delta", text: JSON.stringify(prompts.length === 1 ? source : { ...source, answer: "correct" }) };
    yield { type: "response.completed", finishReason: "stop" };
  } };
  await runResearchAgent({ agentName: "asset-analyst", title: "long repair", taskPacket: { source: "source-context-456" },
    provider, outputFormat: { requiredKeys: ["answer"], schema: { type: "object", properties: { answer: { type: "string", const: "correct" } } } },
    policy: { maxAttempts: 1, maxRepairAttempts: 1 } });
  assert.ok(prompts[1].includes(JSON.stringify(source)), "repair must retain the complete bounded prior response");
  assert.match(prompts[1], /source-context-456/);
});
