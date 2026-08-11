import { ProviderError, redactHarnessText, type HarnessErrorCategory } from "../errors";
import { toAnthropicMessages } from "../messages";
import { isPrivateOrLocalHost } from "../network";
import type { ModelEvent, ModelProvider, ModelRequest, ToolCall } from "../types";
import { acquireProviderRequestLock } from "./request-lock";

export interface AnthropicProviderOptions {
  baseUrl: string;
  apiKey: string;
  allowedHosts: string[];
}

function validateBaseUrl(baseUrl: string, allowedHosts: string[]) {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new ProviderError("Invalid provider base URL", "invalid_request"); }
  if (url.protocol !== "https:") throw new ProviderError("Direct provider must use HTTPS", "invalid_request");
  if (url.username || url.password) throw new ProviderError("Provider URL must not contain credentials", "invalid_request");
  if (url.search || url.hash) throw new ProviderError("Provider base URL must not contain a query or fragment", "invalid_request");
  if (!allowedHosts.map((host) => host.toLowerCase()).includes(url.hostname.toLowerCase())) {
    throw new ProviderError(`Direct provider host is not allowlisted: ${url.hostname}`, "invalid_request");
  }
  if (isPrivateOrLocalHost(url.hostname)) throw new ProviderError("Direct provider cannot target a private host", "invalid_request");
  return url.toString().replace(/\/+$/, "");
}

function safeBody(value: string, apiKey = "") {
  const withoutKey = apiKey.length > 5 ? value.split(apiKey).join("[REDACTED]") : value;
  return redactHarnessText(withoutKey, 2_000);
}

export class AnthropicCompatibleProvider implements ModelProvider {
  readonly id = "direct-anthropic-compatible";
  private readonly baseUrl: string;

  constructor(private readonly options: AnthropicProviderOptions) {
    if (!options.apiKey) throw new ProviderError("Anthropic-compatible provider requires an API key", "invalid_request");
    this.baseUrl = validateBaseUrl(options.baseUrl, options.allowedHosts);
  }

  acquireRequestLock(signal?: AbortSignal) {
    return acquireProviderRequestLock(this.baseUrl, signal);
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const streamBufferLimit = request.maxResponseBytes || 1_000_000;
    let response: Response;
    try {
      const lowered = request.messages?.length
        ? toAnthropicMessages(request.messages)
        : { system: undefined, messages: [{ role: "user" as const, content: [{ type: "text", text: request.prompt }] }] };
      response = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: request.model,
          messages: lowered.messages,
          ...(lowered.system ? { system: lowered.system } : {}),
          // Anthropic's messages protocol requires this field even when the
          // shared harness intentionally leaves generation uncapped.
          max_tokens: request.maxTokens || Number(process.env.RESEARCH_ANTHROPIC_PROTOCOL_MAX_TOKENS || 65_536),
          temperature: request.temperature ?? 0.2,
          stream: true,
          ...(request.tools?.length ? {
            tools: request.tools.map((tool: any) => ({
              name: tool.function?.name,
              description: tool.function?.description,
              input_schema: tool.function?.parameters,
            })),
          } : {}),
        }),
        signal,
        redirect: "error",
      });
    } catch (error) {
      if (signal.aborted) throw new ProviderError("Provider request cancelled", "cancellation");
      throw new ProviderError(`Failed to connect to provider: ${error instanceof Error ? error.message : String(error)}`, "connection");
    }

    const requestId = response.headers.get("request-id") || response.headers.get("x-request-id") || undefined;
    if (!response.ok) {
      const body = safeBody(await response.text().catch(() => ""), this.options.apiKey);
      let category: HarnessErrorCategory = "unknown";
      if (response.status === 401 || response.status === 403) category = "authentication";
      else if (response.status === 429) category = "rate_limit";
      else if (response.status === 408 || response.status === 504) category = "provider_timeout";
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
        throw new ProviderError(`Provider stream error: ${safeBody(payload.error?.message || "unknown", this.options.apiKey)}`, "server_error");
      }
      const events: ModelEvent[] = [];
      if (payload.type === "message_start" && payload.message?.usage) {
        events.push({ type: "usage", usage: { inputTokens: payload.message.usage.input_tokens } });
      }
      if (payload.type === "content_block_start" && payload.content_block?.type === "tool_use") {
        tools.set(Number(payload.index || 0), {
          id: payload.content_block.id || `tool_${payload.index || 0}`,
          name: payload.content_block.name || "",
          arguments: "",
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
          if (Buffer.byteLength(tool.arguments, "utf8") > streamBufferLimit) {
            throw new ProviderError("Provider tool call exceeded maximum size", "response_limit");
          }
        }
      }
      if (payload.type === "message_delta") {
        if (payload.usage) events.push({ type: "usage", usage: { outputTokens: payload.usage.output_tokens } });
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
