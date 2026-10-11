import {
  deriveCacheAffinityId, observeWireRequest, passCacheTelemetry, promptMessages, stablePrefixHash, wireRequestTracker,
  type PassCacheTelemetry, type WireRequestRecord,
} from "./cache";
import { createDeadlineController } from "./deadlines";
import { ProviderError, ResearchAgentRunError, type HarnessErrorCategory } from "./errors";
import { parseStructuredOutput } from "./output-parser";
import { getProvider } from "./providers/provider";
import { getAgentConfig, normalizeModelEnvValue, resolveAgentModel, type ResearchAgentName } from "./registry";
import { calculateCost } from "./telemetry";
import type {
  AgentAttempt, AgentPassTelemetry, AgentRequest, AgentResult, AgentUsage, ExecutionPolicy, ModelEvent, ModelProvider,
} from "./types";
import { coerceStructuredOutput, validateSchema, type SchemaValidationError } from "./validation";

export { ResearchAgentRunError };

const DEFAULT_OUTPUT_TOKENS = 32_768;

/** Largest output limit an attempt may escalate to after a pass spent its whole limit or was cut off. */
function outputTokenCeiling() {
  return numberEnv("RESEARCH_MAX_OUTPUT_TOKENS_CEILING", 131_072);
}

/** Documented max_tokens caps; a larger request is rejected with a 400. Unknown models are not clamped. */
export function modelOutputCap(model: string): number | undefined {
  if (/^claude-haiku-4-5/i.test(model)) return 64_000;
  if (/^claude-/i.test(model)) return 128_000;
  return undefined;
}

const MAX_RETRY_DELAY_MS = 60_000;

