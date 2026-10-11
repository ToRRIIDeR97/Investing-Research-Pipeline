import type { PassCacheTelemetry } from "./cache";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelUsage {
  /** All prompt tokens, including any served from or written to the provider cache. */
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  /** Prompt tokens served from the provider cache; undefined when the provider does not report it. */
  cacheReadTokens?: number;
  /** Prompt tokens written to the provider cache; undefined when the provider does not report it. */
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface ModelRequest {
  model: string;
  /** Stable instructions, sent ahead of the prompt so providers can reuse them from cache. */
  system?: string;
  prompt: string;
  /** Length of the prompt's leading part that later requests resend unchanged: the context sibling calls share, or the generation prompt a repair appends to. Defaults to the whole prompt. */
  cacheablePromptChars?: number;
  temperature?: number;
  maxTokens?: number;
  agentName?: string;
  /** Opaque key that keeps requests sharing a prompt prefix on the same provider cache. */
  cacheAffinityId?: string;
  /** JSON schema of the task output. Only anthropic-direct uses it; other providers ignore it. */
  outputSchema?: Record<string, unknown>;
}

export type ModelEvent =
  | { type: "request.sent"; body: string }
  | { type: "response.started"; requestId?: string }
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool.call"; call: ToolCall }
  | { type: "usage"; usage: ModelUsage }
  | { type: "response.completed"; finishReason?: string }
  /** A valid stream event with no content (ping, hidden thinking, signature). Keeps the inactivity timer honest. */
  | { type: "heartbeat" }
  | { type: "response.failed"; error: Error };

export interface ProviderHealth {
  status: "healthy" | "unhealthy";
  message?: string;
  models?: string[];
}

export interface ModelProvider {
  readonly id: string;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  healthCheck?(): Promise<ProviderHealth>;
}

export interface ExecutionPolicy {
  totalTimeoutMs: number;
  inactivityTimeoutMs: number;
  maxResponseBytes: number;
  /** Per-request ceiling, including schema repair requests. */
  maxOutputTokens?: number;
  maxRepairAttempts: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
}

export interface AgentAttempt {
  attempt: number;
  provider: string;
  model: string;
  modelAttempt?: number;
  requestId?: string;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Output limit this attempt sent; it grows after an attempt spends its whole limit on reasoning. */
  maxOutputTokens?: number;
  costUsd: number;
  status: "success" | "failed" | "cancelled";
  errorCategory?: string;
  errorMessage?: string;
  timeoutType?: "total" | "inactivity";
  repairAttempted: boolean;
  fallback: boolean;
  compactionOccurred: boolean;
  inputBytes?: number;
  originalInputBytes?: number;
  rawResponseExcerpt: string;
  validationErrors: Array<{ path: string; message: string }>;
  passes?: AgentPassTelemetry[];
  localCoercionApplied?: boolean;
  completionRecoveredAtTimeout?: boolean;
}

export interface AgentPassTelemetry {
  kind: "generation" | "repair";
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  requestId?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Content-free comparison with the previous request in the same cache affinity group. */
  cache?: PassCacheTelemetry;
  costUsd: number;
  status: "success" | "failed";
  errorCategory?: string;
  errorMessage?: string;
  validationErrors?: Array<{ path: string; message: string }>;
  localCoercionApplied?: boolean;
  completionRecoveredAtTimeout?: boolean;
  /** Whether a request of this pass carried output_config, and whether a schema rejection resent it without. */
  structuredOutput: { sent: boolean; fallback: boolean };
}

export interface AgentLifecycleHooks {
  beforeAttempt?: (context: { attempt: number; provider: string; model: string }) => Promise<void> | void;
  onAttemptComplete?: (attempt: AgentAttempt) => Promise<void> | void;
}

export interface AgentRequest<T = unknown> {
  agentName: string;
  title: string;
  taskPacket: Record<string, unknown>;
  prompt?: string;
  promptFactory?: (packet: Record<string, unknown>) => string;
  signal?: AbortSignal;
  policy?: Partial<ExecutionPolicy>;
  hooks?: AgentLifecycleHooks;
  provider?: ModelProvider;
  /** Local grouping for provider cache affinity, such as a research run ID. Never sent verbatim. */
  cacheScope?: string;
  /**
   * Packet keys that differ between sibling calls sharing the rest of the packet (report sections,
   * extraction batches). They come last in the packet, and the prompt-cache breakpoint ends before them.
   */
  perCallKeys?: string[];
  outputFormat?: AgentOutputFormat;
  _outputType?: T;
}

export interface AgentOutputFormat {
  requiredKeys: string[];
  schema?: Record<string, unknown>;
  validate?: (value: unknown) => Array<{ path: string; message: string }>;
}

export interface AgentUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
  latencyMs: number;
  requestId?: string;
  promptVersion?: string;
  compaction_occurred?: boolean;
}

export interface AgentResult<T = unknown> {
  structured: T;
  rawText: string;
  attempts: AgentAttempt[];
  usage: AgentUsage;
  config: Record<string, unknown>;
}
