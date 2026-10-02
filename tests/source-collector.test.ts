import assert from "node:assert/strict";
import test from "node:test";
import { SOURCE_REQUEST_ROLES, MAX_STAGE_SOURCE_REQUEST_ROUNDS, STAGE_DEPENDENCIES, TEAM_ROLES } from "../src/lib/research/team-plan";
import { parseSourceRequests, sourceRequestContext, sourceRequestRule, MAX_SEARCHES_PER_REQUEST,
  type StageSourceRequests } from "../src/lib/research/sources/source-requests";
import { discoverRoleSources } from "../src/lib/research/sources/role-discovery";

const ledger = (rounds: number, queries: string[] = []): StageSourceRequests => ({ stage_key: "moat_analysis", role: "business",
  rounds: Array.from({ length: rounds }, (_, index) => ({ round: index + 1, task_key: `task-${index}`, state: "fetched" as const,
    requests: queries.map((query, i) => ({ id: `r${i}`, source_role: "peer_company_primary" as const, query, reason: "Compare take rates",
      status: "fetched" as const, documents: [{ source_id: "s1", title: "Peer annual report", url: "https://peer.example/investors/annual-report" }] })) })) });

test("every specialist stage waits for source discovery before it can start", () => {
  const upstream = (stage: string): Set<string> => new Set((STAGE_DEPENDENCIES[stage] || []).flatMap(dependency => [dependency, ...upstream(dependency)]));
  for (const role of SOURCE_REQUEST_ROLES) assert.ok(upstream(TEAM_ROLES[role].stage).has("source_discovery"), role);
  assert.ok(!SOURCE_REQUEST_ROLES.includes("data"));
});

test("specialist requests are validated, deduplicated against earlier asks and capped", () => {
  const prior = ledger(1, ["Sea Limited 2025 annual report 20-F"]);
  const parsed = parseSourceRequests([
    { source_role: "peer_company_primary", query: "sea limited 2025 annual report 20-f", reason: "Already asked in round one" },
    { source_role: "peer_company_primary", query: "Nu Holdings 2025 annual report 20-F", reason: "Compare credit loss rates" },
    { source_role: "peer_company_primary", query: "Nu Holdings 2025 annual report 20-F", reason: "Duplicate within one output" },
    { source_role: "invented_role", query: "Amazon 2025 10-K annual report", reason: "Unknown role is rejected" },
    { source_role: "industry_primary", query: "Banco Central do Brasil Pix statistics 2025", reason: "Payments market share" },
    { source_role: "regulatory_filing", query: "x", reason: "Too short to be a named document" },
    { source_role: "peer_company_primary", query: "StoneCo 2025 annual report 20-F", reason: "Acquiring economics" },
    { source_role: "peer_company_primary", query: "PagSeguro 2025 annual report 20-F", reason: "Over the per-request cap" },
  ], prior);
  assert.equal(parsed.length, MAX_SEARCHES_PER_REQUEST);
  assert.deepEqual(parsed.map(search => search.query), ["Nu Holdings 2025 annual report 20-F",
    "Banco Central do Brasil Pix statistics 2025", "StoneCo 2025 annual report 20-F"]);
  assert.deepEqual(parseSourceRequests(undefined, null), []);
});

test("a stage may ask the collector a bounded number of times and sees what earlier asks found", () => {
  const fresh = sourceRequestContext(null);
  assert.equal(fresh.allowed, true);
  assert.equal(fresh.rounds_used, 0);
  const exhausted = sourceRequestContext(ledger(MAX_STAGE_SOURCE_REQUEST_ROUNDS, ["Sea Limited 2025 annual report 20-F"]));
  assert.equal(exhausted.allowed, false);
  assert.equal(exhausted.previous[0].status, "fetched");
  assert.equal(exhausted.previous[0].documents[0].title, "Peer annual report");
  assert.match(sourceRequestRule(true), /source_requests/);
  assert.match(sourceRequestRule(false), /Do not return source_requests/);
});

test("targeted collector searches run only the named queries and accept a peer filing that does not name the company", async () => {
  const settings = { RESEARCH_WEB_SEARCH_ENDPOINT: "https://search.example/api", RESEARCH_WEB_DISCOVERY_ENABLED: "1",
    RESEARCH_ACCEPTANCE_PROVIDER: undefined, RESEARCH_TEST_MODE: undefined };
  const prior = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(settings)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  const queries: string[] = [];
  const named = ["Sea Limited 2025 annual report 20-F", "Nu Holdings 2025 annual report 20-F"];
  try {
    const sources = await discoverRoleSources({ assetName: "MercadoLibre", symbol: "MELI", cutoffAt: "2026-09-01",
      roleQueries: { peer_company_primary: named }, requestedOnly: true }, ["peer_company_primary"], async input => {
      const url = new URL(String(input));
      if (url.hostname === "search.example") {
        const query = url.searchParams.get("q") || "";
        queries.push(query);
        const issuer = query.startsWith("Sea") ? "sea" : "nu";
        return new Response(JSON.stringify({ results: [
          { url: `https://${issuer}.example/investors/annual-report-2025`, title: "Annual report" },
          { url: `https://${issuer}.example/investors/annual-report-2024`, title: "Prior annual report" },
        ] }), { headers: { "content-type": "application/json" } });
      }
      const issuer = url.hostname.split(".")[0];
      return new Response(`<html><head><title>${issuer} annual report</title><meta property="article:published_time" content="2026-03-01"></head><body>${`The ${issuer} annual report discusses investor results, filing disclosures and marketplace competition. `.repeat(90)}</body></html>`, { headers: { "content-type": "text/html" } });
    });
    // No generic role queries and no seed-site crawling.
    assert.deepEqual(queries, named);
    // One document per named query, even though each search returned two candidates.
    assert.deepEqual(sources.map(source => source.url), ["https://sea.example/investors/annual-report-2025", "https://nu.example/investors/annual-report-2025"]);
    assert.deepEqual(sources.map(source => source.metadata.discovery_query), named);
  } finally {
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
