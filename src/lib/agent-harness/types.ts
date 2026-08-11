export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
}

export interface ModelRequest {
  model: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  tools?: Array<Record<string, unknown>>;
  agentName?: string;
}

export type ModelEvent =
  | { type: "response.started"; requestId?: string }
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool.call"; call: ToolCall }
  | { type: "usage"; usage: ModelUsage }
  | { type: "response.completed"; finishReason?: string }
  | { type: "response.failed"; error: Error };

export interface ProviderHealth {
  status: "healthy" | "unhealthy";
  message?: string;
  models?: string[];
}

export interface ModelProvider {
  readonly id: string;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  /** Reserve this provider endpoint before the request deadline starts. */
  acquireRequestLock?(signal?: AbortSignal): Promise<() => void>;
  healthCheck?(): Promise<ProviderHealth>;
}

export interface ExecutionPolicy {
  totalTimeoutMs: number;
  inactivityTimeoutMs: number;
  maxResponseBytes: number;
  /** Omitted by default so providers may complete naturally. */
  maxOutputTokens?: number;
  maxRepairAttempts: number;
  maxToolTurns: number;
  maxToolCalls: number;
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
  costUsd: number;
  costSource?: "provider" | "catalog_estimate" | "unknown";
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
  toolCalls: Array<{ name: string; status: "success" | "failed" }>;
  passes?: AgentPassTelemetry[];
  localCoercionApplied?: boolean;
  completionRecoveredAtTimeout?: boolean;
  completionRecoveredWithoutMarker?: boolean;
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
  costUsd: number;
  costSource?: "provider" | "catalog_estimate" | "unknown";
  status: "success" | "failed";
  errorCategory?: string;
  errorMessage?: string;
  validationErrors?: Array<{ path: string; message: string }>;
  localCoercionApplied?: boolean;
  completionRecoveredAtTimeout?: boolean;
  completionRecoveredWithoutMarker?: boolean;
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
  outputFormat?: AgentOutputFormat;
  validateStructured?: (value: unknown) => Array<{ path: string; message: string }>;
  _outputType?: T;
}

export interface AgentOutputFormat {
  requiredKeys: string[];
  schema?: Record<string, unknown>;
}

export interface AgentUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  costUsd: number;
  costSource?: "provider" | "catalog_estimate" | "unknown";
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
