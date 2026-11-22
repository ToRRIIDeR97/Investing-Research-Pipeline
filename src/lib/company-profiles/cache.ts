// The profile cache in front of resolveCompanyProfile: fresh rows are served as they are, missing or stale keys are
// resolved (at most four at a time) and written back as each finishes. A failed lookup is cached briefly and never
// throws, so a page asking for logos always gets an answer: a profile, or null and a monogram. A transient refusal
// (Wikimedia's rate limit) is not cached at all; the key is simply asked again later.
import { profileKey, type CompanyProfile, type CompanySubject } from "./resolve";

export type CacheStatus = "resolved" | "not_found" | "failed";
export interface CacheRow { key: string; status: CacheStatus; profile: CompanyProfile | null; fetched_at: Date; error?: string | null }
export interface CacheDeps {
  read: (keys: string[]) => Promise<CacheRow[]>;
  write: (rows: CacheRow[]) => Promise<void>;
  resolve: (subject: CompanySubject) => Promise<CompanyProfile | null>;
  now?: () => Date;
  /** False with COMPANY_PROFILES=off: no lookups, cached profiles only. */
  enabled?: boolean;
  /** Errors that mean "not now" (rate limits): nothing is written for them. */
  transient?: (error: unknown) => boolean;
}

const HOUR = 3_600_000;
export const PROFILE_TTL_MS: Record<CacheStatus, number> = { resolved: 30 * 24 * HOUR, not_found: 7 * 24 * HOUR, failed: HOUR };
const CONCURRENCY = 4;

export const profilesEnabled = () => process.env.COMPANY_PROFILES !== "off";

/** Pending lookups are slow (about 30 s a company) only while they run unidentified, without WIKIMEDIA_CONTACT. */
export const lookupThrottled = (pending: readonly string[], identified: boolean) => pending.length > 0 && !identified;

interface Started { out: Map<string, CompanyProfile | null>; pending: Set<string>; done: Promise<void> }

function start(subjects: CompanySubject[], deps: CacheDeps): Started {
  const out = new Map<string, CompanyProfile | null>();
  const pending = new Set<string>();
  const bySubject = new Map<string, CompanySubject>();
  for (const subject of subjects) { const key = profileKey(subject); if (!bySubject.has(key)) bySubject.set(key, subject); }
  const keys = [...bySubject.keys()];
  // Every key counts as pending until the cache has been read.
  for (const key of keys) { out.set(key, null); pending.add(key); }
  const done = (async () => {
    if (!keys.length) return;
    const now = (deps.now ?? (() => new Date()))();
    let cached: CacheRow[] = [];
    try { cached = await deps.read(keys); } catch { cached = []; }
    const rows = new Map(cached.map((row) => [row.key, row]));
    const fresh = (row: CacheRow) => now.getTime() - new Date(row.fetched_at).getTime() < PROFILE_TTL_MS[row.status];
    const queue: string[] = [];
    for (const key of keys) {
      const row = rows.get(key);
      // A failed refresh keeps the last good profile in its row, so it is served too.
      if (row?.profile) out.set(key, row.profile);
      if (deps.enabled !== false && (!row || !fresh(row))) queue.push(key);
      else pending.delete(key);
    }
    const save = async (row: CacheRow) => { try { await deps.write([row]); } catch (error) { console.error("Could not cache a company profile:", error); } };
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const key = queue[next++];
        try {
          const profile = await deps.resolve(bySubject.get(key)!);
          const stored = profile ? { ...profile, key } : null;
          out.set(key, stored);
          await save({ key, status: stored ? "resolved" : "not_found", profile: stored, fetched_at: now, error: null });
        } catch (error) {
          if (!deps.transient?.(error)) {
            const stale = out.get(key) ?? null;
            await save({ key, status: "failed", profile: stale, fetched_at: now, error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
          }
        } finally { pending.delete(key); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  })();
  return { out, pending, done };
}

/** One profile (or null) per distinct subject key, after every lookup has finished. */
export async function getCompanyProfiles(subjects: CompanySubject[], deps: CacheDeps): Promise<Map<string, CompanyProfile | null>> {
  const started = start(subjects, deps);
  await started.done;
  return started.out;
}

/**
 * The same, but answers by `deadlineMs`: profiles known by then, plus the keys still being looked up. The lookups
 * carry on in the background and land in the cache, so asking again later returns them.
 */
export async function getCompanyProfilesWithin(subjects: CompanySubject[], deps: CacheDeps, deadlineMs: number) {
  const started = start(subjects, deps);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([started.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, deadlineMs); })]);
  clearTimeout(timer);
  return { profiles: new Map(started.out), pending: [...started.pending] };
}
