import { ProviderError, upstreamServerErrorBody, usageLimitBody, type HarnessErrorCategory } from "../errors";
import type { ModelEvent, ModelProvider, ModelRequest, ModelUsage, ProviderHealth, ToolCall } from "../types";
import { calculateCost, oneHourCacheWriteSurcharge } from "../telemetry";
import { anthropicPromptFields, isClaudeModel } from "./anthropic-cache";
import { anthropicWireSchema, isRejectedSchema, rememberRejectedSchema } from "./anthropic-schema";
import { validateEndpointUrl } from "../../net";

export interface AnthropicProviderOptions {
  baseUrl: string;
  apiKey: string;
  allowedHosts: string[];
  headers?: Record<string, string>;
  /** Constrain Claude output to the request's outputSchema with output_config. Only anthropic-direct sets it. */
  structuredOutput?: boolean;
  /** Send the request's effort as output_config.effort with adaptive thinking. Only anthropic-direct sets it. */
  effort?: boolean;
}

/**
 * Claude models that take output_config.effort with adaptive thinking: Opus 4.6+, Sonnet 4.6+, Haiku 5+, Fable and
 * Mythos. Haiku 4.5 and older take a thinking budget instead and reject effort, so they get neither.
 */
export function supportsAdaptiveEffort(model: string): boolean {
  return /^claude-(opus-(4-[6-9]|[5-9])|sonnet-(4-[6-9]|[5-9])|haiku-[5-9]|fable|mythos)/i.test(model);
}

function validateBaseUrl(baseUrl: string, allowedHosts: string[]) {
  try {
    return validateEndpointUrl(baseUrl, "Provider base URL", { allowedHosts }).toString().replace(/\/+$/, "");
  } catch (error) {
    throw new ProviderError((error as Error).message, "invalid_request");
  }
}

