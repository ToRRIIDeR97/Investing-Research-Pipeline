import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { research_runs } from "./workflow";

// ============================================================
// valuation_scenarios — named what-ifs saved from the valuation workbench (Implementations/research-workspace P1).
// A row keeps the typed change (`WorkbenchChange`) and the summary the server recomputed from the run's stored
// valuation (`scenarioSummary`), never a value the client sent. Kept apart from research_artifacts so a saved
// scenario can never change a report, its hashes or its approval. At most 50 per run (MAX_SCENARIOS_PER_RUN).
// ============================================================
export const valuation_scenarios = pgTable("valuation_scenarios", {
  id: uuid("id").primaryKey().defaultRandom(),
  research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  rationale: text("rationale").notNull().default(""),
  /** user | assistant (a chat proposal the operator applied and saved). */
  source: text("source").notNull().default("user"),
  change_json: jsonb("change_json").notNull(),
  result_json: jsonb("result_json").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("valuation_scenarios_run_name").on(t.research_run_id, t.name),
  index("valuation_scenarios_run_idx").on(t.research_run_id, t.created_at),
  check("valuation_scenarios_source_check", sql`${t.source} IN ('user', 'assistant')`),
]);
