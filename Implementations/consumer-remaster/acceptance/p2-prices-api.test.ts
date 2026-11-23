// P2: AC-8 the price API validates before touching the database.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

process.env.DATABASE_URL ??= "postgres://test@127.0.0.1:1/none";
const ID = "8b0d5c1e-3f7a-4c2e-9b1d-2a6f4e8c7d10";
const get = async (id: string, query = "") => {
  const { GET } = await import("../../../src/app/api/assets/[id]/prices/route");
  return GET(new NextRequest(`http://localhost/api/assets/${id}/prices${query}`), { params: Promise.resolve({ id }) });
};

test("AC-8: an unknown range is a 400 INVALID_RANGE", async () => {
  const res = await get(ID, "?range=2W");
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(await res.json()), /INVALID_RANGE/);
});

test("AC-8: a non-UUID id is a 400 INVALID_ID", async () => {
  const res = await get("sofi", "?range=6M");
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(await res.json()), /INVALID_ID/);
});
