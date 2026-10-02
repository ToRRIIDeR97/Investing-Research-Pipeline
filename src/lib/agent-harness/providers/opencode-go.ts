import { randomUUID } from "node:crypto";
import type { ModelEvent, ModelProvider, ModelRequest, ProviderHealth } from "../types";
import { AnthropicCompatibleProvider } from "./anthropic-compatible";
import { OpenAICompatibleProvider } from "./openai-compatible";

export class OpenCodeGoProvider implements ModelProvider {
  readonly id = "opencode-go-direct";
  private readonly openai: OpenAICompatibleProvider;
  private readonly anthropic: AnthropicCompatibleProvider;
  private readonly fallbackSession = randomUUID();

  constructor(baseUrl: string, apiKey: string, allowedHosts: string[]) {
    const headers = { "User-Agent": "research-os/0.1" };
    this.openai = new OpenAICompatibleProvider({ mode: "direct", baseUrl, apiKey, allowedHosts, headers });
    this.anthropic = new AnthropicCompatibleProvider({ baseUrl, apiKey, allowedHosts, headers });
  }

  healthCheck(): Promise<ProviderHealth> {
    return this.openai.healthCheck();
  }

  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    // The session header is OpenCode's cache affinity signal, as in the Codetonomy harness:
    // requests that share a prompt prefix carry the same opaque value. A fresh one per call defeats reuse.
    const options = { headers: { "x-opencode-session": request.cacheAffinityId || this.fallbackSession } };
    if (/^(qwen|minimax)/i.test(request.model)) return this.anthropic.stream(request, signal, options);
    const providerRequest = /^kimi-/i.test(request.model) ? { ...request, temperature: undefined } : request;
    return this.openai.stream(providerRequest, signal, options);
  }
}
