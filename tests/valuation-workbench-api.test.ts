// W-4: the workbench routes against PostgreSQL. A run with a stored v2 valuation is recomputed in code, scenarios are
// saved with a summary the server recomputes, and nothing writes research_artifacts. Brings its own asset and runs
// and removes them afterwards.
import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { NextRequest } from "next/server";
import { buildScenarioStatements } from "../src/lib/research/valuation/engine";
import { buildFcffValuation, type ValuationSet } from "../src/lib/research/valuation/v2";

const request = (url: string, method: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }) });

function storedValuation() {
  const ratios = { da_to_revenue: 0.05, capex_to_revenue: 0.06, tax_rate: 0.2 };
  const statements = (growth: number, margin: number) => buildScenarioStatements({ baseRevenue: 1000, baseYear: 2025, ratios,
    drivers: Array.from({ length: 5 }, (_, i) => ({ fiscal_year: 2026 + i, revenue_growth: growth, operating_margin: margin, nwc_to_revenue_change: 0.1 })) });
  const set = (key: ValuationSet["set"], discount_rate: number, terminal_growth = 0.025): ValuationSet => ({ set: key, discount_rate, terminal_growth, ronic: 0.2, fade_years: 5, rationale: "test" });
  const scenario_statements = { bear: statements(0.03, 0.2), base: statements(0.08, 0.25), bull: statements(0.12, 0.3) };
  const valuation_sets = [set("conservative", 0.1, 0.02), set("base", 0.09), set("aggressive", 0.08, 0.03)];
  const built = buildFcffValuation({ statements: scenario_statements, sets: valuation_sets,
    probabilities: { probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25 }, price: 40, currency: "USD",
    common: { bridge: 50, shares: 10, currency: "USD", sourceNotes: ["n"], bridgeExplanation: "Cash less debt." },
    timing: null, pack: null, fx: 1, capm: 0.09, riskFree: 0.04, historyRoic: 0.2 });
  return { ...built.assembled.valuation_scenario_set, ...built.additions, scenario_statements, current_market_price: 40,
    risk_free_rate: { rate: 0.04 }, default_valuation_sets: valuation_sets, valuation_status: "complete" };
}

