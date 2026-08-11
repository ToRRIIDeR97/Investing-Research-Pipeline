export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type AgentMessageRole = "system" | "user" | "assistant" | "tool";

export type AgentContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "image"; url?: string; data?: string; mediaType?: string; detail?: "auto" | "low" | "high" }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; toolCallId: string; toolName: string; output: unknown; isError?: boolean };

export interface AgentMessage {
  /** Globally unique client/message identifier used for durable replay. */
  id: string;
  role: AgentMessageRole;
  parts: AgentContentPart[];
  createdAt: string;
  sequence?: number;
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
  messages?: AgentMessage[];
  temperature?: number;
  maxTokens?: number;
  maxResponseBytes?: number;
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
  maxContextBytes: number;
  maxToolOutputBytes: number;
  toolTimeoutMs: number;
  maxRepeatedToolCalls: number;
  /** Omitted by default so providers may complete naturally. */
  maxOutputTokens?: number;
  maxRepairAttempts: number;
  maxToolTurns: number;
  maxToolCalls: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
}

export type AgentSessionStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

export interface AgentSessionRecord {
  id: string;
  parentSessionId?: string;
  researchRunId?: string;
  stageId?: string;
  taskId?: string;
  agentName: string;
  status: AgentSessionStatus;
  model?: string;
  provider?: string;
  result?: unknown;
  error?: unknown;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSessionEvent {
  id: string;
  sessionId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentToolTrace {
  sessionId: string;
  researchRunId?: string;
  taskId?: string;
  agentName: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  status: "running" | "completed" | "failed" | "cancelled";
  errorMessage?: string;
  durationMs?: number;
}

export type PermissionEffect = "allow" | "deny" | "ask";
export type PermissionDecision = "allow_once" | "allow_always" | "deny";

export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  agentName: string;
  toolCallId: string;
  toolName: string;
  action: string;
  resource: string;
  input: unknown;
}

export interface AgentSessionStore {
  createSession(input: {
    id?: string;
    parentSessionId?: string;
    researchRunId?: string;
    stageId?: string;
    taskId?: string;
    agentName: string;
    metadata?: Record<string, unknown>;
  }): Promise<AgentSessionRecord>;
  updateSession(
    sessionId: string,
    patch: Partial<Pick<AgentSessionRecord, "status" | "model" | "provider" | "metadata" | "result" | "error">>
  ): Promise<void>;
  appendMessage(sessionId: string, message: AgentMessage): Promise<AgentMessage>;
  appendEvent(
    sessionId: string,
    type: string,
    payload?: Record<string, unknown>,
    options?: { idempotencyKey?: string }
  ): Promise<AgentSessionEvent>;
  listMessages(sessionId: string): Promise<AgentMessage[]>;
  listEvents(sessionId: string): Promise<AgentSessionEvent[]>;
  recordToolTrace?(trace: AgentToolTrace): Promise<void>;
  recordPermission?(request: PermissionRequest, decision: PermissionDecision): Promise<void>;
}

export interface AgentSessionOptions {
  id?: string;
  inputId?: string;
  parentSessionId?: string;
  researchRunId?: string;
  stageId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  store?: AgentSessionStore;
  depth?: number;
}

export interface McpServerConfig {
  name: string;
  url: string;
  allowedHosts: string[];
  headerEnv?: Record<string, string>;
  timeoutMs?: number;
  enabledTools?: string[];
}

export interface SubagentOptions {
  allowedAgents: string[];
  maxDepth?: number;
  maxChildren?: number;
  execute(request: {
    agentName: string;
    title: string;
    taskPacket: Record<string, unknown>;
    signal: AbortSignal;
    parentSessionId: string;
    depth: number;
  }): Promise<unknown>;
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
  onEvent?: (event: AgentSessionEvent) => Promise<void> | void;
}

export interface AgentRequest<T = unknown> {
  agentName: string;
  title: string;
  taskPacket: Record<string, unknown>;
  prompt?: string;
  systemPrompt?: string;
  messages?: AgentMessage[];
  promptFactory?: (packet: Record<string, unknown>) => string;
  signal?: AbortSignal;
  policy?: Partial<ExecutionPolicy>;
  hooks?: AgentLifecycleHooks;
  provider?: ModelProvider;
  session?: AgentSessionOptions;
  enabledTools?: string[];
  permissionRules?: PermissionRule[];
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision> | PermissionDecision;
  skillPaths?: string[];
  skills?: string[];
  mcpServers?: McpServerConfig[];
  subagents?: SubagentOptions;
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
  sessionId?: string;
}
