import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import { ProviderError, redactHarnessText } from "./errors";
import { PermissionService } from "./permissions";
import { getAgentConfig } from "./registry";
import type {
  AgentSessionStore,
  AgentToolTrace,
  McpServerConfig,
  PermissionDecision,
  PermissionRequest,
  PermissionRule,
  ToolCall,
} from "./types";
import { validateSchema } from "./validation";

export interface ToolExecutionContext {
  agentName: string;
  callId: string;
  sessionId: string;
  signal: AbortSignal;
  researchRunId?: string;
  stageId?: string;
  taskId?: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  inputValidator?: ZodType<TInput>;
  outputValidator?: ZodType<TOutput>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  permission?: {
    action?: string;
    resource?: string | ((input: TInput) => string);
  };
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

interface Registration {
  id: string;
  definition: ToolDefinition<any, any>;
}

export interface ToolScope {
  agentName: string;
  sessionId: string;
  signal: AbortSignal;
  enabledTools?: string[];
  permissionRules?: PermissionRule[];
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision> | PermissionDecision;
  researchRunId?: string;
  stageId?: string;
  taskId?: string;
  store?: AgentSessionStore;
  defaultTimeoutMs: number;
  defaultMaxOutputBytes: number;
  mcpServers?: McpServerConfig[];
}

export interface ToolExecutionResult {
  name: string;
  callId: string;
  output: unknown;
  outputBytes: number;
  truncated: boolean;
}

export interface MaterializedTools {
  definitions: Array<Record<string, unknown>>;
  execute(call: ToolCall): Promise<ToolExecutionResult>;
}

export class ToolRegistry {
  private readonly registrations = new Map<string, Registration[]>();

  constructor(private readonly parent?: ToolRegistry) {}

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): () => void {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(definition.name)) {
      throw new ProviderError(`Invalid tool name: ${definition.name}`, "invalid_request");
    }
    const registration = { id: randomUUID(), definition } as Registration;
    const stack = this.registrations.get(definition.name) || [];
    stack.push(registration);
    this.registrations.set(definition.name, stack);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.registrations.get(definition.name) || [];
      const next = current.filter((item) => item.id !== registration.id);
      if (next.length) this.registrations.set(definition.name, next);
      else this.registrations.delete(definition.name);
    };
  }

  clear() {
    this.registrations.clear();
  }

  private current(): Map<string, Registration> {
    const values = this.parent?.current() || new Map<string, Registration>();
    for (const [name, registrations] of this.registrations) {
      const registration = registrations.at(-1);
      if (registration) values.set(name, registration);
    }
    return values;
  }

  registration(name: string) {
    return this.current().get(name);
  }

  materialize(scope: ToolScope): MaterializedTools {
    const configured = getAgentConfig(scope.agentName).tools || {};
    const explicitlyEnabled = new Set(scope.enabledTools || []);
    const captured = new Map(
      [...this.current()].filter(([name]) => Boolean(configured[name]) || explicitlyEnabled.has(name))
    );
    const definitions = [...captured.values()].map(({ definition }) => ({
      type: "function",
      function: {
        name: definition.name,
        description: definition.description,
        parameters: definition.inputSchema,
      },
    }));
    const configuredAllows: PermissionRule[] = [...captured.keys()]
      .filter((name) => Boolean(configured[name]))
      .map((name) => ({ action: `tool:${name}`, resource: "*", effect: "allow" }));
    const permissions = new PermissionService(
      [...configuredAllows, ...(scope.permissionRules || [])],
      scope.onPermissionRequest
    );

    return {
      definitions,
      execute: async (call) => {
        const registration = captured.get(call.name);
        if (!registration) {
          throw new ProviderError(`Agent ${scope.agentName} is not authorized to call tool: ${call.name}`, "permission_denied");
        }
        return executeRegistration(registration, scope, call, permissions);
      },
    };
  }
}

function schemaErrors(value: unknown, schema: Record<string, unknown>) {
  return validateSchema(value, { type: "json_schema", schema });
}

