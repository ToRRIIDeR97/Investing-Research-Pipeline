// C-6: checklist and evaluation routes against PostgreSQL. Checklists are validated and bounded; an evaluation measures
// from the run's newest stored artifacts, leaves judgement items unknown with a reason when no model call is made, and
// keeps a snapshot that survives editing or deleting its checklist. (A model-judged evaluation on a full mock run is in
// tests/sofi-research-e2e.test.ts.) Brings its own assets, runs and checklists and removes them afterwards.
import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { NextRequest } from "next/server";

const request = (url: string, method = "GET", body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }) });
const table = (columns: string[], rows: unknown[][]) => ({ columns, rows });

test("checklist routes keep checklists and score evaluations from stored data", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const assetId = crypto.randomUUID(), otherAssetId = crypto.randomUUID(), runId = crypto.randomUUID(), otherRunId = crypto.randomUUID();
  const created: string[] = [];
  const lists = await import("../src/app/api/checklists/route");
  const one = await import("../src/app/api/checklists/[id]/route");
  const evals = await import("../src/app/api/assets/[id]/checklist-evaluations/route");
  const { DEFAULT_CHECKLIST } = await import("../src/lib/research/checklist");
  const at = (id: string) => ({ params: Promise.resolve({ id }) });
  const make = async (body: unknown) => lists.POST(request("/api/checklists", "POST", body));
  const evaluate = (asset: string, body: unknown) => evals.POST(request(`/api/assets/${asset}/checklist-evaluations`, "POST", body), at(asset));
  const suffix = assetId.slice(0, 8);
  try {
    const [profile] = await sql`SELECT id, version FROM research_profiles ORDER BY profile_key LIMIT 1`;
    assert.ok(profile, "A research profile must be seeded (npm run db:seed).");
    for (const [id, slug] of [[assetId, `checklist-${suffix}`], [otherAssetId, `checklist-o-${suffix}`]])
      await sql`INSERT INTO assets (id, canonical_name, slug, primary_profile_id, status, asset_kind, base_currency)
        VALUES (${id}, 'Checklist test asset', ${slug}, ${profile.id}, 'active', 'equity', 'USD')`;
    for (const [id, asset] of [[runId, assetId], [otherRunId, otherAssetId]])
      await sql`INSERT INTO research_runs (id, asset_id, run_type, status, research_question, requested_by, profile_id, profile_version,
          source_cutoff_at, market_data_cutoff_at, budget_limit_usd, pipeline_version, metadata_json)
        VALUES (${id}, ${asset}, 'full_initiation_report', 'completed', 'Checklist test question.', 'checklist-test', ${profile.id},
          ${Number(profile.version || 1)}, '2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z', '0', 3, ${sql.json({})})`;
    const artifact = (type: string, version: number, content: unknown) => sql`INSERT INTO research_artifacts (research_run_id, asset_id, artifact_type, scope_key,
        artifact_version, status, content_json, created_by) VALUES (${runId}, ${assetId}, ${type}, ${`checklist-${type}`}, ${version}, 'validated', ${sql.json(content as never)}, 'checklist-test')`;
    // Version 1 is stale; the measures must read version 2.
    await artifact("financial_analytics", 1, { statistics: table(["metric", "median"], [["revenue_yoy", 0.01]]) });
    await artifact("financial_analytics", 2, {
      statistics: table(["metric", "n", "median"], [["revenue_yoy", 20, 0.12], ["operating_margin", 20, 0.18]]),
      cash_conversion: { quarterly: table(["period", "fcf_ttm"], [["2026Q2", 1000]]) },
      capital_allocation: { quarterly: table(["period", "net_cash", "shares_yoy"], [["2026Q2", -2000, 0.01]]) },
    });

    // The default checklist is seeded on the first listing and listed first.
    const listed = await (await lists.GET()).json();
    assert.equal(listed[0].is_default, true);
    assert.equal(listed[0].name, DEFAULT_CHECKLIST.name);

    // Create, validate, rename, bound.
    const items = [
      { id: "growth", label: "Growth at least 10%", weight: 2, kind: "measure", measure: "revenue_yoy_median", op: ">=", threshold: 10 },
      { id: "debt", label: "Net debt repaid in 1.5 years", weight: 1, kind: "measure", measure: "net_debt_payback_years", op: "<=", threshold: 1.5 },
      { id: "pe", label: "P/E at most 30x", weight: 1, kind: "measure", measure: "pe_ttm", op: "<=", threshold: 30 },
      { id: "pure", label: "Pure play\u0007", weight: 3, kind: "judgement", question: "Is most revenue from the theme?" },
    ];
    const made = await make({ name: `Mine ${suffix}`, items });
    assert.equal(made.status, 201);
    const mine = await made.json();
    created.push(mine.id);
    assert.equal(mine.items[3].label, "Pure play");
    assert.equal((await make({ name: `Mine ${suffix}`, items })).status, 409, "names are unique");
    assert.equal((await make({ name: "Bad", items: [items[0], items[0]] })).status, 400);
    assert.equal((await make({ name: "Bad", items: [{ ...items[0], measure: "made_up" }] })).status, 400);
    assert.equal((await make({ name: "Bad", items: [items[0]], extra: 1 })).status, 400);
    assert.equal((await make("{nope")).status, 400);
    assert.equal((await make({ name: "Big", items: [{ ...items[3], question: "x".repeat(70_000) }] })).status, 413);
    const renamed = await one.PATCH(request("/", "PATCH", { name: `Mine renamed ${suffix}`, items }), at(mine.id));
    assert.equal((await renamed.json()).name, `Mine renamed ${suffix}`);
    assert.equal((await one.GET(request("/"), at("not-a-uuid"))).status, 404);
    assert.equal((await one.PATCH(request("/", "PATCH", { name: "x", items }), at(crypto.randomUUID()))).status, 404);

    // An evaluation needs a run with a report unless a run is named; a named run must be the asset's.
    assert.equal((await evaluate(assetId, { checklist_id: mine.id })).status, 409);
    assert.equal((await evaluate(assetId, { checklist_id: mine.id, research_run_id: otherRunId })).status, 400);
    assert.equal((await evaluate(assetId, { checklist_id: crypto.randomUUID(), research_run_id: runId })).status, 404);
    assert.equal((await evaluate(crypto.randomUUID(), { checklist_id: mine.id })).status, 404);
    assert.equal((await evals.POST(new NextRequest(`http://localhost/api/assets/${assetId}/checklist-evaluations`, { method: "POST",
      headers: { origin: "https://unrelated.example", "content-type": "application/json" }, body: JSON.stringify({ checklist_id: mine.id, research_run_id: runId }) }), at(assetId))).status, 403);

    // Measures from the newest analytics; P/E missing (no report facts); the judgement unknown: this run has no report.
    const scored = await evaluate(assetId, { checklist_id: mine.id, research_run_id: runId });
    assert.equal(scored.status, 201);
    const evaluation = await scored.json();
    const byId = Object.fromEntries(evaluation.results.map((r: { id: string }) => [r.id, r]));
    assert.deepEqual([byId.growth.status, byId.growth.value, byId.growth.display], ["met", 12, "12.0%"]);
    assert.deepEqual([byId.debt.status, byId.debt.value], ["not_met", 2]);
    assert.equal(byId.pe.status, "unknown");
    assert.match(byId.pe.reason, /report facts/);
    assert.equal(byId.pure.status, "unknown");
    assert.equal(evaluation.judged_by, "none");
    assert.match(byId.pure.reason, /no report/);
    assert.deepEqual([evaluation.score, evaluation.max, evaluation.percent, evaluation.unknown], [2, 3, 66.7, 2]);

    // Without the paid gate, judgement items say so.
    const saved = { RUN_PAID_RESEARCH: process.env.RUN_PAID_RESEARCH, RESEARCH_MODEL_PROVIDER: process.env.RESEARCH_MODEL_PROVIDER };
    delete process.env.RUN_PAID_RESEARCH; delete process.env.RESEARCH_MODEL_PROVIDER;
    try {
      const gated = await (await evaluate(assetId, { checklist_id: mine.id, research_run_id: runId })).json();
      assert.match(gated.results.find((r: { id: string }) => r.id === "pure").reason, /model calls are off/);
      assert.match(gated.judgement_note, /model calls are off/);
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }

    // Listing is per asset, newest first; deleting the checklist keeps the evaluations' snapshot.
    assert.equal((await (await evals.GET(request("/"), at(assetId))).json()).length, 2);
    assert.deepEqual(await (await evals.GET(request("/"), at(otherAssetId))).json(), []);
    assert.equal((await one.DELETE(request("/", "DELETE"), at(mine.id))).status, 204);
    assert.equal((await one.DELETE(request("/", "DELETE"), at(mine.id))).status, 404);
    const kept = await (await evals.GET(request("/"), at(assetId))).json();
    assert.deepEqual([kept[0].checklist_id, kept[0].checklist.name, kept[0].results.length], [null, `Mine renamed ${suffix}`, 4]);

    // Nothing above wrote research_artifacts beyond the fixture's two rows.
    assert.equal((await sql`SELECT count(*)::int AS n FROM research_artifacts WHERE research_run_id = ${runId}`)[0].n, 2);
  } finally {
    await sql`DELETE FROM checklist_evaluations WHERE asset_id = ANY(${[assetId, otherAssetId]}::uuid[])`;
    if (created.length) await sql`DELETE FROM investment_checklists WHERE id = ANY(${created}::uuid[])`;
    await sql`DELETE FROM research_artifacts WHERE research_run_id = ANY(${[runId, otherRunId]}::uuid[])`;
    await sql`DELETE FROM research_runs WHERE id = ANY(${[runId, otherRunId]}::uuid[])`;
    await sql`DELETE FROM assets WHERE id = ANY(${[assetId, otherAssetId]}::uuid[])`;
    await sql.end();
    const { db } = await import("../src/db");
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  }
});
