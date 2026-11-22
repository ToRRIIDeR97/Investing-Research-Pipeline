// AC-8: the report view reads a chapter's exhibits from one shared helper; legacy documents keep their own exhibits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chapterExhibits } from "../../../src/lib/research/reporting/exhibits";
import { createReport } from "../../../src/lib/research/reporting/report";
import { artifacts, evidence, bodySection, ANALYTICS_ID } from "./fixtures";

const doc = (sections: any[], extra: Record<string, unknown> = {}) => createReport({ ...extra, asset_name: "Example Corp", cutoff: "2025-08-01T00:00:00.000Z",
  is_test: false, required_coverage: ["business"], sections, questions: [],
  coverage: [{ key: "business", status: "satisfied", rationale: "Covered.", section_ids: [sections[0].id] }], evidence, artifacts } as any);

test("AC-8: a chapter's exhibits come back built, in placed order, without unknown keys", () => {
  const d = doc([bodySection("business", ["business"], ["cash_conversion", "quarterly_results", "no_such_exhibit"])]);
  assert.deepEqual(chapterExhibits(d, "business").map(e => e.key), ["cash_conversion", "quarterly_results"]);
  assert.deepEqual(chapterExhibits(d, "missing-section"), []);
});

test("AC-8: a legacy document has no code-built exhibits, so the view keeps its own tables", () => {
  const s: any = { ...bodySection("business", ["business"]), tables: [{ title: "Quarterly", artifact_id: ANALYTICS_ID, path: "quarterly" }] };
  delete s.exhibits;
  const d = doc([s], { standard_version: "asset-framework-2.1-adaptive-2" });
  assert.deepEqual(chapterExhibits(d, "business"), []);
});
