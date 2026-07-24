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
