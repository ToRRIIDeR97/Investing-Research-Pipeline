import { check, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ============================================================
// company_profiles — the display cache for company logos and leadership (Implementations/ui-remaster P2), keyed by
// ticker (`ticker:SOFI`) or cleaned name (`name:bitcoin`). Filled from Wikidata and Wikipedia on first view and
// refreshed after its TTL (resolved 30 days, not_found 7 days, failed 1 hour). Never a report input.
// ============================================================
export const company_profiles = pgTable("company_profiles", {
  key: text("key").primaryKey(),
  /** resolved | not_found | failed */
  status: text("status").notNull(),
  profile_json: jsonb("profile_json"),
  error: text("error"),
  fetched_at: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("company_profiles_status_check", sql`${t.status} IN ('resolved', 'not_found', 'failed')`),
]);
