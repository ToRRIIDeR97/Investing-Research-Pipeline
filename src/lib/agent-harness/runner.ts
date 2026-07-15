import { createDeadlineController } from "./deadlines";
import { ProviderError, ResearchAgentRunError, type HarnessErrorCategory } from "./errors";
import { parseStructuredOutput } from "./output-parser";
import { getProvider } from "./providers/provider";
import { getAgentConfig, normalizeModelEnvValue, resolveAgentModel, type ResearchAgentName } from "./registry";
import { calculateCost } from "./telemetry";
import { executeTool, toolDefinitionsForAgent } from "./tools";
import type {
  AgentAttempt, AgentRequest, AgentResult, AgentUsage, ExecutionPolicy, ModelEvent, ModelProvider, ModelUsage, ToolCall,
} from "./types";
import { validateSchema, type SchemaValidationError } from "./validation";

export { ResearchAgentRunError };

const DEFAULT_POLICY: ExecutionPolicy = {
  totalTimeoutMs: 240_000,
  inactivityTimeoutMs: 90_000,
  maxResponseBytes: 1_000_000,
  maxOutputTokens: 32_000,
  maxRepairAttempts: 1,
  maxToolTurns: 4,
  maxToolCalls: 8,
  maxAttempts: 2,
};

function numberEnv(name: string, fallback: number, minimum = 1) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function executionPolicy(input: AgentRequest): ExecutionPolicy {
  const key = input.agentName.toUpperCase().replace(/-/g, "_");
  const totalDefault = input.agentName === "asset-analyst" ? 600_000 : DEFAULT_POLICY.totalTimeoutMs;
  return {
    totalTimeoutMs: numberEnv(`RESEARCH_${key}_TIMEOUT_MS`, numberEnv("RESEARCH_AGENT_TIMEOUT_MS", totalDefault, 10_000), 10_000),
    inactivityTimeoutMs: numberEnv(`RESEARCH_${key}_INACTIVITY_TIMEOUT_MS`, numberEnv("RESEARCH_INACTIVITY_TIMEOUT_MS", DEFAULT_POLICY.inactivityTimeoutMs, 1_000), 1_000),
    maxResponseBytes: numberEnv(`RESEARCH_${key}_MAX_RESPONSE_BYTES`, numberEnv("RESEARCH_MAX_RESPONSE_BYTES", DEFAULT_POLICY.maxResponseBytes)),
    maxOutputTokens: numberEnv(`RESEARCH_${key}_MAX_OUTPUT_TOKENS`, numberEnv("RESEARCH_MAX_OUTPUT_TOKENS", DEFAULT_POLICY.maxOutputTokens)),
    maxRepairAttempts: numberEnv("RESEARCH_MAX_REPAIR_ATTEMPTS", DEFAULT_POLICY.maxRepairAttempts, 0),
    maxToolTurns: numberEnv("RESEARCH_MAX_TOOL_TURNS", DEFAULT_POLICY.maxToolTurns, 0),
    maxToolCalls: numberEnv("RESEARCH_MAX_TOOL_CALLS", DEFAULT_POLICY.maxToolCalls, 0),
    maxAttempts: numberEnv("RESEARCH_MAX_MODEL_ATTEMPTS", DEFAULT_POLICY.maxAttempts),
    ...input.policy,
  };
}

function buildTaskPrompt(input: AgentRequest, config: ReturnType<typeof getAgentConfig>) {
  if (input.prompt) return input.prompt;
  return [
    `Run Research OS agent: ${config.name}`,
    "Use the task packet below as the complete working context.",
    "Return exactly one JSON object matching the requested schema. Do not include Markdown.",
    "Task packet:", JSON.stringify(input.taskPacket),
  ].join("\n\n");
}

