import type { ModelProvider } from "../types";
import { ProviderError } from "../errors";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { MockProvider } from "./mock";
import { OpenCodeGoProvider } from "./opencode-go";

function allowedHosts() {
  return (process.env.RESEARCH_MODEL_ALLOWED_HOSTS || "").split(",").map((value) => value.trim()).filter(Boolean);
}

export function getProvider(providerTypeOverride?: string): ModelProvider {
  const providerType = providerTypeOverride || process.env.RESEARCH_MODEL_PROVIDER || "direct-openai-compatible";
  if (providerType === "mock") return new MockProvider();

  const baseUrl = process.env.RESEARCH_MODEL_BASE_URL;
  if (!baseUrl) throw new ProviderError(`RESEARCH_MODEL_BASE_URL is required for ${providerType}`, "invalid_request");
  if (providerType === "opencode-go-direct") {
    const apiKey = process.env.RESEARCH_MODEL_API_KEY || process.env.OPENCODE_GO_API_KEY || "";
    return new OpenCodeGoProvider(baseUrl, apiKey, allowedHosts());
  }
  if (providerType === "direct-openai-compatible") {
    return new OpenAICompatibleProvider({
      mode: "direct", baseUrl, apiKey: process.env.RESEARCH_MODEL_API_KEY, allowedHosts: allowedHosts(),
    });
  }
  if (providerType === "local-openai-compatible") {
    return new OpenAICompatibleProvider({
      mode: "local", baseUrl, apiKey: process.env.RESEARCH_MODEL_API_KEY,
    });
  }
  throw new ProviderError(`Unknown model provider: ${providerType}`, "invalid_request");
}
