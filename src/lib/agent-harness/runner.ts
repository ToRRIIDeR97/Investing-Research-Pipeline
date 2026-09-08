import { randomUUID } from "node:crypto";
import {
  assertProviderCircuitAvailable,
  providerCircuitSnapshot,
  qualifiesForProviderCircuit,
  recordProviderFailure,
  recordProviderSuccess,
} from "./circuit-breaker";
import { createDeadlineController } from "./deadlines";
import { ProviderError, redactHarnessText as redact, ResearchAgentRunError, type HarnessErrorCategory } from "./errors";
import { compactMessages, createMessage, messageText, textMessage } from "./messages";
import { registerMcpServers } from "./mcp";
import { parseStructuredOutput } from "./output-parser";
import { getProvider } from "./providers/provider";
import { getAgentConfig, resolveAgentModel, type ResearchAgentName } from "./registry";
import { MemoryAgentSessionStore } from "./session-store";
import { sessionCoordinator } from "./session-coordinator";
import { discoverSkills, renderSkillContext, selectSkills } from "./skills";
import { registerSubagentTool } from "./subagents";
import { estimateCost } from "./telemetry";
import { defaultToolRegistry, materializeTools, ToolRegistry, type MaterializedTools } from "./tools";
import type {
  AgentAttempt, AgentMessage, AgentPassTelemetry, AgentRequest, AgentResult, AgentSessionEvent, AgentSessionStore,
  AgentUsage, ExecutionPolicy, ModelEvent, ModelProvider, ToolCall,
} from "./types";
import { coerceStructuredOutput, validateSchema, type SchemaValidationError } from "./validation";

export { ResearchAgentRunError };

const DEFAULT_SKILLS = ["unslop"];

const DEFAULT_POLICY: ExecutionPolicy = {
  totalTimeoutMs: 720_000,
  attemptTimeoutMs: 360_000,
  repairTimeoutMs: 180_000,
  inactivityTimeoutMs: 90_000,
  maxResponseBytes: 1_000_000,
  maxContextBytes: 4_000_000,
  maxToolOutputBytes: 50_000,
  toolTimeoutMs: 30_000,
  maxRepeatedToolCalls: 3,
  maxRepairAttempts: 1,
  maxToolTurns: 4,
  maxToolCalls: 8,
  maxAttempts: 2,
  retryBaseDelayMs: 1_000,
};

function numberEnv(name: string, fallback: number, minimum = 1) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function optionalPositiveNumberEnv(...names: string[]) {
  for (const name of names) {
    if (!(name in process.env)) continue;
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  return undefined;
}

function executionPolicy(input: AgentRequest): ExecutionPolicy {
  const key = input.agentName.toUpperCase().replace(/-/g, "_");
  const valuationWork = input.agentName === "valuation-analyst";
  const totalDefault = valuationWork ? 960_000 : DEFAULT_POLICY.totalTimeoutMs;
  const attemptDefault = valuationWork ? 480_000 : DEFAULT_POLICY.attemptTimeoutMs;
  const inactivityDefault = input.agentName === "source-reader" ? 120_000 : DEFAULT_POLICY.inactivityTimeoutMs;
  const configuredMaxOutputTokens = optionalPositiveNumberEnv(`RESEARCH_${key}_MAX_OUTPUT_TOKENS`, "RESEARCH_MAX_OUTPUT_TOKENS");
  const policy: ExecutionPolicy = {
    totalTimeoutMs: numberEnv(`RESEARCH_${key}_TIMEOUT_MS`, numberEnv("RESEARCH_AGENT_TIMEOUT_MS", totalDefault, 10_000), 10_000),
    attemptTimeoutMs: numberEnv(`RESEARCH_${key}_ATTEMPT_TIMEOUT_MS`, numberEnv("RESEARCH_ATTEMPT_TIMEOUT_MS", attemptDefault, 1_000), 1_000),
    repairTimeoutMs: numberEnv("RESEARCH_REPAIR_TIMEOUT_MS", DEFAULT_POLICY.repairTimeoutMs, 1_000),
    inactivityTimeoutMs: numberEnv(`RESEARCH_${key}_INACTIVITY_TIMEOUT_MS`, numberEnv("RESEARCH_INACTIVITY_TIMEOUT_MS", inactivityDefault, 1_000), 1_000),
    maxResponseBytes: numberEnv(`RESEARCH_${key}_MAX_RESPONSE_BYTES`, numberEnv("RESEARCH_MAX_RESPONSE_BYTES", DEFAULT_POLICY.maxResponseBytes)),
    maxContextBytes: numberEnv(`RESEARCH_${key}_MAX_CONTEXT_BYTES`, numberEnv("RESEARCH_MAX_CONTEXT_BYTES", DEFAULT_POLICY.maxContextBytes)),
    maxToolOutputBytes: numberEnv("RESEARCH_MAX_TOOL_OUTPUT_BYTES", DEFAULT_POLICY.maxToolOutputBytes),
    toolTimeoutMs: numberEnv("RESEARCH_TOOL_TIMEOUT_MS", DEFAULT_POLICY.toolTimeoutMs),
    maxRepeatedToolCalls: numberEnv("RESEARCH_MAX_REPEATED_TOOL_CALLS", DEFAULT_POLICY.maxRepeatedToolCalls),
    // OpenAI-compatible providers account for reasoning inside max_tokens. Leave
    // it unset unless explicitly configured so valid JSON is not truncated before
    // the model reaches its answer; maxResponseBytes remains the hard response bound.
    maxOutputTokens: configuredMaxOutputTokens,
    maxRepairAttempts: numberEnv("RESEARCH_MAX_REPAIR_ATTEMPTS", DEFAULT_POLICY.maxRepairAttempts, 0),
    maxToolTurns: numberEnv("RESEARCH_MAX_TOOL_TURNS", DEFAULT_POLICY.maxToolTurns, 0),
    maxToolCalls: numberEnv("RESEARCH_MAX_TOOL_CALLS", DEFAULT_POLICY.maxToolCalls, 0),
    maxAttempts: numberEnv(`RESEARCH_${key}_MAX_MODEL_ATTEMPTS`, numberEnv("RESEARCH_MAX_MODEL_ATTEMPTS", DEFAULT_POLICY.maxAttempts)),
    retryBaseDelayMs: numberEnv("RESEARCH_RETRY_BASE_DELAY_MS", DEFAULT_POLICY.retryBaseDelayMs),
    ...input.policy,
  };
  const zeroAllowed = new Set<keyof ExecutionPolicy>([
    "maxRepairAttempts", "maxToolTurns", "maxToolCalls", "retryBaseDelayMs",
  ]);
  for (const [name, value] of Object.entries(policy) as Array<[keyof ExecutionPolicy, number | undefined]>) {
    if (value === undefined) continue;
    const minimum = zeroAllowed.has(name) ? 0 : 1;
    if (!Number.isFinite(value) || value < minimum) {
      throw new ProviderError(`Invalid execution policy value for ${name}`, "invalid_request");
    }
  }
  return policy;
}

function buildTaskPrompt(input: AgentRequest, config: ReturnType<typeof getAgentConfig>) {
  if (input.promptFactory) return input.promptFactory(input.taskPacket);
  if (input.prompt) return input.prompt;
  return [
    `Run Research OS agent: ${config.name}`,
    "Use the task packet below as the complete working context.",
    "Return exactly one JSON object matching the requested schema. Do not include Markdown.",
    "Task packet:", JSON.stringify(input.taskPacket),
  ].join("\n\n");
}

function requiredKeys(outputFormat: Record<string, unknown> | { requiredKeys?: string[]; schema?: unknown }) {
  if ("requiredKeys" in outputFormat && Array.isArray(outputFormat.requiredKeys)) return outputFormat.requiredKeys;
  const fmt = outputFormat as Record<string, unknown>;
  const schema = fmt.schema as { required?: unknown } | undefined;
  return Array.isArray(schema?.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
}

function validateCandidate(
  value: unknown,
  outputFormat: Record<string, unknown>,
  custom?: AgentRequest["validateStructured"]
): SchemaValidationError[] {
  return [
    ...validateSchema(value, outputFormat),
    ...(custom ? custom(value) : []),
  ];
}

function repairCandidate(value: unknown, rawText: string) {
  const serialized = value === undefined ? rawText : JSON.stringify(value);
  if (serialized.length <= 80_000) return serialized;
  return `${serialized.slice(0, 40_000)}\n...[middle omitted]...\n${serialized.slice(-40_000)}`;
}

function modelCandidates(agentName: ResearchAgentName, maxAttempts: number) {
  const primary = resolveAgentModel(agentName);
  return Array.from({ length: maxAttempts }, () => primary);
}

function compactFallback(input: AgentRequest): { request: AgentRequest; compacted: boolean } {
  if (input.taskPacket.context_policy === 'focused-v1') return { request: input, compacted: false };
  const packet = { ...input.taskPacket };
  if (input.agentName === "asset-analyst") {
    if (Array.isArray(packet.evidence_claims)) packet.evidence_claims = packet.evidence_claims.slice(0, 15);
    if (Array.isArray(packet.normalized_observations)) packet.normalized_observations = packet.normalized_observations.slice(0, 20);
    if (Array.isArray(packet.metrics)) packet.metrics = packet.metrics.slice(0, 20);
  } else if (input.agentName === "source-reader") {
    delete packet.source_context;
    if (Array.isArray(packet.source_corpus)) {
      packet.source_corpus = packet.source_corpus.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const chunk = item as Record<string, unknown>;
        return {
          ...chunk,
          content_excerpt: typeof chunk.content_excerpt === "string"
            ? chunk.content_excerpt.slice(0, 2_000)
            : chunk.content_excerpt,
        };
      });
    }
  }
  const compacted = JSON.stringify(packet) !== JSON.stringify(input.taskPacket);
  return { request: { ...input, taskPacket: packet }, compacted };
}

