// Verification (same author as the acceptance set; separately designed cases): AC-1 to AC-4 boundaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commonsFileUrl, parseInfoboxPeople, resolveCompanyProfile, safeImageUrl } from "../../../src/lib/company-profiles/resolve";
import { getCompanyProfiles, type CacheRow } from "../../../src/lib/company-profiles/cache";
import { assetSnapshot } from "../../../src/lib/research/asset-snapshot";
import { SOFI_ENTITIES, SOFI_IMAGES, SOFI_SEARCH, SOFI_WIKITEXT, wikiFetch } from "../fixtures/wiki";
import { monitoring, reportFacts, valuationSet } from "../fixtures/artifacts";

const root = join(__dirname, "../../..");

test("V-1: the brand mark and the shell use the navy accent, and pages load Inter only", () => {
  const css = readFileSync(join(root, "src/app/globals.css"), "utf8");
  assert.doesNotMatch(css, /DM\+Serif|family=DM/);
  assert.match(css, /family=Inter/);
  const mark = readFileSync(join(root, "src/components/brand/logo.tsx"), "utf8");
  assert.doesNotMatch(mark, /#75937d|#1a2a3a/i);
});

test("V-2: hostile wiki values never reach an image src or a name", () => {
  assert.equal(commonsFileUrl("../../evil.svg"), null);
  assert.equal(commonsFileUrl("a/b.png"), null);
  assert.equal(commonsFileUrl("logo.exe"), null);
  assert.equal(commonsFileUrl("Logo\u0000.png"), null);
  assert.equal(commonsFileUrl("File:Apple logo black.svg"), "https://commons.wikimedia.org/wiki/Special:FilePath/Apple%20logo%20black.svg?width=256");
  assert.equal(safeImageUrl("http://upload.wikimedia.org/x.png"), null);
  assert.equal(safeImageUrl("https://upload.wikimedia.org.evil.com/x.png"), null);
  assert.equal(safeImageUrl("javascript:alert(1)"), null);
  assert.equal(safeImageUrl("https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg?utm_source=x"), "https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg");
  const people = parseInfoboxPeople(`{{Infobox company
| key_people = {{plainlist|
* [[Tim Cook]] ([[CEO]])
* <span onclick="x">Jeff Williams</span> (COO)
* [[Arthur Levinson|Art Levinson]] (Chairman)<ref name="a"/>
}}
| founder = [[Steve Jobs]]<br>[[Steve Wozniak]]<br />[[Ronald Wayne]]
}}`);
  assert.deepEqual(people.map((p) => [p.name, p.role, p.title]), [
    ["Tim Cook", "CEO", "Tim Cook"], ["Jeff Williams", "COO", null], ["Art Levinson", "Chairman", "Arthur Levinson"],
    ["Steve Jobs", "Co-founder", "Steve Jobs"], ["Steve Wozniak", "Co-founder", "Steve Wozniak"], ["Ronald Wayne", "Co-founder", "Ronald Wayne"],
  ]);
  assert.deepEqual(parseInfoboxPeople("| founder = [[Satoshi Nakamoto]]\n").map((p) => p.role), ["Founder"]);
});

test("V-2: Wikidata's people are used only when the infobox names nobody; a non-Wikimedia thumbnail is dropped", async () => {
  const entities = structuredClone(SOFI_ENTITIES) as typeof SOFI_ENTITIES & { entities: Record<string, any> };
  entities.entities.Q17020720.claims = { ...entities.entities.Q17020720.claims,
    P169: [{ mainsnak: { datavalue: { value: { id: "Q18631242" } } }, rank: "normal", qualifiers: {} }] } as any;
  const people = { entities: { Q18631242: { id: "Q18631242", labels: { en: { value: "Anthony Noto" } }, sitelinks: { enwiki: { title: "Anthony Noto" } },
    claims: { P18: [{ mainsnak: { datavalue: { value: "Anthony-Noto-Headshot.jpg" } }, rank: "normal" }] } } } };
  const bare = { query: { pages: [{ title: "SoFi", revisions: [{ slots: { main: { content: "{{Infobox company\n| name = SoFi\n}}" } } }] }] } };
  const { fetchJson } = wikiFetch({ search: SOFI_SEARCH, entities, wikitext: bare, people, images: { query: { pages: [] } } });
  const profile = await resolveCompanyProfile({ name: "SoFi", ticker: "SOFI" }, fetchJson);
  assert.deepEqual(profile?.people.map((p) => [p.name, p.role]), [["Anthony Noto", "CEO"]]);
  assert.equal(profile?.people[0].photo_url, "https://commons.wikimedia.org/wiki/Special:FilePath/Anthony-Noto-Headshot.jpg?width=256");

  const evil = { query: { pages: [{ title: "Anthony Noto", thumbnail: { source: "https://evil.example/x.jpg" } }] } };
  const second = await resolveCompanyProfile({ name: "SoFi", ticker: "SOFI" }, wikiFetch({ search: SOFI_SEARCH, entities: SOFI_ENTITIES, wikitext: SOFI_WIKITEXT, images: evil }).fetchJson);
  assert.equal(second?.people[0].photo_url, null);
  // A ticker with a dot matches Wikidata's dash form; class shares are a common case.
  const brk = structuredClone(SOFI_ENTITIES) as any;
  brk.entities.Q17020720.claims.P414[0].qualifiers.P249[0].datavalue.value = "BRK-B";
  assert.ok(await resolveCompanyProfile({ name: "SoFi", ticker: "brk.b" }, wikiFetch({ search: SOFI_SEARCH, entities: brk, wikitext: SOFI_WIKITEXT, images: SOFI_IMAGES }).fetchJson));
});

test("V-2: an assetless subject with no ticker takes the first candidate whose label matches; none matching is null", async () => {
  const search = { search: [{ id: "Q131723", label: "Bitcoin", description: "decentralized cryptocurrency" }] };
  const entities = { entities: { Q131723: { id: "Q131723", labels: { en: { value: "Bitcoin" } }, sitelinks: {}, claims: { P154: [{ mainsnak: { datavalue: { value: "Bitcoin logo.svg" } }, rank: "normal" }] } } } };
  const ok = await resolveCompanyProfile({ name: "Bitcoin", kind: "crypto_asset" }, wikiFetch({ search, entities }).fetchJson);
  assert.equal(ok?.logo_url, "https://commons.wikimedia.org/wiki/Special:FilePath/Bitcoin%20logo.svg?width=256");
  assert.deepEqual(ok?.people, []);
  assert.equal(await resolveCompanyProfile({ name: "Gold" }, wikiFetch({ search: { search: [] } }).fetchJson), null);
});

test("V-3: stale, not-found and failed rows follow their TTLs; a resolver error is cached as failed and returns null", async () => {
  const now = new Date("2026-11-22T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const day = 86_400_000;
  const rows: CacheRow[] = [
    { key: "ticker:OLD", status: "resolved", profile: null, fetched_at: ago(31 * day) },
    { key: "ticker:NF", status: "not_found", profile: null, fetched_at: ago(6 * day) },
    { key: "ticker:NF2", status: "not_found", profile: null, fetched_at: ago(8 * day) },
    { key: "ticker:FAIL", status: "failed", profile: null, fetched_at: ago(30 * 60_000) },
    { key: "ticker:FAIL2", status: "failed", profile: null, fetched_at: ago(2 * 3_600_000) },
  ];
  const resolved: string[] = [];
  const written: CacheRow[] = [];
  let active = 0, peak = 0;
  const subjects = ["OLD", "NF", "NF2", "FAIL", "FAIL2", "BOOM", "A1", "A2", "A3", "A4", "A5"].map((ticker) => ({ name: ticker, ticker }));
  const out = await getCompanyProfiles(subjects, { now: () => now, read: async (keys) => rows.filter((r) => keys.includes(r.key)), write: async (r) => { written.push(...r); },
    resolve: async (s) => {
      active++; peak = Math.max(peak, active); resolved.push(String(s.ticker));
      await new Promise((r) => setTimeout(r, 5)); active--;
      if (s.ticker === "BOOM") throw new Error("network down");
      if (s.ticker === "NF2") return null;
      return { key: `ticker:${s.ticker}`, name: String(s.ticker), wikidata_id: null, logo_url: null, website: null, wikipedia_url: null, people: [] };
    } });
  assert.deepEqual(resolved.sort(), ["A1", "A2", "A3", "A4", "A5", "BOOM", "FAIL2", "NF2", "OLD"]);
  assert.ok(peak <= 4, `peak concurrency ${peak}`);
  assert.equal(out.get("ticker:BOOM"), null);
  assert.equal(out.get("ticker:NF"), null);
  assert.equal(out.get("ticker:OLD")?.name, "OLD");
  const byKey = Object.fromEntries(written.map((r) => [r.key, r]));
  assert.equal(byKey["ticker:BOOM"].status, "failed");
  assert.match(String(byKey["ticker:BOOM"].error), /network down/);
  assert.equal(byKey["ticker:NF2"].status, "not_found");
  assert.equal(byKey["ticker:OLD"].status, "resolved");
});

test("V-3: a write failure still returns the resolved profile", async () => {
  const out = await getCompanyProfiles([{ name: "X", ticker: "X" }], { read: async () => [], write: async () => { throw new Error("db down"); },
    resolve: async () => ({ key: "ticker:X", name: "X", wikidata_id: null, logo_url: null, website: null, wikipedia_url: null, people: [] }) });
  assert.equal(out.get("ticker:X")?.name, "X");
});

test("V-4: the snapshot falls back to the valuation set and a verified price; KPIs are capped at six; unknown columns are not guessed", () => {
  const s = assetSnapshot([valuationSet(true)]);
  assert.ok(s);
  assert.equal(s.price, 14.28);
  assert.equal(s.price_verified, true);
  assert.deepEqual(s.values, { bear: -1.8, base: 1.1, bull: 6.7 });
  assert.deepEqual(s.targets, []);
  assert.deepEqual(s.kpis, []);
  const many = { type: "monitoring_dashboard", content_json: { items: Array.from({ length: 9 }, (_, i) => ({ kpi: `K${i}`, unit: "percent", current_level: i })) } };
  assert.equal(assetSnapshot([reportFacts(), many])!.kpis.length, 6);
  const shuffled = reportFacts({ cases: { columns: ["pv_per_share", "case"], rows: [[2, "base"]] } });
  assert.deepEqual(assetSnapshot([shuffled])!.values, { bear: null, base: 2, bull: null });
  const noColumn = reportFacts({ cases: { columns: ["case", "value"], rows: [["base", 5]] } });
  assert.deepEqual(assetSnapshot([noColumn])!.values, { bear: null, base: null, bull: null });
  // Zero price: no division.
  const zero = assetSnapshot([reportFacts({ market_price: 0 })])!;
  assert.equal(zero.gap.base, null);
  // KPI with equal thresholds has no direction: neutral.
  const flat = { type: "monitoring_dashboard", content_json: { items: [{ kpi: "Flat", unit: "percent", current_level: 3, bear_threshold: 3, bull_threshold: 3 }] } };
  assert.equal(assetSnapshot([reportFacts(), flat])!.kpis[0].tone, "neutral");
  assert.equal(assetSnapshot([reportFacts(), monitoring])!.kpis.find((k) => k.label === "Share count and dilution")!.display, "1.30bn");
});
