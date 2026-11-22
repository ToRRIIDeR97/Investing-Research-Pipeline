import { describe, it } from "node:test";
import assert from "node:assert";
import { runResearchAgent } from "@/lib/agent-harness/runner";
import { ProviderError } from "@/lib/agent-harness/errors";
import type { AgentRequest, ModelEvent, ModelProvider, ModelRequest } from "@/lib/agent-harness/types";

describe("agent roles, prompts, and registry (Component 14)", () => {
  it("C14-T5: Genesis agent receives valuation task -> Registry blocks wrong artifact assignment", async () => {
    const request: AgentRequest = {
      agentName: "asset-analyst", // genesis/general analyst agent
      title: "Run valuation task on asset analyst",
      taskPacket: {
        artifact_type: "valuation_model_run", // valuation task packet
      },
    };

    await assert.rejects(
      runResearchAgent(request),
      (err: Error) => {
        return err.message.includes("cannot be assigned valuation task or output artifact type");
      }
    );
  });

  it("C14-T6: Red-team prompt contains confirm the thesis -> Prompt review fails", async () => {
    const request: AgentRequest = {
      agentName: "research-reviewer", // reviewer agent
      title: "Review investment thesis",
      taskPacket: {},
      prompt: "Please confirm the thesis and validate our assumptions.", // forbidden instruction
    };

    await assert.rejects(
      runResearchAgent(request),
      (err: Error) => {
        return err.message.includes("Red-team prompt review failed");
      }
    );
  });

  it("C14-T6: the check reads a reviewer's instructions, not the report data in its packet", async () => {
    const calls: string[] = [];
    const provider: ModelProvider = { id: "stub", stream(request: ModelRequest) {
      calls.push(request.prompt);
      return (async function* (): AsyncGenerator<ModelEvent> { throw new ProviderError("stub reached", "authentication"); })();
    } };
    const promptFactory = (rule: string) => (p: Record<string, unknown>) => `${rule}\n\nTask packet:\n${JSON.stringify(p)}`;
    const taskPacket = { report_document: { implication: "No thesis breaker has tripped, but the set cannot yet confirm the thesis." } };

    await assert.rejects(runResearchAgent({ agentName: "research-reviewer", title: "Review", taskPacket, provider,
      promptFactory: promptFactory("Review the report against the evidence.") }), /stub reached/);
    assert.equal(calls.length, 1, "a packet that quotes the phrase reaches the model");

    await assert.rejects(runResearchAgent({ agentName: "research-reviewer", title: "Review", taskPacket: {}, provider,
      promptFactory: promptFactory("Confirm the thesis before reviewing.") }), /Red-team prompt review failed/);
    assert.equal(calls.length, 1, "an instruction to confirm the thesis is still refused before any call");
  });
});
