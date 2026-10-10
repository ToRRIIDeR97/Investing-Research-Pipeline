import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// ============================================================
// saved_charts — the Financials "My charts" board.
// A definition names line-item and metric keys, not values, so a chart refills with any
// asset's observations. Not scoped to a user: the app has no authentication (#8).
// ============================================================
export const saved_charts = pgTable(
  "saved_charts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    definition_json: jsonb("definition_json").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("saved_charts_created_at_idx").on(table.created_at)]
);