function category(error: unknown): HarnessErrorCategory {
  if (error instanceof ProviderError) return error.category;
  if (error instanceof ResearchAgentRunError) {
    const value = error.responseMetadata.error_type;
    if (typeof value === "string") return value as HarnessErrorCategory;
  }
  return "unknown";
}

function retryable(value: HarnessErrorCategory, _agentName: string) {
  return value === "rate_limit" || value === "provider_timeout" || value === "connection" || value === "malformed_stream" ||
    value === "schema_validation" || value === "server_error" || value === "context_limit";
}

async function waitForRetry(ms: number, deadline: ReturnType<typeof createDeadlineController>) {
  const abortError = () => deadline.reason() === "caller"
    ? new ProviderError("Request cancelled during retry backoff", "cancellation")
    : new ProviderError("Request total timeout during retry backoff", "provider_timeout", { timeoutType: "total" });
  const signal = deadline.signal;
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function repairContext(input: AgentRequest) {
  const packet = input.taskPacket && typeof input.taskPacket === "object"
    ? input.taskPacket as Record<string, unknown>
    : {};
  const context: Record<string, unknown> = {
    title: input.title,
    agentName: input.agentName,
    output_contract: packet.output_contract,
    providedKeys: Object.keys(packet).slice(0, 20),
  };
  if (input.agentName === "source-reader" && Array.isArray(packet.source_corpus)) {
    // A schema repair must be able to restore citations, but it does not need
    // the entire original corpus. Preserve identifiers plus bounded excerpts
    // so the repair can map each claim to a real source chunk.
    context.source_corpus = packet.source_corpus.slice(0, 8).map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const chunk = item as Record<string, unknown>;
      return {
        source_id: chunk.source_id,
        document_chunk_id: chunk.document_chunk_id,
        char_start: chunk.char_start,
        char_end: chunk.char_end,
        source_role: chunk.source_role,
        title: chunk.title,
        section_title: chunk.section_title,
        content_excerpt: typeof chunk.content_excerpt === "string"
          ? chunk.content_excerpt.slice(0, 2_000)
          : chunk.content_excerpt,
      };
    });
  }
  return context;
}

interface AgentRuntime {
  sessionId: string;
  circuitScopeId: string;
  store: AgentSessionStore;
  hooks?: AgentRequest["hooks"];
}

async function emit(
  runtime: AgentRuntime,
  type: string,
  payload: Record<string, unknown> = {},
  options?: { idempotencyKey?: string }
) {
  const event = await runtime.store.appendEvent(runtime.sessionId, type, payload, options);
  await runtime.hooks?.onEvent?.(event);
  return event;
}

async function persistMessage(runtime: AgentRuntime, message: AgentMessage) {
  const stored = await runtime.store.appendMessage(runtime.sessionId, message);
  await emit(runtime, "message.completed", {
    messageId: stored.id,
    sequence: stored.sequence,
    role: stored.role,
  }, { idempotencyKey: `message:${stored.id}` });
  return stored;
}

interface PassResult {
  rawText: string;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number; costUsd: number; costSource: "provider" | "catalog_estimate" | "unknown" };
  requestId?: string;
  toolCalls: Array<{ name: string; status: "success" | "failed" }>;
  messages: AgentMessage[];
  contextCompacted: boolean;
  queueWaitMs: number;
  executionMs: number;
  circuitState: "closed" | "open";
}

