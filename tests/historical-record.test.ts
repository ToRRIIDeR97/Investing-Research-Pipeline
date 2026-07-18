import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildHistoricalRecord,
  computeStartPeriod,
  buildMELIAdjustedFCFBridge,
  separateMELIRevenueDefinition,
} from "@/lib/research/history/normalizer";
import type { HistoricalObservation } from "@/lib/research/history/contracts";
import { reconcileRecord, reconcileAnnualToQuarters } from "@/lib/research/history/reconciliation";
import { buildTTMSeries, detectInflections } from "@/lib/research/history/diagnostics";

function makeObs(
  metricKey: string,
  year: number,
  quarter: number,
  value: number,
  basis: "gaap" | "non_gaap" | "as_reported" = "gaap"
): HistoricalObservation {
  return {
    metric_key: metricKey,
    fiscal_year: year,
    fiscal_quarter: quarter,
    periodicity: "quarterly",
    reporting_basis: basis,
    metric_type: "reported",
    value_numeric: value,
    confidence: 1,
    restatement_version: 0,
    comparability_status: "comparable",
    metadata_json: {},
  };
}

function makeAnnual(metricKey: string, year: number, value: number): HistoricalObservation {
  return {
    metric_key: metricKey,
    fiscal_year: year,
    fiscal_quarter: null,
    periodicity: "annual",
    reporting_basis: "gaap",
    metric_type: "reported",
    value_numeric: value,
    confidence: 1,
    restatement_version: 0,
    comparability_status: "comparable",
    metadata_json: {},
  };
}

describe("historical record", () => {
  it("C6-T1: Twenty complete comparable quarters pass historical record gate", () => {
    const obs: HistoricalObservation[] = [];
    for (let y = 2020; y <= 2025; y++) {
      for (let q = 1; q <= 4; q++) {
        if (y === 2020 && q < 2) continue;
        if (y === 2025 && q > 1) break;
        obs.push(makeObs("revenue", y, q, 100 + (y - 2020) * 10 + q));
      }
    }
    const record = buildHistoricalRecord({
      asset_id: "00000000-0000-0000-0000-000000000001",
      observations: obs,
      requiredMetricKeys: ["revenue"],
      endFiscalYear: 2025,
      endFiscalQuarter: 1,
    });
    assert.equal(record.coverage.is_complete, true);
    assert.equal(record.coverage.quarters_required, 20);
  });

  it("C6-T2: Nineteen quarters with no documented gap fails gate", () => {
    const obs: HistoricalObservation[] = [];
    for (let y = 2021; y <= 2025; y++) {
      for (let q = 1; q <= 4; q++) {
        if (y === 2025 && q > 1) break;
        if (y === 2022 && q === 3) continue;
        obs.push(makeObs("revenue", y, q, 100));
      }
    }
    const record = buildHistoricalRecord({
      asset_id: "00000000-0000-0000-0000-000000000001",
      observations: obs,
      requiredMetricKeys: ["revenue"],
      endFiscalYear: 2025,
      endFiscalQuarter: 1,
    });
    assert.equal(record.coverage.is_complete, false);
    assert.ok(record.coverage.gaps.length > 0);
  });

  it("C6-T4: Annual value differs from four quarters records conflict", () => {
    const obs: HistoricalObservation[] = [
      makeObs("revenue", 2024, 1, 100),
      makeObs("revenue", 2024, 2, 100),
      makeObs("revenue", 2024, 3, 100),
      makeObs("revenue", 2024, 4, 100),
      makeAnnual("revenue", 2024, 500),
    ];
    const issues = reconcileAnnualToQuarters(obs);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].issue_type, "annual_quarterly_mismatch");
  });

  it("C6-T5: Restatement is preserved and latest becomes canonical", () => {
    const obs: HistoricalObservation[] = [
      { ...makeObs("revenue", 2024, 1, 100), restatement_version: 0 },
      { ...makeObs("revenue", 2024, 1, 110), restatement_version: 1 },
    ];
    const record = buildHistoricalRecord({
      asset_id: "00000000-0000-0000-0000-000000000001",
      observations: obs,
      requiredMetricKeys: ["revenue"],
      endFiscalYear: 2024,
      endFiscalQuarter: 1,
    });
    const canonical = record.observations.find((o) => o.metric_key === "revenue" && o.fiscal_year === 2024 && o.fiscal_quarter === 1);
    assert.equal(canonical?.value_numeric, 110);
    assert.ok(record.reconciliation_issues.some((i) => i.issue_type === "restatement"));
  });

  it("C6-T6: GAAP and non-GAAP measures with similar labels are separate", () => {
    const obs: HistoricalObservation[] = [
      makeObs("revenue", 2024, 1, 100, "gaap"),
      makeObs("revenue", 2024, 1, 120, "non_gaap"),
    ];
    const record = buildHistoricalRecord({
      asset_id: "00000000-0000-0000-0000-000000000001",
      observations: obs,
      requiredMetricKeys: ["revenue"],
      endFiscalYear: 2024,
      endFiscalQuarter: 1,
    });
    assert.equal(record.observations.length, 2);
  });

  it("C6-T10: MELI adjusted-FCF bridge signs reproduce disclosed bridge", () => {
    const bridge = buildMELIAdjustedFCFBridge(1000, 100, 200, 50, 150, 50);
    assert.equal(bridge.adjusted_fcf, 450);
    assert.equal(bridge.bridge_items.find((i) => i.label === "reported_cfo")?.value, 1000);
    assert.equal(bridge.bridge_items.find((i) => i.label === "customer_fund_cash_movement")?.value, -100);
  });

  it("MELI GAAP revenue separated from net revenues and financial income", () => {
    const revenue = separateMELIRevenueDefinition(1000, 1200, 200);
    assert.equal(revenue.gaap_revenue, 1000);
    assert.equal(revenue.net_revenues_and_financial_income, 1200);
    assert.equal(revenue.financial_income, 200);
  });
});

describe("TTM and diagnostics", () => {
  it("C6-T1: TTM calculation sums four quarters", () => {
    const obs: HistoricalObservation[] = [
      makeObs("revenue", 2024, 1, 100),
      makeObs("revenue", 2024, 2, 110),
      makeObs("revenue", 2024, 3, 120),
      makeObs("revenue", 2024, 4, 130),
    ];
    const ttm = buildTTMSeries(obs, ["revenue"], 2024, 1, 2024, 4);
    assert.equal(ttm.length, 1);
    assert.equal(ttm[0].value_numeric, 460);
    assert.equal(ttm[0].periodicity, "ttm");
  });

  it("C7-T1: Statistical inflection detected with corroboration", () => {
    const series: HistoricalObservation[] = [
      makeObs("margin", 2020, 1, 0.1),
      makeObs("margin", 2020, 2, 0.1),
      makeObs("margin", 2020, 3, 0.1),
      makeObs("margin", 2020, 4, 0.1),
      makeObs("margin", 2021, 1, 0.2),
      makeObs("margin", 2021, 2, 0.2),
      makeObs("margin", 2021, 3, 0.2),
      makeObs("margin", 2021, 4, 0.2),
    ];
    const inflections = detectInflections(series, 1.0);
    assert.ok(inflections.length > 0);
    assert.ok(inflections.some((i) => i.fiscal_year === 2021));
  });
});

describe("start period computation", () => {
  it("computes 20-quarter start from 2025Q1", () => {
    const { startFiscalYear, startFiscalQuarter } = computeStartPeriod(2025, 1, 19);
    assert.equal(startFiscalYear, 2020);
    assert.equal(startFiscalQuarter, 2);
  });
});
