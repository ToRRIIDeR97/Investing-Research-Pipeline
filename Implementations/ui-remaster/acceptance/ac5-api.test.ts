// AC-5: the profile lookup validates its body before touching the database or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

process.env.DATABASE_URL ??= "postgres://test@127.0.0.1:1/none";
process.env.COMPANY_PROFILES = "off";
const post = (body: unknown) => new NextRequest("http://localhost/api/company-profiles", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("AC-5: malformed or oversized lookups return 400", async () => {
  const { POST } = await import("../../../src/app/api/company-profiles/route");
  assert.equal((await POST(post("{"))).status, 400);
  assert.equal((await POST(post({}))).status, 400);
  assert.equal((await POST(post({ subjects: [] }))).status, 400);
  assert.equal((await POST(post({ subjects: [{ ticker: "SOFI" }] }))).status, 400);
  assert.equal((await POST(post({ subjects: Array.from({ length: 41 }, (_, i) => ({ name: `Co ${i}` })) }))).status, 400);
});