async function executePass(params: {
  provider: ModelProvider; model: string; prompt: string; agentName: string; policy: ExecutionPolicy;
  deadline: ReturnType<typeof createDeadlineController>; maxOutputTokens?: number;
  invocationDeadline: ReturnType<typeof createDeadlineController>;
  messages: AgentMessage[]; tools: MaterializedTools; runtime: AgentRuntime;
}): Promise<PassResult> {
  const messages = [...params.messages];
  let rawText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let costUsd = 0;
  let costReportedByProvider = false;
  let providerStarted = false;
  let requestId: string | undefined;
  let toolTurns = 0;
  let toolCount = 0;
  let responseBytes = 0;
  let currentTurnText = "";
  let currentTurnReasoning = "";
  let contextCompacted = false;
  let queueWaitMs = 0;
  let executionMs = 0;
  let circuitState: "closed" | "open" = "closed";
  const endpoint = params.provider.endpointKey || params.provider.id;
  const toolSummaries: PassResult["toolCalls"] = [];
  const repeatedCalls = new Map<string, number>();
  const seenToolCallIds = new Set<string>();

  const snapshot = (): PassResult => {
    const visibleRawText = rawText || currentTurnText;
    if (!providerStarted && inputTokens === 0 && outputTokens === 0 && !visibleRawText) {
      return {
        rawText: "",
        usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, costSource: "unknown" },
        requestId,
        toolCalls: [...toolSummaries],
        messages: [...messages],
        contextCompacted,
        queueWaitMs,
        executionMs,
        circuitState,
      };
    }
    const effectiveInputTokens = inputTokens || Math.ceil(JSON.stringify(messages).length / 4);
    const effectiveReasoningTokens = reasoningTokens || Math.ceil(currentTurnReasoning.length / 4);
    const effectiveOutputTokens = outputTokens || Math.ceil(visibleRawText.length / 4) + effectiveReasoningTokens;
    const estimate = estimateCost(params.model, effectiveInputTokens, effectiveOutputTokens);
    const effectiveCost = costReportedByProvider ? costUsd : estimate.costUsd;
    return {
      rawText: visibleRawText,
      usage: {
        inputTokens: effectiveInputTokens,
        outputTokens: effectiveOutputTokens,
        reasoningTokens: effectiveReasoningTokens,
        costUsd: effectiveCost,
        costSource: costReportedByProvider ? "provider" : estimate.costSource,
      },
      requestId,
      toolCalls: [...toolSummaries],
      messages: [...messages],
      contextCompacted,
      queueWaitMs,
      executionMs,
      circuitState,
    };
  };

  const acquireRequestLock = async () => {
    if (!params.provider.acquireRequestLock) return undefined;
    const queuedAt = Date.now();
    params.deadline.pauseTotal();
    params.deadline.pauseInactivity();
    // Queue wait pauses the execution timer, never the checkpoint wall-clock ceiling.
    params.invocationDeadline.pauseInactivity();
    try {
      return await params.provider.acquireRequestLock(params.deadline.signal);
    } finally {
      queueWaitMs += Date.now() - queuedAt;
      params.deadline.resumeInactivity();
      params.deadline.resumeTotal();
      params.invocationDeadline.resumeInactivity();
    }
  };

  try {
    while (true) {
      circuitState = providerCircuitSnapshot(params.runtime.circuitScopeId, endpoint, params.model).state;
      assertProviderCircuitAvailable(params.runtime.circuitScopeId, endpoint, params.model);
      const calls: ToolCall[] = [];
      currentTurnText = "";
      currentTurnReasoning = "";
      let turnInputTokens = 0;
      let turnOutputTokens = 0;
      let turnReasoningTokens = 0;
      let turnCostUsd = 0;
      let completed = false;
      const compacted = compactMessages(messages, params.policy.maxContextBytes);
      contextCompacted ||= compacted.compacted;
      if (compacted.compacted) {
        await emit(params.runtime, "context.compacted", {
          beforeMessages: messages.length,
          afterMessages: compacted.messages.length,
        });
      }
      const releaseRequestLock = await acquireRequestLock();
      let executionStarted: number | undefined;
      try {
        circuitState = providerCircuitSnapshot(params.runtime.circuitScopeId, endpoint, params.model).state;
        assertProviderCircuitAvailable(params.runtime.circuitScopeId, endpoint, params.model);
        executionStarted = Date.now();
        const stream = params.provider.stream({
        model: params.model,
        prompt: params.prompt,
        sessionId: params.runtime.sessionId,
        messages: compacted.messages,
        temperature: 0.2,
        maxTokens: params.maxOutputTokens ?? params.policy.maxOutputTokens,
        maxResponseBytes: params.policy.maxResponseBytes,
        tools: params.tools.definitions,
        agentName: params.agentName,
      }, params.deadline.signal);
        const iterator = stream[Symbol.asyncIterator]();
        while (true) {
        if (params.deadline.remainingMs() <= 0) {
          throw new ProviderError("Provider request exceeded total deadline", "provider_timeout", { timeoutType: "total" });
        }
        const next = iterator.next();
        let abortHandler: (() => void) | undefined;
        const aborted = new Promise<never>((_, reject) => {
          if (params.deadline.signal.aborted) {
            reject(new ProviderError("Provider request cancelled", "cancellation"));
            return;
          }
          abortHandler = () => reject(new ProviderError("Provider request cancelled", "cancellation"));
          params.deadline.signal.addEventListener(
            "abort",
            abortHandler,
            { once: true }
          );
        });
        let item: IteratorResult<ModelEvent>;
        try {
          item = await Promise.race([next, aborted]);
        } catch (error) {
          void iterator.return?.().catch(() => undefined);
          throw error;
        } finally {
          if (abortHandler) params.deadline.signal.removeEventListener("abort", abortHandler);
        }
        if (item.done) break;
        const event = item.value;
        if (params.deadline.remainingMs() <= 0) {
          void iterator.return?.().catch(() => undefined);
          throw new ProviderError("Provider request exceeded total deadline", "provider_timeout", { timeoutType: "total" });
        }
        if (["response.started", "text.delta", "reasoning.delta", "usage", "tool.call", "response.completed"].includes(event.type)) {
          params.deadline.resetInactivity();
        }
        if (event.type === "response.started") {
          providerStarted = true;
          requestId = event.requestId || requestId;
          await emit(params.runtime, "response.started", {
            requestId: event.requestId,
            provider: params.provider.id,
            model: params.model,
          });
        }
        if (event.type === "text.delta") {
          currentTurnText += event.text;
          responseBytes += Buffer.byteLength(event.text, "utf8");
          if (responseBytes > params.policy.maxResponseBytes) {
            throw new ProviderError("Model response exceeded maximum size", "response_limit");
          }
        }
        if (event.type === "reasoning.delta") {
          currentTurnReasoning += event.text;
          responseBytes += Buffer.byteLength(event.text, "utf8");
          if (responseBytes > params.policy.maxResponseBytes) {
            throw new ProviderError("Model response exceeded maximum size", "response_limit");
          }
        }
        if (event.type === "usage") {
          const nextInputTokens = event.usage.inputTokens || 0;
          const nextOutputTokens = event.usage.outputTokens || 0;
          const nextReasoningTokens = event.usage.reasoningTokens || 0;
          inputTokens += Math.max(0, nextInputTokens - turnInputTokens);
          outputTokens += Math.max(0, nextOutputTokens - turnOutputTokens);
          reasoningTokens += Math.max(0, nextReasoningTokens - turnReasoningTokens);
          turnInputTokens = Math.max(turnInputTokens, nextInputTokens);
          turnOutputTokens = Math.max(turnOutputTokens, nextOutputTokens);
          turnReasoningTokens = Math.max(turnReasoningTokens, nextReasoningTokens);
          if (event.usage.costUsd !== undefined) {
            costReportedByProvider = true;
            costUsd += Math.max(0, event.usage.costUsd - turnCostUsd);
            turnCostUsd = Math.max(turnCostUsd, event.usage.costUsd);
          }
        }
        if (event.type === "tool.call") {
          if (!event.call.id || !event.call.name || seenToolCallIds.has(event.call.id)) {
            throw new ProviderError("Provider emitted an invalid or duplicate tool call ID", "malformed_stream");
          }
          seenToolCallIds.add(event.call.id);
          responseBytes += Buffer.byteLength(event.call.id, "utf8") +
            Buffer.byteLength(event.call.name, "utf8") + Buffer.byteLength(event.call.arguments, "utf8");
          if (responseBytes > params.policy.maxResponseBytes) {
            throw new ProviderError("Model response exceeded maximum size", "response_limit");
          }
          calls.push(event.call);
        }
        if (event.type === "response.failed") {
          if (event.error instanceof ProviderError) throw event.error;
          throw new ProviderError(redact(event.error.message), "server_error");
        }
          if (event.type === "response.completed") completed = true;
        }
      } finally {
        if (executionStarted !== undefined) executionMs += Date.now() - executionStarted;
        releaseRequestLock?.();
      }
      if (!completed) throw new ProviderError("Provider did not emit completion", "malformed_stream");
      if (!calls.length && !currentTurnText.trim()) throw new ProviderError("Provider completed without text output", "malformed_stream");
      circuitState = recordProviderSuccess(params.runtime.circuitScopeId, endpoint, params.model).state;

      const assistant = createMessage("assistant", [
        ...(currentTurnReasoning ? [{ type: "reasoning" as const, text: currentTurnReasoning }] : []),
        ...(currentTurnText ? [{ type: "text" as const, text: currentTurnText }] : []),
        ...calls.map((call) => ({ type: "tool_call" as const, call })),
      ]);
      await persistMessage(params.runtime, assistant);
      messages.push(assistant);
      await emit(params.runtime, "response.completed", {
        requestId,
        toolCalls: calls.length,
        textBytes: Buffer.byteLength(currentTurnText, "utf8"),
      });
      if (!calls.length) {
        rawText = currentTurnText;
        break;
      }
      toolTurns += 1;
      if (toolTurns > params.policy.maxToolTurns || toolCount + calls.length > params.policy.maxToolCalls) {
        throw new ProviderError("Tool execution limit exceeded", "invalid_request");
      }
      params.deadline.pauseInactivity();
      const results = await (async () => {
        try {
          return await Promise.all(calls.map(async (call) => {
            try {
              toolCount += 1;
              const signature = `${call.name}:${call.arguments}`;
              const repeated = (repeatedCalls.get(signature) || 0) + 1;
              repeatedCalls.set(signature, repeated);
              if (repeated > params.policy.maxRepeatedToolCalls) {
                throw new ProviderError(`Repeated tool call limit exceeded for ${call.name}`, "invalid_request");
              }
              await emit(params.runtime, "tool.called", {
                callId: call.id,
                name: call.name,
                arguments: call.arguments,
              }, { idempotencyKey: `tool:${call.id}:called` });
              try {
                const result = await params.tools.execute(call);
                toolSummaries.push({ name: call.name, status: "success" });
                await emit(params.runtime, "tool.completed", {
                  callId: call.id,
                  name: call.name,
                  outputBytes: result.outputBytes,
                  truncated: result.truncated,
                }, { idempotencyKey: `tool:${call.id}:completed` });
                return { call, output: result.output, isError: false };
              } catch (error) {
                if (category(error) === "cancellation") throw error;
                const message = redact(error instanceof Error ? error.message : String(error));
                toolSummaries.push({ name: call.name, status: "failed" });
                await emit(params.runtime, "tool.failed", {
                  callId: call.id,
                  name: call.name,
                  error: message,
                  category: category(error),
                }, { idempotencyKey: `tool:${call.id}:failed` });
                return { call, output: { error: message }, isError: true };
              }
            } catch (error) {
              const message = redact(error instanceof Error ? error.message : String(error));
              toolSummaries.push({ name: call.name, status: "failed" });
              await emit(params.runtime, "tool.failed", {
                callId: call.id,
                name: call.name,
                error: message,
                category: category(error),
              }, { idempotencyKey: `tool:${call.id}:failed` }).catch(() => undefined);
              return { call, output: { error: message }, isError: true, fatal: error };
            }
          }));
        } finally {
          params.deadline.resumeInactivity();
        }
      })();
      for (const result of results) {
        const toolMessage = createMessage("tool", [{
          type: "tool_result",
          toolCallId: result.call.id,
          toolName: result.call.name,
          output: result.output,
          isError: result.isError,
        }]);
        await persistMessage(params.runtime, toolMessage);
        messages.push(toolMessage);
      }
      const fatal = results.find((result) => "fatal" in result)?.fatal;
      if (fatal) throw fatal;
    }

    const result = snapshot();
    const outputLimit = params.maxOutputTokens ?? params.policy.maxOutputTokens;
    if (outputLimit !== undefined && result.usage.outputTokens > outputLimit) {
      throw new ProviderError("Model output exceeded token ceiling", "response_limit");
    }
    return result;
  } catch (error) {
    const errorCategory = category(error);
    if (qualifiesForProviderCircuit(errorCategory, params.deadline.reason())) {
      const snapshot = recordProviderFailure(params.runtime.circuitScopeId, endpoint, params.model);
      circuitState = snapshot.state;
      await emit(params.runtime, "provider.circuit", {
        endpoint,
        model: params.model,
        state: snapshot.state,
        consecutiveFailures: snapshot.consecutiveFailures,
        openedAt: snapshot.openedAt,
      }).catch(() => undefined);
    }
    if (error instanceof ProviderError) {
      throw new ProviderError(error.message, error.category, { ...error.details, partial: snapshot() });
    }
    throw error;
  }
}

