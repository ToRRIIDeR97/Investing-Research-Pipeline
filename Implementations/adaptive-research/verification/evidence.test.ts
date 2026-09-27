import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoricalDiagnosis } from "../../../src/lib/research/diagnosis/diagnosis";

test("AC-6: absent metric evidence never becomes a fabricated supporting claim", () => {
  const result = buildHistoricalDiagnosis({ asset_id: "00000000-0000-4000-8000-000000000001", run_id: "00000000-0000-4000-8000-000000000002",
    observations: [{ metric_key: "revenue", fiscal_year: 2025, fiscal_quarter: 1, value_numeric: 10,
      periodicity: "quarterly", reporting_basis: "gaap", metric_type: "reported", unit: "USD", currency: "USD", confidence: 0.9,
      restatement_version: 0, comparability_status: "comparable", metadata_json: {} }], materialMetricKeys: ["revenue"], supportingClaims: {}, endFiscalYear: 2025, endFiscalQuarter: 1 });
  assert.deepEqual(result.diagnoses[0].supporting_claim_ids, []);
  assert.ok((result.diagnoses[0] as any).source_gap);
});
