import { describe, it } from "node:test";
import assert from "node:assert";
import { reconcileSegmentToConsolidated, checkLookahead } from "@/lib/research/history/reconciliation";
import type { HistoricalObservation } from "@/lib/research/history/contracts";

describe("historical reconciliation", () => {
  it("C6-T4: Segment totals do not reconcile to consolidated", () => {
    const consolidated: HistoricalObservation = {
      metric_key: "revenue",
      fiscal_year: 2024,
      fiscal_quarter: 1,
      periodicity: "quarterly",
      reporting_basis: "gaap",
      metric_type: "reported",
      value_numeric: 100,
      confidence: 1,
      restatement_version: 0,
      comparability_status: "comparable",
      metadata_json: {},
    };
    const segmentA: HistoricalObservation = {
      ...consolidated,
      segment: "segment_a",
      value_numeric: 70,
    };
    const segmentB: HistoricalObservation = {
      ...consolidated,
      segment: "segment_b",
      value_numeric: 50,
    };
    const issues = reconcileSegmentToConsolidated([consolidated, segmentA, segmentB]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].issue_type, "segment_consolidated_mismatch");
  });

  it("C6-T4: Segment totals reconcile to consolidated", () => {
    const consolidated: HistoricalObservation = {
      metric_key: "revenue",
      fiscal_year: 2024,
      fiscal_quarter: 1,
      periodicity: "quarterly",
      reporting_basis: "gaap",
      metric_type: "reported",
      value_numeric: 100,
      confidence: 1,
      restatement_version: 0,
      comparability_status: "comparable",
      metadata_json: {},
    };
    const segmentA: HistoricalObservation = { ...consolidated, segment: "segment_a", value_numeric: 60 };
    const segmentB: HistoricalObservation = { ...consolidated, segment: "segment_b", value_numeric: 40 };
    const issues = reconcileSegmentToConsolidated([consolidated, segmentA, segmentB]);
    assert.equal(issues.length, 0);
  });

  it("C8: Lookahead observation is rejected", () => {
    const obs: HistoricalObservation = {
      metric_key: "revenue",
      fiscal_year: 2024,
      fiscal_quarter: 1,
      periodicity: "quarterly",
      reporting_basis: "gaap",
      metric_type: "reported",
      value_numeric: 100,
      available_at: "2024-05-01",
      confidence: 1,
      restatement_version: 0,
      comparability_status: "comparable",
      metadata_json: {},
    };
    const issue = checkLookahead(obs, "2024-03-01");
    assert.ok(issue);
    assert.equal(issue?.severity, "blocking");
  });
});
