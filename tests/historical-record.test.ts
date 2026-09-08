import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildHistoricalRecord,
  buildMetricCoverageManifest,
  computeStartPeriod,
  buildMELIAdjustedFCFBridge,
  separateMELIRevenueDefinition,
  isRecurringHistoricalObservation,
  extractSecQuarterlyObservations,
  extractReportedKpiObservations,
  latestCoverageQuarter,
  selectHistoricalCoverageMetricKeys,
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
  it("extracts member, product, and segment contribution KPIs from verified filing claims", () => {
    const observations = extractReportedKpiObservations([
      { id: "member-claim", claim_text: "Total members reached 11.7 million.", period_end: "2025-06-30", source_id: "source-1", confidence: 0.9 },
      { id: "product-claim", claim_text: "Total products reached 17.1 million.", period_end: "2025-06-30", source_id: "source-1", confidence: 0.9 },
      { id: "margin-claim", claim_text: "Financial Services contribution margin was 45% for the quarter.", period_end: "2025-06-30", source_id: "source-1", confidence: 0.9 },
      { id: "profit-claim", claim_text: "Technology Platform contribution profit was $32 million for the quarter.", period_end: "2025-06-30", source_id: "source-1", confidence: 0.9 },
    ]);
    assert.equal(observations.find((item) => item.metric_key === "members")?.value_numeric, 11_700_000);
    assert.equal(observations.find((item) => item.metric_key === "total_products")?.value_numeric, 17_100_000);
    assert.equal(observations.find((item) => item.metric_key === "financial_services_contribution_margin")?.value_numeric, 45);
    assert.equal(observations.find((item) => item.metric_key === "technology_platform_contribution_profit")?.value_numeric, 32_000_000);
  });

  it("distinguishes an absent KPI disclosure from a missed extraction", () => {
    const coverage = buildMetricCoverageManifest(
      [{ metric_key: "members", value_numeric: 10_000_000 }],
      ["Total members reached 10 million. Technology Platform contribution margin was 30%."],
      [
        { metric_key: "members", source_pattern: /members/i },
        { metric_key: "technology_platform_contribution_margin", source_pattern: /technology platform.*contribution margin/i },
        { metric_key: "total_products", source_pattern: /total products/i },
      ]
    );
    assert.equal(coverage[0].status, "covered");
    assert.equal(coverage[1].status, "present_not_extracted");
    assert.equal(coverage[2].status, "not_found_in_snapshot");
  });

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

  it("keeps recurring measurements and rejects event numbers or empty values", () => {
    assert.equal(isRecurringHistoricalObservation({ metric_key: "net_revenue", value_numeric: 100, period_end: "2025-06-30" }), true);
    assert.equal(isRecurringHistoricalObservation({ metric_key: "acquisition_date", value_numeric: 2024, period_end: "2024-01-01" }), false);
    assert.equal(isRecurringHistoricalObservation({ metric_key: "funding_commitment", value_numeric: 500, as_of_date: "2025-01-01" }), false);
    assert.equal(isRecurringHistoricalObservation({ metric_key: "net_revenue", value_numeric: null, period_end: "2025-06-30" }), false);
  });

  it("does not count a null quarterly observation as present coverage", () => {
    const record = buildHistoricalRecord({
      asset_id: "00000000-0000-0000-0000-000000000001",
      observations: [{ ...makeObs("revenue", 2025, 1, 100), value_numeric: null }],
      requiredMetricKeys: ["revenue"],
      endFiscalYear: 2025,
      endFiscalQuarter: 1,
    });
    assert.equal(record.coverage.quarters_present, 0);
  });

  it("extracts direct SEC quarters, keeps the latest filing, and respects the cutoff", () => {
    const companyFacts = {
      facts: {
        "us-gaap": {
          RevenuesNetOfInterestExpense: {
            units: {
              USD: [
                { start: "2025-01-01", end: "2025-03-31", filed: "2025-05-01", form: "10-Q", val: 100, accn: "old" },
                { start: "2025-01-01", end: "2025-03-31", filed: "2025-05-02", form: "10-Q", val: 101, accn: "new" },
                { start: "2025-04-01", end: "2025-06-30", filed: "2025-08-01", form: "10-Q", val: 110 },
                { start: "2025-07-01", end: "2025-09-30", filed: "2025-11-01", form: "10-Q", val: 120 },
              ],
            },
          },
        },
      },
    };
    const observations = extractSecQuarterlyObservations(companyFacts, "00000000-0000-4000-8000-000000000001", "2025-08-19");
    assert.equal(observations.length, 2);
    assert.equal(observations[0].value_numeric, 101);
    assert.equal(observations[0].source, "sec_companyfacts");
  });

  it("derives additive Q4 facts from the audited annual value and reported Q1-Q3", () => {
    const companyFacts = {
      facts: {
        "us-gaap": {
          NetIncomeLoss: {
            units: {
              USD: [
                { start: "2024-01-01", end: "2024-03-31", filed: "2024-05-01", form: "10-Q", val: 10 },
                { start: "2024-04-01", end: "2024-06-30", filed: "2024-08-01", form: "10-Q", val: 20 },
                { start: "2024-07-01", end: "2024-09-30", filed: "2024-11-01", form: "10-Q", val: 30 },
                { start: "2024-01-01", end: "2024-12-31", filed: "2025-02-20", form: "10-K", fp: "FY", val: 100 },
              ],
            },
          },
        },
      },
    };
    const observations = extractSecQuarterlyObservations(companyFacts, "00000000-0000-4000-8000-000000000001", "2025-03-01");
    const netIncome = observations.filter((row) => row.metric_key === "net_income");
    assert.equal(netIncome.length, 4);
    assert.equal(netIncome.find((row) => row.period_end === "2024-12-31")?.value_numeric, 40);
    assert.match(String(netIncome.find((row) => row.period_end === "2024-12-31")?.description), /annual value minus reported Q1-Q3/);
  });

  it("uses recurring histories for the coverage matrix without letting one-off KPIs inflate its denominator", () => {
    const observations: HistoricalObservation[] = [];
    for (let index = 0; index < 12; index += 1) {
      observations.push(makeObs("revenue", 2022 + Math.floor(index / 4), (index % 4) + 1, index));
    }
    observations.push(makeObs("launch_metric", 2024, 4, 1));
    assert.deepEqual(selectHistoricalCoverageMetricKeys(observations), ["revenue"]);
  });

  it("does not advance the coverage window for a non-core current-quarter observation", () => {
    const observations = [
      makeObs("net_revenue", 2026, 2, 100),
      makeObs("one_off_kpi", 2026, 3, 1),
    ];

    assert.deepEqual(latestCoverageQuarter(observations, ["net_revenue"]), {
      fiscal_year: 2026,
      fiscal_quarter: 2,
    });
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
