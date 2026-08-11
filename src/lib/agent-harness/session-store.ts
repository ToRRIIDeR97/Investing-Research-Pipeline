import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { ProviderError } from "./errors";
import type {
  AgentMessage,
  AgentSessionEvent,
  AgentSessionRecord,
  AgentSessionStatus,
  AgentSessionStore,
  AgentToolTrace,
  PermissionDecision,
  PermissionRequest,
} from "./types";

type Sql = ReturnType<typeof postgres>;

function now() {
  return new Date().toISOString();
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return "undefined";
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(Object.keys(input as Record<string, unknown>).sort().map((key) => [
      key,
      sort((input as Record<string, unknown>)[key]),
    ]));
  };
  return JSON.stringify(sort(JSON.parse(serialized)));
}

function same(left: unknown, right: unknown) {
  return canonicalJson(left) === canonicalJson(right);
}

function sameSessionIdentity(
  session: Pick<AgentSessionRecord, "agentName" | "parentSessionId" | "researchRunId" | "stageId" | "taskId">,
  input: Parameters<AgentSessionStore["createSession"]>[0]
) {
  return session.agentName === input.agentName &&
    session.parentSessionId === input.parentSessionId &&
    session.researchRunId === input.researchRunId &&
    session.stageId === input.stageId &&
    session.taskId === input.taskId;
}

export class MemoryAgentSessionStore implements AgentSessionStore {
  private readonly sessions = new Map<string, AgentSessionRecord>();
  private readonly taskSessions = new Map<string, string>();
  private readonly messages = new Map<string, AgentMessage[]>();
  private readonly messageSessions = new Map<string, string>();
  private readonly events = new Map<string, AgentSessionEvent[]>();
  private readonly eventKeys = new Map<string, AgentSessionEvent>();
  readonly toolTraces = new Map<string, AgentToolTrace>();
  readonly permissions = new Map<string, { request: PermissionRequest; decision: PermissionDecision }>();
  private readonly permissionCalls = new Map<string, string>();

  async createSession(input: Parameters<AgentSessionStore["createSession"]>[0]) {
    if (input.taskId) {
      const existingId = this.taskSessions.get(input.taskId);
      const existing = existingId ? this.sessions.get(existingId) : undefined;
      if (existing) {
        if (!sameSessionIdentity(existing, input)) {
          throw new ProviderError(`Conflicting replay for task session ${input.taskId}`, "invalid_request");
        }
        return existing;
      }
    }
    if (input.id && this.sessions.has(input.id)) {
      const existing = this.sessions.get(input.id)!;
      if (!sameSessionIdentity(existing, input)) {
        throw new ProviderError(`Conflicting replay for agent session ${input.id}`, "invalid_request");
      }
      return existing;
    }
    const createdAt = now();
    const session: AgentSessionRecord = {
      id: input.id || randomUUID(),
      parentSessionId: input.parentSessionId,
      researchRunId: input.researchRunId,
      stageId: input.stageId,
      taskId: input.taskId,
      agentName: input.agentName,
      status: "idle",
      metadata: input.metadata || {},
      createdAt,
      updatedAt: createdAt,
    };
    this.sessions.set(session.id, session);
    if (input.taskId) this.taskSessions.set(input.taskId, session.id);
    return session;
  }

  async updateSession(
    sessionId: string,
    patch: Partial<Pick<AgentSessionRecord, "status" | "model" | "provider" | "metadata" | "result" | "error">>
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ProviderError(`Agent session not found: ${sessionId}`, "invalid_request");
    const updated = { ...session, ...patch, updatedAt: now() };
    if (patch.status === "running" || patch.status === "completed") updated.error = undefined;
    this.sessions.set(sessionId, updated);
  }

