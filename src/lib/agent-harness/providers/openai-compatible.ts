import type { ModelEvent, ModelProvider, ModelRequest, ProviderHealth, ToolCall } from "../types";
import { ProviderError, usageLimitBody, type HarnessErrorCategory } from "../errors";

type ProviderMode = "direct" | "local";

export interface ProviderOptions {
  mode: ProviderMode;
  baseUrl: string;
  apiKey?: string;
  allowedHosts?: string[];
  headers?: Record<string, string>;
}

function privateOrLoopback(host: string) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" ||
    /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

function safeErrorBody(value: string) {
  return value.slice(0, 2000).replace(/(bearer\s+)[^\s"']+/gi, "$1[REDACTED]");
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: ProviderOptions) {
    this.id = options.mode === "local" ? "local-openai-compatible" : "direct-openai-compatible";
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey || "";
    this.extraHeaders = options.headers || {};
    const url = this.validateUrl(options);
    if (options.mode === "direct" && !this.apiKey) {
      throw new ProviderError("Direct provider requires RESEARCH_MODEL_API_KEY", "invalid_request");
    }
    if (options.mode === "direct" && url.protocol !== "https:") {
      throw new ProviderError("Direct provider must use HTTPS", "invalid_request");
    }
  }

  private validateUrl(options: ProviderOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new ProviderError("Invalid provider base URL", "invalid_request");
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new ProviderError("Provider URL must use HTTP or HTTPS", "invalid_request");
    }
    if (url.username || url.password) {
      throw new ProviderError("Provider URL must not contain credentials", "invalid_request");
    }
    if (options.mode === "local") {
      if (!privateOrLoopback(url.hostname)) {
        throw new ProviderError("Local provider must use a loopback or private host", "invalid_request");
      }
    } else {
      const allowed = (options.allowedHosts || []).map((host) => host.toLowerCase()).filter(Boolean);
      if (!allowed.length || !allowed.includes(url.hostname.toLowerCase())) {
        throw new ProviderError(`Direct provider host is not allowlisted: ${url.hostname}`, "invalid_request");
      }
      if (privateOrLoopback(url.hostname)) {
        throw new ProviderError("Direct provider cannot target a private host", "invalid_request");
      }
    }
    return url;
  }

  private headers() {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...this.extraHeaders };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, { headers: this.headers(), redirect: "error" });
      if (!response.ok) return { status: "unhealthy", message: `HTTP ${response.status}` };
      const body = await response.json().catch(() => ({})) as { data?: Array<{ id?: string }> };
      return { status: "healthy", models: (body.data || []).map((item) => item.id || "").filter(Boolean) };
    } catch (error) {
      return { status: "unhealthy", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async *stream(request: ModelRequest, signal: AbortSignal, options: { headers?: Record<string, string> } = {}): AsyncIterable<ModelEvent> {
    const body = JSON.stringify({
      model: request.model,
      messages: [
        ...(request.system ? [{ role: "system", content: request.system }] : []),
        { role: "user", content: request.prompt },
      ],
      stream: true,
      stream_options: { include_usage: true },
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    });
    yield { type: "request.sent", body };
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...this.headers(), ...options.headers },
        body,
        signal,
        redirect: "error",
      });
    } catch (error) {
      if (signal.aborted) throw new ProviderError("Provider request cancelled", "cancellation");
      throw new ProviderError(`Failed to connect to provider: ${error instanceof Error ? error.message : String(error)}`, "connection");
    }

    const requestId = response.headers.get("x-request-id") || response.headers.get("request-id") || undefined;
    if (!response.ok) {
      const raw = safeErrorBody(await response.text().catch(() => ""));
      const status = response.status;
      let category: HarnessErrorCategory = "unknown";
      if (status === 401 || status === 403) category = "authentication";
      else if (status === 429) category = usageLimitBody(raw) ? "quota_exceeded" : "rate_limit";
      else if (status === 408 || status === 504) category = "provider_timeout";
      else if (status === 400 && /context|token|length/i.test(raw)) category = "context_limit";
      else if (status >= 400 && status < 500) category = "invalid_request";
      else if (status >= 500) category = "server_error";
      const retryAfter = response.headers.get("retry-after");
      throw new ProviderError(`Provider HTTP ${status}: ${raw || response.statusText}`, category, {
        status, requestId, retryAfter,
      });
    }
    if (!response.body) throw new ProviderError("Provider returned no response body", "malformed_stream");

    yield { type: "response.started", requestId };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolFragments = new Map<number, ToolCall>();
    let buffer = "";
    let terminal = false;
    let finishReason: string | undefined;

    const parseBlock = (block: string): ModelEvent[] => {
      const dataLines = block.split(/\r?\n/).filter((line) => line.startsWith("data:"));
      if (!dataLines.length) {
        const nonHeartbeat = block.split(/\r?\n/).some((line) => line.trim() && !line.trimStart().startsWith(":"));
        if (nonHeartbeat) throw new ProviderError("Provider emitted an SSE event without data", "malformed_stream");
        return [];
      }
      const data = dataLines.map((line) => line.slice(5).trimStart()).join("\n").trim();
      if (!data || data.startsWith(":")) return [];
      if (data === "[DONE]") {
        terminal = true;
        return [];
      }
      let payload: any;
      try {
        payload = JSON.parse(data);
      } catch {
        throw new ProviderError("Provider emitted malformed SSE JSON", "malformed_stream", { excerpt: data.slice(0, 300) });
      }
      const events: ModelEvent[] = [];
      const choice = payload.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
        events.push({ type: "reasoning.delta", text: delta.reasoning_content });
      }
      if (typeof delta?.content === "string" && delta.content) {
        events.push({ type: "text.delta", text: delta.content });
      }
      for (const fragment of delta?.tool_calls || []) {
        const index = Number(fragment.index || 0);
        const current = toolFragments.get(index) || { id: fragment.id || `tool_${index}`, name: "", arguments: "" };
        if (fragment.id) current.id = fragment.id;
        if (fragment.function?.name) current.name += fragment.function.name;
        if (fragment.function?.arguments) current.arguments += fragment.function.arguments;
        toolFragments.set(index, current);
      }
      if (payload.usage) {
        // OpenAI reports cached_tokens; DeepSeek reports prompt_cache_hit_tokens. Both are part of prompt_tokens.
        const details = payload.usage.prompt_tokens_details;
        const cacheRead = details?.cached_tokens ?? payload.usage.prompt_cache_hit_tokens;
        const cacheWrite = details?.cache_write_tokens;
        events.push({ type: "usage", usage: {
          inputTokens: payload.usage.prompt_tokens,
          outputTokens: payload.usage.completion_tokens,
          reasoningTokens: payload.usage.completion_tokens_details?.reasoning_tokens,
          ...(typeof cacheRead === "number" ? { cacheReadTokens: cacheRead } : {}),
          ...(typeof cacheWrite === "number" ? { cacheWriteTokens: cacheWrite } : {}),
        } });
      }
      if (choice?.finish_reason) {
        terminal = true;
        finishReason = String(choice.finish_reason);
      }
      return events;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) for (const event of parseBlock(block)) yield event;
      }
      buffer += decoder.decode();
      if (buffer.trim()) for (const event of parseBlock(buffer)) yield event;
      if (!terminal) throw new ProviderError("Provider stream ended without a completion marker", "malformed_stream");
      for (const call of [...toolFragments.values()]) {
        if (!call.name) throw new ProviderError("Provider emitted an incomplete tool call", "malformed_stream");
        yield { type: "tool.call", call };
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