function requiredKeys(outputFormat: Record<string, unknown>) {
  const schema = outputFormat.schema as { required?: unknown } | undefined;
  return Array.isArray(schema?.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
}

function modelCandidates(agentName: ResearchAgentName, maxAttempts: number) {
  const primary = resolveAgentModel(agentName);
  const fallbackKey = `RESEARCH_${agentName.toUpperCase().replace(/-/g, "_")}_FALLBACK_MODEL`;
  const builtIns: Partial<Record<ResearchAgentName, string>> = {
    "asset-analyst": "qwen3.7-plus", "valuation-analyst": "deepseek-v4-pro",
  };
  const fallback = process.env[fallbackKey] || builtIns[agentName];
  return [primary, fallback ? normalizeModelEnvValue(fallback) : null]
    .filter((model): model is string => Boolean(model))
    .filter((model, index, all) => all.indexOf(model) === index)
    .slice(0, maxAttempts);
}

function compactFallback(input: AgentRequest): AgentRequest {
  if (input.agentName !== "asset-analyst") return input;
  const packet = { ...input.taskPacket };
  if (Array.isArray(packet.evidence_claims)) packet.evidence_claims = packet.evidence_claims.slice(0, 15);
  if (Array.isArray(packet.normalized_observations)) packet.normalized_observations = packet.normalized_observations.slice(0, 20);
  if (Array.isArray(packet.metrics)) packet.metrics = packet.metrics.slice(0, 20);
  return { ...input, taskPacket: packet };
}

function category(error: unknown): HarnessErrorCategory {
  if (error instanceof ProviderError) return error.category;
  return "unknown";
}

function retryable(value: HarnessErrorCategory) {
  return value === "rate_limit" || value === "provider_timeout" || value === "connection" || value === "malformed_stream";
}

function redact(value: string) {
  const secrets = [process.env.RESEARCH_MODEL_API_KEY, process.env.DATABASE_URL].filter(Boolean) as string[];
  return secrets.reduce((message, secret) => secret.length > 5 ? message.split(secret).join("[REDACTED]") : message, value)
    .replace(/(bearer\s+)[^\s"']+/gi, "$1[REDACTED]");
}

interface PassResult {
  rawText: string;
  usage: Required<ModelUsage>;
  requestId?: string;
  toolCalls: Array<{ name: string; status: "success" | "failed" }>;
}

async function executePass(params: {
  provider: ModelProvider; model: string; prompt: string; agentName: string; policy: ExecutionPolicy;
  deadline: ReturnType<typeof createDeadlineController>;
}): Promise<PassResult> {
  let prompt = params.prompt;
  let rawText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let costReportedByProvider = false;
  let requestId: string | undefined;
  let toolTurns = 0;
  let toolCount = 0;
  const toolSummaries: PassResult["toolCalls"] = [];
  const tools = toolDefinitionsForAgent(params.agentName);

  const snapshot = (): PassResult => {
    const effectiveInputTokens = inputTokens || Math.ceil(params.prompt.length / 4);
    const effectiveOutputTokens = outputTokens || Math.ceil(rawText.length / 4);
    const effectiveCost = costReportedByProvider
      ? costUsd
      : calculateCost(params.model, effectiveInputTokens, effectiveOutputTokens);
    return {
      rawText,
      usage: { inputTokens: effectiveInputTokens, outputTokens: effectiveOutputTokens, costUsd: effectiveCost },
      requestId,
      toolCalls: [...toolSummaries],
    };
  };

  try {
    while (true) {
      const calls: ToolCall[] = [];
      let completed = false;
      const stream = params.provider.stream({
        model: params.model, prompt, temperature: 0.2, maxTokens: params.policy.maxOutputTokens,
        tools, agentName: params.agentName,
      }, params.deadline.signal);
      for await (const event of stream) {
        if (["response.started", "text.delta", "reasoning.delta", "usage", "tool.call", "response.completed"].includes(event.type)) {
          params.deadline.resetInactivity();
        }
        if (event.type === "response.started") requestId = event.requestId || requestId;
        if (event.type === "text.delta") {
          rawText += event.text;
          if (Buffer.byteLength(rawText, "utf8") > params.policy.maxResponseBytes) {
            throw new ProviderError("Model response exceeded maximum size", "response_limit");
          }
        }
        if (event.type === "usage") {
          inputTokens += event.usage.inputTokens || 0;
          outputTokens += event.usage.outputTokens || 0;
          if (event.usage.costUsd !== undefined) {
            costReportedByProvider = true;
            costUsd += event.usage.costUsd;
          }
        }
        if (event.type === "tool.call") calls.push(event.call);
        if (event.type === "response.failed") throw event.error;
        if (event.type === "response.completed") completed = true;
      }
      if (!completed) throw new ProviderError("Provider did not emit completion", "malformed_stream");
      if (!calls.length) break;
      toolTurns += 1;
      if (toolTurns > params.policy.maxToolTurns || toolCount + calls.length > params.policy.maxToolCalls) {
        throw new ProviderError("Tool execution limit exceeded", "invalid_request");
      }
      const results: Array<{ name: string; result?: unknown; error?: string }> = [];
      for (const call of calls) {
        toolCount += 1;
        try {
          const result = await executeTool(params.agentName, call);
          results.push({ name: call.name, result });
          toolSummaries.push({ name: call.name, status: "success" });
        } catch (error) {
          const message = redact(error instanceof Error ? error.message : String(error));
          results.push({ name: call.name, error: message });
          toolSummaries.push({ name: call.name, status: "failed" });
        }
      }
      prompt = `${prompt}\n\nTool results:\n${JSON.stringify(results)}\n\nContinue and return exactly one JSON object.`;
    }

    const result = snapshot();
    if (result.usage.outputTokens > params.policy.maxOutputTokens) throw new ProviderError("Model output exceeded token ceiling", "response_limit");
    return result;
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new ProviderError(error.message, error.category, { ...error.details, partial: snapshot() });
    }
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
    costUsd: Number(attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0).toFixed(6)),
    latencyMs: attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0),
    requestId: final?.requestId,
    promptVersion: fallback.promptVersion,
    compaction_occurred: attempts.some((attempt) => attempt.compactionOccurred),
  };
}

