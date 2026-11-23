/**
 * Test assets (end-to-end fixtures such as "sofi-e2e-10e0e85c") stay out of Home, the Research list, search and the
 * Start research list. Pure and client-safe; a direct URL to a test asset still opens.
 */

const E2E_SLUG = /-e2e-[0-9a-f]{6,}/i;

/** True for status `test` or a slug with `-e2e-` followed by 6+ hex characters. */
export function isTestAsset(asset: { slug?: string | null; canonical_name?: string | null; status?: string | null }): boolean {
  if (String(asset.status ?? "").toLowerCase() === "test") return true;
  return E2E_SLUG.test(String(asset.slug ?? ""));
}