async function executeTrackedPass(
  kind: AgentPassTelemetry["kind"],
  params: Parameters<typeof executePass>[0],
  passes: AgentPassTelemetry[]
) {
  const started = Date.now();
  try {
    const result = await executePass(params);
    passes.push({
      kind, startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(),
      latencyMs: Date.now() - started, requestId: result.requestId,
      queueWaitMs: result.queueWaitMs, executionMs: result.executionMs, circuitState: result.circuitState,
      inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
      reasoningTokens: result.usage.reasoningTokens, costUsd: result.usage.costUsd, costSource: result.usage.costSource, status: "success",
    });
    return result;
  } catch (error) {
    const partial = error instanceof ProviderError ? error.details.partial as PassResult | undefined : undefined;
    passes.push({
      kind, startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(),
      latencyMs: Date.now() - started, requestId: partial?.requestId,
      queueWaitMs: partial?.queueWaitMs || 0, executionMs: partial?.executionMs || 0,
      circuitState: partial?.circuitState || "closed",
      inputTokens: partial?.usage.inputTokens || 0, outputTokens: partial?.usage.outputTokens || 0,
      reasoningTokens: partial?.usage.reasoningTokens || 0, costUsd: partial?.usage.costUsd || 0, costSource: partial?.usage.costSource,
      status: "failed", errorCategory: category(error),
      errorMessage: redact(error instanceof Error ? error.message : String(error)),
    });
    throw error;
  }
}

