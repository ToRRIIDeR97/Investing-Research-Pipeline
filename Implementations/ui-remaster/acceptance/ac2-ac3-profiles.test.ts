// AC-2 and AC-3: company profiles from Wikidata and Wikipedia (stubbed, no network) and the profile cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCompanyName, profileKey, resolveCompanyProfile } from "../../../src/lib/company-profiles/resolve";
import { getCompanyProfiles, type CacheRow } from "../../../src/lib/company-profiles/cache";
import { SOFI_ENTITIES, SOFI_IMAGES, SOFI_SEARCH, SOFI_WIKITEXT, wikiFetch } from "../fixtures/wiki";

const sofi = { name: "SoFi Technologies, Inc.", ticker: "SOFI", kind: "equity" };

test("AC-2: SoFi resolves to its logo, website and leadership, photos only where Wikipedia has one", async () => {
  const { fetchJson } = wikiFetch({ search: SOFI_SEARCH, entities: SOFI_ENTITIES, wikitext: SOFI_WIKITEXT, images: SOFI_IMAGES });
  const profile = await resolveCompanyProfile(sofi, fetchJson);
  assert.ok(profile);
  assert.equal(profile.wikidata_id, "Q17020720");
  assert.equal(profile.logo_url, "https://commons.wikimedia.org/wiki/Special:FilePath/SoFi%20logo.svg?width=256");
  assert.equal(profile.website, "http://sofi.com/");
  assert.deepEqual(profile.people.map((p) => [p.name, p.role]), [
    ["Anthony Noto", "CEO"], ["Chris Lapointe", "CFO"], ["Mike Cagney", "Co-founder"], ["Dan Macklin", "Co-founder"], ["James Finnigan", "Co-founder"], ["Ian Brady", "Co-founder"],
  ]);
  const noto = profile.people[0];
  assert.match(noto.photo_url ?? "", /^https:\/\/thumb\.wikimedia\.org\/wikipedia\/commons\/thumb\/7\/7f\/Anthony-Noto-Headshot\.jpg\//);
  assert.equal(noto.page_url, "https://en.wikipedia.org/wiki/Anthony_Noto");
  assert.equal(profile.people[1].photo_url, null);
  assert.equal(profile.people[1].page_url, null);
  assert.ok(profile.people[2].photo_url);
});

test("AC-2: a ticker that no candidate lists returns null rather than another company's logo", async () => {
  const { fetchJson } = wikiFetch({ search: SOFI_SEARCH, entities: SOFI_ENTITIES, wikitext: SOFI_WIKITEXT, images: SOFI_IMAGES });
  assert.equal(await resolveCompanyProfile({ name: "SoFi Technologies", ticker: "SOFX" }, fetchJson), null);
});

test("AC-3: keys and names normalise; cache hits skip the resolver; misses resolve and are written", async () => {
  assert.equal(cleanCompanyName("SoFi Technologies, Inc. (Test)"), "SoFi Technologies");
  assert.equal(profileKey({ name: "SoFi Technologies, Inc.", ticker: "sofi" }), "ticker:SOFI");
  assert.equal(profileKey({ name: "Bitcoin" }), "name:bitcoin");
  const now = new Date("2026-11-22T00:00:00Z");
  const cached = { key: "ticker:SOFI", name: "SoFi", wikidata_id: "Q1", logo_url: null, website: null, wikipedia_url: null, people: [] };
  const rows: CacheRow[] = [{ key: "ticker:SOFI", status: "resolved", profile: cached, fetched_at: new Date("2026-11-01T00:00:00Z") }];
  const written: CacheRow[] = [];
  const resolved: string[] = [];
  const result = await getCompanyProfiles([sofi, { name: "Apple Inc.", ticker: "AAPL" }, { name: "SoFi", ticker: "SOFI" }], {
    now: () => now,
    read: async (keys) => rows.filter((r) => keys.includes(r.key)),
    write: async (out) => { written.push(...out); },
    resolve: async (s) => { resolved.push(String(s.ticker)); return { ...cached, key: profileKey(s), name: "Apple" }; },
  });
  assert.deepEqual(resolved, ["AAPL"]);
  assert.equal(result.get("ticker:SOFI")?.name, "SoFi");
  assert.equal(result.get("ticker:AAPL")?.name, "Apple");
  assert.deepEqual(written.map((r) => [r.key, r.status]), [["ticker:AAPL", "resolved"]]);
});

test("AC-3: with profiles switched off the resolver is never called", async () => {
  let calls = 0;
  const result = await getCompanyProfiles([sofi], { enabled: false, read: async () => [], write: async () => {}, resolve: async () => { calls++; return null; } });
  assert.equal(calls, 0);
  assert.equal(result.get("ticker:SOFI"), null);
});
