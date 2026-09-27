import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

async function reporting() {
  assert.ok(existsSync("src/lib/research/reporting/report.ts"), "AC-1: adaptive report module exists");
  return import("../../../src/lib/research/reporting/report");
}

test("AC-3: an evidenced no-moat result is complete; critical unanswered questions withhold conclusions", async () => {
  const r = await reporting();
  const evidence = [{ id: "c", claim_text: "Customers switch freely.", source_title: "Customer study", url: "https://example.com/study", published_at: "2025-02-01", location: "Page 4", quote: "Customers switch freely." }];
  const document = r.createReport({ asset_name: "Switchable", cutoff: "2025-03-01", is_test: false, artifacts: [], evidence,
    required_coverage: ["moat"], coverage: [{ key: "moat", status: "satisfied", rationale: "Customer evidence demonstrates no durable advantage.", section_ids: ["moat"] }],
    questions: [{ id: "funding", question: "Can the business fund its commitments?", materiality: "critical", status: "blocked", answer: "Funding evidence is unavailable.", evidence_ids: [], artifact_ids: [], follow_up: "Obtain debt maturity disclosure." }],
    sections: [{ id: "moat", title: "No demonstrated moat", purpose: "Test switching", coverage: ["moat"], artifact_ids: [],
      paragraphs: [{ kind: "analysis", text: "Low switching friction leaves pricing exposed.", evidence_ids: ["c"], artifact_ids: [] }],
      counterevidence: "No retention disclosure supports a durable advantage.", implication: "Do not assume protected pricing.", gaps: [], tables: [] }] });
  assert.equal(document.conclusion_status, "withheld");
  assert.match(document.markdown, /Conclusion withheld/);
  assert.match(document.markdown, /Obtain debt maturity disclosure/);
});

test("AC-2/3: not-applicable coverage needs an explanation and tables cannot invent an input path", async () => {
  const r = await reporting();
  assert.throws(() => r.createReport({ asset_name: "Empty", cutoff: "2026-01-01", is_test: false, sections: [],
    questions: [], artifacts: [], evidence: [], required_coverage: ["history"],
    coverage: [{ key: "history", status: "not_applicable", rationale: "", section_ids: [] }] }), /coverage|rationale|section/i);
  assert.throws(() => r.resolveTable({ title: "Invented", artifact_id: "x", path: "missing" },
    [{ id: "x", artifact_type: "model", scope_key: "x", artifact_version: 1, content_json: { known: 1 } }]), /path/i);
});

test("AC-5/8: no approval or input snapshot mismatch cannot export", async () => {
  const r = await reporting();
  assert.throws(() => r.assertReportApproval({ content_hash: "x", input_hash: "y" } as any, null, "y"), /approval/i);
  assert.doesNotThrow(() => r.assertReportApproval({ content_hash: "x", input_hash: "y" } as any,
    { report_hash: "x", input_hash: "y" }, "y"));
  assert.notEqual(r.fingerprint({ model: { value: 40 } }), r.fingerprint({ model: { value: 41 } }));
});

test("AC-7: model text cannot inject raw HTML or Markdown links", async () => {
  const r = await reporting();
  const escaped = r.plainMarkdown('<img src=x onerror=alert(1)> [click](javascript:alert(1))');
  assert.ok(!escaped.includes('<img'));
  assert.ok(escaped.includes('\\[click\\]'));
  assert.ok(escaped.includes('&lt;img'));
});
