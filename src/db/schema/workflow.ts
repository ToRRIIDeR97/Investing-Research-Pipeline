import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { assets } from "./core";
import { research_profiles } from "./profiles";

// ============================================================
// research_runs — §27.6
// A research run is a finite-state workflow, not an open chat.
// ============================================================
export const research_runs = pgTable("research_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").notNull().references(() => assets.id),
  run_type: text("run_type").notNull(),
  status: text("status").notNull().default("pending"),
  research_question: text("research_question"),
  requested_by: text("requested_by"),
  profile_id: uuid("profile_id").references(() => research_profiles.id),
  profile_version: integer("profile_version"),
  source_cutoff_at: timestamp("source_cutoff_at", { withTimezone: true }),
  market_data_cutoff_at: timestamp("market_data_cutoff_at", { withTimezone: true }),
  budget_limit_usd: numeric("budget_limit_usd"),
  actual_cost_usd: numeric("actual_cost_usd").notNull().default("0"),
  // Historical v1/v2 rows remain readable. New runs use the current server-owned pipeline.
  pipeline_version: integer("pipeline_version").notNull().default(3),
  started_at: timestamp("started_at", { withTimezone: true }),
  completed_at: timestamp("completed_at", { withTimezone: true }),
  failure_reason: text("failure_reason"),
  metadata_json: jsonb("metadata_json").notNull().default({}),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// research_stages — §27.6
// Each stage in the research workflow FSM.
// ============================================================
export const research_stages = pgTable(
  "research_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id),
    stage_key: text("stage_key").notNull(),
    stage_order: integer("stage_order").notNull(),
    status: text("status").notNull().default("pending"),
    allowed_model_tiers: text("allowed_model_tiers").array().notNull().default([]),
    max_retries: integer("max_retries").notNull().default(2),
    budget_limit_usd: numeric("budget_limit_usd"),
    completion_criteria_json: jsonb("completion_criteria_json").notNull().default({}),
    validator_config_json: jsonb("validator_config_json").notNull().default({}),
    validation_result_json: jsonb("validation_result_json"),
    started_at: timestamp("started_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    failure_reason: text("failure_reason"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("research_stages_run_key_unique").on(table.research_run_id, table.stage_key),
    unique("research_stages_run_order_unique").on(table.research_run_id, table.stage_order),
  ]
);

// ============================================================
// research_tasks — §27.6
// Individual agent tasks within a stage.
// ============================================================
export const research_tasks = pgTable(
  "research_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id),
    stage_id: uuid("stage_id").notNull().references(() => research_stages.id),
    task_key: text("task_key").notNull(),
    task_type: text("task_type").notNull(),
    agent_name: text("agent_name"),
    status: text("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(100),
    input_json: jsonb("input_json").notNull().default({}),
    output_json: jsonb("output_json"),
    validation_status: text("validation_status"),
    validation_result_json: jsonb("validation_result_json"),
    retry_count: integer("retry_count").notNull().default(0),
    cost_usd: numeric("cost_usd").notNull().default("0"),
    // Estimated cost held by a model attempt in flight; set by budget preflight and cleared when the call is recorded.
    budget_reservation_usd: numeric("budget_reservation_usd"),
    idempotency_key: text("idempotency_key"),
    started_at: timestamp("started_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    failure_reason: text("failure_reason"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("research_tasks_status_priority_idx").on(
      table.status,
      table.priority,
      table.created_at
    ),
    index("research_tasks_run_stage_idx").on(table.research_run_id, table.stage_id),
    index("research_tasks_idempotency_idx").on(table.idempotency_key),
  ]
);

// ============================================================
// task_dependencies — §27.6
// ============================================================
export const task_dependencies = pgTable("task_dependencies", {
  id: uuid("id").primaryKey().defaultRandom(),
  task_id: uuid("task_id").notNull().references(() => research_tasks.id),
  depends_on_task_id: uuid("depends_on_task_id").notNull().references(() => research_tasks.id),
  dependency_type: text("dependency_type").notNull().default("success"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// stage_validation_results — §27.6
// ============================================================
export const stage_validation_results = pgTable("stage_validation_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id),
  stage_id: uuid("stage_id").notNull().references(() => research_stages.id),
  validator_key: text("validator_key").notNull(),
  status: text("status").notNull(),
  findings_json: jsonb("findings_json").notNull().default([]),
  required_missing_json: jsonb("required_missing_json").notNull().default([]),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// Relations
// ============================================================
export const researchRunsRelations = relations(research_runs, ({ many }) => ({
  stages: many(research_stages),
  tasks: many(research_tasks),
}));

export const researchStagesRelations = relations(research_stages, ({ one, many }) => ({
  run: one(research_runs, {
    fields: [research_stages.research_run_id],
    references: [research_runs.id],
  }),
  tasks: many(research_tasks),
  validation_results: many(stage_validation_results),
}));

export const researchTasksRelations = relations(research_tasks, ({ one }) => ({
  run: one(research_runs, {
    fields: [research_tasks.research_run_id],
    references: [research_runs.id],
  }),
  stage: one(research_stages, {
    fields: [research_tasks.stage_id],
    references: [research_stages.id],
  }),
}));

export const taskDependenciesRelations = relations(task_dependencies, ({ one }) => ({
  task: one(research_tasks, {
    fields: [task_dependencies.task_id],
    references: [research_tasks.id],
  }),
}));

export const stageValidationResultsRelations = relations(stage_validation_results, ({ one }) => ({
  run: one(research_runs, {
    fields: [stage_validation_results.research_run_id],
    references: [research_runs.id],
  }),
  stage: one(research_stages, {
    fields: [stage_validation_results.stage_id],
    references: [research_stages.id],
  }),
}));