function parseInput(registration: Registration, call: ToolCall) {
  let input: unknown;
  try {
    input = JSON.parse(call.arguments || "{}");
  } catch {
    throw new ProviderError(`Invalid JSON arguments for tool ${call.name}`, "invalid_request");
  }
  const validator = registration.definition.inputValidator;
  if (validator) {
    const parsed = validator.safeParse(input);
    if (!parsed.success) {
      throw new ProviderError(
        `Invalid arguments for tool ${call.name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | ")}`,
        "invalid_request"
      );
    }
    return parsed.data;
  }
  const errors = schemaErrors(input, registration.definition.inputSchema);
  if (errors.length) {
    throw new ProviderError(
      `Invalid arguments for tool ${call.name}: ${errors.map((error) => `${error.path}: ${error.message}`).join(" | ")}`,
      "invalid_request"
    );
  }
  return input;
}

function validateOutput(registration: Registration, output: unknown) {
  const validator = registration.definition.outputValidator;
  if (validator) {
    const parsed = validator.safeParse(output);
    if (!parsed.success) {
      throw new ProviderError(
        `Invalid output from tool ${registration.definition.name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | ")}`,
        "invalid_request"
      );
    }
    return parsed.data;
  }
  if (registration.definition.outputSchema) {
    const errors = schemaErrors(output, registration.definition.outputSchema);
    if (errors.length) {
      throw new ProviderError(
        `Invalid output from tool ${registration.definition.name}: ${errors.map((error) => `${error.path}: ${error.message}`).join(" | ")}`,
        "invalid_request"
      );
    }
  }
  return output;
}

function boundOutput(value: unknown, maxBytes: number) {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch {
    throw new ProviderError("Tool output is not JSON serializable", "invalid_request");
  }
  if (serialized === undefined) throw new ProviderError("Tool output is not JSON serializable", "invalid_request");
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= maxBytes) return { output: value, outputBytes: bytes, truncated: false };
  const buffer = Buffer.from(serialized, "utf8");
  let previewBytes = Math.max(0, Math.floor((maxBytes - 128) / 2));
  while (previewBytes >= 0) {
    const start = buffer.subarray(0, previewBytes).toString("utf8").replace(/\uFFFD$/, "");
    const end = buffer.subarray(Math.max(0, buffer.length - previewBytes)).toString("utf8").replace(/^\uFFFD/, "");
    const output = {
      truncated: true,
      originalBytes: bytes,
      preview: `${start}\n...[tool output truncated]...\n${end}`,
    };
    if (Buffer.byteLength(JSON.stringify(output), "utf8") <= maxBytes) {
      return { output, outputBytes: bytes, truncated: true };
    }
    if (previewBytes === 0) break;
    previewBytes = Math.floor(previewBytes * 0.8);
  }
  throw new ProviderError("Tool output limit is too small for truncation metadata", "response_limit");
}

