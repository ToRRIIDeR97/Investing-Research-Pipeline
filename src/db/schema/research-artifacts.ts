import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
  unique,
  uniqueIndex,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { assets } from "./core";
import { research_runs } from "./workflow";
import { evidence_claims } from "./evidence";
import { research_profiles } from "./profiles";

// ============================================================
// research_artifacts — §V3-Artifact-Registry
// Versioned analytical artifacts.
// ============================================================
export const research_artifacts = pgTable(
  "research_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    research_run_id: uuid("research_run_id")
      .notNull()
      .references(() => research_runs.id),
    asset_id: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    profile_id: uuid("profile_id").references(() => research_profiles.id),
    artifact_type: text("artifact_type").notNull(),
    scope_key: text("scope_key").notNull(),
    artifact_version: integer("artifact_version").notNull().default(1),
    status: text("status").notNull().default("planned"),
    content_json: jsonb("content_json").notNull().default({}),
    schema_version: text("schema_version").notNull().default("3.0.0"),
    validator_version: text("validator_version").notNull().default("1.0.0"),
    prompt_version: text("prompt_version").notNull().default("1.0.0"),
    validation_result_json: jsonb("validation_result_json").notNull().default({}),
    created_by: text("created_by").notNull(),
    supersedes_artifact_id: uuid("supersedes_artifact_id"),
    accepted_at: timestamp("accepted_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("research_artifacts_run_idx").on(table.research_run_id),
    index("research_artifacts_type_idx").on(table.artifact_type),
    uniqueIndex("research_artifacts_run_type_scope_current_unique")
      .on(table.research_run_id, table.artifact_type, table.scope_key)
      .where(sql`${table.status} = 'accepted'`),
    foreignKey({
      columns: [table.supersedes_artifact_id],
      foreignColumns: [table.id],
      name: "research_artifacts_supersedes_id_fk",
    }),
  ]
);

// ============================================================
// research_artifact_dependencies
// Explicit dependency graph between artifacts.
// ============================================================
export const research_artifact_dependencies = pgTable(
  "research_artifact_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifact_id: uuid("artifact_id")
      .notNull()
      .references(() => research_artifacts.id),
    depends_on_artifact_id: uuid("depends_on_artifact_id")
      .notNull()
      .references(() => research_artifacts.id),
    dependency_type: text("dependency_type").notNull().default("required"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("research_artifact_dependencies_unique").on(
      table.artifact_id,
      table.depends_on_artifact_id
    ),
  ]
);

// ============================================================
// research_artifact_claim_links
// Links artifacts to evidence claims with support type.
// ============================================================
export const research_artifact_claim_links = pgTable(
  "research_artifact_claim_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifact_id: uuid("artifact_id")
      .notNull()
      .references(() => research_artifacts.id),
    evidence_claim_id: uuid("evidence_claim_id")
      .notNull()
      .references(() => evidence_claims.id),
    support_type: text("support_type").notNull().default("supports"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("research_artifact_claim_links_unique").on(
      table.artifact_id,
      table.evidence_claim_id,
      table.support_type
    ),
  ]
);

// ============================================================
// research_assumptions
// Explicit, versioned, ranged assumptions.
// ============================================================
export const research_assumptions = pgTable(
  "research_assumptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    research_run_id: uuid("research_run_id")
      .notNull()
      .references(() => research_runs.id),
    assumption_key: text("assumption_key").notNull(),
    assumption_category: text("assumption_category").notNull(),
    value_numeric: numeric("value_numeric"),
    value_text: text("value_text"),
    unit: text("unit"),
    currency: text("currency"),
    range_low: numeric("range_low"),
    range_high: numeric("range_high"),
    classification: text("classification").notNull(), // disclosed_fact, third_party_data, derived_estimate, analyst_assumption, speculative_option
    causal_mechanism: text("causal_mechanism"),
    time_lag: text("time_lag"),
    falsification_condition: text("falsification_condition"),
    model_input_path: text("model_input_path"),
    confidence: numeric("confidence"),
    status: text("status").notNull().default("draft"),
    assumption_version: integer("assumption_version").notNull().default(1),
    supersedes_assumption_id: uuid("supersedes_assumption_id"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("research_assumptions_run_idx").on(table.research_run_id),
    index("research_assumptions_key_idx").on(table.assumption_key),
    uniqueIndex("research_assumptions_run_key_current_unique")
      .on(table.research_run_id, table.assumption_key)
      .where(sql`${table.status} = 'accepted'`),
    foreignKey({
      columns: [table.supersedes_assumption_id],
      foreignColumns: [table.id],
      name: "research_assumptions_supersedes_id_fk",
    }),
  ]
);

// ============================================================
// research_assumption_claim_links
// Links assumptions to supporting or contradicting evidence claims.
// ============================================================
export const research_assumption_claim_links = pgTable(
  "research_assumption_claim_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assumption_id: uuid("assumption_id")
      .notNull()
      .references(() => research_assumptions.id),
    evidence_claim_id: uuid("evidence_claim_id")
      .notNull()
      .references(() => evidence_claims.id),
    support_type: text("support_type").notNull().default("supports"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("research_assumption_claim_links_unique").on(
      table.assumption_id,
      table.evidence_claim_id,
      table.support_type
    ),
  ]
);

// ============================================================
// Relations
// ============================================================
export const researchArtifactsRelations = relations(research_artifacts, ({ one }) => ({
  run: one(research_runs, {
    fields: [research_artifacts.research_run_id],
    references: [research_runs.id],
  }),
  asset: one(assets, {
    fields: [research_artifacts.asset_id],
    references: [assets.id],
  }),
}));

export const researchAssumptionsRelations = relations(research_assumptions, ({ one }) => ({
  run: one(research_runs, {
    fields: [research_assumptions.research_run_id],
    references: [research_runs.id],
  }),
}));
