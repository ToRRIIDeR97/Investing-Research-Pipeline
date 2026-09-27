import { randomUUID } from "node:crypto";
import type { ModelEvent, ModelProvider, ModelRequest, ProviderHealth } from "../types";
import { AnthropicCompatibleProvider } from "./anthropic-compatible";
import { OpenAICompatibleProvider } from "./openai-compatible";

export class OpenCodeGoProvider implements ModelProvider {
  readonly id = "opencode-go-direct";
  private readonly openai: OpenAICompatibleProvider;
  private readonly anthropic: AnthropicCompatibleProvider;

  constructor(baseUrl: string, apiKey: string, allowedHosts: string[]) {
    const headers = { "x-opencode-session": randomUUID(), "User-Agent": "research-os/0.1" };
    this.openai = new OpenAICompatibleProvider({ mode: "direct", baseUrl, apiKey, allowedHosts, headers });
    this.anthropic = new AnthropicCompatibleProvider({ baseUrl, apiKey, allowedHosts, headers });
  }

  healthCheck(): Promise<ProviderHealth> {
    return this.openai.healthCheck();
  }

  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (/^(qwen|minimax)/i.test(request.model)) return this.anthropic.stream(request, signal);
    const providerRequest = /^kimi-/i.test(request.model) ? { ...request, temperature: undefined } : request;
    return this.openai.stream(providerRequest, signal);
  }
}
