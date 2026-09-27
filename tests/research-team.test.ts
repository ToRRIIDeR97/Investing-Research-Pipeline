import assert from "node:assert/strict";
import test from "node:test";
import { readyStages, dependentStages, STAGE_DEPENDENCIES, TEAM_ROLES } from "../src/lib/research/team-plan";
import { requestStageRoots, includeUnansweredQuestions, ResearchRequest, type TeamRequest } from "../src/lib/research/team";
import { STAGE_CONFIGS } from "../src/lib/workflow/stages";
import { discoverRoleSources } from "../src/lib/research/sources/role-discovery";

const ledger = (completed: string[]) => STAGE_CONFIGS.map(s => ({ stage_key: s.key, status: completed.includes(s.key) ? "completed" : "pending" }));
test("the five specialists cover every stage with an acyclic dependency graph", () => {
  assert.equal(Object.keys(TEAM_ROLES).length, 5);
  assert.deepEqual(Object.keys(STAGE_DEPENDENCIES), STAGE_CONFIGS.map(s => s.key));
  const stages = ledger([]);
  let finished = 0;
  while (finished < stages.length) {
    const ready = readyStages(stages);
    assert.ok(ready.length, "dependency graph must make progress");
    stages.filter(s => ready.includes(s.stage_key)).forEach(s => { s.status = "completed"; finished++; });
  }
});

test("collector searches the requested question and only accepts fetched documents within cutoff", async () => {
  const settings = { RESEARCH_WEB_SEARCH_ENDPOINT: "https://search.example/api", RESEARCH_WEB_DISCOVERY_ENABLED: "1",
    RESEARCH_ACCEPTANCE_PROVIDER: undefined, RESEARCH_TEST_MODE: undefined };
  const prior = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(settings)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  const queries: string[] = [];
  const question = '"Acme" disclosed maintenance capex';
  try {
    const sources = await discoverRoleSources({ assetName: "Acme", symbol: "ACME", cutoffAt: "2025-01-01",
      roleQueries: { regulatory_filing: [question] } }, ["regulatory_filing"], async input => {
      const url = new URL(String(input));
      if (url.hostname === "search.example") {
        queries.push(url.searchParams.get("q") || "");
        return new Response(JSON.stringify({ results: [
          { url: "https://issuer.example/annual-report", title: "Annual report" },
          { url: "https://issuer.example/future-report", title: "Future report" },
        ] }), { headers: { "content-type": "application/json" } });
      }
      const date = url.pathname.includes("future") ? "2026-01-01" : "2024-01-01";
      return new Response(`<html><head><title>Acme annual report</title><meta property="article:published_time" content="${date}"></head><body>${"Acme disclosed maintenance and growth investment in the annual report. ".repeat(90)}</body></html>`, { headers: { "content-type": "text/html" } });
    });
    assert.equal(queries[0], question);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].url, "https://issuer.example/annual-report");
    assert.ok(sources[0].content.includes("maintenance"));
  } finally {
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
test("financials and business work overlap while forecasts wait for both branches", () => {
  const stages = ledger(STAGE_CONFIGS.slice(0, 7).map(s => s.key));
  assert.deepEqual(readyStages(stages), ["historical_record", "company_genesis"]);
  stages.find(s => s.stage_key === "company_genesis")!.status = "completed";
  assert.deepEqual(readyStages(stages), ["historical_record", "business_process_analysis"]);
  assert.ok(!readyStages(stages).includes("asset_valuation"));
  stages.find(s => s.stage_key === "research_plan")!.status = "waiting_for_human";
  // Initial plan approval cannot be treated as dependency completion.
  assert.deepEqual(readyStages(ledger(STAGE_CONFIGS.slice(0, 3).map(s => s.key))), ["research_plan"]);
});
test("replaying a specialist invalidates its consumers without reopening plan approval", () => {
  const financial = dependentStages(["historical_record"]);
  for (const key of ["historical_diagnosis", "operating_model", "asset_valuation", "ai_reviewer", "human_review", "export", "refresh_schedule"]) assert.ok(financial.includes(key));
  for (const key of ["research_plan", "source_discovery", "company_genesis"]) assert.ok(!financial.includes(key));
  assert.ok(dependentStages(["source_discovery"]).includes("historical_record"));
});
test("missing disclosure routes to the collector and unresolved material questions block the report", () => {
  const request: TeamRequest = { id: "r1", role: "valuation", question: "What is the disclosed maintenance capex?", material: true, needs_sources: true, source_role: "regulatory_filing" };
  assert.deepEqual(requestStageRoots([request]), ["source_discovery"]);
  assert.deepEqual(requestStageRoots([{ ...request, needs_sources: false }]), ["asset_valuation"]);
  const outline = includeUnansweredQuestions({ sections: [], coverage: [], questions: [] }, { round: 2, state: "answered", requests: [{ ...request, response: { status: "unavailable", answer: "Issuer does not disclose it", evidence_ids: [], artifact_ids: [] } }] });
  assert.equal(outline.questions[0].status, "blocked");
  assert.equal(outline.questions[0].materiality, "material");
  assert.equal(ResearchRequest.safeParse({ ...request, role: "unknown" }).success, false);
  assert.equal(ResearchRequest.safeParse({ ...request, source_role: "invented" }).success, false);
});
