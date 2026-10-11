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
  /** The model used its whole output limit (usually on reasoning) before writing an answer. */
  | "output_exhausted"
  /** The provider account's usage or billing limit is spent; retrying will not help until it resets. */
  | "quota_exceeded"
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

/** A 4xx whose body reports an upstream outage, such as OpenCode's 400 "server_error: Upstream request failed". */
export function upstreamServerErrorBody(body: string): boolean {
  return /"type"\s*:\s*"server_error"|Upstream request failed/i.test(body);
}

/** A 429 that reports a spent account limit (OpenCode Go's GoUsageLimitError, quota, billing) rather than throttling. */
export function usageLimitBody(body: string): boolean {
  return /usage ?limit|UsageLimitError|insufficient_quota|quota exceeded|exceeded your (current )?quota|billing|credit balance/i.test(body);
}