function aggregateUsage(attempts: AgentAttempt[], fallback: { provider: string; model: string; promptVersion?: string }): AgentUsage {
  const successes = attempts.filter((attempt) => attempt.status === "success");
  const final = successes.at(-1) || attempts.at(-1);
  return {
    provider: final?.provider || fallback.provider,
    model: final?.model || fallback.model,
    inputTokens: attempts.reduce((sum, attempt) => sum + attempt.inputTokens, 0),
    outputTokens: attempts.reduce((sum, attempt) => sum + attempt.outputTokens, 0),
    reasoningTokens: attempts.reduce((sum, attempt) => sum + (attempt.reasoningTokens || 0), 0),
    costUsd: Number(attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0).toFixed(6)),
    costSource: attempts.some((attempt) => attempt.costSource === "unknown")
      ? "unknown"
      : attempts.some((attempt) => attempt.costSource === "catalog_estimate")
        ? "catalog_estimate"
        : "provider",
    latencyMs: attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0),
    requestId: final?.requestId,
    promptVersion: fallback.promptVersion,
    compaction_occurred: attempts.some((attempt) => attempt.compactionOccurred),
  };
}

interface ExecutionSetup {
  config: ReturnType<typeof getAgentConfig>;
  policy: ExecutionPolicy;
  provider: ModelProvider;
  runtime: AgentRuntime;
  invocationDeadline: ReturnType<typeof createDeadlineController>;
  baseMessages: AgentMessage[];
  tools: MaterializedTools;
}

function messagesForPrompt(base: AgentMessage[], prompt: string) {
  const messages = base.map((message) => ({ ...message, parts: [...message.parts] }));
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "user") continue;
    messages[index] = textMessage("user", prompt, messages[index].id);
    return messages;
  }
  return [...messages, textMessage("user", prompt)];
}

function preflightRequest(input: AgentRequest, config: ReturnType<typeof getAgentConfig>) {
  if (input.taskPacket && typeof input.taskPacket === "object") {
    const packet = input.taskPacket as any;
    if (packet.artifact_type !== undefined) {
      if (typeof packet.artifact_type !== "string") throw new Error("artifact_type must be a string");
      const artifactType = packet.artifact_type.toLowerCase();
      if (packet.artifact_type !== config.outputSchemaKey && (
        (input.agentName === "asset-analyst" && artifactType.includes("valuation")) ||
        (input.agentName === "intake-planner" && artifactType.includes("valuation"))
      )) {
        throw new Error(`Agent ${input.agentName} cannot be assigned valuation task or output artifact type ${packet.artifact_type}. Expected ${config.outputSchemaKey}.`);
      }
    }
  }

  if (input.agentName.toLowerCase().includes("red-team") || input.agentName.toLowerCase().includes("reviewer")) {
    const firstUser = input.messages?.find((message) => message.role === "user");
    const supplied = input.messages
      ?.filter((message) => message.role === "system" || message === firstUser)
      .map(messageText) || [];
    const instructionText = [
      input.systemPrompt || "",
      buildTaskPrompt(input, config).split("\nTask packet:\n", 1)[0],
      ...supplied,
    ].join("\n");
    if (instructionText.toLowerCase().includes("confirm the thesis") || instructionText.toLowerCase().includes("prove the thesis")) {
      throw new Error("Red-team prompt review failed: prompt must not contain instructions to confirm or prove the thesis.");
    }
  }
}

