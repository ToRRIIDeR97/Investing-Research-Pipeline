import { ToolCall } from "./types";
import { ProviderError } from "./errors";
import { getAgentConfig } from "./registry";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: any;
  execute(input: any): Promise<any>;
}

const TOOL_REGISTRY = new Map<string, ToolDefinition>();

export function registerTool(tool: ToolDefinition) {
  TOOL_REGISTRY.set(tool.name, tool);
}

export function clearRegisteredTools() {
  TOOL_REGISTRY.clear();
}

export function toolDefinitionsForAgent(agentName: string): Array<Record<string, unknown>> {
  const config = getAgentConfig(agentName);
  return [...TOOL_REGISTRY.values()]
    .filter((tool) => Boolean(config.tools?.[tool.name]))
    .map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
}

export function validateToolCall(agentName: string, toolName: string, args: Record<string, unknown>): void {
  const config = getAgentConfig(agentName);

  // Enforce deny-by-default: agent must explicitly have the tool enabled in its config
  if (!config.tools?.[toolName]) {
    throw new ProviderError(
      `Agent ${agentName} is not authorized to call tool: ${toolName}`,
      "invalid_request"
    );
  }

  const toolDef = TOOL_REGISTRY.get(toolName);
  if (!toolDef) {
    throw new ProviderError(`Tool ${toolName} is not registered in the harness`, "invalid_request");
  }

  // Simple local schema validation for tool input if defined
  if (toolDef.inputSchema?.required && Array.isArray(toolDef.inputSchema.required)) {
    for (const req of toolDef.inputSchema.required) {
      if (!(req in args)) {
        throw new ProviderError(`Missing required tool input parameter: ${req}`, "invalid_request");
      }
    }
  }
}

export async function executeTool(agentName: string, toolCall: ToolCall): Promise<any> {
  let args: Record<string, any>;
  try {
    args = JSON.parse(toolCall.arguments);
  } catch (err) {
    throw new ProviderError(`Invalid JSON arguments for tool ${toolCall.name}`, "invalid_request");
  }

  validateToolCall(agentName, toolCall.name, args);

  const toolDef = TOOL_REGISTRY.get(toolCall.name);
  if (!toolDef) {
    throw new Error(`Tool definition not found: ${toolCall.name}`);
  }

  return toolDef.execute(args);
}