const DEFAULT_POLICY: ExecutionPolicy = {
  totalTimeoutMs: 240_000,
  inactivityTimeoutMs: 90_000,
  maxResponseBytes: 1_000_000,
  maxRepairAttempts: 1,
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
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function executionPolicy(input: AgentRequest): ExecutionPolicy {
  const key = input.agentName.toUpperCase().replace(/-/g, "_");
  const totalDefault = input.agentName === "asset-analyst"
    ? 600_000
    : input.agentName === "source-reader" ? 600_000 : DEFAULT_POLICY.totalTimeoutMs;
  return {
    totalTimeoutMs: numberEnv(`RESEARCH_${key}_TIMEOUT_MS`, numberEnv("RESEARCH_AGENT_TIMEOUT_MS", totalDefault, 10_000), 10_000),
    inactivityTimeoutMs: numberEnv(`RESEARCH_${key}_INACTIVITY_TIMEOUT_MS`, numberEnv("RESEARCH_INACTIVITY_TIMEOUT_MS", DEFAULT_POLICY.inactivityTimeoutMs, 1_000), 1_000),
    maxResponseBytes: numberEnv(`RESEARCH_${key}_MAX_RESPONSE_BYTES`, numberEnv("RESEARCH_MAX_RESPONSE_BYTES", DEFAULT_POLICY.maxResponseBytes)),
    // Zero or unset uses the 32,768 default; a pass that spends it all on reasoning gets a larger limit on retry.
    maxOutputTokens: optionalPositiveNumberEnv(`RESEARCH_${key}_MAX_OUTPUT_TOKENS`, "RESEARCH_MAX_OUTPUT_TOKENS") ?? DEFAULT_OUTPUT_TOKENS,
    maxRepairAttempts: numberEnv("RESEARCH_MAX_REPAIR_ATTEMPTS", DEFAULT_POLICY.maxRepairAttempts, 0),
    maxAttempts: numberEnv("RESEARCH_MAX_MODEL_ATTEMPTS", DEFAULT_POLICY.maxAttempts),
    retryBaseDelayMs: numberEnv("RESEARCH_RETRY_BASE_DELAY_MS", DEFAULT_POLICY.retryBaseDelayMs),
    overloadRetryDelayMs: numberEnv("RESEARCH_OVERLOAD_RETRY_DELAY_MS", 5_000),
    ...input.policy,
  };
}

export function buildTaskPrompt(input: Pick<AgentRequest, "agentName" | "taskPacket" | "prompt" | "promptFactory">, config: ReturnType<typeof getAgentConfig>) {
  if (input.promptFactory) return input.promptFactory(input.taskPacket);
  if (input.prompt) return input.prompt;
  return [
    `Run Research OS agent: ${config.name}`,
    "Use the task packet below as the complete working context.",
    "Return exactly one JSON object matching the requested schema. Do not include Markdown.",
    "Task packet:", JSON.stringify(input.taskPacket),
  ].join("\n\n");
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function requiredKeys(outputFormat: Record<string, unknown> | { requiredKeys?: string[]; schema?: unknown }) {
  if ("requiredKeys" in outputFormat && Array.isArray(outputFormat.requiredKeys)) return outputFormat.requiredKeys;
  const fmt = outputFormat as Record<string, unknown>;
  const schema = fmt.schema as { required?: unknown } | undefined;
  return Array.isArray(schema?.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
}

function modelCandidates(agentName: ResearchAgentName, maxAttempts: number, providerId: string) {
  const primary = resolveAgentModel(agentName);
  const fallbackKey = `RESEARCH_${agentName.toUpperCase().replace(/-/g, "_")}_FALLBACK_MODEL`;
  // Built-in fallbacks are OpenCode Go model IDs; the Anthropic API answers them with a 404.
  const builtIns: Partial<Record<ResearchAgentName, string>> = providerId === "direct-anthropic-compatible" ? {} : {
    "source-reader": "deepseek-v4-pro", "asset-analyst": "qwen3.7-plus", "valuation-analyst": "deepseek-v4-pro",
  };
  const fallback = process.env.RESEARCH_ALL_AGENTS_MODEL ? undefined : process.env[fallbackKey] || builtIns[agentName];
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

function retryable(value: HarnessErrorCategory) {
  return value === "rate_limit" || value === "provider_timeout" || value === "connection" || value === "malformed_stream"
    || value === "output_exhausted" || value === "server_error";
}

/** The pass stopped because it reached its output limit rather than finishing its answer. */
function atOutputLimit(finishReason: string | undefined, outputTokens: number, limit: number | undefined) {
  return /^(length|max_tokens)$/.test(finishReason || "") || (limit !== undefined && outputTokens >= limit);
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

const SECRET_ENV = ["RESEARCH_MODEL_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_GO_API_KEY", "RESEARCH_WEB_SEARCH_API_KEY",
  "RESEARCH_EMBEDDING_API_KEY", "DATABASE_URL"];

/** Removes every configured secret, and bearer tokens, from text bound for logs and traces. */
export function redact(value: string) {
  const secrets = SECRET_ENV.map((name) => process.env[name]).filter(Boolean) as string[];
  return secrets.reduce((message, secret) => secret.length > 5 ? message.split(secret).join("[REDACTED]") : message, value)
    .replace(/(bearer\s+)[^\s"']+/gi, "$1[REDACTED]");
}

interface PassUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
}

interface PassResult {
  rawText: string;
  usage: PassUsage;
  requestId?: string;
  cache?: PassCacheTelemetry;
  finishReason?: string;
}

/** Cache counts stay absent, not zero, when the provider did not report them. */
function cacheTokens(usage?: Partial<PassUsage>): Pick<PassUsage, "cacheReadTokens" | "cacheWriteTokens"> {
  return {
    ...(usage?.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage?.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
  };
}

const addOptional = (left?: number, right?: number) => left === undefined && right === undefined ? undefined : (left || 0) + (right || 0);

function combineUsage(left: PassUsage, right?: Partial<PassUsage>): PassUsage {
  return {
    inputTokens: left.inputTokens + (right?.inputTokens || 0),
    outputTokens: left.outputTokens + (right?.outputTokens || 0),
    reasoningTokens: left.reasoningTokens + (right?.reasoningTokens || 0),
    ...cacheTokens({
      cacheReadTokens: addOptional(left.cacheReadTokens, right?.cacheReadTokens),
      cacheWriteTokens: addOptional(left.cacheWriteTokens, right?.cacheWriteTokens),
    }),
    costUsd: left.costUsd + (right?.costUsd || 0),
  };
}

type StructuredOutputTelemetry = AgentPassTelemetry["structuredOutput"];

async function executePass(params: {
  provider: ModelProvider; model: string; system?: string; prompt: string; cacheablePromptChars?: number; agentName: string; policy: ExecutionPolicy;
  deadline: ReturnType<typeof createDeadlineController>; maxOutputTokens?: number; cacheAffinityId: string; outputSchema?: Record<string, unknown>;
}, structured: StructuredOutputTelemetry): Promise<PassResult> {
  let rawText = "";
  let rawBytes = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let costUsd: number | undefined;
  let providerStarted = false;
  let requestId: string | undefined;
  let finishReason: string | undefined;
  let wire: WireRequestRecord | undefined;
  let lastSentStructured = false;
  const snapshot = (): PassResult => {
    const started = providerStarted || inputTokens > 0 || outputTokens > 0 || Boolean(rawText);
    const input = started ? inputTokens || Math.ceil(((params.system?.length || 0) + params.prompt.length) / 4) : 0;
    const output = started ? outputTokens || Math.ceil(rawText.length / 4) : 0;
    const cache = cacheTokens({ cacheReadTokens, cacheWriteTokens });
    return { rawText, requestId, finishReason, usage: {
      inputTokens: input, outputTokens: output, reasoningTokens, ...cache,
      costUsd: costUsd ?? calculateCost(params.model, input, output, cache),
    }, ...(wire ? { cache: passCacheTelemetry(wire, cacheReadTokens) } : {}) };
  };
  const iterator = params.provider.stream({
    model: params.model, ...(params.system ? { system: params.system } : {}), prompt: params.prompt,
    ...(params.cacheablePromptChars === undefined ? {} : { cacheablePromptChars: params.cacheablePromptChars }), temperature: 0.2,
    maxTokens: params.maxOutputTokens ?? params.policy.maxOutputTokens, agentName: params.agentName,
    cacheAffinityId: params.cacheAffinityId, ...(params.outputSchema ? { outputSchema: params.outputSchema } : {}),
  }, params.deadline.signal)[Symbol.asyncIterator]();
  try {
    let completed = false;
    while (true) {
      if (params.deadline.remainingMs() <= 0) {
        throw new ProviderError("Provider request exceeded total deadline", "provider_timeout", { timeoutType: "total" });
      }
      const next = iterator.next();
      let abortHandler: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        abortHandler = () => reject(new ProviderError("Provider request cancelled", "cancellation"));
        if (params.deadline.signal.aborted) abortHandler();
        else params.deadline.signal.addEventListener("abort", abortHandler, { once: true });
      });
      let item: IteratorResult<ModelEvent>;
      try { item = await Promise.race([next, aborted]); }
      finally { if (abortHandler) params.deadline.signal.removeEventListener("abort", abortHandler); }
      if (item.done) break;
      if (params.deadline.remainingMs() <= 0) {
        throw new ProviderError("Provider request exceeded total deadline", "provider_timeout", { timeoutType: "total" });
      }
      const event = item.value;
      params.deadline.resetInactivity();
      switch (event.type) {
        case "request.sent":
          try {
            const observation = observeWireRequest(event.body, { providerId: params.provider.id, modelId: params.model, affinityId: params.cacheAffinityId });
            wire = wireRequestTracker.record(params.cacheAffinityId, event.body, observation);
          } catch {
            // Cache telemetry never fails a model request.
          }
          try {
            const sentStructured = "output_config" in JSON.parse(event.body);
            if (sentStructured) structured.sent = true;
            else if (lastSentStructured) structured.fallback = true;
            lastSentStructured = sentStructured;
          } catch {
            // Neither does structured-output telemetry.
          }
          break;
        case "response.started": providerStarted = true; requestId = event.requestId || requestId; break;
        case "text.delta": {
          const text = event.text.replace(/\u0000/g, "");
          rawText += text;
          // Count each delta once; measuring the whole response on every delta copies it each time.
          rawBytes += Buffer.byteLength(text, "utf8");
          if (rawBytes > params.policy.maxResponseBytes) {
            throw new ProviderError("Model response exceeded maximum size", "response_limit");
          }
          break;
        }
        case "usage":
          inputTokens = event.usage.inputTokens ?? inputTokens;
          outputTokens = event.usage.outputTokens ?? outputTokens;
          reasoningTokens = event.usage.reasoningTokens ?? reasoningTokens;
          cacheReadTokens = event.usage.cacheReadTokens ?? cacheReadTokens;
          cacheWriteTokens = event.usage.cacheWriteTokens ?? cacheWriteTokens;
          costUsd = event.usage.costUsd ?? costUsd;
          break;
        case "tool.call": throw new ProviderError("Research model calls do not permit tools", "invalid_request");
        case "response.failed": throw event.error;
        case "response.completed": completed = true; finishReason = event.finishReason || finishReason; break;
      }
    }
    if (!completed) throw new ProviderError("Provider did not emit completion", "malformed_stream");
    const outputLimit = params.maxOutputTokens ?? params.policy.maxOutputTokens;
    if (!rawText.trim()) {
      if (atOutputLimit(finishReason, outputTokens, outputLimit)) {
        throw new ProviderError(`The model used its whole output limit (${outputLimit ?? outputTokens} tokens${reasoningTokens ? `, ${reasoningTokens} of them reasoning` : ""}) before writing an answer`,
          "output_exhausted", { outputLimit });
      }
      throw new ProviderError("Provider completed without text output", "malformed_stream");
    }
    const result = snapshot();
    if (outputLimit !== undefined && result.usage.outputTokens > outputLimit) {
      throw new ProviderError("Model output exceeded token ceiling", "response_limit");
    }
    return result;
  } catch (error) {
    void iterator.return?.().catch(() => undefined);
    if (error instanceof ProviderError) throw new ProviderError(error.message, error.category, { ...error.details, partial: snapshot() });
    throw error;
  } finally {
    if (wire) wireRequestTracker.complete(params.cacheAffinityId, wire.observation.wireRequestHash);
  }
}

function cacheFields(pass?: PassResult): Pick<AgentPassTelemetry, "cacheReadTokens" | "cacheWriteTokens" | "cache"> {
  return { ...cacheTokens(pass?.usage), ...(pass?.cache ? { cache: pass.cache } : {}) };
}

async function executeTrackedPass(
  kind: AgentPassTelemetry["kind"],
  params: Parameters<typeof executePass>[0],
  passes: AgentPassTelemetry[]
) {
  const started = Date.now();
  const structuredOutput: StructuredOutputTelemetry = { sent: false, fallback: false };
  try {
    const result = await executePass(params, structuredOutput);
    passes.push({
      kind, startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(),
      latencyMs: Date.now() - started, requestId: result.requestId,
      inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
      reasoningTokens: result.usage.reasoningTokens, ...cacheFields(result), costUsd: result.usage.costUsd, status: "success",
      structuredOutput,
    });
    return result;
  } catch (error) {
    const partial = error instanceof ProviderError ? error.details.partial as PassResult | undefined : undefined;
    passes.push({
      kind, startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(),
      latencyMs: Date.now() - started, requestId: partial?.requestId,
      inputTokens: partial?.usage.inputTokens || 0, outputTokens: partial?.usage.outputTokens || 0,
      reasoningTokens: partial?.usage.reasoningTokens || 0, ...cacheFields(partial), costUsd: partial?.usage.costUsd || 0,
      status: "failed", errorCategory: category(error),
      errorMessage: redact(error instanceof Error ? error.message : String(error)), structuredOutput,
    });
    throw error;
  }
}

function optionalTotal(key: "cacheReadTokens" | "cacheWriteTokens", attempts: AgentAttempt[]) {
  const reported = attempts.filter((attempt) => attempt[key] !== undefined);
  return reported.length ? { [key]: reported.reduce((sum, attempt) => sum + attempt[key]!, 0) } : {};
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
    ...optionalTotal("cacheReadTokens", attempts),
    ...optionalTotal("cacheWriteTokens", attempts),
    costUsd: Number(attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0).toFixed(6)),
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
    if (promptText.toLowerCase().includes("confirm the thesis") || promptText.toLowerCase().includes("prove the thesis")) {
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
  // Sent unchanged on generation and repair; only anthropic-direct turns it into output_config.
  const outputSchema = isPlainObject(effectiveOutputFormat.schema) ? effectiveOutputFormat.schema : undefined;
  const candidates = modelCandidates(input.agentName as ResearchAgentName, policy.maxAttempts, provider.id);
  const primaryModel = candidates[0];
  const originalPromptBytes = Buffer.byteLength(buildTaskPrompt(input, config), "utf8");
  const cacheScope = input.cacheScope || `agent:${input.agentName}`;
  let outputLimit = policy.maxOutputTokens;

  for (let index = 0; index < candidates.length; index += 1) {
    const attemptNumber = index + 1;
    const model = candidates[index];
    const fallback = model !== primaryModel;
    const modelAttempt = candidates.slice(0, index + 1).filter((candidate) => candidate === model).length;
    const compactedFallback = fallback ? compactFallback(input) : { request: input, compacted: false };
    const cap = modelOutputCap(model);
    const attemptOutputLimit = outputLimit !== undefined && cap !== undefined ? Math.min(outputLimit, cap) : outputLimit;
    const currentInput = compactedFallback.request;
    await input.hooks?.beforeAttempt?.({ attempt: attemptNumber, provider: provider.id, model });
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const deadline = createDeadlineController(input.signal, policy.totalTimeoutMs, policy.inactivityTimeoutMs);
    let pass: PassResult = { rawText: "", usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 } };
    let repairAttempted = false;
    let validationErrors: SchemaValidationError[] = [];
    const passes: AgentPassTelemetry[] = [];
    let localCoercionApplied = false;
    let completionRecoveredAtTimeout = false;
    let generationWasMalformed = false;
    let success: { record: AgentAttempt; parsed: unknown; rawText: string } | undefined;

    try {
      // Stable instructions travel as the system message; generation and repair share it and one affinity key.
      const messages = promptMessages(buildTaskPrompt(currentInput, config));
      const cacheAffinityId = deriveCacheAffinityId({
        scopeId: cacheScope, providerId: provider.id, modelId: model, stablePrefixHash: stablePrefixHash(messages.system),
      });
      const passParams = { provider, model, system: messages.system, agentName: input.agentName, policy, deadline, cacheAffinityId, maxOutputTokens: attemptOutputLimit, outputSchema };
      try {
        pass = await executeTrackedPass("generation", { ...passParams, prompt: messages.prompt }, passes);
      } catch (error) {
        const timeoutReason = deadline.reason();
        const partial = error instanceof ProviderError ? error.details.partial as PassResult | undefined : undefined;
        if ((timeoutReason === "total" || timeoutReason === "inactivity") && partial?.rawText.trim()) {
          try {
            let candidate = parseStructuredOutput(partial.rawText, keys);
            let candidateErrors = validateSchema(candidate, effectiveOutputFormat);
            if (candidateErrors.length) {
              const coerced = coerceStructuredOutput(candidate, effectiveOutputFormat);
              if (coerced.changed) {
                const coercedErrors = validateSchema(coerced.value, effectiveOutputFormat);
                if (coercedErrors.length < candidateErrors.length) {
                  candidate = coerced.value;
                  candidateErrors = coercedErrors;
                }
              }
            }
            if (candidateErrors.length) throw new Error("Timed-out response did not satisfy the output schema");
            pass = partial;
            completionRecoveredAtTimeout = true;
            const generationPass = passes.at(-1);
            if (generationPass?.kind === "generation") generationPass.completionRecoveredAtTimeout = true;
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
        validationErrors = validateSchema(parsed, effectiveOutputFormat);
        if (validationErrors.length) {
          const coerced = coerceStructuredOutput(parsed, effectiveOutputFormat);
          if (coerced.changed) {
            const coercedErrors = validateSchema(coerced.value, effectiveOutputFormat);
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
      // A reply cut off at its output limit cannot be repaired within the same limit; regenerate with a larger one.
      if (generationWasMalformed && atOutputLimit(pass.finishReason, pass.usage.outputTokens, attemptOutputLimit)) {
        throw new ProviderError(`The response was cut off at the output limit (${attemptOutputLimit ?? pass.usage.outputTokens} tokens)`,
          "output_exhausted", { outputLimit: attemptOutputLimit, partial: pass });
      }

      if (validationErrors.length && policy.maxRepairAttempts > 0) {
        repairAttempted = true;
        const repairInstructions = [
          `REPAIR TASK: ${input.title}`,
          "",
          "The previous model output failed schema validation. Repair it into exactly one JSON object.",
          `Required top-level keys: ${keys.join(", ")}`,
          `Validation errors: ${validationErrors.map((error) => `${error.path}: ${error.message}`).join(" | ").slice(0, 4000)}`,
          "",
          ...(input.outputFormat ? [] : ["Original submitted task and evidence:", JSON.stringify({ title: input.title, agentName: input.agentName,
            output_contract: (input.taskPacket as any).output_contract, providedKeys: Object.keys(input.taskPacket).slice(0, 20) })]),
          "Required output schema:",
          JSON.stringify(effectiveOutputFormat.schema || effectiveOutputFormat),
          "",
          `Previous response: ${input.outputFormat ? pass.rawText : pass.rawText.slice(0, 12_000)}`,
        ].join("\n\n");
        // A full-task repair repeats the generation request and appends the repair, so the
        // provider can serve the repeated task and evidence from its cache.
        const repairPrompt = input.outputFormat ? `${messages.prompt}\n\n${repairInstructions}` : repairInstructions;
        if (deadline.remainingMs() < 10_000) {
          throw new ProviderError("Insufficient time remaining for structured-output repair", "provider_timeout", {
            timeoutType: "total", partial: pass,
          });
        }
        let repair: PassResult;
        try {
          repair = await executeTrackedPass("repair", { ...passParams, prompt: repairPrompt,
            ...(input.outputFormat ? { cacheablePromptChars: messages.prompt.length } : {}) }, passes);
        } catch (error) {
          if (error instanceof ProviderError) {
            const repairPartial = error.details.partial as PassResult | undefined;
            throw new ProviderError(error.message, error.category, {
              ...error.details,
              partial: {
                rawText: repairPartial?.rawText || pass.rawText,
                requestId: repairPartial?.requestId || pass.requestId,
                usage: combineUsage(pass.usage, repairPartial?.usage),
              } satisfies PassResult,
            });
          }
          throw error;
        }
        pass = {
          ...repair,
          usage: combineUsage(pass.usage, repair.usage),
        };
        try {
          parsed = parseStructuredOutput(repair.rawText, keys);
          validationErrors = validateSchema(parsed, effectiveOutputFormat);
          if (validationErrors.length) {
            const coerced = coerceStructuredOutput(parsed, effectiveOutputFormat);
            if (coerced.changed) {
              const coercedErrors = validateSchema(coerced.value, effectiveOutputFormat);
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
          if (atOutputLimit(repair.finishReason, repair.usage.outputTokens, attemptOutputLimit)) {
            throw new ProviderError(`The repair was cut off at the output limit (${attemptOutputLimit ?? repair.usage.outputTokens} tokens)`,
              "output_exhausted", { outputLimit: attemptOutputLimit, partial: pass });
          }
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
        ...cacheTokens(pass.usage), maxOutputTokens: passParams.maxOutputTokens,
        costUsd: Number(pass.usage.costUsd.toFixed(6)), status: "success", repairAttempted,
        fallback, compactionOccurred: compactedFallback.compacted,
        inputBytes: Buffer.byteLength(buildTaskPrompt(currentInput, config), "utf8"), originalInputBytes: originalPromptBytes,
        rawResponseExcerpt: redact(pass.rawText.slice(0, 12_000)), validationErrors,
        passes,
        localCoercionApplied,
        completionRecoveredAtTimeout,
      };
      attempts.push(record);
      deadline.cleanup();
      success = { record, parsed, rawText: pass.rawText };
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
        ...cacheTokens(pass.usage), maxOutputTokens: attemptOutputLimit,
        costUsd: Number(pass.usage.costUsd.toFixed(6)), status: errorCategory === "cancellation" ? "cancelled" : "failed",
        errorCategory, errorMessage: redact(failure instanceof Error ? failure.message : String(failure)),
        timeoutType: reason === "total" || reason === "inactivity" ? reason : undefined,
        repairAttempted, fallback, compactionOccurred: compactedFallback.compacted,
        inputBytes: Buffer.byteLength(buildTaskPrompt(currentInput, config), "utf8"), originalInputBytes: originalPromptBytes,
        rawResponseExcerpt: redact(pass.rawText.slice(0, 12_000)), validationErrors,
        passes,
        localCoercionApplied,
        completionRecoveredAtTimeout,
      };
      attempts.push(record);
      await input.hooks?.onAttemptComplete?.(record);
      // A pass that spent its whole limit, or was cut off by it, gets twice the limit next time, up to the ceiling.
      if (errorCategory === "output_exhausted" && attemptOutputLimit !== undefined) {
        outputLimit = Math.min(attemptOutputLimit * 2, Math.max(attemptOutputLimit, outputTokenCeiling()));
      }
      const exhausted = (kind: HarnessErrorCategory, message: string) => new ResearchAgentRunError(
        `Agent attempts exhausted: ${message}`, aggregateUsage(attempts, { provider: provider.id, model, promptVersion: config.promptVersion }),
        { attempts, error_type: kind, raw_response_excerpt: record.rawResponseExcerpt }, attempts
      );
      if (!retryable(errorCategory) || index === candidates.length - 1) throw exhausted(errorCategory, record.errorMessage || "");
      // Overload, 5xx and rate limits wait longer than a dropped connection; a retry-after is honoured as sent.
      const retryAfter = failure instanceof ProviderError ? Number(failure.details.retryAfter) : 0;
      const overloaded = errorCategory === "server_error" || errorCategory === "rate_limit";
      const baseDelay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.max(policy.retryBaseDelayMs, overloaded ? policy.overloadRetryDelayMs ?? 0 : 0) * 2 ** index;
      const delay = Math.min(MAX_RETRY_DELAY_MS, Math.max(1, Math.round(baseDelay * (0.9 + Math.random() * 0.2))));
      await sleep(delay, input.signal);
      if (input.signal?.aborted) throw exhausted("cancellation", "Request cancelled by caller");
      continue;
    }
    // A ledger hook failure must not turn a successful paid call into a failed attempt that is paid for again.
    await input.hooks?.onAttemptComplete?.(success.record);
    const usage = aggregateUsage(attempts, { provider: provider.id, model, promptVersion: config.promptVersion });
    return { structured: success.parsed as TStructured, rawText: success.rawText, attempts, usage, config: config as unknown as Record<string, unknown> };
  }
  throw new Error("No model candidates configured");
}
