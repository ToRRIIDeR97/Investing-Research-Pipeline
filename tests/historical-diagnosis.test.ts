import { describe, it } from "node:test";
import assert from "node:assert";
import { diagnoseMetric, buildHistoricalDiagnosis } from "@/lib/research/diagnosis/diagnosis";
import { validateHistoricalDiagnosis } from "@/lib/research/diagnosis/contracts";
import type { HistoricalObservation } from "@/lib/research/history/contracts";

function makeObs(metricKey: string, year: number, quarter: number, value: number): HistoricalObservation {
  return {
    metric_key: metricKey,
    fiscal_year: year,
    fiscal_quarter: quarter,
    periodicity: "quarterly",
    reporting_basis: "gaap",
    metric_type: "reported",
    value_numeric: value,
    confidence: 1,
    restatement_version: 0,
    comparability_status: "comparable",
    metadata_json: {},
  };
}

const claimIds = ["00000000-0000-0000-0000-000000000001"];

describe("historical diagnosis", () => {
  it("C7-T1: Margin change caused by identified mix shift with evidence", () => {
    const observations: HistoricalObservation[] = [
      makeObs("gross_margin", 2020, 1, 0.30),
      makeObs("gross_margin", 2020, 2, 0.31),
      makeObs("gross_margin", 2020, 3, 0.30),
      makeObs("gross_margin", 2020, 4, 0.31),
      makeObs("gross_margin", 2021, 1, 0.35),
      makeObs("gross_margin", 2021, 2, 0.36),
      makeObs("gross_margin", 2021, 3, 0.37),
      makeObs("gross_margin", 2021, 4, 0.38),
    ];
    const diagnosis = diagnoseMetric("gross_margin", observations, "product_mix_shift", claimIds);
    assert.equal(diagnosis.structural_cyclical_temporary_or_accounting, "structural");
    assert.equal(diagnosis.causal_process_node, "product_mix_shift");
    assert.ok(diagnosis.supporting_claim_ids.includes(claimIds[0]));
  });

  it("C7-T2: Single quarter labeled structural without corroboration is rejected", () => {
    const observations: HistoricalObservation[] = [
      makeObs("revenue", 2020, 1, 100),
      makeObs("revenue", 2020, 2, 100),
      makeObs("revenue", 2020, 3, 100),
      makeObs("revenue", 2020, 4, 100),
      makeObs("revenue", 2021, 1, 150),
    ];
    const diagnosis = diagnoseMetric("revenue", observations, undefined, claimIds);
    assert.equal(diagnosis.structural_cyclical_temporary_or_accounting, "unexplained");
  });

  it("C7-T3: Statistical change point with no causal evidence is marked unexplained", () => {
    const observations: HistoricalObservation[] = [
      makeObs("revenue", 2020, 1, 100),
      makeObs("revenue", 2020, 2, 100),
      makeObs("revenue", 2020, 3, 100),
      makeObs("revenue", 2020, 4, 100),
      makeObs("revenue", 2021, 1, 100),
      makeObs("revenue", 2021, 2, 200),
      makeObs("revenue", 2021, 3, 200),
      makeObs("revenue", 2021, 4, 200),
    ];
    const diagnosis = buildHistoricalDiagnosis({
      asset_id: "00000000-0000-0000-0000-000000000001",
      observations,
      materialMetricKeys: ["revenue"],
      supportingClaims: { revenue: claimIds },
      endFiscalYear: 2021,
      endFiscalQuarter: 4,
    });
    assert.ok(diagnosis.unexplained_inflections.some((i) => i.metric_key === "revenue"));
    const record = diagnosis.diagnoses[0];
    assert.equal(record.structural_cyclical_temporary_or_accounting, "unexplained");
  });

  it("C7-T6: Historical diagnosis without forecast implication is rejected", () => {
    const artifact = {
      artifact_type: "historical_diagnosis" as const,
      asset_id: "00000000-0000-0000-0000-000000000001",
      diagnoses: [
        {
          metric_key: "revenue",
          current_level: 100,
          historical_mean: 100,
          historical_median: 100,
          historical_min: 90,
          historical_max: 110,
          historical_std_dev: 5,
          trend: "stable" as const,
          stability: 0.9,
          structural_cyclical_temporary_or_accounting: "stable" as any,
          forecast_implication: "",
          supporting_claim_ids: claimIds,
          confidence: 0.8,
        },
      ],
    };
    const result = validateHistoricalDiagnosis(artifact);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it("C7-T2: Structural label without process node fails validation", () => {
    const artifact = {
      artifact_type: "historical_diagnosis" as const,
      asset_id: "00000000-0000-0000-0000-000000000001",
      diagnoses: [
        {
          metric_key: "revenue",
          current_level: 100,
          historical_mean: 100,
          historical_median: 100,
          historical_min: 90,
          historical_max: 110,
          historical_std_dev: 5,
          trend: "increasing" as const,
          stability: 0.9,
          structural_cyclical_temporary_or_accounting: "structural" as const,
          forecast_implication: "Revenue growth is structural.",
          supporting_claim_ids: claimIds,
          confidence: 0.8,
        },
      ],
    };
    const result = validateHistoricalDiagnosis(artifact);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("causal process node")));
  });
});