export async function runResearchAgent<TStructured = unknown>(input: AgentRequest): Promise<AgentResult<TStructured>> {
  const config = getAgentConfig(input.agentName);
  const policy = executionPolicy(input);
  const providerType = process.env.RESEARCH_MODEL_PROVIDER || "direct-openai-compatible";
  const provider = input.provider || getProvider(providerType);
  const attempts: AgentAttempt[] = [];
  const keys = requiredKeys(config.outputFormat);
  const candidates = modelCandidates(input.agentName as ResearchAgentName, policy.maxAttempts);

  for (let index = 0; index < candidates.length; index += 1) {
    const attemptNumber = index + 1;
    const model = candidates[index];
    const fallback = index > 0;
    const currentInput = fallback ? compactFallback(input) : input;
    await input.hooks?.beforeAttempt?.({ attempt: attemptNumber, provider: provider.id, model });
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const deadline = createDeadlineController(input.signal, policy.totalTimeoutMs, policy.inactivityTimeoutMs);
    let pass: PassResult = { rawText: "", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, toolCalls: [] };
    let repairAttempted = false;
    let validationErrors: SchemaValidationError[] = [];

    try {
      const prompt = buildTaskPrompt(currentInput, config);
      pass = await executePass({ provider, model, prompt, agentName: input.agentName, policy, deadline });
      let parsed: unknown;
      try {
        parsed = parseStructuredOutput(pass.rawText, keys);
        validationErrors = validateSchema(parsed, config.outputFormat);
      } catch (error) {
        validationErrors = [{ path: "root", message: error instanceof Error ? error.message : String(error) }];
      }

      if (validationErrors.length && policy.maxRepairAttempts > 0) {
        repairAttempted = true;
        const repairPrompt = [
          "Repair the following response into exactly one JSON object with all required keys.",
          `Validation errors: ${validationErrors.map((error) => `${error.path}: ${error.message}`).join(" | ").slice(0, 4000)}`,
          `Previous response: ${pass.rawText.slice(0, 12_000)}`,
        ].join("\n\n");
        const repair = await executePass({ provider, model, prompt: repairPrompt, agentName: input.agentName, policy, deadline });
        pass = {
          ...repair,
          usage: {
            inputTokens: pass.usage.inputTokens + repair.usage.inputTokens,
            outputTokens: pass.usage.outputTokens + repair.usage.outputTokens,
            costUsd: pass.usage.costUsd + repair.usage.costUsd,
          },
          toolCalls: [...pass.toolCalls, ...repair.toolCalls],
        };
        try {
          parsed = parseStructuredOutput(repair.rawText, keys);
          validationErrors = validateSchema(parsed, config.outputFormat);
        } catch (error) {
          validationErrors = [{ path: "root", message: error instanceof Error ? error.message : String(error) }];
        }
      }
      if (validationErrors.length) {
        throw new ProviderError(`Structured output validation failed: ${validationErrors.map((error) => `${error.path}: ${error.message}`).join(" | ")}`, "schema_validation");
      }

      const completed = Date.now();
      const record: AgentAttempt = {
        attempt: attemptNumber, provider: provider.id, model, requestId: pass.requestId,
        startedAt, completedAt: new Date(completed).toISOString(), latencyMs: completed - started,
        inputTokens: pass.usage.inputTokens, outputTokens: pass.usage.outputTokens,
        costUsd: Number(pass.usage.costUsd.toFixed(6)), status: "success", repairAttempted,
        fallback, compactionOccurred: fallback && input.agentName === "asset-analyst",
        rawResponseExcerpt: redact(pass.rawText.slice(0, 12_000)), validationErrors, toolCalls: pass.toolCalls,
      };
      attempts.push(record);
      await input.hooks?.onAttemptComplete?.(record);
      deadline.cleanup();
      const usage = aggregateUsage(attempts, { provider: provider.id, model, promptVersion: config.promptVersion });
      return { structured: parsed as TStructured, rawText: pass.rawText, attempts, usage, config: config as unknown as Record<string, unknown> };
    } catch (error) {
      if (error instanceof ProviderError && error.details.partial) {
        pass = error.details.partial as PassResult;
      }
      const reason = deadline.reason();
      deadline.cleanup();
      let failure = error;
      if (reason === "caller") failure = new ProviderError("Request cancelled by caller", "cancellation");
      else if (reason === "total" || reason === "inactivity") {
        failure = new ProviderError(`Request ${reason} timeout`, "provider_timeout", { timeoutType: reason });
      }
      const errorCategory = category(failure);
      const completed = Date.now();
      const record: AgentAttempt = {
        attempt: attemptNumber, provider: provider.id, model, requestId: pass.requestId,
        startedAt, completedAt: new Date(completed).toISOString(), latencyMs: completed - started,
        inputTokens: pass.usage.inputTokens, outputTokens: pass.usage.outputTokens,
        costUsd: Number(pass.usage.costUsd.toFixed(6)), status: errorCategory === "cancellation" ? "cancelled" : "failed",
        errorCategory, errorMessage: redact(failure instanceof Error ? failure.message : String(failure)),
        timeoutType: reason === "total" || reason === "inactivity" ? reason : undefined,
        repairAttempted, fallback, compactionOccurred: fallback && input.agentName === "asset-analyst",
        rawResponseExcerpt: redact(pass.rawText.slice(0, 12_000)), validationErrors, toolCalls: pass.toolCalls,
      };
      attempts.push(record);
      await input.hooks?.onAttemptComplete?.(record);
      if (!retryable(errorCategory) || index === candidates.length - 1) {
        const usage = aggregateUsage(attempts, { provider: provider.id, model, promptVersion: config.promptVersion });
        throw new ResearchAgentRunError(
          `Agent attempts exhausted: ${record.errorMessage}`, usage,
          { attempts, error_type: errorCategory, raw_response_excerpt: record.rawResponseExcerpt }, attempts
        );
      }
      const retryAfter = failure instanceof ProviderError ? Number(failure.details.retryAfter) : 0;
      const baseDelay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 30_000)
        : Math.min(250 * 2 ** index, 2_000);
      const delay = Math.min(30_000, Math.max(1, Math.round(baseDelay * (0.9 + Math.random() * 0.2))));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("No model candidates configured");
}
