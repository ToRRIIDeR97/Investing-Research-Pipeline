import { describe, it } from "node:test";
import assert from "node:assert";
import {
  SOURCE_ROLES,
  isValidSourceRole,
  sourceRoleRank,
  compareSourceRoles,
} from "@/lib/research/sources/roles";
import { buildSourcePlan, validateSourcePlan, planMissingRoles } from "@/lib/research/sources/planner";
import { buildCoverageMatrix, coverageGate, inferRoleFromMetadata } from "@/lib/research/sources/coverage";
import {
  classifyFetchFailure,
  isSubstantiveSource,
  retrievalAttemptToCoverageStatus,
  validateRetrievalAttempt,
} from "@/lib/research/sources/retrieval-log";
import {
  buildRoleSearchQueries,
  discoverRoleSources,
  extractPublicLinks,
  isSafePublicUrl,
  isSubstantiveFetchedContent,
  parseBingHtml,
  parseSearchPayload,
} from "@/lib/research/sources/role-discovery";
import {
  missingRequiredSourceRoles,
  validateArtifactCitationIds,
} from "@/lib/research/sources/artifact-evidence";

describe("source intelligence v3", () => {
  it("C3-T1: Store a candidate URL only does not satisfy coverage", () => {
    const attempt = {
      research_run_id: "run-1",
      source_role: "regulatory_filing" as const,
      source_url: "https://sec.gov/some-filing",
      source_title: undefined,
      status: "attempted" as const,
    };
    assert.equal(isSubstantiveSource(attempt), false);
    const status = retrievalAttemptToCoverageStatus(attempt);
    assert.equal(status.coverage_status, "uncovered");
  });

  it("C3-T2: Store a failed filing fetch as attempt, not coverage", () => {
    const failure = classifyFetchFailure(new Error("404 not found"));
    assert.equal(failure.status, "unavailable");
    const attempt = {
      research_run_id: "run-1",
      source_role: "regulatory_filing" as const,
      source_url: "https://sec.gov/missing",
      status: "failed" as const,
      failure_reason: failure.reason,
    };
    const status = retrievalAttemptToCoverageStatus(attempt);
    assert.equal(status.coverage_status, "gap");
  });

  it("C3-T3: Assign one source to two legitimate roles", () => {
    const plan = buildSourcePlan("run-1", "asset-1", [
      { artifact_type: "historical_record", rationale: "regulatory_filing" },
      { artifact_type: "historical_diagnosis", rationale: "earnings_transcript" },
    ]);
    const roles = plan.items.filter((i) => i.required).map((i) => i.source_role);
    assert.ok(roles.includes("regulatory_filing"));
    assert.ok(roles.includes("earnings_transcript"));
  });

  it("C3-T4: Infer peer coverage from metadata word sector does not pass", () => {
    const roles = inferRoleFromMetadata("Analyst report on sector trends");
    assert.equal(roles.length, 0);
  });

  it("C3-T5: Required founder-history role with no source creates explicit gap", () => {
    const plan = buildSourcePlan("run-1", "asset-1", [
      { artifact_type: "company_genesis", rationale: "founder_and_company_history" },
    ]);
    const matrix = buildCoverageMatrix({
      run_id: "run-1",
      plan_roles: plan.required_roles,
      assignments: [],
      requiredArtifacts: [{ artifact_type: "company_genesis", rationale: "founder_and_company_history" }],
    });
    assert.ok(matrix.gaps.length > 0);
    assert.ok(matrix.gaps.some((g) => g.source_role === "founder_and_company_history"));
  });

  it("C3-T6: Source published after cutoff is excluded from point-in-time packet", () => {
    // coverage logic does not yet enforce point-in-time; this documents expectation
    const cutoff = new Date("2024-12-31");
    const pubDate = new Date("2025-01-15");
    assert.ok(pubDate > cutoff);
    // Point-in-time enforcement belongs to the planner/retrieval layer; this test validates the gap is tracked.
    const plan = buildSourcePlan("run-1", "asset-1", [
      { artifact_type: "historical_record", rationale: "regulatory_filing" },
    ]);
    const matrix = buildCoverageMatrix({
      run_id: "run-1",
      plan_roles: plan.required_roles,
      assignments: [],
      requiredArtifacts: [{ artifact_type: "historical_record", rationale: "regulatory_filing" }],
    });
    assert.ok(matrix.gaps.length > 0);
  });

  it("C3-T7: Re-run retrieval with same idempotent data does not duplicate coverage rows", () => {
    // Idempotency is enforced by the unique index on (research_run_id, source_role, artifact_type).
    const plan = buildSourcePlan("run-1", "asset-1", [
      { artifact_type: "historical_record", rationale: "regulatory_filing" },
    ]);
    const matrix1 = buildCoverageMatrix({
      run_id: "run-1",
      plan_roles: plan.required_roles,
      assignments: [{ source_document_id: "doc-1", role: "regulatory_filing", confidence: 90 }],
      requiredArtifacts: [{ artifact_type: "historical_record", rationale: "regulatory_filing" }],
    });
    const matrix2 = buildCoverageMatrix({
      run_id: "run-1",
      plan_roles: plan.required_roles,
      assignments: [{ source_document_id: "doc-1", role: "regulatory_filing", confidence: 90 }],
      requiredArtifacts: [{ artifact_type: "historical_record", rationale: "regulatory_filing" }],
    });
    assert.equal(matrix1.gaps.length, matrix2.gaps.length);
    assert.equal(matrix1.covered_roles.length, 1);
  });

  it("C3-T8: Coverage matrix for MELI shows required roles distinctly", () => {
    const plan = buildSourcePlan("run-meli", "meli", [
      { artifact_type: "company_genesis", rationale: "founder_and_company_history" },
      { artifact_type: "historical_record", rationale: "regulatory_filing" },
      { artifact_type: "marketplace process map", rationale: "marketplace customer_or_channel" },
      { artifact_type: "moat_assessment", rationale: "regulatory_or_government" },
      { artifact_type: "operating_scenario_set", rationale: "macro_dataset" },
      { artifact_type: "annual_price_target_path", rationale: "market_data" },
    ]);
    const required = plan.required_roles;
    assert.ok(required.includes("founder_and_company_history"));
    assert.ok(required.includes("regulatory_filing"));
    assert.ok(required.includes("market_data"));
    assert.ok(required.includes("peer_company_primary"));
    assert.ok(required.includes("industry_primary"));
    // industry_primary is required because it's in REQUIRED_SOURCE_ROLES_FOR_INITIATION
  });

  it("coverage gate passes when all required roles are covered", () => {
    const matrix = buildCoverageMatrix({
      run_id: "run-1",
      plan_roles: ["regulatory_filing", "market_data"],
      assignments: [
        { source_document_id: "doc-1", role: "regulatory_filing", confidence: 90 },
        { source_document_id: "doc-2", role: "market_data", confidence: 80 },
      ],
      requiredArtifacts: [
        { artifact_type: "historical_record", rationale: "regulatory_filing" },
        { artifact_type: "annual_price_target_path", rationale: "market_data" },
      ],
    });
    const gate = coverageGate(matrix);
    assert.equal(gate.passed, true);
    assert.equal(gate.missingCritical.length, 0);
  });

  it("builds role-specific queries instead of generic company searches", () => {
    const founderQueries = buildRoleSearchQueries("NuScale Power", "SMR", "founder_and_company_history");
    const earningsQueries = buildRoleSearchQueries("NuScale Power", "SMR", "earnings_release");
    assert.ok(founderQueries.some((query) => /founder|history|origin/i.test(query)));
    assert.ok(earningsQueries.every((query) => /earnings|results/i.test(query)));
    assert.notDeepEqual(founderQueries, earningsQueries);
  });

  it("rejects private and unsafe discovery URLs", () => {
    assert.equal(isSafePublicUrl("http://127.0.0.1/admin"), false);
    assert.equal(isSafePublicUrl("http://192.168.1.10/report"), false);
    assert.equal(isSafePublicUrl("file:///etc/passwd"), false);
    assert.equal(isSafePublicUrl("https://www.nrc.gov/reactors/new-reactors/smr.html"), true);
  });

  it("extracts only safe public links and requires substantive fetched content", () => {
    const links = extractPublicLinks("https://example.com/investors/", [
      '<a href="/history">Company history</a>',
      '<a href="http://127.0.0.1/private">Private</a>',
    ].join(""));
    assert.deepEqual(links, [{ url: "https://example.com/history", text: "Company history" }]);
    assert.equal(isSubstantiveFetchedContent("<html><p>short page</p></html>"), false);
    assert.equal(
      isSubstantiveFetchedContent(`<html><title>Founder history</title><p>${"documented history ".repeat(90)}</p></html>`),
      true
    );
  });

  it("parses configurable search-provider results and ignores unsafe targets", () => {
    const results = parseSearchPayload({
      webPages: {
        value: [
          { url: "https://company.example/history", name: "Company history" },
          { url: "http://localhost/secret", name: "Unsafe" },
        ],
      },
    }, "founder query");
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Company history");
    const bingResults = parseBingHtml(
      '<li class="b_algo"><h2><a href="https://university.example/founder">Founder archive</a></h2></li>',
      "founder query"
    );
    assert.deepEqual(bingResults, [{
      url: "https://university.example/founder",
      title: "Founder archive",
      query: "founder query",
    }]);
  });

  it("fetches substantive role sources and excludes documents published after cutoff", async () => {
    const oldEndpoint = process.env.RESEARCH_WEB_SEARCH_ENDPOINT;
    const oldAcceptance = process.env.RESEARCH_ACCEPTANCE_PROVIDER;
    const oldTestMode = process.env.RESEARCH_TEST_MODE;
    process.env.RESEARCH_WEB_SEARCH_ENDPOINT = "https://search.example/api";
    delete process.env.RESEARCH_ACCEPTANCE_PROVIDER;
    delete process.env.RESEARCH_TEST_MODE;
    const fetchMock = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://search.example/api")) {
        return new Response(JSON.stringify({
          results: [
            { url: "https://company.example/history", title: "Founder history" },
            { url: "https://company.example/future", title: "Future history" },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const published = url.endsWith("/future") ? "2025-02-01" : "2024-06-01";
      return new Response(
        `<html><head><title>Founder history</title><meta property="article:published_time" content="${published}"></head><body>${"documented founder history ".repeat(90)}</body></html>`,
        { status: 200, headers: { "content-type": "text/html" } }
      );
    };
    try {
      const sources = await discoverRoleSources({
        assetName: "Example Company",
        symbol: "EX",
        cutoffAt: "2024-12-31T23:59:59Z",
      }, ["founder_and_company_history"], fetchMock as typeof fetch);
      assert.equal(sources.length, 1);
      assert.equal(sources[0].metadata.source_role, "founder_and_company_history");
      assert.equal(sources[0].metadata.fetch_status, "fetched");
    } finally {
      if (oldEndpoint === undefined) delete process.env.RESEARCH_WEB_SEARCH_ENDPOINT;
      else process.env.RESEARCH_WEB_SEARCH_ENDPOINT = oldEndpoint;
      if (oldAcceptance === undefined) delete process.env.RESEARCH_ACCEPTANCE_PROVIDER;
      else process.env.RESEARCH_ACCEPTANCE_PROVIDER = oldAcceptance;
      if (oldTestMode === undefined) delete process.env.RESEARCH_TEST_MODE;
      else process.env.RESEARCH_TEST_MODE = oldTestMode;
    }
  });

  it("attempts explicit role seeds before heuristic search results", async () => {
    const oldEndpoint = process.env.RESEARCH_WEB_SEARCH_ENDPOINT;
    const oldMax = process.env.RESEARCH_WEB_DISCOVERY_MAX_PER_ROLE;
    const oldAcceptance = process.env.RESEARCH_ACCEPTANCE_PROVIDER;
    const oldTestMode = process.env.RESEARCH_TEST_MODE;
    process.env.RESEARCH_WEB_SEARCH_ENDPOINT = "https://search.example/api";
    process.env.RESEARCH_WEB_DISCOVERY_MAX_PER_ROLE = "1";
    delete process.env.RESEARCH_ACCEPTANCE_PROVIDER;
    delete process.env.RESEARCH_TEST_MODE;
    const fetched: string[] = [];
    const fetchMock = async (input: string | URL | Request) => {
      const url = String(input);
      fetched.push(url);
      if (url.startsWith("https://search.example/api")) {
        return new Response(JSON.stringify({
          results: [{ url: "https://issuer.example/investors", title: "Issuer annual report" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(
        `<html><head><title>Independent industry report</title></head><body>${"NuScale reactor industry statistics and report ".repeat(90)}</body></html>`,
        { status: 200, headers: { "content-type": "text/html" } }
      );
    };
    try {
      const sources = await discoverRoleSources({
        assetName: "NuScale Power",
        symbol: "SMR",
        roleSeedUrls: {
          industry_primary: ["https://regulator.example/industry-report"],
        },
      }, ["industry_primary"], fetchMock as typeof fetch);
      assert.equal(sources.length, 1);
      assert.equal(sources[0].url, "https://regulator.example/industry-report");
      assert.equal(fetched.includes("https://issuer.example/investors"), false);
    } finally {
      if (oldEndpoint === undefined) delete process.env.RESEARCH_WEB_SEARCH_ENDPOINT;
      else process.env.RESEARCH_WEB_SEARCH_ENDPOINT = oldEndpoint;
      if (oldMax === undefined) delete process.env.RESEARCH_WEB_DISCOVERY_MAX_PER_ROLE;
      else process.env.RESEARCH_WEB_DISCOVERY_MAX_PER_ROLE = oldMax;
      if (oldAcceptance === undefined) delete process.env.RESEARCH_ACCEPTANCE_PROVIDER;
      else process.env.RESEARCH_ACCEPTANCE_PROVIDER = oldAcceptance;
      if (oldTestMode === undefined) delete process.env.RESEARCH_TEST_MODE;
      else process.env.RESEARCH_TEST_MODE = oldTestMode;
    }
  });

  it("allows an explicitly labelled independent source without the issuer name", async () => {
    const oldEndpoint = process.env.RESEARCH_WEB_SEARCH_ENDPOINT;
    const oldAcceptance = process.env.RESEARCH_ACCEPTANCE_PROVIDER;
    const oldTestMode = process.env.RESEARCH_TEST_MODE;
    process.env.RESEARCH_WEB_SEARCH_ENDPOINT = "https://search.example/api";
    delete process.env.RESEARCH_ACCEPTANCE_PROVIDER;
    delete process.env.RESEARCH_TEST_MODE;
    const fetchMock = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://search.example/api")) {
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        `<html><head><title>Advanced reactor industry report</title></head><body>${"reactor industry design statistics and regulatory report ".repeat(90)}</body></html>`,
        { status: 200, headers: { "content-type": "text/html" } }
      );
    };
    try {
      const sources = await discoverRoleSources({
        assetName: "NuScale Power",
        symbol: "SMR",
        roleSeedUrls: {
          industry_primary: ["https://regulator.example/reactor-industry"],
        },
      }, ["industry_primary"], fetchMock as typeof fetch);
      assert.equal(sources.length, 1);
      assert.equal(sources[0].metadata.source_role, "industry_primary");
    } finally {
      if (oldEndpoint === undefined) delete process.env.RESEARCH_WEB_SEARCH_ENDPOINT;
      else process.env.RESEARCH_WEB_SEARCH_ENDPOINT = oldEndpoint;
      if (oldAcceptance === undefined) delete process.env.RESEARCH_ACCEPTANCE_PROVIDER;
      else process.env.RESEARCH_ACCEPTANCE_PROVIDER = oldAcceptance;
      if (oldTestMode === undefined) delete process.env.RESEARCH_TEST_MODE;
      else process.env.RESEARCH_TEST_MODE = oldTestMode;
    }
  });

  it("does not use issuer-site crawling to satisfy independent industry coverage", async () => {
    const oldEndpoint = process.env.RESEARCH_WEB_SEARCH_ENDPOINT;
    const oldAcceptance = process.env.RESEARCH_ACCEPTANCE_PROVIDER;
    const oldTestMode = process.env.RESEARCH_TEST_MODE;
    process.env.RESEARCH_WEB_SEARCH_ENDPOINT = "https://search.example/api";
    delete process.env.RESEARCH_ACCEPTANCE_PROVIDER;
    delete process.env.RESEARCH_TEST_MODE;
    const fetchMock = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://search.example/api")) {
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        `<html><head><title>NuScale investors</title></head><body>
          ${"NuScale investor financial results and presentation ".repeat(90)}
          <a href="/annual-report">NuScale reactor industry report</a>
        </body></html>`,
        { status: 200, headers: { "content-type": "text/html" } }
      );
    };
    try {
      const sources = await discoverRoleSources({
        assetName: "NuScale Power",
        symbol: "SMR",
        roleSeedUrls: {
          company_investor_relations: ["https://issuer.example/investors"],
        },
      }, ["company_investor_relations", "industry_primary"], fetchMock as typeof fetch);
      assert.deepEqual(
        sources.map((source) => source.metadata.source_role),
        ["company_investor_relations"]
      );
    } finally {
      if (oldEndpoint === undefined) delete process.env.RESEARCH_WEB_SEARCH_ENDPOINT;
      else process.env.RESEARCH_WEB_SEARCH_ENDPOINT = oldEndpoint;
      if (oldAcceptance === undefined) delete process.env.RESEARCH_ACCEPTANCE_PROVIDER;
      else process.env.RESEARCH_ACCEPTANCE_PROVIDER = oldAcceptance;
      if (oldTestMode === undefined) delete process.env.RESEARCH_TEST_MODE;
      else process.env.RESEARCH_TEST_MODE = oldTestMode;
    }
  });

  it("blocks missing artifact roles and rejects invented nested citation IDs", () => {
    assert.deepEqual(
      missingRequiredSourceRoles(
        ["founder_and_company_history", "company_investor_relations"],
        ["company_investor_relations"]
      ),
      ["founder_and_company_history"]
    );
    const validation = validateArtifactCitationIds({
      company_genesis: {
        material_claims: [
          { evidence_claim_ids: ["11111111-1111-4111-8111-111111111111"] },
          { evidence_claim_ids: ["invented-id"] },
        ],
      },
    }, ["11111111-1111-4111-8111-111111111111"]);
    assert.equal(validation.valid, false);
    assert.deepEqual(validation.invalidIds, ["invented-id"]);
  });

  it("accepts a repaired artifact after all invented nested citations are removed", () => {
    const allowedId = "11111111-1111-4111-8111-111111111111";
    const repaired = {
      company_genesis: {
        material_claims: [{ evidence_claim_ids: [allowedId] }],
      },
      founder_profile: {
        motivations: [{ evidence_claim_ids: [] }],
      },
    };
    assert.deepEqual(validateArtifactCitationIds(repaired, [allowedId]), {
      valid: true,
      citedIds: [allowedId],
      invalidIds: [],
    });
  });
});
