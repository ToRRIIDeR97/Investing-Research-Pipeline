import test from "node:test";
import assert from "node:assert/strict";
import { runResearchAgent } from "../../../src/lib/agent-harness/runner";
import type { ModelProvider, ModelEvent } from "../../../src/lib/agent-harness/types";

test("AC-L2: semantic repair retains the original task and complete output contract", async () => {
  const prompts: string[] = [];
  const provider: ModelProvider = { id: "fixture", async *stream(request): AsyncGenerator<ModelEvent> {
    prompts.push(request.prompt);
    yield { type: "text.delta", text: JSON.stringify({ answer: prompts.length === 1 ? "wrong" : "verified" }) };
    yield { type: "response.completed", finishReason: "stop" };
  } };
  const result = await runResearchAgent({ agentName: "asset-analyst", title: "repair test", taskPacket: {},
    prompt: "Use source claim source-123, which establishes the verified result.", provider,
    outputFormat: { requiredKeys: ["answer"], schema: { type: "object", properties: { answer: { type: "string", enum: ["verified"] } }, required: ["answer"] } },
    policy: { maxAttempts: 1, maxRepairAttempts: 1 } });
  assert.deepEqual(result.structured, { answer: "verified" });
  assert.match(prompts[1], /source-123/);
  assert.match(prompts[1], /"enum":\["verified"\]/);
});