async function executeResearchAgent<TStructured>(input: AgentRequest, setup: ExecutionSetup): Promise<AgentResult<TStructured>> {
  const { config, policy, provider } = setup;

  const attempts: AgentAttempt[] = [];

  // Use request-level output format override if provided; otherwise fall back to agent config
  const effectiveOutputFormat: Record<string, unknown> = (input.outputFormat as unknown as Record<string, unknown>) || config.outputFormat;
  const keys = requiredKeys(effectiveOutputFormat);
  const candidates = modelCandidates(input.agentName as ResearchAgentName, policy.maxAttempts);
  const primaryModel = candidates[0];
  const originalPromptBytes = Buffer.byteLength(buildTaskPrompt(input, config), "utf8");

  for (let index = 0; index < candidates.length; index += 1) {
    const attemptNumber = index + 1;
    const model = candidates[index];
    const fallback = model !== primaryModel;
    const modelAttempt = candidates.slice(0, index + 1).filter((candidate) => candidate === model).length;
    // A same-model source-reader retry must change the request. Replaying the
    // full packet can reproduce the same long-reasoning stall; keep the retry
    // bounded and deterministic by using the existing excerpt compactor.
    const priorTransportFailure = input.agentName === "source-reader"
      && Array.isArray(input.taskPacket.prior_validation_errors)
      && input.taskPacket.prior_validation_errors.some((error) => /connect|stream|terminated|timeout/i.test(String(error)));
    const compactedFallback = fallback || index > 0 || priorTransportFailure
      ? compactFallback(input)
      : { request: input, compacted: false };
    const currentInput = compactedFallback.request;
    await input.hooks?.beforeAttempt?.({ attempt: attemptNumber, provider: provider.id, model });
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const deadline = createDeadlineController(
      setup.invocationDeadline.signal,
      Math.max(1, Math.min(policy.attemptTimeoutMs, setup.invocationDeadline.remainingMs())),
      policy.inactivityTimeoutMs
    );
    let pass: PassResult = {
      rawText: "",
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, costSource: "unknown" },
      toolCalls: [], messages: [...setup.baseMessages], contextCompacted: false,
      queueWaitMs: 0, executionMs: 0, circuitState: "closed",
    };
    let repairAttempted = false;
    let validationErrors: SchemaValidationError[] = [];
    const passes: AgentPassTelemetry[] = [];
    let localCoercionApplied = false;
    let completionRecoveredAtTimeout = false;
    let completionRecoveredWithoutMarker = false;
    let generationWasMalformed = false;

    try {
      const prompt = buildTaskPrompt(currentInput, config);
      try {
        pass = await executeTrackedPass("generation", {
          provider, model, prompt, agentName: input.agentName, policy, deadline,
          invocationDeadline: setup.invocationDeadline,
          messages: input.messages?.length ? setup.baseMessages : messagesForPrompt(setup.baseMessages, prompt),
          tools: setup.tools, runtime: setup.runtime,
        }, passes);
      } catch (error) {
        const timeoutReason = deadline.reason();
        const partial = error instanceof ProviderError ? error.details.partial as PassResult | undefined : undefined;
        const timedOut = timeoutReason === "total" || timeoutReason === "inactivity";
        const recoverableStreamEnd = error instanceof ProviderError &&
          error.category === "malformed_stream" &&
          /completion marker|did not emit completion|terminated/i.test(error.message);
        if ((timedOut || recoverableStreamEnd) && partial?.rawText.trim()) {
          try {
            let candidate = parseStructuredOutput(partial.rawText, keys);
            let candidateErrors = validateCandidate(candidate, effectiveOutputFormat, input.validateStructured);
            if (candidateErrors.length) {
              const coerced = coerceStructuredOutput(candidate, effectiveOutputFormat);
              if (coerced.changed) {
                const coercedErrors = validateCandidate(coerced.value, effectiveOutputFormat, input.validateStructured);
                if (coercedErrors.length < candidateErrors.length) {
                  candidate = coerced.value;
                  candidateErrors = coercedErrors;
                }
              }
            }
            if (candidateErrors.length) throw new Error("Incomplete response did not satisfy the output schema");
            pass = partial;
            const generationPass = passes.at(-1);
            if (timedOut) {
              completionRecoveredAtTimeout = true;
              if (generationPass?.kind === "generation") generationPass.completionRecoveredAtTimeout = true;
            } else {
              completionRecoveredWithoutMarker = true;
              if (generationPass?.kind === "generation") generationPass.completionRecoveredWithoutMarker = true;
            }
          } catch {
            throw error;
          }
        } else {
          throw error;
        }
      }
      let parsed: unknown;
      try {
        parsed = parseStructuredOutput(pass.rawText, keys);
        validationErrors = validateCandidate(parsed, effectiveOutputFormat, input.validateStructured);
        if (validationErrors.length) {
          const coerced = coerceStructuredOutput(parsed, effectiveOutputFormat);
          if (coerced.changed) {
            const coercedErrors = validateCandidate(coerced.value, effectiveOutputFormat, input.validateStructured);
            if (coercedErrors.length < validationErrors.length) {
              parsed = coerced.value;
              localCoercionApplied = true;
              if (passes[0]) passes[0].localCoercionApplied = true;
              const originalErrors = validationErrors;
              validationErrors = coercedErrors;
              if (passes[0]) passes[0].validationErrors = originalErrors;
            }
          }
        }
      } catch (error) {
        generationWasMalformed = /No valid JSON object found/i.test(error instanceof Error ? error.message : String(error));
        validationErrors = [{ path: "root", message: error instanceof Error ? error.message : String(error) }];
      }
      if (passes[0] && !passes[0].validationErrors) passes[0].validationErrors = [...validationErrors];

      const sourceReaderRepairRules = input.agentName === "source-reader"
        ? [
            "For every evidence_claim, use exactly these field names: claim_text, claim_type, claim_category, source_id, document_chunk_id, quoted_text, char_start, char_end, confidence.",
            "claim_category must be exactly one of: fact, estimate, assumption, opinion.",
            "Use source_id and document_chunk_id only from source_corpus, and pair each claim with its matching chunk.",
            "quoted_text must be an exact contiguous substring of the matching source_corpus.content_excerpt; char_start is inclusive and char_end is exclusive, and both must match that quote.",
            "Do not use aliases such as claim or source_quote. Do not omit a citation or invent an identifier.",
          ]
        : [];
      for (let repairIndex = 0; validationErrors.length && repairIndex < policy.maxRepairAttempts; repairIndex += 1) {
        repairAttempted = true;
        const repairPrompt = [
          `REPAIR TASK: ${input.title}`,
          "",
          "The previous model output failed schema validation. Repair it into exactly one JSON object.",
          `Required top-level keys: ${keys.join(", ")}`,
          `Validation errors: ${validationErrors.map((error) => `${error.path}: ${error.message}`).join(" | ").slice(0, 16_000)}`,
          ...sourceReaderRepairRules,
          "",
          "Required JSON schema:",
          JSON.stringify(effectiveOutputFormat.schema || effectiveOutputFormat),
          "",
          "Original task context (compact):",
          JSON.stringify(repairContext(input)),
          "",
          `Previous parsed response: ${repairCandidate(parsed, pass.rawText)}`,
        ].join("\n\n");
        if (setup.invocationDeadline.remainingMs() < 10_000) {
          throw new ProviderError("Insufficient time remaining for structured-output repair", "provider_timeout", {
            timeoutType: "total", partial: pass,
          });
        }
        let repair: PassResult;
        const repairDeadline = createDeadlineController(
          setup.invocationDeadline.signal,
          Math.max(1, Math.min(policy.repairTimeoutMs, setup.invocationDeadline.remainingMs())),
          Math.min(60_000, policy.inactivityTimeoutMs)
        );
        try {
          const repairMessage = textMessage("user", repairPrompt);
          await persistMessage(setup.runtime, repairMessage);
          repair = await executeTrackedPass("repair", {
            provider, model, prompt: repairPrompt, agentName: input.agentName, policy, deadline: repairDeadline,
            invocationDeadline: setup.invocationDeadline,
            messages: [
              ...setup.baseMessages.filter((message) => message.role === "system"),
              repairMessage,
            ],
            tools: setup.tools,
            runtime: setup.runtime,
          }, passes);
        } catch (error) {
          const repairReason = repairDeadline.reason();
          if (repairReason === "total" || repairReason === "inactivity") {
            const partial = error instanceof ProviderError ? error.details.partial : undefined;
            throw new ProviderError(`Repair ${repairReason} timeout`, "provider_timeout", {
              timeoutType: repairReason,
              partial: partial || pass,
            });
          }
          if (error instanceof ProviderError) {
            const repairPartial = error.details.partial as PassResult | undefined;
            throw new ProviderError(error.message, error.category, {
              ...error.details,
              partial: {
                rawText: repairPartial?.rawText || pass.rawText,
                requestId: repairPartial?.requestId || pass.requestId,
                usage: {
                  inputTokens: pass.usage.inputTokens + (repairPartial?.usage.inputTokens || 0),
                  outputTokens: pass.usage.outputTokens + (repairPartial?.usage.outputTokens || 0),
                  reasoningTokens: pass.usage.reasoningTokens + (repairPartial?.usage.reasoningTokens || 0),
                  costUsd: pass.usage.costUsd + (repairPartial?.usage.costUsd || 0),
                  costSource: pass.usage.costSource === "unknown" || repairPartial?.usage.costSource === "unknown"
                    ? "unknown"
                    : pass.usage.costSource === "catalog_estimate" || repairPartial?.usage.costSource === "catalog_estimate"
                      ? "catalog_estimate"
                      : "provider",
                },
                toolCalls: [...pass.toolCalls, ...(repairPartial?.toolCalls || [])],
                messages: repairPartial?.messages || pass.messages,
                contextCompacted: Boolean(pass.contextCompacted || repairPartial?.contextCompacted),
                queueWaitMs: pass.queueWaitMs + (repairPartial?.queueWaitMs || 0),
                executionMs: pass.executionMs + (repairPartial?.executionMs || 0),
                circuitState: repairPartial?.circuitState || pass.circuitState,
              } satisfies PassResult,
            });
          }
          throw error;
        } finally {
          repairDeadline.cleanup();
        }
        pass = {
          ...repair,
          contextCompacted: pass.contextCompacted || repair.contextCompacted,
          usage: {
            inputTokens: pass.usage.inputTokens + repair.usage.inputTokens,
            outputTokens: pass.usage.outputTokens + repair.usage.outputTokens,
            reasoningTokens: pass.usage.reasoningTokens + repair.usage.reasoningTokens,
            costUsd: pass.usage.costUsd + repair.usage.costUsd,
            costSource: pass.usage.costSource === "unknown" || repair.usage.costSource === "unknown"
              ? "unknown"
              : pass.usage.costSource === "catalog_estimate" || repair.usage.costSource === "catalog_estimate"
                ? "catalog_estimate"
                : "provider",
          },
          toolCalls: [...pass.toolCalls, ...repair.toolCalls],
        };
        try {
          parsed = parseStructuredOutput(repair.rawText, keys);
          validationErrors = validateCandidate(parsed, effectiveOutputFormat, input.validateStructured);
          if (validationErrors.length) {
            const coerced = coerceStructuredOutput(parsed, effectiveOutputFormat);
            if (coerced.changed) {
              const coercedErrors = validateCandidate(coerced.value, effectiveOutputFormat, input.validateStructured);
              if (coercedErrors.length < validationErrors.length) {
                const originalErrors = validationErrors;
                parsed = coerced.value;
                validationErrors = coercedErrors;
                localCoercionApplied = true;
                const repairPass = passes.at(-1);
                if (repairPass?.kind === "repair") {
                  repairPass.localCoercionApplied = true;
                  repairPass.validationErrors = originalErrors;
                }
              }
            }
          }
        } catch (error) {
          validationErrors = [{ path: "root", message: error instanceof Error ? error.message : String(error) }];
        }
        if (passes.at(-1)?.kind === "repair" && !passes.at(-1)!.validationErrors) {
          passes.at(-1)!.validationErrors = [...validationErrors];
        }
      }
      if (validationErrors.length) {
        const failureCategory = generationWasMalformed ? "malformed_stream" : "schema_validation";
        throw new ProviderError(`Structured output validation failed: ${validationErrors.map((error) => `${error.path}: ${error.message}`).join(" | ")}`, failureCategory);
      }

      const completed = Date.now();
      const record: AgentAttempt = {
        attempt: attemptNumber, provider: provider.id, model, modelAttempt, requestId: pass.requestId,
        startedAt, completedAt: new Date(completed).toISOString(), latencyMs: completed - started,
        queueWaitMs: passes.reduce((sum, item) => sum + (item.queueWaitMs || 0), 0),
        executionMs: passes.reduce((sum, item) => sum + (item.executionMs || 0), 0),
        circuitState: pass.circuitState,
        inputTokens: pass.usage.inputTokens, outputTokens: pass.usage.outputTokens, reasoningTokens: pass.usage.reasoningTokens,
        costUsd: Number(pass.usage.costUsd.toFixed(6)), costSource: pass.usage.costSource, status: "success", repairAttempted,
        fallback, compactionOccurred: compactedFallback.compacted || pass.contextCompacted,
        inputBytes: Buffer.byteLength(buildTaskPrompt(currentInput, config), "utf8"), originalInputBytes: originalPromptBytes,
        rawResponseExcerpt: redact(pass.rawText.slice(0, 12_000)), validationErrors, toolCalls: pass.toolCalls,
        passes,
        localCoercionApplied,
        completionRecoveredAtTimeout,
        completionRecoveredWithoutMarker,
      };
      attempts.push(record);
      deadline.cleanup();
      const usage = aggregateUsage(attempts, { provider: provider.id, model, promptVersion: config.promptVersion });
      try {
        await input.hooks?.onAttemptComplete?.(record);
      } catch (error) {
        throw new ResearchAgentRunError(
          `Attempt persistence failed after a successful model response: ${redact(error instanceof Error ? error.message : String(error))}`,
          usage,
          { attempts, error_type: "server_error", persistence_failure: true },
          attempts
        );
      }
      return {
        structured: parsed as TStructured,
        rawText: pass.rawText,
        attempts,
        usage,
        config: config as unknown as Record<string, unknown>,
        sessionId: setup.runtime.sessionId,
      };
    } catch (error) {
      if (error instanceof ResearchAgentRunError) throw error;
      if (error instanceof ProviderError && error.details.partial) {
        pass = error.details.partial as PassResult;
      }
      const reason = setup.invocationDeadline.reason() || deadline.reason();
      deadline.cleanup();
      let failure = error;
      if (reason === "caller") failure = new ProviderError("Request cancelled by caller", "cancellation");
      else if (reason === "total" || reason === "inactivity") {
        failure = new ProviderError(`Request ${reason} timeout`, "provider_timeout", { timeoutType: reason });
      }
      const errorCategory = category(failure);
      const completed = Date.now();
      const record: AgentAttempt = {
        attempt: attemptNumber, provider: provider.id, model, modelAttempt, requestId: pass.requestId,
        startedAt, completedAt: new Date(completed).toISOString(), latencyMs: completed - started,
        queueWaitMs: passes.reduce((sum, item) => sum + (item.queueWaitMs || 0), 0),
        executionMs: passes.reduce((sum, item) => sum + (item.executionMs || 0), 0),
        circuitState: pass.circuitState,
        inputTokens: pass.usage.inputTokens, outputTokens: pass.usage.outputTokens, reasoningTokens: pass.usage.reasoningTokens,
        costUsd: Number(pass.usage.costUsd.toFixed(6)), costSource: pass.usage.costSource, status: errorCategory === "cancellation" ? "cancelled" : "failed",
        errorCategory, errorMessage: redact(failure instanceof Error ? failure.message : String(failure)),
        timeoutType: reason === "total" || reason === "inactivity"
          ? reason
          : failure instanceof ProviderError && (failure.details.timeoutType === "total" || failure.details.timeoutType === "inactivity")
            ? failure.details.timeoutType
            : undefined,
        repairAttempted, fallback, compactionOccurred: compactedFallback.compacted || pass.contextCompacted,
        inputBytes: Buffer.byteLength(buildTaskPrompt(currentInput, config), "utf8"), originalInputBytes: originalPromptBytes,
        rawResponseExcerpt: redact(pass.rawText.slice(0, 12_000)), validationErrors, toolCalls: pass.toolCalls,
        passes,
        localCoercionApplied,
        completionRecoveredAtTimeout,
        completionRecoveredWithoutMarker,
      };
      attempts.push(record);
      try {
        await input.hooks?.onAttemptComplete?.(record);
      } catch (hookError) {
        const usage = aggregateUsage(attempts, { provider: provider.id, model, promptVersion: config.promptVersion });
        throw new ResearchAgentRunError(
          `Attempt persistence failed after a failed model response: ${redact(hookError instanceof Error ? hookError.message : String(hookError))}`,
          usage,
          { attempts, error_type: "server_error", persistence_failure: true },
          attempts
        );
      }
      const schemaAttemptsExhausted = errorCategory === "schema_validation" &&
        attempts.filter((attempt) => attempt.errorCategory === "schema_validation").length >= 2;
      if (!retryable(errorCategory, input.agentName) || schemaAttemptsExhausted || index === candidates.length - 1) {
        const usage = aggregateUsage(attempts, { provider: provider.id, model, promptVersion: config.promptVersion });
        throw new ResearchAgentRunError(
          `Agent attempts exhausted: ${record.errorMessage}`, usage,
          { attempts, error_type: errorCategory, raw_response_excerpt: record.rawResponseExcerpt }, attempts
        );
      }
      const retryAfter = failure instanceof ProviderError ? Number(failure.details.retryAfter) : 0;
      const baseDelay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 30_000)
        : Math.min(policy.retryBaseDelayMs * 2 ** index, 30_000);
      const delay = Math.min(30_000, Math.max(1, Math.round(baseDelay * (0.9 + Math.random() * 0.2))));
      setup.invocationDeadline.pauseInactivity();
      try {
        await waitForRetry(delay, setup.invocationDeadline);
      } finally {
        setup.invocationDeadline.resumeInactivity();
      }
    }
  }
  throw new Error("No model candidates configured");
}

