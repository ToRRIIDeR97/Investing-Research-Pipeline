import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
  boolean,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { research_runs, research_stages, research_tasks } from "./workflow";

// ============================================================
// agent_output_staging — §27.13
// Quarantine zone for AI outputs before acceptance.
// ============================================================
export const agent_output_staging = pgTable("agent_output_staging", {
  id: uuid("id").primaryKey().defaultRandom(),
  research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id),
  stage_id: uuid("stage_id").notNull().references(() => research_stages.id),
  task_id: uuid("task_id").notNull().references(() => research_tasks.id),
  target_table: text("target_table").notNull(),
  target_record_id: uuid("target_record_id"),
  output_schema_key: text("output_schema_key").notNull(),
  output_schema_version: integer("output_schema_version").notNull(),
  payload_json: jsonb("payload_json").notNull(),
  validation_status: text("validation_status").notNull().default("pending"),
  validation_errors_json: jsonb("validation_errors_json").notNull().default([]),
  review_status: text("review_status").notNull().default("pending"),
  created_by_agent: text("created_by_agent").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  accepted_at: timestamp("accepted_at", { withTimezone: true }),
  rejected_at: timestamp("rejected_at", { withTimezone: true }),
  rejection_reason: text("rejection_reason"),
});

// ============================================================
// model_call_logs — §27.13
// Every model call is logged for cost tracking and audit.
// ============================================================
export const model_call_logs = pgTable(
  "model_call_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    research_run_id: uuid("research_run_id").references(() => research_runs.id),
    stage_id: uuid("stage_id").references(() => research_stages.id),
    task_id: uuid("task_id").references(() => research_tasks.id),
    agent_name: text("agent_name"),
    model_provider: text("model_provider").notNull(),
    model_name: text("model_name").notNull(),
    model_tier: text("model_tier").notNull(),
    prompt_version: text("prompt_version"),
    input_tokens: integer("input_tokens"),
    output_tokens: integer("output_tokens"),
    cost_usd: numeric("cost_usd"),
    cost_source: text("cost_source").notNull().default("unknown"),
    latency_ms: integer("latency_ms"),
    status: text("status").notNull(),
    error_message: text("error_message"),
    request_metadata_json: jsonb("request_metadata_json").notNull().default({}),
    response_metadata_json: jsonb("response_metadata_json").notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("model_call_logs_run_idx").on(table.research_run_id),
    index("model_call_logs_agent_model_idx").on(table.agent_name, table.model_name),
    index("model_call_logs_created_idx").on(table.created_at),
  ]
);

// ============================================================
// model_budget_limits — §27.13 / §3509
// Declarative model spend caps by run, stage, task, user, project, or tier.
// ============================================================
export const model_budget_limits = pgTable(
  "model_budget_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope_type: text("scope_type").notNull(),
    scope_id: uuid("scope_id"),
    model_tier: text("model_tier"),
    period: text("period"),
    limit_usd: numeric("limit_usd").notNull(),
    hard_limit: boolean("hard_limit").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("model_budget_limits_scope_idx").on(
      table.scope_type,
      table.scope_id,
      table.model_tier
    ),
  ]
);

// ============================================================
// model_budget_ledger — §27.13 / §3525
// Spend ledger used for budget enforcement and audit.
// ============================================================
export const model_budget_ledger = pgTable(
  "model_budget_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    model_call_log_id: uuid("model_call_log_id").references(() => model_call_logs.id),
    research_run_id: uuid("research_run_id").references(() => research_runs.id),
    stage_id: uuid("stage_id").references(() => research_stages.id),
    task_id: uuid("task_id").references(() => research_tasks.id),
    model_tier: text("model_tier").notNull(),
    cost_usd: numeric("cost_usd").notNull(),
    cost_source: text("cost_source").notNull().default("unknown"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("model_budget_ledger_run_idx").on(table.research_run_id),
    index("model_budget_ledger_stage_idx").on(table.stage_id),
    index("model_budget_ledger_tier_idx").on(table.model_tier),
  ]
);

// Reservations close the check-then-insert race when multiple workers share a
// run budget. A reservation is consumed by the eventual model-call ledger row
// or released when the attempt never starts.
export const model_budget_reservations = pgTable(
  "model_budget_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    research_run_id: uuid("research_run_id").references(() => research_runs.id),
    stage_id: uuid("stage_id").references(() => research_stages.id),
    task_id: uuid("task_id").references(() => research_tasks.id),
    model_tier: text("model_tier").notNull(),
    reserved_usd: numeric("reserved_usd").notNull(),
    status: text("status").notNull().default("pending"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("model_budget_reservations_run_idx").on(table.research_run_id, table.status),
    index("model_budget_reservations_expires_idx").on(table.status, table.expires_at),
  ]
);

