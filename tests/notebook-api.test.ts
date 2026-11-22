// Notebook routes against PostgreSQL: create, list, update and delete each kind, scoped to one asset, with the
// request contracts enforced. Brings its own asset and run and removes them afterwards.
import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { NextRequest } from "next/server";

const request = (url: string, method: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }) });

test("notebook API keeps pins, KPIs, annotations and journal entries per asset", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const assetId = crypto.randomUUID(), otherAssetId = crypto.randomUUID(), runId = crypto.randomUUID(), otherRunId = crypto.randomUUID();
  const notebook = await import("../src/app/api/assets/[id]/notebook/route");
  const list = await import("../src/app/api/assets/[id]/notebook/[kind]/route");
  const item = await import("../src/app/api/assets/[id]/notebook/[kind]/[itemId]/route");
  const at = (id: string, kind = "", itemId = "") => ({ params: Promise.resolve({ id, kind, itemId }) });
  const post = (asset: string, kind: string, body: unknown) => list.POST(request(`/api/assets/${asset}/notebook/${kind}`, "POST", body), at(asset, kind));
  try {
    const [profile] = await sql`SELECT id, version FROM research_profiles ORDER BY profile_key LIMIT 1`;
    assert.ok(profile, "A research profile must be seeded (npm run db:seed).");
    for (const [id, slug] of [[assetId, `notebook-${assetId.slice(0, 8)}`], [otherAssetId, `notebook-${otherAssetId.slice(0, 8)}`]])
      await sql`INSERT INTO assets (id, canonical_name, slug, primary_profile_id, status, asset_kind, base_currency)
        VALUES (${id}, 'Notebook test asset', ${slug}, ${profile.id}, 'active', 'equity', 'USD')`;
    for (const [id, asset] of [[runId, assetId], [otherRunId, otherAssetId]])
      await sql`INSERT INTO research_runs (id, asset_id, run_type, status, research_question, requested_by, profile_id, profile_version,
          source_cutoff_at, market_data_cutoff_at, budget_limit_usd, pipeline_version, metadata_json)
        VALUES (${id}, ${asset}, 'full_initiation_report', 'completed', 'Notebook test question.', 'notebook-test', ${profile.id},
          ${Number(profile.version || 1)}, '2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z', '0', 3, ${sql.json({})})`;

    // Empty to start; an unknown asset or section is a 404.
    assert.deepEqual(await (await notebook.GET(request(`/api/assets/${assetId}/notebook`, "GET"), at(assetId))).json(), { pins: [], kpis: [], annotations: [], journal: [] });
    assert.equal((await notebook.GET(request("/api/assets/x/notebook", "GET"), at(crypto.randomUUID()))).status, 404);
    assert.equal((await post(assetId, "nonsense", {})).status, 404);

    const pinned = await post(assetId, "pins", { kind: "exhibit", ref_key: "valuation_matrix", note: "Compare with the street." });
    assert.equal(pinned.status, 201);
    const pin = await pinned.json();
    assert.equal((await post(assetId, "pins", { kind: "exhibit", ref_key: "valuation_matrix" })).status, 409, "pinned once");
    assert.equal((await post(assetId, "pins", { kind: "exhibit", ref_key: "made_up" })).status, 400);
    assert.equal((await post(assetId, "pins", { kind: "metric", ref_key: "operating_margin", frequency: "quarterly" })).status, 201);

    const kpi = await (await post(assetId, "kpis", { label: "Operating margin", metric_key: "metric:operating_margin", bear_line: 30, bull_line: 40 })).json();
    assert.deepEqual([kpi.bear_line, kpi.bull_line, kpi.segment], [30, 40, null]);

    const annotated = await post(assetId, "annotations", { research_run_id: runId, section_id: "valuation", section_title: "Valuation",
      section_coverage: ["forecasts", "valuation", "downside"], exhibit_key: "valuation_matrix", body: "Bear case looks too kind.\u0000" });
    assert.equal(annotated.status, 201);
    assert.equal((await annotated.json()).body, "Bear case looks too kind.");
    assert.equal((await post(assetId, "annotations", { research_run_id: otherRunId, section_id: "valuation", body: "x" })).status, 400, "another asset's run");

    const snapshot = [{ kpi_id: kpi.id, label: "Operating margin", value: 34.6, display: "34.6%", unit: "%", period: "Q2 2026", status: "healthy" }];
    const entry = await (await post(assetId, "journal", { entry_date: "2026-11-21", research_run_id: runId, thesis: "Ads reaccelerate.",
      price: 612.5, currency: "USD", change_my_mind: "Margin below 30%.", kpi_snapshot: snapshot })).json();
    assert.deepEqual([entry.entry_date, entry.price, entry.kpi_snapshot], ["2026-11-21", 612.5, snapshot]);
    assert.equal((await post(assetId, "journal", { entry_date: "2026-11-21" })).status, 400, "an entry needs words");
    assert.equal((await post(assetId, "journal", "{not json")).status, 400);
    assert.equal((await post(assetId, "journal", { entry_date: "2026-11-21", body: "x".repeat(70_000) })).status, 413);

    const full = await (await notebook.GET(request(`/api/assets/${assetId}/notebook`, "GET"), at(assetId))).json();
    assert.deepEqual([full.pins.length, full.kpis.length, full.annotations.length, full.journal.length], [2, 1, 1, 1]);
    assert.deepEqual((await (await notebook.GET(request(`/api/assets/${otherAssetId}/notebook`, "GET"), at(otherAssetId))).json()).pins, [], "scoped to its asset");

    const patched = await item.PATCH(request(`/api/assets/${assetId}/notebook/kpis/${kpi.id}`, "PATCH", { bear_line: 32 }), at(assetId, "kpis", kpi.id));
    assert.equal((await patched.json()).bear_line, 32);
    assert.equal((await item.PATCH(request("/", "PATCH", { bear_line: 40 }), at(assetId, "kpis", kpi.id))).status, 400, "lines must differ");
    assert.equal((await item.PATCH(request("/", "PATCH", { note: "x" }), at(otherAssetId, "pins", pin.id))).status, 404, "another asset cannot edit it");
    assert.equal((await item.PATCH(request("/", "PATCH", {}), at(assetId, "pins", pin.id))).status, 400);
    assert.equal((await item.DELETE(request("/", "DELETE"), at(assetId, "pins", pin.id))).status, 204);
    assert.equal((await item.DELETE(request("/", "DELETE"), at(assetId, "pins", pin.id))).status, 404);
    assert.equal((await item.DELETE(request("/", "DELETE"), at(assetId, "pins", "not-a-uuid"))).status, 404);

    // Deleting the run keeps the note and the entry, without their run.
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    const after = await (await notebook.GET(request(`/api/assets/${assetId}/notebook`, "GET"), at(assetId))).json();
    assert.deepEqual([after.annotations[0].research_run_id, after.journal[0].research_run_id], [null, null]);
  } finally {
    await sql`DELETE FROM research_runs WHERE id = ANY(${[runId, otherRunId]}::uuid[])`;
    await sql`DELETE FROM assets WHERE id = ANY(${[assetId, otherAssetId]}::uuid[])`;
    await sql.end();
    const { db } = await import("../src/db");
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  }
});
