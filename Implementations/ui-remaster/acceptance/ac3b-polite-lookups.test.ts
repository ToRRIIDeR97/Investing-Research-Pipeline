// AC-3 addendum (added after the freeze, see implementation.md): Wikimedia rate limits. A page gets an answer within
// a deadline while slow lookups finish in the background; a rate-limit refusal is never cached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getCompanyProfilesWithin, type CacheRow } from "../../../src/lib/company-profiles/cache";
import { RateLimitedError, wikimediaUserAgent } from "../../../src/lib/company-profiles/resolve";

const profile = (key: string) => ({ key, name: key, wikidata_id: null, logo_url: null, website: null, wikipedia_url: null, people: [] });

test("AC-3b: answers by the deadline with what it has; the slow lookup still lands in the cache", async () => {
  const written: CacheRow[] = [];
  let release!: () => void;
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const result = await getCompanyProfilesWithin([{ name: "Fast", ticker: "FST" }, { name: "Slow", ticker: "SLW" }], {
    read: async () => [], write: async (rows) => { written.push(...rows); },
    resolve: async (s) => { if (s.ticker === "SLW") await slow; return profile(`ticker:${s.ticker}`); },
  }, 50);
  assert.equal(result.profiles.get("ticker:FST")?.name, "ticker:FST");
  assert.equal(result.profiles.get("ticker:SLW"), null);
  assert.deepEqual(result.pending, ["ticker:SLW"]);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(written.map((r) => [r.key, r.status]).sort(), [["ticker:FST", "resolved"], ["ticker:SLW", "resolved"]]);
});

test("AC-3b: a rate-limit refusal writes nothing and keeps the last good profile", async () => {
  const written: CacheRow[] = [];
  const old: CacheRow = { key: "ticker:OLD", status: "resolved", profile: profile("ticker:OLD"), fetched_at: new Date("2020-01-01") };
  const result = await getCompanyProfilesWithin([{ name: "Old", ticker: "OLD" }, { name: "New", ticker: "NEW" }], {
    read: async () => [old], write: async (rows) => { written.push(...rows); },
    resolve: async () => { throw new RateLimitedError(Date.now() + 60_000); },
    transient: (error) => error instanceof RateLimitedError,
  }, 1_000);
  assert.equal(result.profiles.get("ticker:OLD")?.name, "ticker:OLD");
  assert.equal(result.profiles.get("ticker:NEW"), null);
  assert.deepEqual(result.pending, []);
  assert.deepEqual(written, []);
});

test("AC-3b: the User-Agent carries no operator details unless WIKIMEDIA_CONTACT is set", () => {
  delete process.env.WIKIMEDIA_CONTACT;
  assert.equal(wikimediaUserAgent(), "PragmaResearch/1.0 (self-hosted research tool) undici");
  process.env.WIKIMEDIA_CONTACT = "https://example.org/pragma <script>";
  assert.equal(wikimediaUserAgent(), "PragmaResearch/1.0 (https://example.org/pragmascript) undici");
  delete process.env.WIKIMEDIA_CONTACT;
});
