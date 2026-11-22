// AC-6, AC-7: the section writer returns prose only; createReport renders code-built exhibits; legacy reports keep their hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SECTION_CONTRACT, OUTLINE_CONTRACT, STANDARD_VERSION, storedSection } from "../../../src/lib/research/reporting/contracts";
import { createReport } from "../../../src/lib/research/reporting/report";
import { artifacts, evidence, bodySection, EVIDENCE_ID, ANALYTICS_ID, VAL_ID } from "./fixtures";

const coverageFor = (keys: string[], id: string) => keys.map(key => ({ key, status: "satisfied" as const, rationale: "Covered.", section_ids: [id] }));
const report = (sections: any[], keys: string[], extra: Record<string, unknown> = {}) => createReport({ ...extra, asset_name: "Example Corp",
  cutoff: "2025-08-01T00:00:00.000Z", is_test: false, required_coverage: keys, sections, questions: [],
  coverage: coverageFor(keys, sections[0].id), evidence, artifacts } as any);

test("AC-6: the writer and outline schemas ask for no tables, chart plans or chart specs", () => {
  const writer = JSON.stringify(SECTION_CONTRACT.schema);
  for (const banned of ['"tables"', '"chart_plan"', '"valuation_bridge"', '"scenarios"', '"ratio"', '"series"', '"history"'])
    assert.ok(!writer.includes(banned), `section schema still mentions ${banned}`);
  assert.ok(writer.includes('"process"') && writer.includes('"organization"'), "qualitative visuals stay");
  assert.ok(!JSON.stringify(OUTLINE_CONTRACT.schema).includes('"chart_plan"'));
});

test("AC-6: an answer that still carries tables, chart specs and a chart plan is accepted, and code strips them", () => {
  const answer = { section: { ...bodySection("business", ["business"]), chart_plan: "Operating margin trend (ratio)",
    tables: [{ title: "Quarterly", artifact_id: ANALYTICS_ID, path: "quarterly" }],
    visuals: [{ kind: "scenarios", title: "Value", caption: "c", artifact_id: VAL_ID, metric: "value_per_share", unit: "USD" },
      { kind: "process", title: "How orders become revenue", caption: "c", lanes: [{ nodes: [{ label: "Customers", icon: "people" }, { label: "Revenue", icon: "chart" }],
        note: "n", relationship: "documented", evidence_ids: [EVIDENCE_ID], artifact_ids: [] }] }] } };
  assert.deepEqual(SECTION_CONTRACT.validate!(answer), []);
  const stored = storedSection(answer.section, ["quarterly_results"]);
  assert.deepEqual(stored.tables, []);
  assert.deepEqual(stored.exhibits, ["quarterly_results"]);
  assert.equal((stored as any).chart_plan, undefined);
  assert.deepEqual((stored.visuals ?? []).map(v => v.kind), ["process"]);
});

test("AC-7: a new report renders its placed exhibits from stored data", () => {
  const doc = report([bodySection("business", ["business", "valuation"], ["quarterly_results", "valuation_matrix", "no_such_exhibit"])], ["business", "valuation"]);
  assert.equal(STANDARD_VERSION, "asset-framework-2.1-adaptive-3");
  assert.equal(doc.standard_version, STANDARD_VERSION);
  assert.match(doc.markdown, /\| 2025Q2 \|/);
  assert.match(doc.markdown, /39\.0%/);
  assert.match(doc.markdown, /105\.20/);
  assert.doesNotMatch(doc.markdown, /no_such_exhibit/);
  // plainMarkdown escapes underscores, so a leaked key would read operating\_margin.
  assert.doesNotMatch(doc.markdown, /[a-z]\\?_[a-z]/, "no snake_case reaches the rendered report");
});

test("AC-7: the content hash covers exhibit data", () => {
  const section = bodySection("business", ["business"], ["quarterly_results"]);
  const before = report([section], ["business"]).content_hash;
  const changed = artifacts.map(a => a.artifact_type !== "financial_analytics" ? a : { ...a, content_json: { ...a.content_json,
    quarterly: { ...a.content_json.quarterly, rows: a.content_json.quarterly.rows.map((r: any[], i: number) => i === 9 ? [r[0], 99999, ...r.slice(2)] : r) } } });
  const after = createReport({ asset_name: "Example Corp", cutoff: "2025-08-01T00:00:00.000Z", is_test: false, required_coverage: ["business"],
    sections: [section], questions: [], coverage: coverageFor(["business"], "business"), evidence, artifacts: changed } as any).content_hash;
  assert.notEqual(before, after);
});

test("AC-7: reports stored under earlier standards render byte-identically (hashes captured on the baseline)", () => {
  const legacy = (version: string) => {
    const s: any = { ...bodySection("business", ["business", "history"]), tables: [{ title: "Quarterly results", artifact_id: ANALYTICS_ID, path: "quarterly" }],
      visuals: [{ kind: "scenarios", title: "Value per share", caption: "Stored cases.", artifact_id: VAL_ID, metric: "value_per_share", unit: "USD" }] };
    delete s.exhibits;
    return report([s], ["business", "history"], { standard_version: version });
  };
  const two = legacy("asset-framework-2.1-adaptive-2"), one = legacy("asset-framework-2.1-adaptive-1");
  assert.equal(two.standard_version, "asset-framework-2.1-adaptive-2");
  assert.equal(two.content_hash, "b60fb9fed8e0985e4b62dcb96daf440edd3de84d1f6d7d25be1cada9ec774064");
  assert.equal(one.content_hash, "a6e6ede369a8f7393b8a780df45f6ceead09ea51c42ff02eda9b5a548f081670");
});