async function initialMessages(
  input: AgentRequest,
  config: ReturnType<typeof getAgentConfig>,
  runtime: AgentRuntime
) {
  const existing = await runtime.store.listMessages(runtime.sessionId);
  if (existing.length) {
    if (input.messages?.length) {
      const appended: AgentMessage[] = [];
      for (const message of input.messages) appended.push(await persistMessage(runtime, message));
      return [...existing, ...appended.filter((message) => !existing.some((current) => current.id === message.id))];
    }
    const inputId = input.session?.inputId || randomUUID();
    if (existing.some((message) => message.id === inputId)) return existing;
    const message = textMessage("user", buildTaskPrompt(input, config), inputId);
    const stored = await persistMessage(runtime, message);
    return existing.some((current) => current.id === stored.id) ? existing : [...existing, stored];
  }

  const messages: AgentMessage[] = [];
  const roots = [
    ...(input.skillPaths || []),
    `${process.cwd()}/.agents/skills`,
    `${process.cwd()}/.opencode/skills`,
  ];
  const discovered = await discoverSkills({ roots });
  const skillContext = renderSkillContext(selectSkills(discovered, [...new Set([...DEFAULT_SKILLS, ...(input.skills || [])])]));
  const system = [input.systemPrompt, skillContext].filter(Boolean).join("\n\n");
  if (system) messages.push(textMessage("system", system));
  if (input.messages?.length) messages.push(...input.messages);
  else messages.push(textMessage("user", buildTaskPrompt(input, config), input.session?.inputId || randomUUID()));
  const stored: AgentMessage[] = [];
  for (const message of messages) stored.push(await persistMessage(runtime, message));
  return stored;
}

