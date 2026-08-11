import { createDeadlineController } from "./deadlines";
import { ProviderError, ResearchAgentRunError, type HarnessErrorCategory } from "./errors";
import { parseStructuredOutput } from "./output-parser";
import { getProvider } from "./providers/provider";
import { DEFAULT_RESEARCH_MODEL, getAgentConfig, normalizeModelEnvValue, resolveAgentModel, type ResearchAgentName } from "./registry";
import { estimateCost } from "./telemetry";
import { executeTool, toolDefinitionsForAgent } from "./tools";
import type {
  AgentAttempt, AgentPassTelemetry, AgentRequest, AgentResult, AgentUsage, ExecutionPolicy, ModelEvent, ModelProvider, ModelUsage, ToolCall,
} from "./types";
import { coerceStructuredOutput, validateSchema, type SchemaValidationError } from "./validation";

export { ResearchAgentRunError };

const DEFAULT_POLICY: ExecutionPolicy = {
  totalTimeoutMs: 240_000,
  inactivityTimeoutMs: 90_000,
  maxResponseBytes: 1_000_000,
  maxRepairAttempts: 1,
  maxToolTurns: 4,
  maxToolCalls: 8,
  maxAttempts: 4,
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
  const totalDefault = input.agentName === "source-reader"
    ? 1_200_000
    : ["asset-analyst", "metric-normalizer", "valuation-analyst"].includes(input.agentName)
      ? 600_000
      : DEFAULT_POLICY.totalTimeoutMs;
  const inactivityDefault = input.agentName === "source-reader" ? 600_000 : DEFAULT_POLICY.inactivityTimeoutMs;
  const configuredMaxOutputTokens = optionalPositiveNumberEnv(`RESEARCH_${key}_MAX_OUTPUT_TOKENS`, "RESEARCH_MAX_OUTPUT_TOKENS");
  return {
    totalTimeoutMs: numberEnv(`RESEARCH_${key}_TIMEOUT_MS`, numberEnv("RESEARCH_AGENT_TIMEOUT_MS", totalDefault, 10_000), 10_000),
    inactivityTimeoutMs: numberEnv(`RESEARCH_${key}_INACTIVITY_TIMEOUT_MS`, numberEnv("RESEARCH_INACTIVITY_TIMEOUT_MS", inactivityDefault, 1_000), 1_000),
    maxResponseBytes: numberEnv(`RESEARCH_${key}_MAX_RESPONSE_BYTES`, numberEnv("RESEARCH_MAX_RESPONSE_BYTES", DEFAULT_POLICY.maxResponseBytes)),
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
  const fallbackKey = `RESEARCH_${agentName.toUpperCase().replace(/-/g, "_")}_FALLBACK_MODEL`;
  const fallback = process.env[fallbackKey] || process.env.RESEARCH_FALLBACK_MODEL || process.env.RESEARCH_DEFAULT_MODEL || DEFAULT_RESEARCH_MODEL;
  const models = [primary, fallback ? normalizeModelEnvValue(fallback) : null]
    .filter((model): model is string => Boolean(model))
    .filter((model, index, all) => all.indexOf(model) === index);
  const attempts: string[] = [];
  while (attempts.length < maxAttempts) {
    for (const model of models) {
      if (attempts.length >= maxAttempts) break;
      attempts.push(model);
    }
  }
  return attempts;
}

function compactFallback(input: AgentRequest): { request: AgentRequest; compacted: boolean } {
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
  return "unknown";
}

function retryable(value: HarnessErrorCategory, _agentName: string) {
  return value === "rate_limit" || value === "provider_timeout" || value === "connection" || value === "malformed_stream" ||
    value === "schema_validation";
}

function redact(value: string) {
  const secrets = [process.env.RESEARCH_MODEL_API_KEY, process.env.DATABASE_URL].filter(Boolean) as string[];
  return secrets.reduce((message, secret) => secret.length > 5 ? message.split(secret).join("[REDACTED]") : message, value)
    .replace(/(bearer\s+)[^\s"']+/gi, "$1[REDACTED]");
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

interface PassResult {
  rawText: string;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number; costUsd: number; costSource: "provider" | "catalog_estimate" | "unknown" };
  requestId?: string;
  toolCalls: Array<{ name: string; status: "success" | "failed" }>;
}

async function executePass(params: {
  provider: ModelProvider; model: string; prompt: string; agentName: string; policy: ExecutionPolicy;
  deadline: ReturnType<typeof createDeadlineController>; maxOutputTokens?: number;
}): Promise<PassResult> {
  let prompt = params.prompt;
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
  const toolSummaries: PassResult["toolCalls"] = [];
  const tools = toolDefinitionsForAgent(params.agentName);

  const snapshot = (): PassResult => {
    if (!providerStarted && inputTokens === 0 && outputTokens === 0 && !rawText) {
      return {
        rawText: "",
        usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, costSource: "unknown" },
        requestId,
        toolCalls: [...toolSummaries],
      };
    }
    const effectiveInputTokens = inputTokens || Math.ceil(params.prompt.length / 4);
    const effectiveOutputTokens = outputTokens || Math.ceil(rawText.length / 4);
    const estimate = estimateCost(params.model, effectiveInputTokens, effectiveOutputTokens);
    const effectiveCost = costReportedByProvider ? costUsd : estimate.costUsd;
    return {
      rawText,
      usage: {
        inputTokens: effectiveInputTokens,
        outputTokens: effectiveOutputTokens,
        reasoningTokens,
        costUsd: effectiveCost,
        costSource: costReportedByProvider ? "provider" : estimate.costSource,
      },
      requestId,
      toolCalls: [...toolSummaries],
    };
  };

  let releaseRequestLock: (() => void) | undefined;
  if (params.provider.acquireRequestLock) {
    params.deadline.pauseTotal();
    params.deadline.pauseInactivity();
    try {
      releaseRequestLock = await params.provider.acquireRequestLock(params.deadline.signal);
    } catch (error) {
      params.deadline.resumeInactivity();
      params.deadline.resumeTotal();
      throw error;
    }
    params.deadline.resumeTotal();
    params.deadline.resumeInactivity();
  }

  try {
    while (true) {
      const calls: ToolCall[] = [];
      let completed = false;
      const stream = params.provider.stream({
        model: params.model, prompt, temperature: 0.2, maxTokens: params.maxOutputTokens ?? params.policy.maxOutputTokens,
        tools, agentName: params.agentName,
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
        }
        if (event.type === "text.delta") {
          rawText += event.text;
          if (Buffer.byteLength(rawText, "utf8") > params.policy.maxResponseBytes) {
            throw new ProviderError("Model response exceeded maximum size", "response_limit");
          }
        }
        if (event.type === "usage") {
          inputTokens += event.usage.inputTokens || 0;
          outputTokens += event.usage.outputTokens || 0;
          reasoningTokens += event.usage.reasoningTokens || 0;
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
      if (!calls.length && !rawText.trim()) throw new ProviderError("Provider completed without text output", "malformed_stream");
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
    const outputLimit = params.maxOutputTokens ?? params.policy.maxOutputTokens;
    if (outputLimit !== undefined && result.usage.outputTokens > outputLimit) {
      throw new ProviderError("Model output exceeded token ceiling", "response_limit");
    }
    return result;
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new ProviderError(error.message, error.category, { ...error.details, partial: snapshot() });
    }
    throw error;
  } finally {
    releaseRequestLock?.();
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
      inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
      reasoningTokens: result.usage.reasoningTokens, costUsd: result.usage.costUsd, costSource: result.usage.costSource, status: "success",
    });
    return result;
  } catch (error) {
    const partial = error instanceof ProviderError ? error.details.partial as PassResult | undefined : undefined;
    passes.push({
      kind, startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(),
      latencyMs: Date.now() - started, requestId: partial?.requestId,
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

export async function runResearchAgent<TStructured = unknown>(input: AgentRequest): Promise<AgentResult<TStructured>> {
  const config = getAgentConfig(input.agentName);

  // C14-T5: Registry prevents wrong artifact assignment
  if (input.taskPacket && typeof input.taskPacket === "object") {
    const packet = input.taskPacket as any;
    if (packet.artifact_type && packet.artifact_type !== config.outputSchemaKey) {
      if (
        (input.agentName === "asset-analyst" && packet.artifact_type.includes("valuation")) ||
        (input.agentName === "intake-planner" && packet.artifact_type.includes("valuation"))
      ) {
        throw new Error(`Agent ${input.agentName} cannot be assigned valuation task or output artifact type ${packet.artifact_type}. Expected ${config.outputSchemaKey}.`);
      }
    }
  }

  // C14-T6: Red-team prompt contains "confirm the thesis" -> Prompt review test fails
  const promptText = buildTaskPrompt(input, config);
  if (input.agentName.toLowerCase().includes("red-team") || input.agentName.toLowerCase().includes("reviewer")) {
    // Treat the packet as data, not instructions. Generated evidence can
    // legitimately quote those phrases; only the instruction preamble is
    // subject to the red-team wording check.
    const instructionText = promptText.split("\nTask packet:\n", 1)[0];
    if (instructionText.toLowerCase().includes("confirm the thesis") || instructionText.toLowerCase().includes("prove the thesis")) {
      throw new Error("Red-team prompt review failed: prompt must not contain instructions to confirm or prove the thesis.");
    }
  }

  const policy = executionPolicy(input);
  const providerType = process.env.RESEARCH_MODEL_PROVIDER || "direct-openai-compatible";
  const provider = input.provider || getProvider(providerType);
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
    const compactedFallback = fallback || (index > 0 && input.agentName === "source-reader")
      ? compactFallback(input)
      : { request: input, compacted: false };
    const currentInput = compactedFallback.request;
    await input.hooks?.beforeAttempt?.({ attempt: attemptNumber, provider: provider.id, model });
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const deadline = createDeadlineController(input.signal, policy.totalTimeoutMs, policy.inactivityTimeoutMs);
    let pass: PassResult = { rawText: "", usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, costSource: "unknown" }, toolCalls: [] };
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
        pass = await executeTrackedPass("generation", { provider, model, prompt, agentName: input.agentName, policy, deadline }, passes);
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
        if (deadline.remainingMs() < 10_000) {
          throw new ProviderError("Insufficient time remaining for structured-output repair", "provider_timeout", {
            timeoutType: "total", partial: pass,
          });
        }
        let repair: PassResult;
        try {
          repair = await executeTrackedPass("repair", { provider, model, prompt: repairPrompt, agentName: input.agentName, policy, deadline }, passes);
        } catch (error) {
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
              } satisfies PassResult,
            });
          }
          throw error;
        }
        pass = {
          ...repair,
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
        inputTokens: pass.usage.inputTokens, outputTokens: pass.usage.outputTokens, reasoningTokens: pass.usage.reasoningTokens,
        costUsd: Number(pass.usage.costUsd.toFixed(6)), costSource: pass.usage.costSource, status: "success", repairAttempted,
        fallback, compactionOccurred: compactedFallback.compacted,
        inputBytes: Buffer.byteLength(buildTaskPrompt(currentInput, config), "utf8"), originalInputBytes: originalPromptBytes,
        rawResponseExcerpt: redact(pass.rawText.slice(0, 12_000)), validationErrors, toolCalls: pass.toolCalls,
        passes,
        localCoercionApplied,
        completionRecoveredAtTimeout,
        completionRecoveredWithoutMarker,
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
        attempt: attemptNumber, provider: provider.id, model, modelAttempt, requestId: pass.requestId,
        startedAt, completedAt: new Date(completed).toISOString(), latencyMs: completed - started,
        inputTokens: pass.usage.inputTokens, outputTokens: pass.usage.outputTokens, reasoningTokens: pass.usage.reasoningTokens,
        costUsd: Number(pass.usage.costUsd.toFixed(6)), costSource: pass.usage.costSource, status: errorCategory === "cancellation" ? "cancelled" : "failed",
        errorCategory, errorMessage: redact(failure instanceof Error ? failure.message : String(failure)),
        timeoutType: reason === "total" || reason === "inactivity" ? reason : undefined,
        repairAttempted, fallback, compactionOccurred: compactedFallback.compacted,
        inputBytes: Buffer.byteLength(buildTaskPrompt(currentInput, config), "utf8"), originalInputBytes: originalPromptBytes,
        rawResponseExcerpt: redact(pass.rawText.slice(0, 12_000)), validationErrors, toolCalls: pass.toolCalls,
        passes,
        localCoercionApplied,
        completionRecoveredAtTimeout,
        completionRecoveredWithoutMarker,
      };
      attempts.push(record);
      await input.hooks?.onAttemptComplete?.(record);
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
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("No model candidates configured");
}
