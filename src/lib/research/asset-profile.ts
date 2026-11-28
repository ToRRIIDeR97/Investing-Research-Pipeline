/**
 * The research profile a new asset starts with. Profiles are seeded (`research_profiles.profile_key`); an asset
 * added from Start research has no explicit choice, so its kind (and, for equities, its sector) picks one.
 * Without a profile the `asset_identity` stage cannot run.
 */
import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

/** The seeded profile key for an asset kind, or null when no seeded profile fits (a crypto asset other than bitcoin). */
export function defaultProfileKeyFor(kind: string | null | undefined, sector: string | null | undefined, slug?: string | null): string | null {
  switch ((kind ?? "").toLowerCase()) {
    case "equity":
      return /^financial/i.test(sector ?? "") ? "financials" : "operating_company";
    case "fund":
    case "etf":
      return "etf_fund";
    case "commodity":
      return "commodity_energy";
    case "crypto_asset":
      return (slug ?? "").toLowerCase() === "bitcoin" ? "bitcoin" : null;
    default:
      return null;
  }
}

/** The newest active profile with this key, or null. */
export async function profileIdForKey(sql: Sql, key: string | null): Promise<string | null> {
  if (!key) return null;
  const [row] = await sql`
    SELECT id FROM research_profiles WHERE profile_key = ${key} AND status = 'active'
    ORDER BY created_at DESC LIMIT 1`;
  return row ? String(row.id) : null;
}