async function executeRegistration(
  registration: Registration,
  scope: ToolScope,
  call: ToolCall,
  permissions: PermissionService
): Promise<ToolExecutionResult> {
  const input = parseInput(registration, call);
  const permission = registration.definition.permission;
  const action = permission?.action || `tool:${call.name}`;
  const resource = typeof permission?.resource === "function"
    ? permission.resource(input)
    : permission?.resource || "*";
  const request: PermissionRequest = {
    id: randomUUID(), sessionId: scope.sessionId, agentName: scope.agentName,
    toolCallId: call.id, toolName: call.name, action, resource, input,
  };
  let decision: PermissionDecision;
  try {
    decision = await permissions.authorize(request, scope.signal);
  } catch (error) {
    if (error instanceof ProviderError && error.category === "permission_denied") {
      await scope.store?.recordPermission?.(request, "deny");
    }
    throw error;
  }
  await scope.store?.recordPermission?.(request, decision);

  const started = Date.now();
  const timeoutMs = registration.definition.timeoutMs || scope.defaultTimeoutMs;
  const controller = new AbortController();
  const onAbort = () => controller.abort(scope.signal.reason);
  if (scope.signal.aborted) controller.abort(scope.signal.reason);
  else scope.signal.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const context: ToolExecutionContext = {
    agentName: scope.agentName,
    callId: call.id,
    sessionId: scope.sessionId,
    signal: controller.signal,
    researchRunId: scope.researchRunId,
    stageId: scope.stageId,
    taskId: scope.taskId,
  };
  timer = setTimeout(() => controller.abort("tool_timeout"), timeoutMs);

  let abortHandler: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    const rejectAbort = () => reject(new ProviderError(
      controller.signal.reason === "tool_timeout" ? `Tool ${call.name} timed out` : `Tool ${call.name} cancelled`,
      controller.signal.reason === "tool_timeout" ? "provider_timeout" : "cancellation"
    ));
    if (controller.signal.aborted) {
      rejectAbort();
      return;
    }
    abortHandler = rejectAbort;
    controller.signal.addEventListener("abort", abortHandler, { once: true });
  });
  const persistTrace = async (trace: AgentToolTrace) => {
    const pending = scope.store?.recordToolTrace?.(trace);
    if (pending) await Promise.race([pending, aborted]);
  };
  try {
    await persistTrace({
      sessionId: scope.sessionId, researchRunId: scope.researchRunId, taskId: scope.taskId,
      agentName: scope.agentName, toolCallId: call.id, toolName: call.name,
      input, status: "running",
    });
    const raw = await Promise.race([registration.definition.execute(input, context), aborted]);
    const output = validateOutput(registration, raw);
    const bounded = boundOutput(output, registration.definition.maxOutputBytes || scope.defaultMaxOutputBytes);
    await persistTrace({
      sessionId: scope.sessionId, researchRunId: scope.researchRunId, taskId: scope.taskId,
      agentName: scope.agentName, toolCallId: call.id, toolName: call.name,
      input, output: bounded.output, status: "completed", durationMs: Date.now() - started,
    });
    return { name: call.name, callId: call.id, ...bounded };
  } catch (error) {
    await persistTrace({
      sessionId: scope.sessionId, researchRunId: scope.researchRunId, taskId: scope.taskId,
      agentName: scope.agentName, toolCallId: call.id, toolName: call.name,
      input, status: controller.signal.aborted ? "cancelled" : "failed",
      errorMessage: redactHarnessText(error instanceof Error ? error.message : String(error), 2_000),
      durationMs: Date.now() - started,
    }).catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    scope.signal.removeEventListener("abort", onAbort);
    if (abortHandler) controller.signal.removeEventListener("abort", abortHandler);
  }
}

export const defaultToolRegistry = new ToolRegistry();

export function registerTool<TInput = any, TOutput = any>(tool: ToolDefinition<TInput, TOutput>) {
  return defaultToolRegistry.register(tool);
}

export function clearRegisteredTools() {
  defaultToolRegistry.clear();
}

export function materializeTools(scope: ToolScope, registry = defaultToolRegistry) {
  return registry.materialize(scope);
}

export function toolDefinitionsForAgent(agentName: string): Array<Record<string, unknown>> {
  const controller = new AbortController();
  return defaultToolRegistry.materialize({
    agentName, sessionId: "legacy", signal: controller.signal,
    defaultTimeoutMs: 30_000, defaultMaxOutputBytes: 50_000,
  }).definitions;
}

export function validateToolCall(agentName: string, toolName: string, args: Record<string, unknown>): void {
  const config = getAgentConfig(agentName);
  if (!config.tools?.[toolName]) {
    throw new ProviderError(`Agent ${agentName} is not authorized to call tool: ${toolName}`, "permission_denied");
  }
  const registration = defaultToolRegistry.materialize({
    agentName, sessionId: "legacy", signal: new AbortController().signal,
    defaultTimeoutMs: 30_000, defaultMaxOutputBytes: 50_000,
  });
  if (!registration.definitions.some((definition: any) => definition.function?.name === toolName)) {
    throw new ProviderError(`Tool ${toolName} is not registered in the harness`, "invalid_request");
  }
  const definition = defaultToolRegistry.registration(toolName);
  if (!definition) throw new ProviderError(`Tool ${toolName} is not registered in the harness`, "invalid_request");
  const errors = schemaErrors(args, definition.definition.inputSchema);
  if (errors.length) throw new ProviderError(`Invalid arguments for tool ${toolName}`, "invalid_request");
}

export async function executeTool(agentName: string, toolCall: ToolCall): Promise<unknown> {
  const controller = new AbortController();
  const tools = defaultToolRegistry.materialize({
    agentName, sessionId: "legacy", signal: controller.signal,
    defaultTimeoutMs: 30_000, defaultMaxOutputBytes: 50_000,
  });
  return (await tools.execute(toolCall)).output;
}
