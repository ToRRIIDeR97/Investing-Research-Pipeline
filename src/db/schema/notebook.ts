import { date, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { assets } from "./core";
import { research_runs } from "./workflow";

// ============================================================
// The investing notebook: one page per asset for the operator's own pins, KPIs, report annotations and journal.
// Rows hold references (exhibit keys, metric keys, report anchors) and the operator's text, never computed values:
// values are drawn from the asset's latest completed run when the page renders. Journal entries are the exception,
// keeping a snapshot of the KPI readings at the time they were written, so then and now can be compared.
// Not scoped to a user: the app has no accounts (#8).
// ============================================================

/** A report exhibit (`exhibits.ts` key) or a Financials metric (`metric-catalogue.ts` key) pinned to the notebook. */
export const notebook_pins = pgTable("notebook_pins", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // exhibit | metric
  ref_key: text("ref_key").notNull(),
  /** Metric pins only: quarterly | annual; "" for exhibits. */
  frequency: text("frequency").notNull().default(""),
  note: text("note").notNull().default(""),
  position: integer("position").notNull().default(0),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("notebook_pins_asset_idx").on(t.asset_id, t.position),
  uniqueIndex("notebook_pins_unique_ref").on(t.asset_id, t.kind, t.ref_key, t.frequency),
]);

/** A KPI the operator tracks, with their own danger (bear) and target (bull) lines in the KPI's display unit. */
export const notebook_kpis = pgTable("notebook_kpis", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  /** A metric-catalogue key ("metric:operating_margin") or a captured observation metric_key ("revenue"). */
  metric_key: text("metric_key").notNull(),
  segment: text("segment"),
  bear_line: doublePrecision("bear_line"),
  bull_line: doublePrecision("bull_line"),
  note: text("note").notNull().default(""),
  position: integer("position").notNull().default(0),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("notebook_kpis_asset_idx").on(t.asset_id, t.position)]);

/**
 * A note on a report chapter, exhibit or paragraph. The anchor records the run and chapter it was written on plus
 * the chapter's coverage keys, so a newer run's report can carry it to the matching chapter (`carryAnnotation`).
 */
export const notebook_annotations = pgTable("notebook_annotations", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  research_run_id: uuid("research_run_id").references(() => research_runs.id, { onDelete: "set null" }),
  section_id: text("section_id").notNull(),
  section_title: text("section_title").notNull().default(""),
  section_coverage: jsonb("section_coverage").notNull().default([]),
  exhibit_key: text("exhibit_key"),
  paragraph_index: integer("paragraph_index"),
  /** The start of the annotated paragraph as it read then, so a moved or rewritten paragraph can still be recognised. */
  quote: text("quote").notNull().default(""),
  body: text("body").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("notebook_annotations_asset_idx").on(t.asset_id, t.created_at)]);

/** A dated thesis journal entry with the KPI readings at the time it was written. */
export const notebook_journal_entries = pgTable("notebook_journal_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  research_run_id: uuid("research_run_id").references(() => research_runs.id, { onDelete: "set null" }),
  entry_date: date("entry_date").notNull(),
  thesis: text("thesis").notNull().default(""),
  price: doublePrecision("price"),
  currency: text("currency"),
  change_my_mind: text("change_my_mind").notNull().default(""),
  body: text("body").notNull().default(""),
  kpi_snapshot: jsonb("kpi_snapshot").notNull().default([]),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("notebook_journal_asset_idx").on(t.asset_id, t.entry_date)]);
