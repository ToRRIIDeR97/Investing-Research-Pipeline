// P4 (added in review, AC-16): the report document keeps stock_rating, but no model packet carries it.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { read } from "./support";

test("AC-16: report packets drop stock_rating; other artifacts keep their order", async () => {
  const { splitReportArtifacts } = await import("../../../src/lib/research/reporting/runtime");
  const { modelVisibleArtifacts } = await import("../../../src/lib/research/reporting/store");
  const artifacts = [
    { id: "1", artifact_type: "valuation_scenario_set", content_json: {} },
    { id: "2", artifact_type: "stock_rating", content_json: {} },
    { id: "3", artifact_type: "financial_analytics", content_json: {} },
    { id: "4", artifact_type: "decision_record", content_json: {} },
  ];
  const { shared, packetArtifacts } = splitReportArtifacts(artifacts);
  assert.deepEqual(packetArtifacts.map((a) => a.id), ["1", "4"]);
  assert.deepEqual(Object.keys(shared), ["financial_analytics"]);
  assert.deepEqual(modelVisibleArtifacts(artifacts).map((a) => a.id), ["1", "3", "4"]);
});

test("AC-16: the team-requests packet filters report inputs", () => {
  assert.match(read("src/lib/research/team.ts"), /artifacts: modelVisibleArtifacts\(inputs\.artifacts\)/);
});

test("AC-16: the legacy reviewer packet (plans without report_standard) filters its artifacts", () => {
  assert.match(read("src/lib/research/handlers/ai-reviewer.ts"), /modelVisibleArtifacts\(artifacts\.map/);
});
