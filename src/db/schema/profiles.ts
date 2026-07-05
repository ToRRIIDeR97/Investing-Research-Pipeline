import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { assets } from "./core";
import { research_runs } from "./workflow";

// ============================================================
// research_profiles — §27.5
// Asset-specific research profiles define required modules,
// allowed methods, forbidden methods, and completion criteria.
// ============================================================
export const research_profiles = pgTable(
  "research_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_key: text("profile_key").notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull().default("active"),
    asset_kinds: text("asset_kinds").array().notNull().default([]),
    description: text("description"),
    required_modules_json: jsonb("required_modules_json").notNull().default([]),
    optional_modules_json: jsonb("optional_modules_json").notNull().default([]),
    forbidden_methods_json: jsonb("forbidden_methods_json").notNull().default([]),
    required_valuation_lenses_json: jsonb("required_valuation_lenses_json")
      .notNull()
      .default([]),
    required_scenario_drivers_json: jsonb("required_scenario_drivers_json")
      .notNull()
      .default([]),
    completion_criteria_json: jsonb("completion_criteria_json").notNull().default({}),
    validator_config_json: jsonb("validator_config_json").notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("research_profiles_key_version_unique").on(table.profile_key, table.version),
  ]
);

// ============================================================
// profile_module_schemas — §27.5
// JSON schema for individual profile modules.
// ============================================================
export const profile_module_schemas = pgTable(
  "profile_module_schemas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profile_id: uuid("profile_id").notNull().references(() => research_profiles.id),
    module_key: text("module_key").notNull(),
    schema_version: integer("schema_version").notNull(),
    json_schema: jsonb("json_schema").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("profile_module_schemas_unique").on(
      table.profile_id,
      table.module_key,
      table.schema_version
    ),
  ]
);

// ============================================================
// asset_profile_assignments — §27.5
// Links assets (or research runs) to their selected profile.
// ============================================================
export const asset_profile_assignments = pgTable("asset_profile_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").notNull().references(() => assets.id),
  research_run_id: uuid("research_run_id").references(() => research_runs.id),
  profile_id: uuid("profile_id").notNull().references(() => research_profiles.id),
  assignment_reason: text("assignment_reason"),
  assigned_by: text("assigned_by").notNull(),
  confidence: numeric("confidence"),
  status: text("status").notNull().default("active"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// Relations
// ============================================================
export const researchProfilesRelations = relations(research_profiles, ({ many }) => ({
  module_schemas: many(profile_module_schemas),
  assignments: many(asset_profile_assignments),
}));

export const profileModuleSchemasRelations = relations(profile_module_schemas, ({ one }) => ({
  profile: one(research_profiles, {
    fields: [profile_module_schemas.profile_id],
    references: [research_profiles.id],
  }),
}));

export const assetProfileAssignmentsRelations = relations(asset_profile_assignments, ({ one }) => ({
  profile: one(research_profiles, {
    fields: [asset_profile_assignments.profile_id],
    references: [research_profiles.id],
  }),
}));
