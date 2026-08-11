import { z } from "zod";
import { ProviderError } from "./errors";
import type { SubagentOptions } from "./types";
import type { ToolRegistry } from "./tools";

const TOOL_NAME = "delegate_research_agent";

export function registerSubagentTool(options: {
  registry: ToolRegistry;
  config: SubagentOptions;
  parentSessionId: string;
  parentDepth: number;
}): { toolName: string; unregister(): void } {
  const allowed = new Set(options.config.allowedAgents);
  const maxDepth = options.config.maxDepth ?? 1;
  const maxChildren = options.config.maxChildren ?? 4;
  let children = 0;
  const inputValidator = z.object({
    agentName: z.string().refine((name) => allowed.has(name), "Agent is not allowed for delegation"),
    title: z.string().min(1).max(500),
    taskPacket: z.record(z.unknown()),
  }).strict();

  const unregister = options.registry.register({
    name: TOOL_NAME,
    description: `Delegate one bounded research task to an allowed specialist: ${[...allowed].join(", ")}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["agentName", "title", "taskPacket"],
      properties: {
        agentName: { type: "string", enum: [...allowed] },
        title: { type: "string", minLength: 1, maxLength: 500 },
        taskPacket: { type: "object" },
      },
    },
    inputValidator,
    permission: { action: "subagent", resource: (input) => input.agentName },
    execute: async (input, context) => {
      if (options.parentDepth >= maxDepth) {
        throw new ProviderError(`Subagent depth limit exceeded (${maxDepth})`, "permission_denied");
      }
      children += 1;
      if (children > maxChildren) {
        throw new ProviderError(`Subagent child limit exceeded (${maxChildren})`, "response_limit");
      }
      if (Buffer.byteLength(JSON.stringify(input.taskPacket), "utf8") > 1_000_000) {
        throw new ProviderError("Subagent task packet exceeds 1 MB", "response_limit");
      }
      return options.config.execute({
        agentName: input.agentName,
        title: input.title,
        taskPacket: input.taskPacket,
        signal: context.signal,
        parentSessionId: options.parentSessionId,
        depth: options.parentDepth + 1,
      });
    },
  });
  return { toolName: TOOL_NAME, unregister };
}
