// The database side of the profile cache, and asset ids turned into lookup subjects (name and primary ticker).
import { sqlClient } from "@/db";
import { getCompanyProfilesWithin, lookupThrottled, profilesEnabled, type CacheRow } from "./cache";
import { profileKey, RateLimitedError, resolveCompanyProfile, wikimediaFetchJson, wikimediaIdentified, type CompanyProfile, type CompanySubject } from "./resolve";

// One lookup per key at a time across requests, so a page asking again while a lookup runs joins it.
const inflight = new Map<string, Promise<CompanyProfile | null>>();
function resolveOnce(subject: CompanySubject) {
  const key = profileKey(subject);
  let running = inflight.get(key);
  if (!running) {
    running = resolveCompanyProfile(subject, wikimediaFetchJson).finally(() => inflight.delete(key));
    inflight.set(key, running);
  }
  return running;
}
/** How long a request waits for lookups before answering with what it has (the rest arrive on a later ask). */
const ANSWER_WITHIN_MS = 2_500;

export type LookupSubject = { asset_id: string } | CompanySubject;

async function readRows(keys: string[]): Promise<CacheRow[]> {
  const rows = await sqlClient`SELECT key, status, profile_json, error, fetched_at FROM company_profiles WHERE key = ANY(${keys})`;
  return rows.map((row) => ({ key: String(row.key), status: row.status as CacheRow["status"], profile: (row.profile_json ?? null) as CompanyProfile | null,
    fetched_at: new Date(row.fetched_at as string), error: (row.error as string | null) ?? null }));
}

async function writeRows(rows: CacheRow[]): Promise<void> {
  for (const row of rows) {
    await sqlClient`
      INSERT INTO company_profiles (key, status, profile_json, error, fetched_at)
      VALUES (${row.key}, ${row.status}, ${row.profile ? sqlClient.json(row.profile as never) : null}, ${row.error ?? null}, ${row.fetched_at})
      ON CONFLICT (key) DO UPDATE SET status = EXCLUDED.status, profile_json = EXCLUDED.profile_json, error = EXCLUDED.error, fetched_at = EXCLUDED.fetched_at`;
  }
}

/** Name, kind and primary ticker per asset id; unknown ids are left out. */
export async function assetSubjects(ids: string[]): Promise<Map<string, CompanySubject>> {
  if (!ids.length) return new Map();
  const rows = await sqlClient`
    SELECT a.id, a.canonical_name, a.asset_kind,
      (SELECT l.symbol FROM listings l JOIN instruments i ON i.id = l.instrument_id WHERE i.asset_id = a.id
       ORDER BY l.is_primary DESC, l.created_at ASC LIMIT 1) AS ticker
    FROM assets a WHERE a.id = ANY(${ids}::uuid[])`;
  return new Map(rows.map((row) => [String(row.id), { name: String(row.canonical_name), kind: String(row.asset_kind),
    ticker: row.asset_kind === "equity" && row.ticker ? String(row.ticker) : null }]));
}

/** Profiles for a batch of subjects; `keys[i]` names subject i (null for an unknown asset id); `pending` lists keys
 *  still being looked up, worth asking for again in a few seconds; `throttled` says those lookups run unidentified
 *  (no WIKIMEDIA_CONTACT), so each takes about 30 s. It is a flag only: the contact value never leaves the server. */
export async function lookupCompanyProfiles(subjects: LookupSubject[]) {
  const assetIds = subjects.flatMap((s) => "asset_id" in s ? [s.asset_id] : []);
  const assets = await assetSubjects([...new Set(assetIds)]);
  const resolved = subjects.map((s) => "asset_id" in s ? assets.get(s.asset_id) ?? null : s);
  const keys = resolved.map((s) => s ? profileKey(s) : null);
  const { profiles, pending } = await getCompanyProfilesWithin(resolved.filter((s): s is CompanySubject => !!s), {
    read: readRows, write: writeRows, enabled: profilesEnabled(), resolve: resolveOnce,
    transient: (error) => error instanceof RateLimitedError,
  }, ANSWER_WITHIN_MS);
  return { keys, profiles: Object.fromEntries(profiles) as Record<string, CompanyProfile | null>, pending,
    throttled: lookupThrottled(pending, wikimediaIdentified()) };
}
