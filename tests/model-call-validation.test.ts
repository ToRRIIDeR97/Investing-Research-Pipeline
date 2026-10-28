// Model-call spend feeds the budget ledger: bad costs, ids and list bounds are rejected before any query runs.
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { recordModelCall } from "../src/lib/agents/model-calls";

const params = { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }) };
const base = { model_provider: "mock", model_name: "mock-1", model_tier: "standard", status: "success" };

test("recordModelCall refuses a negative or non-finite cost", async () => {
  for (const costUsd of [-50, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      recordModelCall({ modelProvider: "mock", modelName: "mock-1", modelTier: "standard", status: "success", costUsd }),
      /finite number of at least 0/,
    );
  }
});

test("POST /model-calls answers 400 for a bad cost, amount or id", async () => {
  const { POST } = await import("../src/app/api/research-runs/[id]/model-calls/route");
  const bodies = [
    { ...base, cost_usd: -50 },
    { ...base, cost_usd: "abc" },
    { ...base, input_tokens: -1 },
    { ...base, task_id: "not-a-uuid" },
    { ...base, stage_id: 42 },
    { model_provider: "mock" },
  ];
  for (const body of bodies) {
    const response = await POST(new NextRequest("http://localhost/api/test", { method: "POST", body: JSON.stringify(body) }), params);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).code, "VALIDATION_ERROR");
  }
});

test("GET /model-calls answers 400 for an out-of-range limit or a bad since", async () => {
  const { GET } = await import("../src/app/api/research-runs/[id]/model-calls/route");
  for (const query of ["?limit=0", "?limit=1001", "?limit=abc", "?since=not-a-date"]) {
    const response = await GET(new NextRequest(`http://localhost/api/test${query}`), params);
    assert.equal(response.status, 400, query);
  }
});
