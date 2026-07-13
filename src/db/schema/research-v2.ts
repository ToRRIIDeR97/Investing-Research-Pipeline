import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { assets } from "./core";
import { research_profiles } from "./profiles";
import { research_runs } from "./workflow";
import { evidence_claims } from "./evidence";
import { metric_observations } from "./metrics";
import { valuation_methods } from "./valuation";
import { backtest_runs } from "./backtesting";

// v2 records make analytical work first-class data instead of hiding it in
// agent task JSON or manufacturing it while exporting a package.
export const analysis_sections = pgTable(
  "analysis_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id),
    profile_id: uuid("profile_id").references(() => research_profiles.id),
    module_key: text("module_key").notNull(),
    title: text("title").notNull(),
    content_json: jsonb("content_json").notNull().default({}),
    supporting_claim_ids: uuid("supporting_claim_ids").array().notNull().default([]),
    status: text("status").notNull().default("draft"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("analysis_sections_run_module_unique").on(table.research_run_id, table.module_key),
    index("analysis_sections_run_idx").on(table.research_run_id),
  ]
);

export const valuation_model_runs = pgTable(
  "valuation_model_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id),
    asset_id: uuid("asset_id").notNull().references(() => assets.id),
    profile_id: uuid("profile_id").notNull().references(() => research_profiles.id),
    valuation_method_id: uuid("valuation_method_id").references(() => valuation_methods.id),
    model_key: text("model_key").notNull(),
    status: text("status").notNull().default("pending"),
    input_manifest_json: jsonb("input_manifest_json").notNull().default({}),
    assumptions_json: jsonb("assumptions_json").notNull().default([]),
    outputs_json: jsonb("outputs_json").notNull().default({}),
    validation_json: jsonb("validation_json").notNull().default({}),
    reproducible: boolean("reproducible").notNull().default(false),
    error_message: text("error_message"),
    started_at: timestamp("started_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("valuation_model_runs_run_idx").on(table.research_run_id)]
);

export const valuation_artifacts = pgTable(
  "valuation_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    valuation_model_run_id: uuid("valuation_model_run_id")
      .notNull()
      .references(() => valuation_model_runs.id),
    artifact_type: text("artifact_type").notNull(),
    title: text("title").notNull(),
    storage_path: text("storage_path").notNull(),
    content_hash: text("content_hash"),
    metadata_json: jsonb("metadata_json").notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("valuation_artifacts_model_idx").on(table.valuation_model_run_id)]
);

export const indicator_definitions = pgTable(
  "indicator_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id),
    profile_id: uuid("profile_id").notNull().references(() => research_profiles.id),
    indicator_key: text("indicator_key").notNull(),
    name: text("name").notNull(),
    family: text("family").notNull(),
    hypothesis: text("hypothesis").notNull(),
    calculation_json: jsonb("calculation_json").notNull().default({}),
    input_metric_ids: uuid("input_metric_ids").array().notNull().default([]),
    supporting_claim_ids: uuid("supporting_claim_ids").array().notNull().default([]),
    lookahead_risk: text("lookahead_risk").notNull(),
    backtestability: text("backtestability").notNull(),
    status: text("status").notNull().default("draft"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("indicator_definitions_run_key_unique").on(table.research_run_id, table.indicator_key),
    index("indicator_definitions_run_idx").on(table.research_run_id),
  ]
);

export const indicator_observations = pgTable(
  "indicator_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    indicator_definition_id: uuid("indicator_definition_id")
      .notNull()
      .references(() => indicator_definitions.id),
    observed_at: timestamp("observed_at", { withTimezone: true }).notNull(),
    available_at: timestamp("available_at", { withTimezone: true }).notNull(),
    value_numeric: numeric("value_numeric"),
    value_text: text("value_text"),
    input_observation_ids: uuid("input_observation_ids").array().notNull().default([]),
    metadata_json: jsonb("metadata_json").notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("indicator_observations_definition_available_idx").on(table.indicator_definition_id, table.available_at)]
);

export const strategy_combinations = pgTable(
  "strategy_combinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id),
    combination_key: text("combination_key").notNull(),
    name: text("name").notNull(),
    hypothesis: text("hypothesis").notNull(),
    definition_json: jsonb("definition_json").notNull().default({}),
    status: text("status").notNull().default("proposed"),
    backtest_run_id: uuid("backtest_run_id").references(() => backtest_runs.id),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("strategy_combinations_run_key_unique").on(table.research_run_id, table.combination_key),
    index("strategy_combinations_run_idx").on(table.research_run_id),
  ]
);

// Intentional imports above retain strong schema ownership for the IDs that
// appear in JSON manifests. These aliases make the cross-table dependency
// visible to consumers without requiring a separate ORM abstraction layer.
export type ResearchV2References = {
  evidenceClaim: typeof evidence_claims.$inferSelect;
  metricObservation: typeof metric_observations.$inferSelect;
};
