import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  date,
  jsonb,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { assets } from "./core";
import { research_runs } from "./workflow";

// ============================================================
// theses — §27.11
// ============================================================
export const theses = pgTable("theses", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").notNull().references(() => assets.id),
  research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id),
  one_sentence_thesis: text("one_sentence_thesis").notNull(),
  why_now: text("why_now"),
  market_missing: text("market_missing"),
  status: text("status").notNull().default("draft"),
  created_by: text("created_by").notNull(),
  reviewed_by: text("reviewed_by"),
  reviewed_at: timestamp("reviewed_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// thesis_drivers — §27.11
// ============================================================
export const thesis_drivers = pgTable("thesis_drivers", {
  id: uuid("id").primaryKey().defaultRandom(),
  thesis_id: uuid("thesis_id").notNull().references(() => theses.id),
  driver_name: text("driver_name").notNull(),
  driver_type: text("driver_type").notNull(),
  description: text("description"),
  value_impact: text("value_impact"),
  confidence: numeric("confidence"),
  evidence_claim_ids: uuid("evidence_claim_ids").array().notNull().default([]),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// risks — §27.11
// ============================================================
export const risks = pgTable("risks", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").notNull().references(() => assets.id),
  research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id),
  risk_name: text("risk_name").notNull(),
  risk_type: text("risk_type").notNull(),
  description: text("description"),
  severity: text("severity").notNull(),
  probability: text("probability"),
  evidence_claim_ids: uuid("evidence_claim_ids").array().notNull().default([]),
  mitigants_json: jsonb("mitigants_json").notNull().default([]),
  what_would_confirm: text("what_would_confirm"),
  what_would_disconfirm: text("what_would_disconfirm"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// catalysts — §27.11
// ============================================================
export const catalysts = pgTable("catalysts", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").notNull().references(() => assets.id),
  research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id),
  catalyst_name: text("catalyst_name").notNull(),
  catalyst_type: text("catalyst_type").notNull(),
  expected_date: date("expected_date"),
  date_confidence: text("date_confidence"),
  description: text("description"),
  upside_downside: text("upside_downside"),
  evidence_claim_ids: uuid("evidence_claim_ids").array().notNull().default([]),
  status: text("status").notNull().default("open"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// review_decisions — §27.11
// Human review is the acceptance gate.
// ============================================================
export const review_decisions = pgTable("review_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").notNull().references(() => assets.id),
  research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id),
  status: text("status").notNull(),
  conviction: text("conviction"),
  priority: text("priority"),
  watchlist_reason: text("watchlist_reason"),
  position_sizing_note: text("position_sizing_note"),
  what_would_change_mind: text("what_would_change_mind"),
  open_questions: text("open_questions"),
  follow_up_date: date("follow_up_date"),
  reviewed_by: text("reviewed_by").notNull(),
  reviewed_at: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// notebooks — §27.11
// ============================================================
export const notebooks = pgTable("notebooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").references(() => assets.id),
  research_run_id: uuid("research_run_id").references(() => research_runs.id),
  title: text("title").notNull(),
  notebook_type: text("notebook_type").notNull(),
  created_by: text("created_by").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// note_blocks — §27.11
// Block types: paragraph, heading, table, chart, checklist,
// source_quote, metric_embed, valuation_embed, backtest_embed,
// memo_section
// ============================================================
export const note_blocks = pgTable(
  "note_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    notebook_id: uuid("notebook_id").notNull().references(() => notebooks.id),
    parent_block_id: uuid("parent_block_id"),
    block_order: integer("block_order").notNull(),
    block_type: text("block_type").notNull(),
    content_json: jsonb("content_json").notNull(),
    created_by: text("created_by").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.parent_block_id],
      foreignColumns: [table.id],
      name: "note_blocks_parent_block_id_fk",
    }),
  ]
);

// ============================================================
// note_links — §27.11
// ============================================================
export const note_links = pgTable("note_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  note_block_id: uuid("note_block_id").notNull().references(() => note_blocks.id),
  target_type: text("target_type").notNull(),
  target_id: uuid("target_id").notNull(),
  relationship_type: text("relationship_type").notNull().default("references"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// exports — §27.11
// Generated artifacts: markdown, pdf, csv, etc.
// ============================================================
export const exports = pgTable("exports", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").references(() => assets.id),
  research_run_id: uuid("research_run_id").references(() => research_runs.id),
  export_type: text("export_type").notNull(),
  template_version: text("template_version"),
  storage_path: text("storage_path").notNull(),
  content_hash: text("content_hash"),
  generated_by: text("generated_by").notNull(),
  generated_at: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  metadata_json: jsonb("metadata_json").notNull().default({}),
});

// ============================================================
// Relations
// ============================================================
export const thesesRelations = relations(theses, ({ many }) => ({
  drivers: many(thesis_drivers),
}));

export const thesisDriversRelations = relations(thesis_drivers, ({ one }) => ({
  thesis: one(theses, {
    fields: [thesis_drivers.thesis_id],
    references: [theses.id],
  }),
}));

export const notebooksRelations = relations(notebooks, ({ many }) => ({
  blocks: many(note_blocks),
}));

export const noteBlocksRelations = relations(note_blocks, ({ one, many }) => ({
  notebook: one(notebooks, {
    fields: [note_blocks.notebook_id],
    references: [notebooks.id],
  }),
  links: many(note_links),
}));

export const noteLinksRelations = relations(note_links, ({ one }) => ({
  block: one(note_blocks, {
    fields: [note_links.note_block_id],
    references: [note_blocks.id],
  }),
}));
