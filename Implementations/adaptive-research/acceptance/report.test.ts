import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { generateMarkdownReport } from "../../../src/lib/export/report-generator";

async function reporting() {
  assert.ok(existsSync("src/lib/research/reporting/report.ts"), "AC-1: adaptive report module exists");
  return import("../../../src/lib/research/reporting/report");
}

const evidence = [{ id: "claim-retail", claim_text: "Retail cash funded expansion losses.",
  source_title: "Quarterly filing", url: "https://example.com/filing", published_at: "2026-07-01",
  location: "Segment note", quote: "Retail cash funded expansion losses." }];
const artifacts = [{ id: "model-1", artifact_type: "operating_model", scope_key: "retail",
  artifact_version: 1, content_json: { revenue: 100, currency: "RMB", period: "2025" } }];

test("AC-1/2: custom sections preserve explanation and source-backed tables", async () => {
  const r = await reporting();
  const section = {
    id: "expansion", title: "Why expansion consumes the retail surplus", purpose: "Assess capital allocation",
    coverage: ["management"], artifact_ids: ["model-1"],
    paragraphs: [{ kind: "analysis" as const, text: "Retail earnings can improve while shareholder cash falls because expansion absorbs the surplus.", evidence_ids: ["claim-retail"], artifact_ids: ["model-1"] }],
    counterevidence: "Losses may buy a profitable customer base, but retention is undisclosed.",
    implication: "Loss normalization determines the scenario spread.", gaps: ["Cohort retention is unavailable."],
    tables: [{ title: "Operating inputs", artifact_id: "model-1", path: "" }],
  };
  const document = r.createReport({ asset_name: "Retail Co", cutoff: "2026-08-01", sections: [section],
    coverage: [{ key: "management", status: "qualified", rationale: "Retention disclosure is missing.", section_ids: ["expansion"] }],
    required_coverage: ["management"], questions: [], evidence, artifacts, is_test: true });
  const markdown = generateMarkdownReport({ runId: "r", asset: { canonical_name: "Retail Co", slug: "retail", asset_kind: "equity" }, report_document: document } as any);
  assert.match(markdown, /Why expansion consumes the retail surplus/);
  assert.match(markdown, /shareholder cash falls/);
  assert.match(markdown, /https:\/\/example.com\/filing/);
  assert.match(markdown, /100/);
  assert.match(markdown, /Cohort retention/);
  assert.doesNotMatch(markdown, /## 25\./);
  assert.ok(document.content_hash);
});

test("AC-2/3: unsupported facts, future evidence and missing coverage are rejected", async () => {
  const r = await reporting();
  const input: any = { asset_name: "Retail", cutoff: "2026-06-01", is_test: false, artifacts, evidence,
    sections: [{ id: "s", title: "Evidence", purpose: "Check", coverage: ["history"], artifact_ids: [],
      paragraphs: [{ kind: "fact", text: "Growth is guaranteed.", evidence_ids: ["missing"], artifact_ids: [] }],
      counterevidence: "Unknown", implication: "Unknown", gaps: [], tables: [] }],
    required_coverage: ["history", "valuation"], coverage: [{ key: "history", status: "satisfied", rationale: "Checked", section_ids: ["s"] }], questions: [] };
  assert.throws(() => r.createReport(input), /evidence|coverage|cutoff/i);
});

test("AC-5: changed inputs invalidate approval; hashes ignore object-key ordering", async () => {
  const r = await reporting();
  assert.equal(r.fingerprint({ a: 1, b: 2 }), r.fingerprint({ b: 2, a: 1 }));
  assert.throws(() => r.assertReportApproval({ content_hash: "new", input_hash: "i" } as any,
    { report_hash: "old", input_hash: "i" }, "i"), /changed|stale|match/i);
  assert.throws(() => r.assertReportApproval({ content_hash: "same", input_hash: "i" } as any,
    { report_hash: "same", input_hash: "i" }, "changed-input"), /changed|stale|match/i);
});

test("AC-1: historical report rendering stays available", () => {
  assert.match(generateMarkdownReport({ runId: "old", asset: { canonical_name: "Legacy", slug: "old", asset_kind: "equity" } }), /## 25\./);
});
