import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { assets } from "./core";
import { research_runs } from "./workflow";

// ============================================================
// Investment checklists (Implementations/research-workspace P3). Checklists are global (one operator, no accounts)
// and at most 50; the built-in default is seeded once (is_default). An evaluation keeps a snapshot of the checklist
// it scored, each item's result and the score, so editing or deleting a checklist never rewrites a past evaluation.
// ============================================================
export const investment_checklists = pgTable("investment_checklists", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** The items (`ChecklistItem[]`), validated by `Checklist` on every write. */
  items_json: jsonb("items_json").notNull(),
  is_default: boolean("is_default").notNull().default(false),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("investment_checklists_name_unique").on(t.name),
  uniqueIndex("investment_checklists_one_default").on(t.is_default).where(sql`${t.is_default}`),
]);

export const checklist_evaluations = pgTable("checklist_evaluations", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  research_run_id: uuid("research_run_id").references(() => research_runs.id, { onDelete: "set null" }),
  checklist_id: uuid("checklist_id").references(() => investment_checklists.id, { onDelete: "set null" }),
  /** The checklist as it was scored ({ name, items }). */
  checklist_json: jsonb("checklist_json").notNull(),
  /** `ItemResult[]`: status, value and display, reason, cited evidence. */
  results_json: jsonb("results_json").notNull(),
  score: integer("score").notNull(),
  max: integer("max").notNull(),
  percent: doublePrecision("percent"),
  unknown: integer("unknown").notNull(),
  /** model (judgements by the model call) | none (no call: gate off, nothing to judge, or the call failed). */
  judged_by: text("judged_by").notNull().default("none"),
  judgement_note: text("judgement_note").notNull().default(""),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("checklist_evaluations_asset_idx").on(t.asset_id, t.created_at)]);