export async function runResearchAgent<TStructured = unknown>(input: AgentRequest): Promise<AgentResult<TStructured>> {
  const config = getAgentConfig(input.agentName);
  preflightRequest(input, config);
  if (input.session?.depth !== undefined && (!Number.isInteger(input.session.depth) || input.session.depth < 0)) {
    throw new ProviderError("Session depth must be a non-negative integer", "invalid_request");
  }
  if (input.signal?.aborted) throw new ProviderError("Request cancelled by caller", "cancellation");
  const policy = executionPolicy(input);
  const store = input.session?.store || new MemoryAgentSessionStore();
  const session = await store.createSession({
    id: input.session?.id,
    parentSessionId: input.session?.parentSessionId,
    researchRunId: input.session?.researchRunId,
    stageId: input.session?.stageId,
    taskId: input.session?.taskId,
    agentName: input.agentName,
    metadata: { title: input.title, ...(input.session?.metadata || {}) },
  });
  const runtime: AgentRuntime = {
    sessionId: session.id,
    circuitScopeId: input.session?.researchRunId || session.id,
    store,
    hooks: input.hooks,
  };
  const operationId = input.session?.inputId || randomUUID();
  if (session.result && typeof session.result === "object" && "structured" in session.result) {
    if (session.status !== "completed") await store.updateSession(session.id, { status: "completed" });
    return { ...(session.result as AgentResult<TStructured>), sessionId: session.id };
  }
  return sessionCoordinator.run(session.id, operationId, async () => {
    const invocationDeadline = createDeadlineController(
      input.signal,
      policy.totalTimeoutMs,
      policy.totalTimeoutMs + 60_000
    );
    const registry = new ToolRegistry(defaultToolRegistry);
    let subagent: ReturnType<typeof registerSubagentTool> | undefined;
    let mcp: Awaited<ReturnType<typeof registerMcpServers>> | undefined;

    try {
      if (invocationDeadline.signal.aborted) throw new ProviderError("Request cancelled by caller", "cancellation");
      if (input.subagents) {
        subagent = registerSubagentTool({
          registry,
          config: input.subagents,
          parentSessionId: session.id,
          parentDepth: input.session?.depth || 0,
        });
      }
      const providerType = process.env.RESEARCH_MODEL_PROVIDER || "direct-openai-compatible";
      const provider = input.provider || getProvider(providerType);
      await store.updateSession(session.id, {
        status: "running",
        provider: provider.id,
        model: resolveAgentModel(input.agentName as ResearchAgentName),
      });
      await emit(runtime, "session.started", {
        operationId,
        agentName: input.agentName,
        provider: provider.id,
      }, { idempotencyKey: `operation:${operationId}:started` });
      const baseMessages = await initialMessages(input, config, runtime);
      if (input.mcpServers?.length) {
        mcp = await registerMcpServers(input.mcpServers, registry, invocationDeadline.signal);
        for (const failure of mcp.errors) {
          await emit(runtime, "mcp.failed", { server: failure.server, message: redact(failure.message, 2_000) });
        }
      }
      const tools = materializeTools({
        agentName: input.agentName,
        sessionId: session.id,
        signal: invocationDeadline.signal,
        enabledTools: [
          ...(input.enabledTools || []),
          ...(mcp?.enabledTools || []),
          ...(subagent ? [subagent.toolName] : []),
        ],
        permissionRules: input.permissionRules,
        onPermissionRequest: input.onPermissionRequest,
        researchRunId: input.session?.researchRunId,
        stageId: input.session?.stageId,
        taskId: input.session?.taskId,
        store,
        defaultTimeoutMs: policy.toolTimeoutMs,
        defaultMaxOutputBytes: policy.maxToolOutputBytes,
      }, registry);
      const result = await executeResearchAgent<TStructured>(input, {
        config, policy, provider, runtime, invocationDeadline, baseMessages, tools,
      });
      const completed = { ...result, sessionId: session.id };
      await store.updateSession(session.id, {
        status: "completed",
        provider: result.usage.provider,
        model: result.usage.model,
        result: completed,
      });
      await emit(runtime, "session.completed", {
        attempts: result.attempts.length,
        costUsd: result.usage.costUsd,
      }, { idempotencyKey: `operation:${operationId}:completed` }).catch(() => undefined);
      return completed;
    } catch (error) {
      const cancelled = category(error) === "cancellation" || input.signal?.aborted;
      await emit(runtime, cancelled ? "session.cancelled" : "session.failed", {
        error: redact(error instanceof Error ? error.message : String(error)),
        category: category(error),
      }, { idempotencyKey: `operation:${operationId}:${cancelled ? "cancelled" : "failed"}` }).catch(() => undefined);
      await store.updateSession(session.id, {
        status: cancelled ? "cancelled" : "failed",
        error: {
          message: redact(error instanceof Error ? error.message : String(error)),
          category: category(error),
        },
      }).catch(() => undefined);
      throw error;
    } finally {
      invocationDeadline.cleanup();
      subagent?.unregister();
      await mcp?.close().catch(() => undefined);
    }
  });
}