function safeBody(value: string) {
  return value.slice(0, 2_000).replace(/((?:bearer|x-api-key)[:\s]+)[^\s"']+/gi, "$1[REDACTED]");
}

const count = (value: unknown): number | undefined => typeof value === "number" ? value : undefined;

/** Anthropic reports uncached, cache-read and cache-write prompt tokens separately; inputTokens is their sum. */
function promptUsage(usage: Record<string, unknown>) {
  const input = count(usage.input_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  if (input === undefined) return {};
  return {
    inputTokens: input + (cacheRead ?? 0) + (cacheWrite ?? 0),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
  };
}

export class AnthropicCompatibleProvider implements ModelProvider {
  readonly id = "direct-anthropic-compatible";
  private readonly baseUrl: string;

  constructor(private readonly options: AnthropicProviderOptions) {
    if (!options.apiKey) throw new ProviderError("Anthropic-compatible provider requires an API key", "invalid_request");
    this.baseUrl = validateBaseUrl(options.baseUrl, options.allowedHosts);
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { "x-api-key": this.options.apiKey, "anthropic-version": "2023-06-01", ...this.options.headers },
        redirect: "error",
      });
      if (!response.ok) return { status: "unhealthy", message: `HTTP ${response.status}` };
      const body = await response.json().catch(() => ({})) as { data?: Array<{ id?: string }> };
      return { status: "healthy", models: (body.data || []).map((item) => item.id || "").filter(Boolean) };
    } catch (error) {
      return { status: "unhealthy", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** output_config.format when the option is on, the model is Claude and the schema is expressible and not rejected. */
  private outputFormat(request: ModelRequest) {
    if (!this.options.structuredOutput || !isClaudeModel(request.model) || !request.outputSchema) return undefined;
    const wire = anthropicWireSchema(request.outputSchema);
    return "schema" in wire && !isRejectedSchema(wire.schema) ? { type: "json_schema" as const, schema: wire.schema } : undefined;
  }

  private async post(body: string, signal: AbortSignal, headers?: Record<string, string>): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.options.apiKey,
          "anthropic-version": "2023-06-01",
          ...this.options.headers,
          ...headers,
        },
        body,
        signal,
        redirect: "error",
      });
    } catch (error) {
      if (signal.aborted) throw new ProviderError("Provider request cancelled", "cancellation");
      throw new ProviderError(`Failed to connect to provider: ${error instanceof Error ? error.message : String(error)}`, "connection");
    }
  }

  async *stream(request: ModelRequest, signal: AbortSignal, options: { headers?: Record<string, string> } = {}): AsyncIterable<ModelEvent> {
    let format = this.outputFormat(request);
    // Effort and adaptive thinking go only to Claude models that accept them, on anthropic-direct. A thinking
    // budget (budget_tokens) is never sent: Claude 5.5 models reject it with a 400.
    const effort = this.options.effort && request.effort && supportsAdaptiveEffort(request.model) ? request.effort : undefined;
    // Cache breakpoints are placed by anthropic-cache.ts.
    const serialize = () => JSON.stringify({
      model: request.model,
      ...anthropicPromptFields(request),
      // Anthropic's messages protocol requires this field even when the
      // shared harness intentionally leaves generation uncapped.
      max_tokens: request.maxTokens || Number(process.env.RESEARCH_ANTHROPIC_PROTOCOL_MAX_TOKENS || 65_536),
      // Current Claude models reject non-default sampling values with a 400.
      ...(/^claude-/i.test(request.model) ? {} : { temperature: request.temperature ?? 0.2 }),
      ...(effort ? { thinking: { type: "adaptive" } } : {}),
      ...(format || effort ? { output_config: { ...(format ? { format } : {}), ...(effort ? { effort } : {}) } } : {}),
      stream: true,
    });
    let body = serialize();
    yield { type: "request.sent", body };
    let response = await this.post(body, signal, options.headers);
    let errorText: string | undefined;
    // A rejected schema is resent once without output_config and not sent again. Checked before the
    // status mapping, whose context-limit test would read a rejection that names maxLength as a context limit.
    if (format && response.status === 400) {
      errorText = await response.text().catch(() => "");
      if (/schema|output_config|too complex/i.test(errorText)) {
        rememberRejectedSchema(format.schema);
        format = undefined;
        errorText = undefined;
        body = serialize();
        yield { type: "request.sent", body };
        response = await this.post(body, signal, options.headers);
      }
    }

    const requestId = response.headers.get("request-id") || response.headers.get("x-request-id") || undefined;
    if (!response.ok) {
      const body = safeBody(errorText ?? await response.text().catch(() => ""));
      let category: HarnessErrorCategory = "unknown";
      if (response.status === 401 || response.status === 403) category = "authentication";
      else if (response.status === 429) category = usageLimitBody(body) ? "quota_exceeded" : "rate_limit";
      else if (response.status === 408 || response.status === 504) category = "provider_timeout";
      else if (upstreamServerErrorBody(body)) category = "server_error";
      else if (response.status === 400 && /context|token|length/i.test(body)) category = "context_limit";
      else if (response.status >= 400 && response.status < 500) category = "invalid_request";
      else if (response.status >= 500) category = "server_error";
      throw new ProviderError(`Provider HTTP ${response.status}: ${body || response.statusText}`, category, {
        status: response.status,
        requestId,
        retryAfter: response.headers.get("retry-after"),
      });
    }
    if (!response.body) throw new ProviderError("Provider returned no response body", "malformed_stream");

    yield { type: "response.started", requestId };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const tools = new Map<number, ToolCall>();
    let buffer = "";
    let terminal = false;
    let finishReason: string | undefined;
    // Usage from message_start; 1-hour cache writes need a cost above the default 5-minute write price.
    let startUsage: ModelUsage = {};
    let oneHourWrites = 0;
    const noteOneHour = (usage: any) => { oneHourWrites = count(usage?.cache_creation?.ephemeral_1h_input_tokens) ?? oneHourWrites; };

    const parseBlock = (block: string): ModelEvent[] => {
      const dataLines = block.split(/\r?\n/).filter((line) => line.startsWith("data:"));
      if (!dataLines.length) {
        if (block.split(/\r?\n/).some((line) => line.trim() && !line.trimStart().startsWith(":"))) {
          throw new ProviderError("Provider emitted an SSE event without data", "malformed_stream");
        }
        return [];
      }
      const data = dataLines.map((line) => line.slice(5).trimStart()).join("\n").trim();
      if (!data) return [];
      let payload: any;
      try { payload = JSON.parse(data); } catch {
        throw new ProviderError("Provider emitted malformed SSE JSON", "malformed_stream", { excerpt: data.slice(0, 300) });
      }
      if (payload.type === "error") {
        const type = String(payload.error?.type || "");
        // Overloaded and api errors are transient; the rest keep their HTTP meaning.
        const category: HarnessErrorCategory = type === "rate_limit_error" ? "rate_limit"
          : type === "authentication_error" || type === "permission_error" ? "authentication"
          : type === "invalid_request_error" ? "invalid_request" : "server_error";
        throw new ProviderError(`Provider stream error${type ? ` (${type})` : ""}: ${safeBody(payload.error?.message || "unknown")}`, category);
      }
      const events: ModelEvent[] = [];
      if (payload.type === "message_start" && payload.message?.usage) {
        startUsage = promptUsage(payload.message.usage);
        noteOneHour(payload.message.usage);
        events.push({ type: "usage", usage: startUsage });
      }
      if (payload.type === "content_block_start" && payload.content_block?.type === "tool_use") {
        tools.set(Number(payload.index || 0), {
          id: payload.content_block.id || `tool_${payload.index || 0}`,
          name: payload.content_block.name || "",
          arguments: payload.content_block.input ? JSON.stringify(payload.content_block.input) : "",
        });
      }
      if (payload.type === "content_block_delta") {
        if (payload.delta?.type === "text_delta" && payload.delta.text) events.push({ type: "text.delta", text: payload.delta.text });
        if (payload.delta?.type === "thinking_delta" && payload.delta.thinking) events.push({ type: "reasoning.delta", text: payload.delta.thinking });
        if (payload.delta?.type === "input_json_delta") {
          const index = Number(payload.index || 0);
          const tool = tools.get(index);
          if (!tool) throw new ProviderError("Tool arguments arrived before tool declaration", "malformed_stream");
          tool.arguments += payload.delta.partial_json || "";
        }
      }
      if (payload.type === "message_delta") {
        if (payload.usage) {
          noteOneHour(payload.usage);
          const usage: ModelUsage = { ...promptUsage(payload.usage), outputTokens: payload.usage.output_tokens };
          if (oneHourWrites) {
            const total = { ...startUsage, ...usage };
            usage.costUsd = Number((calculateCost(request.model, total.inputTokens, total.outputTokens, total)
              + oneHourCacheWriteSurcharge(request.model, oneHourWrites, total.inputTokens)).toFixed(6));
          }
          events.push({ type: "usage", usage });
        }
        if (payload.delta?.stop_reason) {
          finishReason = String(payload.delta.stop_reason);
          terminal = true;
        }
      }
      if (payload.type === "message_stop") terminal = true;
      return events;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          const events = parseBlock(block);
          // Pings and hidden adaptive thinking carry no content but prove the stream is alive.
          if (!events.length && block.trim()) yield { type: "heartbeat" };
          for (const event of events) yield event;
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) for (const event of parseBlock(buffer)) yield event;
      if (!terminal) throw new ProviderError("Provider stream ended without a completion marker", "malformed_stream");
      for (const tool of tools.values()) {
        if (!tool.name) throw new ProviderError("Provider emitted an incomplete tool call", "malformed_stream");
        yield { type: "tool.call", call: tool };
      }
      yield { type: "response.completed", finishReason };
    } catch (error) {
      if (signal.aborted) throw new ProviderError("Provider stream cancelled", "cancellation");
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(`Provider stream failed: ${error instanceof Error ? error.message : String(error)}`, "malformed_stream");
    } finally {
      try { await reader.cancel(); } catch {}
      reader.releaseLock();
    }
  }
}
