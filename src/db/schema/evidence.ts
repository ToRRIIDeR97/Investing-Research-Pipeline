import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  date,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { assets } from "./core";
import { research_runs } from "./workflow";
import { source_locations } from "./corpus";

// ============================================================
// evidence_claims — §27.8
// Claims with traceable evidence chain.
// claim_category: fact, estimate, assumption, opinion
// ============================================================
export const evidence_claims = pgTable("evidence_claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").notNull().references(() => assets.id),
  research_run_id: uuid("research_run_id").references(() => research_runs.id),
  claim_text: text("claim_text").notNull(),
  claim_type: text("claim_type").notNull(),
  claim_category: text("claim_category").notNull(), // fact, estimate, assumption, opinion
  polarity: text("polarity"),
  period_start: date("period_start"),
  period_end: date("period_end"),
  as_of_date: date("as_of_date"),
  confidence: numeric("confidence"),
  generated_by: text("generated_by").notNull(),
  review_status: text("review_status").notNull().default("pending"),
  reviewed_by: text("reviewed_by"),
  reviewed_at: timestamp("reviewed_at", { withTimezone: true }),
  no_source_reason: text("no_source_reason"),
  metadata_json: jsonb("metadata_json").notNull().default({}),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  supersedes_id: uuid("supersedes_id"), // Self-ref FK added via migration (circular dep at schema level)
}, (table) => [
  index("evidence_claims_run_review_idx").on(table.research_run_id, table.review_status),
]);

// ============================================================
// evidence_links — §27.8
// Links claims to precise source locations.
// support_type: supports, contradicts, context, calculation_source
// ============================================================
export const evidence_links = pgTable("evidence_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  evidence_claim_id: uuid("evidence_claim_id").notNull().references(() => evidence_claims.id),
  source_location_id: uuid("source_location_id").notNull().references(() => source_locations.id),
  support_type: text("support_type").notNull().default("supports"),
  quoted_text: text("quoted_text"),
  confidence: numeric("confidence"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("evidence_links_claim_idx").on(table.evidence_claim_id),
]);

// ============================================================
// claim_relationships — §27.8
// ============================================================
export const claim_relationships = pgTable(
  "claim_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    from_claim_id: uuid("from_claim_id").notNull().references(() => evidence_claims.id),
    to_claim_id: uuid("to_claim_id").notNull().references(() => evidence_claims.id),
    relationship_type: text("relationship_type").notNull(), // supports, contradicts, updates, derives_from, duplicates
    confidence: numeric("confidence"),
    extractor: text("extractor"), // agent that proposed the edge, e.g. source-reader
    extractor_version: text("extractor_version"),
    evidence_location_ids: jsonb("evidence_location_ids").notNull().default([]),
    review_status: text("review_status").notNull().default("unreviewed"), // unreviewed, accepted, rejected
    description: text("description"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("claim_relationships_from_to_type_unique").on(table.from_claim_id, table.to_claim_id, table.relationship_type),
    index("claim_relationships_to_claim_idx").on(table.to_claim_id),
  ]
);

// ============================================================
// source_gaps — §27.8
// Known gaps in source coverage.
// ============================================================
export const source_gaps = pgTable("source_gaps", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").notNull().references(() => assets.id),
  research_run_id: uuid("research_run_id").references(() => research_runs.id),
  gap_key: text("gap_key"),
  description: text("description").notNull(),
  severity: text("severity").notNull(),
  status: text("status").notNull().default("open"),
  owner: text("owner"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolved_at: timestamp("resolved_at", { withTimezone: true }),
  resolution_note: text("resolution_note"),
});

// ============================================================
// Relations
// ============================================================
export const evidenceClaimsRelations = relations(evidence_claims, ({ many }) => ({
  links: many(evidence_links),
}));

export const evidenceLinksRelations = relations(evidence_links, ({ one }) => ({
  claim: one(evidence_claims, {
    fields: [evidence_links.evidence_claim_id],
    references: [evidence_claims.id],
  }),
}));
