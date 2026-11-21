// The filings library's contracts beyond the acceptance set: a stated form is authoritative, and the window counts
// fractional years.
import { test } from "node:test";
import assert from "node:assert/strict";
import { filingForm, recentFilings, yearsBefore } from "../src/lib/research/filings/library";

const doc = (id: string, over: Record<string, unknown>) => ({ id, source_type: "regulatory_filing", title: "Filing", url: `https://www.sec.gov/${id}.htm`,
  published_at: "2026-05-01T00:00:00.000Z", retrieved_at: "2026-06-01T00:00:00.000Z", metadata_json: {}, ...over });

test("filingForm returns a library form or null; a stated form outside the library is null, whatever the title says", () => {
  assert.equal(filingForm(doc("a", { metadata_json: { form: "DEF 14A" }, title: "Proxy that mentions the 10-K" })), null);
  assert.equal(filingForm(doc("b", { metadata_json: { form: "10-K/A" } })), "10-K");
  assert.equal(filingForm(doc("c", { metadata_json: { form: "6-K" }, title: "Results" })), "6-K");
  assert.equal(filingForm(doc("d", { metadata_json: { form: "  " }, title: "Company 20-F 2025" })), "20-F", "a blank stated form falls back to the title");
  assert.equal(filingForm(doc("e", { title: "Company 110-K", url: "https://x.example/10-KT.htm" })), null);
  assert.equal(recentFilings([doc("f", { metadata_json: { form: "DEF 14A" }, title: "10-K" })], new Date("2026-11-21T00:00:00Z")).length, 0);
});

test("the window counts fractional years and keeps the two-year calendar boundary", () => {
  const now = new Date("2026-11-21T00:00:00Z");
  const at = (published_at: string) => doc(published_at, { title: "10-Q", published_at });
  const docs = [at("2024-11-22T00:00:00.000Z"), at("2024-11-20T00:00:00.000Z"), at("2026-11-01T00:00:00.000Z"), at("2026-09-01T00:00:00.000Z")];
  assert.deepEqual(recentFilings(docs, now).map((d) => d.published_at.slice(0, 10)), ["2026-11-01", "2026-09-01", "2024-11-22"]);
  // 0.1 years is about 36.5 days: November's filing is in, September's is out (0.1 used to act as a whole year).
  assert.deepEqual(recentFilings(docs, now, 0.1).map((d) => d.published_at.slice(0, 10)), ["2026-11-01"]);
  assert.equal(yearsBefore(now, 2), Date.parse("2024-11-21T00:00:00Z"));
  assert.equal(yearsBefore(now, 1.5), Date.parse("2025-11-21T00:00:00Z") - 0.5 * 365.25 * 86_400_000);
});
