import { index, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { check } from "drizzle-orm/pg-core";

// ============================================================
// theme_research — theme research v1 (Implementations/research-workspace P4). One row per theme the operator asks
// about: the validated request, the pipeline's status and its result (framing, candidates with source agreement,
// exclusions, scorecard, ranked shortlist, ownership options). Global, at most MAX_THEMES rows; never a report input.
// ============================================================
export const theme_research = pgTable("theme_research", {
  id: uuid("id").primaryKey().defaultRandom(),
  theme: text("theme").notNull(),
  request_json: jsonb("request_json").notNull(),
  /** pending | running | completed | failed */
  status: text("status").notNull().default("pending"),
  result_json: jsonb("result_json"),
  error: text("error"),
  cost_usd: numeric("cost_usd").notNull().default("0"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  started_at: timestamp("started_at", { withTimezone: true }),
  completed_at: timestamp("completed_at", { withTimezone: true }),
}, (t) => [
  index("theme_research_created_idx").on(t.created_at),
  check("theme_research_status_check", sql`${t.status} IN ('pending', 'running', 'completed', 'failed')`),
]);