  async appendMessage(sessionId: string, message: AgentMessage) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ProviderError(`Agent session not found: ${sessionId}`, "invalid_request");
    const owner = this.messageSessions.get(message.id);
    if (owner && owner !== sessionId) throw new ProviderError(`Message ID already belongs to another session: ${message.id}`, "invalid_request");
    const messages = this.messages.get(sessionId) || [];
    const existing = messages.find((candidate) => candidate.id === message.id);
    if (existing) {
      if (!same(existing.parts, message.parts) || existing.role !== message.role) {
        throw new ProviderError(`Conflicting replay for message ${message.id}`, "invalid_request");
      }
      return existing;
    }
    if (terminalSessionStatus(session.status)) {
      throw new ProviderError(`Agent session is already ${session.status}: ${sessionId}`, "invalid_request");
    }
    const stored = { ...message, sequence: messages.length + 1 };
    messages.push(stored);
    this.messages.set(sessionId, messages);
    this.messageSessions.set(message.id, sessionId);
    return stored;
  }

  async appendEvent(
    sessionId: string,
    type: string,
    payload: Record<string, unknown> = {},
    options: { idempotencyKey?: string } = {}
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ProviderError(`Agent session not found: ${sessionId}`, "invalid_request");
    const events = this.events.get(sessionId) || [];
    if (options.idempotencyKey) {
      const existing = this.eventKeys.get(`${sessionId}:${options.idempotencyKey}`);
      if (existing) {
        if (existing.type !== type || !same(existing.payload, payload)) {
          throw new ProviderError(`Conflicting replay for event ${options.idempotencyKey}`, "invalid_request");
        }
        return existing;
      }
    }
    if (terminalSessionStatus(session.status) && type !== `session.${session.status}`) {
      throw new ProviderError(`Agent session is already ${session.status}: ${sessionId}`, "invalid_request");
    }
    const event: AgentSessionEvent = {
      id: randomUUID(), sessionId, sequence: events.length + 1, type,
      payload,
      createdAt: now(),
    };
    events.push(event);
    this.events.set(sessionId, events);
    if (options.idempotencyKey) this.eventKeys.set(`${sessionId}:${options.idempotencyKey}`, event);
    return event;
  }

  async listMessages(sessionId: string) {
    return [...(this.messages.get(sessionId) || [])];
  }

  async listEvents(sessionId: string) {
    return [...(this.events.get(sessionId) || [])];
  }

  async recordToolTrace(trace: AgentToolTrace) {
    const key = `${trace.sessionId}:${trace.toolCallId}`;
    const existing = this.toolTraces.get(key);
    if (existing && (existing.toolName !== trace.toolName || !same(existing.input, trace.input))) {
      throw new ProviderError(`Conflicting replay for tool call ${trace.toolCallId}`, "invalid_request");
    }
    if (existing && existing.status !== "running") {
      if (
        trace.status === "running" || existing.status !== trace.status ||
        !same(existing.output, trace.output) || existing.errorMessage !== trace.errorMessage
      ) {
        throw new ProviderError(`Conflicting replay for settled tool call ${trace.toolCallId}`, "invalid_request");
      }
      return;
    }
    this.toolTraces.set(key, trace);
  }

  async recordPermission(request: PermissionRequest, decision: PermissionDecision) {
    const callKey = `${request.sessionId}:${request.toolCallId}`;
    const existingId = this.permissionCalls.get(callKey);
    if (existingId) {
      const existing = this.permissions.get(existingId);
      const { id: _existingId, ...existingRequest } = existing?.request || request;
      const { id: _requestId, ...replayedRequest } = request;
      if (!existing || !same(existingRequest, replayedRequest) || existing.decision !== decision) {
        throw new ProviderError(`Conflicting replay for permission ${request.toolCallId}`, "invalid_request");
      }
      return;
    }
    this.permissions.set(request.id, { request, decision });
    this.permissionCalls.set(callKey, request.id);
  }
}

