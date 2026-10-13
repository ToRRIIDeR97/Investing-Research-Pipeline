import { test } from "node:test";
import assert from "node:assert/strict";
import { evidenceTargets } from "../src/lib/research/handlers/evidence-extraction";
import { evidenceNeeds, evidencePassageBudget, headlineKpis, HEADLINE_KPIS } from "../src/lib/research/memory";
import { evidenceQuote, EVIDENCE_QUOTE_CHARS, rankEvidencePacket } from "../src/lib/research/sources/corpus";
import { businessArchetypes } from "../src/lib/research/archetypes/registry";

test("the evidence target grows with the corpus and keeps the old floor", () => {
  const env = {};
  assert.deepEqual(evidenceTargets("deep_dive", 0, env), { target: 40, floor: 25 });
  // The META run: 25 filings plus about 8 other documents, previously 12 claims.
  assert.equal(evidenceTargets("full_initiation_report", 33, env).target, 139);
  assert.equal(evidenceTargets("quick_update", 3, env).target, 29);
  assert.equal(evidenceTargets("deep_dive", 500, env).target, 160);
  assert.equal(evidenceTargets("deep_dive", 10, { RESEARCH_EVIDENCE_TARGET_BASE: "10", RESEARCH_EVIDENCE_TARGET_PER_SOURCE: "1", RESEARCH_EVIDENCE_TARGET_MAX: "50" }).target, 25);
});

test("the passage budget scales with documents between 32 and the maximum", () => {
  assert.equal(evidencePassageBudget(3, {}), 32);
  assert.equal(evidencePassageBudget(20, {}), 80);
  assert.equal(evidencePassageBudget(40, {}), 128);
  assert.equal(evidencePassageBudget(40, { RESEARCH_EVIDENCE_PASSAGES_MAX: "64" }), 64);
});

test("every archetype has headline KPIs, and an ad platform asks for users, ARPU, impressions and price per ad", () => {
  for (const archetype of businessArchetypes) assert.ok(HEADLINE_KPIS[archetype.key]?.length, archetype.key);
  const kpis = headlineKpis(["operating_company_core", "advertising_platform"]).join(" ");
  for (const term of ["DAP", "ARPU", "ad impressions", "price per ad"]) assert.match(kpis, new RegExp(term));
  assert.deepEqual(headlineKpis(["unknown"]), HEADLINE_KPIS.operating_company_core);
  assert.match(headlineKpis(["bank"]).join(" "), /net interest margin.*deposits.*provision for credit losses/);
});

test("the headline-KPI need follows the founder needs and covers filings and earnings material only", () => {
  const kpis = headlineKpis(["advertising_platform"]);
  const needs = evidenceNeeds(["regulatory_filing", "earnings_release", "industry_primary"], { name: "Meta" }, { passageBudget: 128, kpis });
  assert.deepEqual(needs.map((need) => need.key), ["founder_origin_filings", "headline_kpis", "role:regulatory_filing", "role:earnings_release", "role:industry_primary"]);
  assert.deepEqual(needs[1].sourceRoles, ["regulatory_filing", "earnings_release"]);
  assert.equal(needs[1].maxPassages, 32);
  assert.equal(needs[2].maxPassages, 32);
  assert.ok(!evidenceNeeds(["industry_primary"], { name: "Meta" }, { kpis }).some((need) => need.key === "headline_kpis"));
});

test("the evidence packet ranks by confidence and recency, covers claim types first and puts inventory last", () => {
  const rows = [
    { id: "a", claim_type: "revenue", confidence: "0.9", evidence_date: "2025-12-31" },
    { id: "b", claim_type: "revenue", confidence: "0.9", evidence_date: "2021-12-31" },
    { id: "c", claim_type: "revenue", confidence: "0.85", evidence_date: "2025-12-31" },
    { id: "d", claim_type: "operating_kpi", confidence: "0.7", evidence_date: null },
    { id: "e", claim_type: "source_inventory_fact", confidence: "0.95", evidence_date: "2025-12-31" },
    { id: "f", claim_type: "Operating_KPI", confidence: "0.8", evidence_date: new Date("2025-09-30") },
  ];
  assert.deepEqual(rankEvidencePacket(rows, 10).map((row) => row.id), ["a", "f", "c", "d", "b", "e"]);
  assert.deepEqual(rankEvidencePacket(rows, 3).map((row) => row.id), ["a", "f", "c"]);
  assert.deepEqual(rankEvidencePacket([...rows].reverse(), 10).map((row) => row.id), ["a", "f", "c", "d", "b", "e"]);
});

test("the packet quote is bounded and dropped when it only repeats the claim", () => {
  assert.equal(evidenceQuote("Same claim text.", "Same  claim text."), null);
  assert.equal(evidenceQuote(null, "Claim"), null);
  assert.equal(evidenceQuote("Family daily active people (DAP) was 3.43 billion.", "DAP rose"), "Family daily active people (DAP) was 3.43 billion.");
  const long = evidenceQuote("x".repeat(1000), "Claim")!;
  assert.equal(long.length, EVIDENCE_QUOTE_CHARS);
  assert.ok(long.endsWith("…"));
});
