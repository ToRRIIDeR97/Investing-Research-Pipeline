import { describe, it } from "node:test";
import assert from "node:assert";
import { runResearchAgent } from "@/lib/agent-harness/runner";
import type { AgentRequest } from "@/lib/agent-harness/types";

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
});