function rowToSession(row: any): AgentSessionRecord {
  return {
    id: row.id,
    parentSessionId: row.parent_session_id || undefined,
    researchRunId: row.research_run_id || undefined,
    stageId: row.stage_id || undefined,
    taskId: row.task_id || undefined,
    agentName: row.agent_name,
    status: row.status,
    model: row.model || undefined,
    provider: row.provider || undefined,
    result: row.result_json ?? undefined,
    error: row.error_json ?? undefined,
    metadata: row.metadata_json || {},
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class PostgresAgentSessionStore implements AgentSessionStore {
  constructor(private readonly sql: Sql) {}

  async createSession(input: Parameters<AgentSessionStore["createSession"]>[0]) {
    const id = input.id || randomUUID();
    if (input.id) {
      const existing = await this.sql`SELECT * FROM agent_sessions WHERE id = ${input.id} LIMIT 1`;
      if (existing[0]) {
        if (!sameSessionIdentity(rowToSession(existing[0]), input)) {
          throw new ProviderError(`Conflicting replay for agent session ${input.id}`, "invalid_request");
        }
        return rowToSession(existing[0]);
      }
    }
    let rows = await this.sql`
      INSERT INTO agent_sessions (
        id, parent_session_id, research_run_id, stage_id, task_id,
        agent_name, status, metadata_json
      ) VALUES (
        ${id}, ${input.parentSessionId || null}, ${input.researchRunId || null},
        ${input.stageId || null}, ${input.taskId || null}, ${input.agentName},
        'idle', ${this.sql.json((input.metadata || {}) as any)}
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    if (!rows[0]) {
      rows = await this.sql`
        SELECT * FROM agent_sessions
        WHERE id = ${id} OR task_id = ${input.taskId || null}
        ORDER BY CASE WHEN id = ${id} THEN 0 ELSE 1 END
        LIMIT 1
      `;
    }
    if (!rows[0]) throw new ProviderError(`Unable to create agent session ${id}`, "server_error");
    if (!sameSessionIdentity(rowToSession(rows[0]), input)) {
      throw new ProviderError(`Conflicting replay for task session ${input.taskId}`, "invalid_request");
    }
    return rowToSession(rows[0]);
  }

  async updateSession(
    sessionId: string,
    patch: Partial<Pick<AgentSessionRecord, "status" | "model" | "provider" | "metadata" | "result" | "error">>
  ) {
    const status = patch.status || null;
    const model = patch.model || null;
    const provider = patch.provider || null;
    const hasMetadata = patch.metadata !== undefined;
    const hasResult = patch.result !== undefined;
    const hasError = patch.error !== undefined;
    const rows = await this.sql`
      UPDATE agent_sessions
      SET status = COALESCE(${status}, status),
          model = COALESCE(${model}, model),
          provider = COALESCE(${provider}, provider),
          metadata_json = CASE WHEN ${hasMetadata} THEN ${this.sql.json((patch.metadata || {}) as any)} ELSE metadata_json END,
          result_json = CASE WHEN ${hasResult} THEN ${hasResult ? this.sql.json(patch.result as any) : null} ELSE result_json END,
          error_json = CASE WHEN ${hasError} THEN ${hasError ? this.sql.json(patch.error as any) : null} WHEN ${status} IN ('running', 'completed') THEN NULL ELSE error_json END,
          completed_at = CASE WHEN ${status} IN ('completed', 'failed', 'cancelled') THEN NOW() WHEN ${status} = 'running' THEN NULL ELSE completed_at END,
          updated_at = NOW()
      WHERE id = ${sessionId}
      RETURNING id
    `;
    if (!rows[0]) throw new ProviderError(`Agent session not found: ${sessionId}`, "invalid_request");
  }

  async appendMessage(sessionId: string, message: AgentMessage) {
    return this.sql.begin(async (tx: any) => {
      const locked = await tx`SELECT id, status FROM agent_sessions WHERE id = ${sessionId} FOR UPDATE`;
      if (!locked[0]) throw new ProviderError(`Agent session not found: ${sessionId}`, "invalid_request");
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${message.id}, 1))`;
      const existing = await tx`
        SELECT id, session_id, sequence, role, content_json, created_at
        FROM agent_session_messages WHERE id = ${message.id} LIMIT 1
      `;
      if (existing[0]) {
        if (existing[0].session_id !== sessionId || existing[0].role !== message.role || !same(existing[0].content_json, message.parts)) {
          throw new ProviderError(`Conflicting replay for message ${message.id}`, "invalid_request");
        }
        return {
          ...message,
          sequence: Number(existing[0].sequence),
          createdAt: new Date(existing[0].created_at).toISOString(),
        };
      }
      if (terminalSessionStatus(locked[0].status)) {
        throw new ProviderError(`Agent session is already ${locked[0].status}: ${sessionId}`, "invalid_request");
      }
      const seqRows = await tx`
        UPDATE agent_sessions
        SET next_message_sequence = next_message_sequence + 1, updated_at = NOW()
        WHERE id = ${sessionId}
        RETURNING next_message_sequence
      `;
      if (!seqRows[0]) throw new ProviderError(`Agent session not found: ${sessionId}`, "invalid_request");
      const sequence = Number(seqRows[0].next_message_sequence);
      const rows = await tx`
        INSERT INTO agent_session_messages (id, session_id, sequence, role, content_json)
        VALUES (${message.id}, ${sessionId}, ${sequence}, ${message.role}, ${tx.json(message.parts)})
        RETURNING created_at
      `;
      return { ...message, sequence, createdAt: new Date(rows[0].created_at).toISOString() };
    }) as unknown as AgentMessage;
  }

  async appendEvent(
    sessionId: string,
    type: string,
    payload: Record<string, unknown> = {},
    options: { idempotencyKey?: string } = {}
  ) {
    return this.sql.begin(async (tx: any) => {
      const locked = await tx`SELECT id, status FROM agent_sessions WHERE id = ${sessionId} FOR UPDATE`;
      if (!locked[0]) throw new ProviderError(`Agent session not found: ${sessionId}`, "invalid_request");
      if (options.idempotencyKey) {
        const existing = await tx`
          SELECT id, sequence, event_type, payload_json, created_at
          FROM agent_session_events
          WHERE session_id = ${sessionId} AND idempotency_key = ${options.idempotencyKey}
          LIMIT 1
        `;
        if (existing[0]) {
          if (existing[0].event_type !== type || !same(existing[0].payload_json, payload)) {
            throw new ProviderError(`Conflicting replay for event ${options.idempotencyKey}`, "invalid_request");
          }
          return {
            id: existing[0].id, sessionId, sequence: Number(existing[0].sequence), type,
            payload, createdAt: new Date(existing[0].created_at).toISOString(),
          } satisfies AgentSessionEvent;
        }
      }
      if (terminalSessionStatus(locked[0].status) && type !== `session.${locked[0].status}`) {
        throw new ProviderError(`Agent session is already ${locked[0].status}: ${sessionId}`, "invalid_request");
      }
      const seqRows = await tx`
        UPDATE agent_sessions
        SET next_event_sequence = next_event_sequence + 1, updated_at = NOW()
        WHERE id = ${sessionId}
        RETURNING next_event_sequence
      `;
      if (!seqRows[0]) throw new ProviderError(`Agent session not found: ${sessionId}`, "invalid_request");
      const id = randomUUID();
      const sequence = Number(seqRows[0].next_event_sequence);
      const rows = await tx`
        INSERT INTO agent_session_events (id, session_id, sequence, event_type, payload_json, idempotency_key)
        VALUES (${id}, ${sessionId}, ${sequence}, ${type}, ${tx.json(payload)}, ${options.idempotencyKey || null})
        RETURNING created_at
      `;
      return { id, sessionId, sequence, type, payload, createdAt: new Date(rows[0].created_at).toISOString() } satisfies AgentSessionEvent;
    }) as unknown as AgentSessionEvent;
  }

  async listMessages(sessionId: string) {
    const rows = await this.sql`
      SELECT id, sequence, role, content_json, created_at
      FROM agent_session_messages WHERE session_id = ${sessionId}
      ORDER BY sequence ASC
    `;
    return rows.map((row: any) => ({
      id: row.id, sequence: Number(row.sequence), role: row.role,
      parts: row.content_json, createdAt: new Date(row.created_at).toISOString(),
    })) as AgentMessage[];
  }

  async listEvents(sessionId: string) {
    const rows = await this.sql`
      SELECT id, sequence, event_type, payload_json, created_at
      FROM agent_session_events WHERE session_id = ${sessionId}
      ORDER BY sequence ASC
    `;
    return rows.map((row: any) => ({
      id: row.id, sessionId, sequence: Number(row.sequence), type: row.event_type,
      payload: row.payload_json || {}, createdAt: new Date(row.created_at).toISOString(),
    })) as AgentSessionEvent[];
  }

  async recordToolTrace(trace: AgentToolTrace) {
    const rows = await this.sql`
      INSERT INTO agent_traces (
        research_run_id, task_id, session_id, tool_call_id, agent_name,
        tool_name, tool_input_json, tool_output_json, status,
        error_message, duration_ms, completed_at
      ) VALUES (
        ${trace.researchRunId || null}, ${trace.taskId || null}, ${trace.sessionId}, ${trace.toolCallId},
        ${trace.agentName}, ${trace.toolName}, ${this.sql.json(trace.input as any)},
        ${trace.output === undefined ? null : this.sql.json(trace.output as any)}, ${trace.status},
        ${trace.errorMessage || null}, ${trace.durationMs ?? null},
        ${trace.status === "running" ? null : new Date()}
      )
      ON CONFLICT (session_id, tool_call_id)
      DO UPDATE SET
        tool_output_json = EXCLUDED.tool_output_json,
        status = EXCLUDED.status,
        error_message = EXCLUDED.error_message,
        duration_ms = EXCLUDED.duration_ms,
        completed_at = EXCLUDED.completed_at
      WHERE agent_traces.tool_name = EXCLUDED.tool_name
        AND agent_traces.tool_input_json = EXCLUDED.tool_input_json
        AND (
          agent_traces.status = 'running'
          OR (
            agent_traces.status = EXCLUDED.status
            AND agent_traces.tool_output_json IS NOT DISTINCT FROM EXCLUDED.tool_output_json
            AND agent_traces.error_message IS NOT DISTINCT FROM EXCLUDED.error_message
          )
        )
      RETURNING id
    `;
    if (!rows[0]) throw new ProviderError(`Conflicting replay for tool call ${trace.toolCallId}`, "invalid_request");
  }

  async recordPermission(request: PermissionRequest, decision: PermissionDecision) {
    const rows = await this.sql`
      INSERT INTO agent_permission_requests (
        id, session_id, tool_call_id, tool_name, agent_name,
        action, resource, input_json, status, decision, resolved_at
      ) VALUES (
        ${request.id}, ${request.sessionId}, ${request.toolCallId}, ${request.toolName}, ${request.agentName},
        ${request.action}, ${request.resource}, ${this.sql.json(request.input as any)},
        'resolved', ${decision}, NOW()
      )
      ON CONFLICT (session_id, tool_call_id)
      DO UPDATE SET status = EXCLUDED.status, decision = EXCLUDED.decision, resolved_at = EXCLUDED.resolved_at
      WHERE agent_permission_requests.tool_name = EXCLUDED.tool_name
        AND agent_permission_requests.agent_name = EXCLUDED.agent_name
        AND agent_permission_requests.action = EXCLUDED.action
        AND agent_permission_requests.resource = EXCLUDED.resource
        AND agent_permission_requests.input_json = EXCLUDED.input_json
        AND agent_permission_requests.decision = EXCLUDED.decision
      RETURNING id
    `;
    if (!rows[0]) throw new ProviderError(`Conflicting replay for permission ${request.toolCallId}`, "invalid_request");
  }
}

export function terminalSessionStatus(status: AgentSessionStatus) {
  return status === "completed" || status === "failed" || status === "cancelled";
}
