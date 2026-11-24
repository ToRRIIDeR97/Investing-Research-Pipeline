import { check, date, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ============================================================
// quant_snapshots — the Quant page's cached PragValue and PragTrend result (Implementations/quant-page), one row per
// ticker and as-of trading day. Built by code from SEC facts and stored prices; never a research input.
// ============================================================
export const quant_snapshots = pgTable("quant_snapshots", {
  ticker: text("ticker").notNull(),
  as_of_day: date("as_of_day").notNull(),
  /** ok | partial (a section unavailable) | failed */
  status: text("status").notNull(),
  snapshot_json: jsonb("snapshot_json").notNull(),
  computed_at: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.ticker, t.as_of_day] }),
  check("quant_snapshots_status_check", sql`${t.status} IN ('ok', 'partial', 'failed')`),
]);
