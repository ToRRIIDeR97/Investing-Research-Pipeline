/**
 * Source intelligence schema for Research OS v3.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { research_runs } from "./workflow";
import { source_documents } from "./corpus";

export const source_retrieval_attempts = pgTable(
  "source_retrieval_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    research_run_id: uuid("research_run_id")
      .notNull()
      .references(() => research_runs.id),
    source_role: text("source_role").notNull(),
    source_url: text("source_url"),
    source_title: text("source_title"),
    attempt_status: text("attempt_status").notNull().default("attempted"), // attempted, fetched, failed, unavailable
    failure_reason: text("failure_reason"),
    attempt_metadata_json: jsonb("attempt_metadata_json").notNull().default({}),
    attempted_at: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("source_retrieval_attempts_run_idx").on(table.research_run_id),
    index("source_retrieval_attempts_role_idx").on(table.source_role),
  ]
);

export const source_role_coverage = pgTable(
  "source_role_coverage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    research_run_id: uuid("research_run_id")
      .notNull()
      .references(() => research_runs.id),
    source_role: text("source_role").notNull(),
    artifact_type: text("artifact_type").notNull(),
    source_document_id: uuid("source_document_id").references(() => source_documents.id),
    coverage_status: text("coverage_status").notNull().default("uncovered"), // covered, uncovered, gap, waived
    confidence: integer("confidence"), // 0-100
    rationale: text("rationale"),
    blocked_artifact_types: jsonb("blocked_artifact_types").notNull().default([]),
    human_waived: boolean("human_waived").notNull().default(false),
    waived_by: text("waived_by"),
    waived_at: timestamp("waived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("source_role_coverage_run_role_artifact_unique").on(
      table.research_run_id,
      table.source_role,
      table.artifact_type
    ),
    index("source_role_coverage_run_idx").on(table.research_run_id),
    index("source_role_coverage_role_idx").on(table.source_role),
  ]
);

export const source_role_assignments = pgTable(
  "source_role_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source_document_id: uuid("source_document_id")
      .notNull()
      .references(() => source_documents.id),
    role: text("role").notNull(),
    confidence: integer("confidence"), // 0-100
    rationale: text("rationale"),
    assigned_by: text("assigned_by").notNull().default("system"), // system, human
    assigned_at: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("source_role_assignments_document_role_unique").on(table.source_document_id, table.role),
    index("source_role_assignments_document_idx").on(table.source_document_id),
    index("source_role_assignments_role_idx").on(table.role),
  ]
);

export const source_document_metadata = pgTable(
  "source_document_metadata",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source_document_id: uuid("source_document_id")
      .notNull()
      .references(() => source_documents.id)
      .unique(),
    document_type: text("document_type"), // 10-K, 10-Q, earnings_call, transcript, etc.
    publication_date: timestamp("publication_date", { withTimezone: true }),
    reporting_period_start: timestamp("reporting_period_start", { withTimezone: true }),
    reporting_period_end: timestamp("reporting_period_end", { withTimezone: true }),
    market_availability_date: timestamp("market_availability_date", { withTimezone: true }),
    retrieved_at: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
    parser_version: text("parser_version").notNull().default("unknown"),
    parse_status: text("parse_status").notNull().default("pending"), // pending, parsed, failed
    parse_error: text("parse_error"),
    metadata_json: jsonb("metadata_json").notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("source_document_metadata_type_idx").on(table.document_type),
    index("source_document_metadata_pub_date_idx").on(table.publication_date),
  ]
);

export type SourceRetrievalAttempt = typeof source_retrieval_attempts.$inferSelect;
export type SourceRoleCoverage = typeof source_role_coverage.$inferSelect;
export type SourceRoleAssignment = typeof source_role_assignments.$inferSelect;
export type SourceDocumentMetadata = typeof source_document_metadata.$inferSelect;