// ============================================================
// agent_sessions/messages/events — durable harness transcript
// ============================================================
export const agent_sessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parent_session_id: uuid("parent_session_id").references((): AnyPgColumn => agent_sessions.id, { onDelete: "cascade" }),
    research_run_id: uuid("research_run_id").references(() => research_runs.id, { onDelete: "cascade" }),
    stage_id: uuid("stage_id").references(() => research_stages.id, { onDelete: "cascade" }),
    task_id: uuid("task_id").references(() => research_tasks.id, { onDelete: "cascade" }),
    agent_name: text("agent_name").notNull(),
    status: text("status").notNull().default("idle"),
    provider: text("provider"),
    model: text("model"),
    result_json: jsonb("result_json"),
    error_json: jsonb("error_json"),
    metadata_json: jsonb("metadata_json").notNull().default({}),
    next_event_sequence: integer("next_event_sequence").notNull().default(0),
    next_message_sequence: integer("next_message_sequence").notNull().default(0),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("agent_sessions_task_unique").on(table.task_id),
    index("agent_sessions_run_idx").on(table.research_run_id, table.created_at),
    index("agent_sessions_parent_idx").on(table.parent_session_id),
  ]
);

export const agent_session_messages = pgTable(
  "agent_session_messages",
  {
    id: text("id").primaryKey(),
    session_id: uuid("session_id").notNull().references(() => agent_sessions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    role: text("role").notNull(),
    content_json: jsonb("content_json").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_session_messages_sequence_unique").on(table.session_id, table.sequence),
    index("agent_session_messages_session_idx").on(table.session_id, table.sequence),
  ]
);

export const agent_session_events = pgTable(
  "agent_session_events",
  {
    id: uuid("id").primaryKey(),
    session_id: uuid("session_id").notNull().references(() => agent_sessions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    event_type: text("event_type").notNull(),
    payload_json: jsonb("payload_json").notNull().default({}),
    idempotency_key: text("idempotency_key"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_session_events_sequence_unique").on(table.session_id, table.sequence),
    uniqueIndex("agent_session_events_idempotency_unique").on(table.session_id, table.idempotency_key),
    index("agent_session_events_session_idx").on(table.session_id, table.sequence),
  ]
);

export const agent_permission_requests = pgTable(
  "agent_permission_requests",
  {
    id: uuid("id").primaryKey(),
    session_id: uuid("session_id").notNull().references(() => agent_sessions.id, { onDelete: "cascade" }),
    tool_call_id: text("tool_call_id").notNull(),
    tool_name: text("tool_name").notNull(),
    agent_name: text("agent_name").notNull(),
    action: text("action").notNull(),
    resource: text("resource").notNull(),
    input_json: jsonb("input_json").notNull().default({}),
    status: text("status").notNull().default("pending"),
    decision: text("decision"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("agent_permission_requests_call_unique").on(table.session_id, table.tool_call_id),
    index("agent_permission_requests_session_idx").on(table.session_id, table.created_at),
  ]
);

// ============================================================
// agent_traces — §27.13
// Tool calls made by agents.
// ============================================================
export const agent_traces = pgTable("agent_traces", {
  id: uuid("id").primaryKey().defaultRandom(),
  research_run_id: uuid("research_run_id").references(() => research_runs.id),
  task_id: uuid("task_id").references(() => research_tasks.id),
  session_id: uuid("session_id").references(() => agent_sessions.id, { onDelete: "cascade" }),
  agent_name: text("agent_name").notNull(),
  tool_call_id: text("tool_call_id"),
  tool_name: text("tool_name"),
  tool_input_json: jsonb("tool_input_json").notNull().default({}),
  tool_output_json: jsonb("tool_output_json"),
  status: text("status").notNull(),
  error_message: text("error_message"),
  duration_ms: integer("duration_ms"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completed_at: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("agent_traces_session_call_unique").on(table.session_id, table.tool_call_id),
  index("agent_traces_session_idx").on(table.session_id, table.created_at),
]);

// ============================================================
// Relations
// ============================================================
export const agentOutputStagingRelations = relations(agent_output_staging, ({ one }) => ({
  // These relations are to workflow tables; defined in workflow schema
}));

export const modelCallLogsRelations = relations(model_call_logs, ({ one }) => ({
  // Relations to workflow tables
}));

export const agentTracesRelations = relations(agent_traces, ({ one }) => ({
  // Relations to workflow tables
}));
