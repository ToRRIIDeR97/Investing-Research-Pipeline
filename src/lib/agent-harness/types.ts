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
  costUsd: number;
  status: "success" | "failed";
  errorCategory?: string;
  errorMessage?: string;
  validationErrors?: Array<{ path: string; message: string }>;
  localCoercionApplied?: boolean;
  completionRecoveredAtTimeout?: boolean;
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
