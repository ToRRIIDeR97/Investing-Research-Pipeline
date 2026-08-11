import type { AgentAttempt, AgentUsage } from "./types";

export type HarnessErrorCategory =
  | "authentication"
  | "rate_limit"
  | "connection"
  | "server_error"
  | "provider_timeout"
  | "invalid_request"
  | "context_limit"
  | "cancellation"
  | "malformed_stream"
  | "schema_validation"
  | "response_limit"
  | "permission_denied"
  | "budget_exhausted"
  | "unknown";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly category: HarnessErrorCategory,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class ResearchAgentRunError extends Error {
  constructor(
    message: string,
    readonly usage: AgentUsage,
    readonly responseMetadata: Record<string, unknown> = {},
    readonly attempts: AgentAttempt[] = []
  ) {
    super(message);
    this.name = "ResearchAgentRunError";
  }
}

export function redactHarnessText(value: string, maxLength = 12_000) {
  let redacted = value;
  for (const key of ["RESEARCH_MODEL_API_KEY", "ANTHROPIC_API_KEY", "DATABASE_URL"]) {
    const secret = process.env[key];
    if (secret && secret.length > 5) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/(bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:x-api-key|api[_-]?key)[:=\s]+)[^\s,"']+/gi, "$1[REDACTED]")
    .slice(0, maxLength);
}
