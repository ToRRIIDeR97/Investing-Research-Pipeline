import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildResearchSectionManifest,
  normalizeResearchProvenanceRow,
} from "@/lib/research/artifacts/read-model";

describe("research report read model", () => {
  it("maps all canonical sections to the research-adapted tabs", () => {
    const manifest = buildResearchSectionManifest({
      artifactsByType: {
        investment_thesis: [{}],
        historical_record: [{}],
        backtest_review: [{}],
      },
      evidenceCount: 1,
      sourceCount: 1,
      stageStatus: new Map([["backtest_review", "skipped"]]),
    });

    assert.equal(manifest.taxonomy_version, "research-adapted-v1");
    assert.equal(manifest.sections.length, 25);
    assert.deepEqual(manifest.sections.map((section) => section.number), Array.from({ length: 25 }, (_, index) => index + 1));
    assert.equal(manifest.sections[0]?.tab, "general");
    assert.equal(manifest.sections[0]?.anchor, "report-section-1");
    assert.equal(manifest.sections[3]?.tab, "evidence");
    assert.equal(manifest.sections[15]?.tab, "valuation");
    assert.equal(manifest.sections[22]?.status, "skipped");
    assert.equal(manifest.sections[4]?.status, "complete");
    assert.ok(manifest.sections[6]?.missing_artifact_types.includes("segment_model"));
    assert.ok(manifest.tabs.every((tab) => tab.route.startsWith("research/")));
  });

  it("retains source quote, locator and artifact version/status while preserving missing fields", () => {
    const record = normalizeResearchProvenanceRow({
      artifact_id: "artifact-1",
      artifact_type: "operating_model",
      artifact_version: "2",
      artifact_status: "accepted",
      claim_id: "claim-1",
      claim_text: "Revenue grew.",
      support_type: "supports",
      source_document_id: "source-1",
      source_title: "Annual filing",
      source_canonical_url: "https://example.test/filing",
      quoted_text: "Revenue grew 20%.",
      page_start: "14",
      page_end: 15,
      locator_json: { section: "Revenue", table: "A" },
      as_of: "2025-12-31",
    }, "artifact");

    assert.equal(record.entity_id, "artifact-1");
    assert.equal(record.source_title, "Annual filing");
    assert.equal(record.source_url, "https://example.test/filing");
    assert.equal(record.quote, "Revenue grew 20%.");
    assert.deepEqual(record.locator, { section: "Revenue", table: "A" });
    assert.equal(record.page_start, 14);
    assert.equal(record.artifact_version, 2);
    assert.equal(record.artifact_status, "accepted");
    assert.equal(record.metric_id, null);
    assert.equal(record.scenario_name, null);
  });
});
