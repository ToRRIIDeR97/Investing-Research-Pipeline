import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { research_runs } from "./workflow";

export const research_run_jobs = pgTable(
  "research_run_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    research_run_id: uuid("research_run_id")
      .notNull()
      .references(() => research_runs.id),
    job_type: text("job_type").notNull().default("pipeline"),
    status: text("status").notNull().default("queued"),
    requested_by: text("requested_by"),
    attempt_count: integer("attempt_count").notNull().default(0),
    max_attempts: integer("max_attempts").notNull().default(3),
    lease_owner: text("lease_owner"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    result_json: jsonb("result_json"),
    failure_reason: text("failure_reason"),
    queued_at: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    started_at: timestamp("started_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("research_run_jobs_one_active_pipeline_per_run")
      .on(table.research_run_id)
      .where(sql`${table.job_type} = 'pipeline' AND ${table.status} IN ('queued', 'running')`),
    index("research_run_jobs_claim_idx").on(table.status, table.queued_at),
    index("research_run_jobs_run_idx").on(table.research_run_id, table.created_at),
  ]
);

export const research_worker_heartbeats = pgTable("research_worker_heartbeats", {
  worker_id: text("worker_id").primaryKey(),
  status: text("status").notNull().default("healthy"),
  last_seen_at: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  started_at: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  stopped_at: timestamp("stopped_at", { withTimezone: true }),
  metadata_json: jsonb("metadata_json").notNull().default({}),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const researchRunJobsRelations = relations(research_run_jobs, ({ one }) => ({
  run: one(research_runs, {
    fields: [research_run_jobs.research_run_id],
    references: [research_runs.id],
  }),
}));
