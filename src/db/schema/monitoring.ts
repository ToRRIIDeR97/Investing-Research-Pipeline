import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { assets } from "./core";
import { research_runs } from "./workflow";

// ============================================================
// asset_monitor_checks — results of scripts/monitor-check.ts.
// One row per check of an asset against its latest completed run: new 10-Q/10-K filings on EDGAR,
// the monitoring dashboard KPIs scored on their statements, and whether a refresh is due. A check
// makes no model call and never queues a run; the asset page reads the latest row.
// ============================================================
export const asset_monitor_checks = pgTable(
  "asset_monitor_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    asset_id: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    research_run_id: uuid("research_run_id").references(() => research_runs.id, { onDelete: "set null" }),
    // refresh_due | current | skipped | failed
    status: text("status").notNull(),
    refresh_due: boolean("refresh_due").notNull().default(false),
    reasons_json: jsonb("reasons_json").notNull().default([]),
    filings_json: jsonb("filings_json").notNull().default([]),
    kpis_json: jsonb("kpis_json").notNull().default([]),
    checked_at: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("asset_monitor_checks_asset_checked_idx").on(table.asset_id, table.checked_at)]
);
