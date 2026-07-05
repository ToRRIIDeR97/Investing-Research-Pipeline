import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  date,
  jsonb,
  unique,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { assets } from "./core";
import { research_runs } from "./workflow";
import { source_documents } from "./corpus";
import { evidence_claims } from "./evidence";

// ============================================================
// metric_definitions — §27.9
// Canonical metric registry.
// ============================================================
export const metric_definitions = pgTable("metric_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  metric_key: text("metric_key").unique().notNull(),
  display_name: text("display_name").notNull(),
  metric_category: text("metric_category").notNull(),
  unit_type: text("unit_type"),
  default_unit: text("default_unit"),
  default_currency: text("default_currency"),
  description: text("description"),
  applicable_profile_keys: text("applicable_profile_keys").array().notNull().default([]),
  calculation_method: text("calculation_method"),
  cheaper_when: text("cheaper_when"),
  higher_is_better: boolean("higher_is_better"),
  metadata_json: jsonb("metadata_json").notNull().default({}),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// metric_observations — §27.9
// Point-in-time metric values with revision tracking.
// ============================================================
export const metric_observations = pgTable(
  "metric_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    asset_id: uuid("asset_id").notNull().references(() => assets.id),
    research_run_id: uuid("research_run_id").references(() => research_runs.id),
    metric_definition_id: uuid("metric_definition_id").notNull().references(() => metric_definitions.id),
    period_start: date("period_start"),
    period_end: date("period_end"),
    as_of_date: date("as_of_date"),
    available_at: timestamp("available_at", { withTimezone: true }),
    published_at: timestamp("published_at", { withTimezone: true }),
    retrieved_at: timestamp("retrieved_at", { withTimezone: true }),
    value_numeric: numeric("value_numeric"),
    value_text: text("value_text"),
    unit: text("unit"),
    currency: text("currency"),
    data_provider: text("data_provider"),
    source_document_id: uuid("source_document_id").references(() => source_documents.id),
    evidence_claim_id: uuid("evidence_claim_id").references(() => evidence_claims.id),
    calculation_json: jsonb("calculation_json").notNull().default({}),
    confidence: numeric("confidence"),
    revision_number: integer("revision_number").notNull().default(0),
    is_revised: boolean("is_revised").notNull().default(false),
    review_status: text("review_status").notNull().default("pending"),
    metadata_json: jsonb("metadata_json").notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    supersedes_id: uuid("supersedes_id"),
  },
  (table) => [
    index("metric_obs_asset_metric_asof_idx").on(
      table.asset_id,
      table.metric_definition_id,
      table.as_of_date
    ),
    index("metric_obs_period_idx").on(table.period_start, table.period_end),
    index("metric_obs_available_idx").on(table.available_at),
    foreignKey({
      columns: [table.supersedes_id],
      foreignColumns: [table.id],
      name: "metric_observations_supersedes_id_fk",
    }),
  ]
);

// ============================================================
// metric_observation_inputs — §27.9
// Links calculated metrics to their input observations.
// ============================================================
export const metric_observation_inputs = pgTable("metric_observation_inputs", {
  id: uuid("id").primaryKey().defaultRandom(),
  metric_observation_id: uuid("metric_observation_id").notNull().references(() => metric_observations.id),
  input_metric_observation_id: uuid("input_metric_observation_id").notNull().references(() => metric_observations.id),
  relationship_type: text("relationship_type").notNull().default("calculation_input"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// Relations
// ============================================================
export const metricDefinitionsRelations = relations(metric_definitions, ({ many }) => ({
  observations: many(metric_observations),
}));

export const metricObservationsRelations = relations(metric_observations, ({ one }) => ({
  definition: one(metric_definitions, {
    fields: [metric_observations.metric_definition_id],
    references: [metric_definitions.id],
  }),
}));
