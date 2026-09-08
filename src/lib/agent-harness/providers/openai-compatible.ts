import type { ModelEvent, ModelProvider, ModelRequest, ProviderHealth, ToolCall } from "../types";
import { ProviderError, redactHarnessText, type HarnessErrorCategory } from "../errors";
import { toOpenAIChatMessages } from "../messages";
import { isPrivateOrLocalHost } from "../network";
import { acquireProviderRequestLock } from "./request-lock";

type ProviderMode = "direct" | "local";

export interface ProviderOptions {
  mode: ProviderMode;
  baseUrl: string;
  apiKey?: string;
  allowedHosts?: string[];
  clientName?: string;
  sessionHeader?: string;
}

function safeErrorBody(value: string, apiKey: string) {
  const withoutKey = apiKey.length > 5 ? value.split(apiKey).join("[REDACTED]") : value;
  return redactHarnessText(withoutKey, 2_000);
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly endpointKey: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly clientName?: string;
  private readonly sessionHeader?: string;

  constructor(options: ProviderOptions) {
    this.id = options.mode === "local" ? "local-openai-compatible" : "direct-openai-compatible";
    this.apiKey = options.apiKey || "";
    this.clientName = options.clientName;
    this.sessionHeader = options.sessionHeader;
    const url = this.validateUrl(options);
    this.baseUrl = url.toString().replace(/\/+$/, "");
    this.endpointKey = this.baseUrl;
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
    if (url.search || url.hash) {
      throw new ProviderError("Provider base URL must not contain a query or fragment", "invalid_request");
    }
    if (options.mode === "local") {
      if (!isPrivateOrLocalHost(url.hostname)) {
        throw new ProviderError("Local provider must use a loopback or private host", "invalid_request");
      }
    } else {
      const allowed = (options.allowedHosts || []).map((host) => host.toLowerCase()).filter(Boolean);
      if (!allowed.length || !allowed.includes(url.hostname.toLowerCase())) {
        throw new ProviderError(`Direct provider host is not allowlisted: ${url.hostname}`, "invalid_request");
      }
      if (isPrivateOrLocalHost(url.hostname)) {
        throw new ProviderError("Direct provider cannot target a private host", "invalid_request");
      }
    }
    return url;
  }

  private headers(request?: ModelRequest) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (this.clientName) headers["User-Agent"] = this.clientName;
    if (this.sessionHeader && request?.sessionId) headers[this.sessionHeader] = request.sessionId;
    return headers;
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(),
        redirect: "error",
        signal: AbortSignal.timeout(Number(process.env.RESEARCH_PROVIDER_HEALTH_TIMEOUT_MS || 10_000)),
      });
      if (!response.ok) return { status: "unhealthy", message: `HTTP ${response.status}` };
      const body = await response.json().catch(() => ({})) as { data?: Array<{ id?: string }> };
      return { status: "healthy", models: (body.data || []).map((item) => item.id || "").filter(Boolean) };
    } catch (error) {
      return { status: "unhealthy", message: error instanceof Error ? error.message : String(error) };
    }
  }

  acquireRequestLock(signal?: AbortSignal) {
    return acquireProviderRequestLock(this.baseUrl, signal);
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const streamBufferLimit = request.maxResponseBytes || 1_000_000;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(request),
        body: JSON.stringify({
          model: request.model,
          messages: request.messages?.length
            ? toOpenAIChatMessages(request.messages)
            : [{ role: "user", content: request.prompt }],
          stream: true,
          stream_options: { include_usage: true },
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
          ...(request.tools?.length ? { tools: request.tools } : {}),
        }),
        signal,
        redirect: "error",
      });
    } catch (error) {
      if (signal.aborted) throw new ProviderError("Provider request cancelled", "cancellation");
      throw new ProviderError(`Failed to connect to provider: ${error instanceof Error ? error.message : String(error)}`, "connection");
    }

    const requestId = response.headers.get("x-request-id") || response.headers.get("request-id") || undefined;
    let streamedRequestId = requestId;
    if (!response.ok) {
      const raw = safeErrorBody(await response.text().catch(() => ""), this.apiKey);
      const status = response.status;
      let category: HarnessErrorCategory = "unknown";
      if (status === 401 || status === 403) category = "authentication";
      else if (status === 429) category = "rate_limit";
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
      if (!streamedRequestId && typeof payload.id === "string" && payload.id) {
        streamedRequestId = payload.id;
        events.push({ type: "response.started", requestId: payload.id });
      }
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
        if (Buffer.byteLength(current.name, "utf8") + Buffer.byteLength(current.arguments, "utf8") > streamBufferLimit) {
          throw new ProviderError("Provider tool call exceeded maximum size", "response_limit");
        }
        toolFragments.set(index, current);
      }
      if (payload.usage) {
        events.push({ type: "usage", usage: {
          inputTokens: payload.usage.prompt_tokens,
          outputTokens: payload.usage.completion_tokens,
          reasoningTokens: payload.usage.completion_tokens_details?.reasoning_tokens,
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
        if (Buffer.byteLength(buffer, "utf8") > streamBufferLimit) {
          throw new ProviderError("Provider SSE event exceeded maximum size", "response_limit");
        }
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
