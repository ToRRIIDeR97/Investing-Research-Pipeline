import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";

function loadLocalEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

const definition = { series: [{ key: "revenue", as: "bar", axis: "left" }, { key: "metric:operating_margin", as: "line", axis: "right" }], chart_type: "bars", frequency: "quarterly", range: "last_8", mode: "values" };
const request = (url: string, method: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }) });

test("saved charts API creates, lists, updates and deletes definitions", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  loadLocalEnv();
  const list = await import("../src/app/api/saved-charts/route");
  const item = await import("../src/app/api/saved-charts/[id]/route");
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const created: string[] = [];
  try {
    const response = await list.POST(request("/api/saved-charts", "POST", { name: " Revenue\u0000 and margin ", definition }));
    assert.equal(response.status, 201);
    const chart = await response.json();
    created.push(chart.id);
    assert.equal(chart.name, "Revenue and margin");
    assert.deepEqual(chart.definition, definition);

    const listed = await (await list.GET()).json();
    assert.ok(listed.some((c: { id: string }) => c.id === chart.id));

    const renamed = await item.PATCH(request(`/api/saved-charts/${chart.id}`, "PATCH", { name: "Margins", definition: { ...definition, chart_type: "lines" } }), params(chart.id));
    assert.equal(renamed.status, 200);
    const updated = await renamed.json();
    assert.equal(updated.name, "Margins");
    assert.equal(updated.definition.chart_type, "lines");
    assert.ok(Date.parse(updated.updated_at) >= Date.parse(chart.updated_at));

    // Values, unknown fields, bad keys and empty updates are refused.
    assert.equal((await list.POST(request("/api/saved-charts", "POST", { name: "x", definition: { ...definition, values: [1] } }))).status, 400);
    assert.equal((await list.POST(request("/api/saved-charts", "POST", { name: "x", definition: { ...definition, series: [{ key: "a b", as: "bar", axis: "left" }] } }))).status, 400);
    assert.equal((await list.POST(request("/api/saved-charts", "POST", "{not json"))).status, 400);
    assert.equal((await list.POST(request("/api/saved-charts", "POST", { name: "x".repeat(20_000), definition }))).status, 413);
    assert.equal((await item.PATCH(request(`/api/saved-charts/${chart.id}`, "PATCH", {}), params(chart.id))).status, 400);
    assert.equal((await item.PATCH(request("/api/saved-charts/not-a-uuid", "PATCH", { name: "y" }), params("not-a-uuid"))).status, 404);

    const removed = await item.DELETE(request(`/api/saved-charts/${chart.id}`, "DELETE"), params(chart.id));
    assert.equal(removed.status, 204);
    created.pop();
    assert.equal((await item.DELETE(request(`/api/saved-charts/${chart.id}`, "DELETE"), params(chart.id))).status, 404);
  } finally {
    for (const id of created) await item.DELETE(request(`/api/saved-charts/${id}`, "DELETE"), params(id));
    const { db } = await import("../src/db");
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  }
});
