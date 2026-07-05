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
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { assets } from "./core";
import { research_runs } from "./workflow";
import { research_profiles } from "./profiles";
import { metric_definitions } from "./metrics";
import { source_documents } from "./corpus";
import { evidence_claims } from "./evidence";

// ============================================================
// valuation_methods — §27.10
// Canonical registry of valuation methods.
// ============================================================
export const valuation_methods = pgTable("valuation_methods", {
  id: uuid("id").primaryKey().defaultRandom(),
  method_key: text("method_key").unique().notNull(),
  name: text("name").notNull(),
  method_family: text("method_family").notNull(),
  description: text("description"),
  applicable_profile_keys: text("applicable_profile_keys").array().notNull().default([]),
  forbidden_profile_keys: text("forbidden_profile_keys").array().notNull().default([]),
  requires_code: boolean("requires_code").notNull().default(false),
  requires_market_data: boolean("requires_market_data").notNull().default(false),
  metadata_json: jsonb("metadata_json").notNull().default({}),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// valuation_signals — §27.10
// Asset-profile-appropriate valuation signals.
// signal: very_cheap, cheap, neutral, expensive, very_expensive,
//         inconclusive, not_applicable
// ============================================================
export const valuation_signals = pgTable("valuation_signals", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").notNull().references(() => assets.id),
  research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id),
  profile_id: uuid("profile_id").notNull().references(() => research_profiles.id),
  valuation_method_id: uuid("valuation_method_id").references(() => valuation_methods.id),
  metric_definition_id: uuid("metric_definition_id").references(() => metric_definitions.id),
  signal_key: text("signal_key").notNull(),
  signal_name: text("signal_name").notNull(),
  lens_family: text("lens_family").notNull(),
  current_value: numeric("current_value"),
  current_value_text: text("current_value_text"),
  comparison_range_json: jsonb("comparison_range_json").notNull().default({}),
  percentile: numeric("percentile"),
  z_score: numeric("z_score"),
  cheaper_when: text("cheaper_when"),
  signal: text("signal").notNull(), // very_cheap..not_applicable
  cheapness_score: numeric("cheapness_score"),
  confidence: numeric("confidence"),
  source_document_id: uuid("source_document_id").references(() => source_documents.id),
  evidence_claim_id: uuid("evidence_claim_id").references(() => evidence_claims.id),
  metadata_json: jsonb("metadata_json").notNull().default({}),
  review_status: text("review_status").notNull().default("pending"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// scenarios — §27.10
// ============================================================
export const scenarios = pgTable("scenarios", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").notNull().references(() => assets.id),
  research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id),
  scenario_name: text("scenario_name").notNull(),
  scenario_type: text("scenario_type").notNull(),
  time_horizon: text("time_horizon"),
  probability: numeric("probability"),
  value_anchor: numeric("value_anchor"),
  currency: text("currency"),
  assumptions_json: jsonb("assumptions_json").notNull().default({}),
  supporting_claim_ids: uuid("supporting_claim_ids").array().notNull().default([]),
  confidence: numeric("confidence"),
  review_status: text("review_status").notNull().default("pending"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// Relations
// ============================================================
export const valuationMethodsRelations = relations(valuation_methods, ({ many }) => ({
  signals: many(valuation_signals),
}));

export const valuationSignalsRelations = relations(valuation_signals, ({ one }) => ({
  method: one(valuation_methods, {
    fields: [valuation_signals.valuation_method_id],
    references: [valuation_methods.id],
  }),
}));
