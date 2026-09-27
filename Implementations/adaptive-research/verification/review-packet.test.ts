import test from "node:test";
import assert from "node:assert/strict";
import * as reports from "../../../src/lib/research/reporting/report";

test("AC-L3: compact review reconstructs the exact report, including late evidence and table values", () => {
  const source = { id: "source", claim_text: "Cash fell", source_title: "Filing", url: "https://example.com/filing",
    published_at: "2026-01-01", location: "Note 10", quote: "context ".repeat(2000) + "Cash fell to 73." };
  const artifact = { id: "cash", artifact_type: "cash_bridge", scope_key: "cash", artifact_version: 1,
    content_json: { rows: [{ period: "2025", cash: 73, currency: "USD" }] } };
  const document = reports.createReport({ asset_name: "Test", cutoff: "2026-02-01", is_test: true,
    artifacts: [artifact], evidence: [source], required_coverage: ["management"], questions: [],
    coverage: [{ key: "management", status: "qualified", rationale: "Limited history", section_ids: ["allocation"] }],
    sections: [{ id: "allocation", title: "Cash allocation", purpose: "Explain the decline", coverage: ["management"],
      artifact_ids: ["cash"], paragraphs: [{ kind: "fact", text: "Cash fell to 73.", evidence_ids: ["source"], artifact_ids: ["cash"] }],
      counterevidence: "One period does not establish a trend.", implication: "Investigate reinvestment.", gaps: ["Earlier periods missing"],
      tables: [{ title: "Cash bridge", artifact_id: "cash", path: "rows" }] }] });
  assert.equal(typeof (reports as any).reviewDocument, "function", "AC-L3 review projection is available");
  const body = (reports as any).reviewDocument(document);
  const packet = { report_document: body, artifacts: document.artifacts, evidence_claims: document.evidence };
  const transmitted = JSON.parse(JSON.stringify(packet));
  const reconstructed = reports.createReport({ ...transmitted.report_document,
    artifacts: transmitted.artifacts, evidence: transmitted.evidence_claims });
  assert.equal(reconstructed.markdown, document.markdown);
  assert.equal(reconstructed.content_hash, document.content_hash);
  assert.equal(reconstructed.input_hash, document.input_hash);
  assert.equal(transmitted.evidence_claims[0].quote, source.quote);
  assert.equal(transmitted.artifacts[0].content_json.rows[0].cash, 73);
  assert.ok(document.markdown.includes("Cash fell to 73."), "Original stored report is unchanged");
});