test("workbench API recomputes the stored valuation and keeps named scenarios per run", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const assetId = crypto.randomUUID(), runId = crypto.randomUUID(), bareRunId = crypto.randomUUID();
  const bench = await import("../src/app/api/research-runs/[id]/workbench/route");
  const scenarios = await import("../src/app/api/research-runs/[id]/workbench/scenarios/route");
  const scenario = await import("../src/app/api/research-runs/[id]/workbench/scenarios/[scenarioId]/route");
  const at = (id: string, scenarioId = "") => ({ params: Promise.resolve({ id, scenarioId }) });
  const save = (run: string, body: unknown) => scenarios.POST(request(`/api/research-runs/${run}/workbench/scenarios`, "POST", body), at(run));
  const artifactState = async () => (await sql`SELECT count(*)::int AS n, max(updated_at) AS updated, string_agg(md5(content_json::text), ',' ORDER BY id) AS hash
    FROM research_artifacts WHERE research_run_id = ANY(${[runId, bareRunId]}::uuid[])`)[0];
  try {
    const [profile] = await sql`SELECT id, version FROM research_profiles ORDER BY profile_key LIMIT 1`;
    assert.ok(profile, "A research profile must be seeded (npm run db:seed).");
    await sql`INSERT INTO assets (id, canonical_name, slug, primary_profile_id, status, asset_kind, base_currency)
      VALUES (${assetId}, 'Workbench test asset', ${`workbench-${assetId.slice(0, 8)}`}, ${profile.id}, 'active', 'equity', 'USD')`;
    for (const id of [runId, bareRunId])
      await sql`INSERT INTO research_runs (id, asset_id, run_type, status, research_question, requested_by, profile_id, profile_version,
          source_cutoff_at, market_data_cutoff_at, budget_limit_usd, pipeline_version, metadata_json)
        VALUES (${id}, ${assetId}, 'full_initiation_report', 'completed', 'Workbench test question.', 'workbench-test', ${profile.id},
          ${Number(profile.version || 1)}, '2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z', '0', 3, ${sql.json({})})`;
    const valuation = storedValuation();
    await sql`INSERT INTO research_artifacts (research_run_id, asset_id, artifact_type, scope_key, status, content_json, created_by)
      VALUES (${runId}, ${assetId}, 'valuation_scenario_set', 'workbench-test', 'validated', ${sql.json(valuation as never)}, 'workbench-test')`;
    const before = await artifactState();

    // GET: available, with the stored valuation reproduced; a run with no valuation says why; bad ids are 404.
    const page = await (await bench.GET(request(`/api/research-runs/${runId}/workbench`, "GET"), at(runId))).json();
    assert.equal(page.available, true);
    assert.equal(page.baseline.value_today.base, Number(Number(valuation.value_today_base).toFixed(2)));
    assert.deepEqual(page.inputs.probabilities, { bear: 0.25, base: 0.5, bull: 0.25 });
    assert.deepEqual(page.scenarios, []);
    const bare = await bench.GET(request("/", "GET"), at(bareRunId));
    assert.equal(bare.status, 200);
    const bareBody = await bare.json();
    assert.equal(bareBody.available, false);
    assert.match(bareBody.reason, /no valuation/i);
    assert.equal((await bench.GET(request("/", "GET"), at("not-a-uuid"))).status, 404);
    assert.equal((await bench.GET(request("/", "GET"), at(crypto.randomUUID()))).status, 404);

    // POST: a change recomputes; a broken rule is a 422 with a reason; the shape is checked; the body is bounded.
    const higher = await bench.POST(request("/", "POST", { change: { sets: { base: { discount_rate: 0.095 }, conservative: { discount_rate: 0.105 } } } }), at(runId));
    assert.equal(higher.status, 200);
    assert.ok((await higher.json()).value_today.base < page.baseline.value_today.base);
    const refused = await bench.POST(request("/", "POST", { change: { sets: { base: { terminal_growth: 0.095 } } } }), at(runId));
    assert.equal(refused.status, 422);
    assert.ok(typeof (await refused.json()).error === "string");
    assert.equal((await bench.POST(request("/", "POST", { change: { probabilities: { bear: 0.5, base: 0.5, bull: 0.5 } } }), at(runId))).status, 422);
    assert.equal((await bench.POST(request("/", "POST", { change: {}, extra: 1 }), at(runId))).status, 400);
    assert.equal((await bench.POST(request("/", "POST", "{nope"), at(runId))).status, 400);
    assert.equal((await bench.POST(request("/", "POST", { change: { drivers: { base: [] } }, pad: "x".repeat(40_000) }), at(runId))).status, 413);
    assert.equal((await bench.POST(request("/", "POST", { change: {} }), at(bareRunId))).status, 422, "a run that cannot be recomputed");

    // Scenarios: saved with the server's own summary, whatever the client claims; duplicate names are 409.
    const change = { probabilities: { bear: 0.2, base: 0.5, bull: 0.3 } };
    const created = await save(runId, { name: "  Bull tilt\u0007 ", rationale: "More weight on the bull case.", change, result: { value_today: { base: 999 } } });
    assert.equal(created.status, 400, "a client-supplied result is refused");
    const saved = await save(runId, { name: "  Bull tilt\u0007 ", rationale: "More weight on the bull case.", change });
    assert.equal(saved.status, 201);
    const row = await saved.json();
    assert.equal(row.name, "Bull tilt");
    assert.equal(row.source, "user");
    assert.deepEqual(row.change, change);
    const recomputed = await (await bench.POST(request("/", "POST", { change }), at(runId))).json();
    assert.deepEqual(row.result, { value_today: recomputed.value_today, return_today: recomputed.return_today, anchors: recomputed.anchors, probabilities: recomputed.probabilities });
    assert.equal((await save(runId, { name: "Bull tilt", change: {} })).status, 409);
    assert.equal((await save(runId, { name: "Too far", change: { sets: { base: { terminal_growth: 0.095 } } } })).status, 422);
    assert.equal((await save(runId, { name: "", change: {} })).status, 400);
    assert.equal((await save(runId, { name: "x", source: "model", change: {} })).status, 400);
    const fromChat = await save(runId, { name: "Margin squeeze", source: "assistant", change: { drivers: { base: [{ fiscal_year: 2027, operating_margin: 0.2 }] } } });
    assert.equal(fromChat.status, 201);
    const assistant = await fromChat.json();
    assert.equal(assistant.source, "assistant");
    const [stored] = await sql`SELECT result_json FROM valuation_scenarios WHERE id = ${assistant.id}`;
    assert.deepEqual(Object.keys(stored.result_json).sort(), ["anchors", "probabilities", "return_today", "value_today"]);

    const listed = await (await bench.GET(request("/", "GET"), at(runId))).json();
    assert.deepEqual(listed.scenarios.map((s: { name: string }) => s.name), ["Bull tilt", "Margin squeeze"]);
    assert.deepEqual(await (await scenarios.GET(request("/", "GET"), at(bareRunId))).json(), [], "scoped to its run");

    // Delete: scoped to the run; a second delete and bad ids are 404.
    assert.equal((await scenario.DELETE(request("/", "DELETE"), at(bareRunId, row.id))).status, 404, "another run cannot delete it");
    assert.equal((await scenario.DELETE(request("/", "DELETE"), at(runId, row.id))).status, 204);
    assert.equal((await scenario.DELETE(request("/", "DELETE"), at(runId, row.id))).status, 404);
    assert.equal((await scenario.DELETE(request("/", "DELETE"), at(runId, "not-a-uuid"))).status, 404);

    // At most 50 per run.
    for (let i = 0; i < 49; i++) await sql`INSERT INTO valuation_scenarios (research_run_id, name, change_json, result_json) VALUES (${runId}, ${`filler ${i}`}, ${sql.json({})}, ${sql.json({})})`;
    assert.equal((await save(runId, { name: "One too many", change: {} })).status, 409);

    // Nothing above wrote research_artifacts.
    assert.deepEqual(await artifactState(), before);

    // Deleting the run removes its scenarios.
    await sql`DELETE FROM research_artifacts WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    assert.equal((await sql`SELECT count(*)::int AS n FROM valuation_scenarios WHERE research_run_id = ${runId}`)[0].n, 0);
  } finally {
    await sql`DELETE FROM research_artifacts WHERE research_run_id = ANY(${[runId, bareRunId]}::uuid[])`;
    await sql`DELETE FROM research_runs WHERE id = ANY(${[runId, bareRunId]}::uuid[])`;
    await sql`DELETE FROM assets WHERE id = ${assetId}`;
    await sql.end();
    const { db } = await import("../src/db");
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  }
});
