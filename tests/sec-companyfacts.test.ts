import assert from "node:assert/strict";
import { test } from "node:test";
import { latestSecInstantFact, latestSecQuarterlyFact, secQuarterlyObservations } from "../src/lib/research/history/sec-companyfacts";

test("SEC instant NAV inputs respect the filing cutoff", () => {
  const facts = { facts: { "us-gaap": { Goodwill: { units: { USD: [
    { end: "2026-06-30", val: 100, filed: "2026-08-01", accn: "q2", form: "10-Q" },
    { end: "2026-06-30", val: 80, filed: "2026-10-01", accn: "restated", form: "10-Q" },
  ] } } } } };
  assert.deepEqual(latestSecInstantFact(facts, "us-gaap", "Goodwill", "USD", new Date("2026-09-23")), {
    value: 100, end: "2026-06-30", filed: "2026-08-01", accession_number: "q2",
  });
});

test("SEC diluted share fact selects the latest filed direct quarter, not year-to-date", () => {
  const facts = { facts: { "us-gaap": { WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: [
    { start: "2026-01-01", end: "2026-06-30", val: 1364978000, filed: "2026-08-06", accn: "q2", form: "10-Q" },
    { start: "2026-04-01", end: "2026-06-30", val: 1351990000, filed: "2026-08-06", accn: "q2", form: "10-Q" },
    { start: "2026-04-01", end: "2026-06-30", val: 1400000000, filed: "2026-10-01", accn: "future", form: "10-Q" },
  ] } } } } };
  assert.deepEqual(latestSecQuarterlyFact(
    facts, "us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding", "shares", new Date("2026-09-23")
  ), {
    value: 1351990000, start: "2026-04-01", end: "2026-06-30", filed: "2026-08-06", accession_number: "q2",
  });
});

test("SEC quarterly facts use filed values and derive a fourth quarter from annual less nine months", () => {
  const facts = { facts: { "us-gaap": {
    RevenuesNetOfInterestExpense: { units: { USD: [
      { start: "2025-01-01", end: "2025-09-30", val: 750, filed: "2025-11-01", accn: "q3", form: "10-Q" },
      { start: "2025-01-01", end: "2025-12-31", val: 1100, filed: "2026-02-01", accn: "fy", form: "10-K" },
      { start: "2025-01-01", end: "2025-12-31", val: 1200, filed: "2026-10-01", accn: "future-restatement", form: "10-K" },
    ] } },
    Assets: { units: { USD: [
      { end: "2025-12-31", val: 5000, filed: "2026-02-01", accn: "fy", form: "10-K" },
    ] } },
  } } };
  const rows = secQuarterlyObservations(facts, new Date("2026-09-23"));
  const q4 = rows.find((row) => row.metric_key === "net_revenue" && row.period_end === "2025-12-31");
  assert.equal(q4?.value_numeric, 350);
  assert.equal(q4?.accession_number, "fy");
  assert.match(q4?.formula_or_adjustment || "", /less prior year-to-date q3/);
  assert.equal(rows.find((row) => row.metric_key === "total_assets")?.value_numeric, 5000);
  assert.equal(rows.some((row) => row.accession_number === "future-restatement"), false);
  assert.equal(secQuarterlyObservations(facts, new Date("2025-12-31")).some((row) => row.metric_key === "net_revenue" && row.period_end === "2025-12-31"), false);
});

test("SEC quarters of a 52/53-week fiscal year come from fact durations, not calendar quarter-ends", () => {
  const facts = { facts: { "us-gaap": {
    RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
      { start: "2023-10-01", end: "2023-12-30", val: 120, filed: "2024-02-02", accn: "q1", form: "10-Q", frame: "CY2023Q4" },
      { start: "2023-12-31", end: "2024-03-30", val: 90, filed: "2024-05-03", accn: "q2", form: "10-Q" },
      { start: "2023-10-01", end: "2024-03-30", val: 210, filed: "2024-05-03", accn: "q2", form: "10-Q" },
      { start: "2024-03-31", end: "2024-06-29", val: 86, filed: "2024-08-02", accn: "q3", form: "10-Q" },
      { start: "2023-10-01", end: "2024-06-29", val: 296, filed: "2024-08-02", accn: "q3", form: "10-Q" },
      { start: "2023-10-01", end: "2024-09-28", val: 391, filed: "2024-11-01", accn: "fy", form: "10-K" },
    ] } },
    Assets: { units: { USD: [
      { end: "2024-09-28", val: 365, filed: "2024-11-01", accn: "fy", form: "10-K" },
      { end: "2024-08-15", val: 1, filed: "2024-11-01", accn: "fy", form: "10-K" },
    ] } },
    WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: [
      { start: "2023-10-01", end: "2024-06-29", val: 15400, filed: "2024-08-02", accn: "q3", form: "10-Q" },
      { start: "2024-03-31", end: "2024-06-29", val: 15350, filed: "2024-08-02", accn: "q3", form: "10-Q" },
    ] } },
  } } };
  const rows = secQuarterlyObservations(facts, new Date("2025-01-01"));
  const revenue = rows.filter((row) => row.metric_key === "revenue").map((row) => [row.period_start, row.period_end, row.value_numeric]);
  assert.deepEqual(revenue, [
    ["2023-10-01", "2023-12-30", 120],
    ["2023-12-31", "2024-03-30", 90],
    ["2024-03-31", "2024-06-29", 86],
    // Q4 = the fiscal year (from 1 October) less the nine months with the same start.
    ["2024-06-30", "2024-09-28", 95],
  ]);
  assert.match(rows.find((row) => row.period_end === "2024-09-28" && row.metric_key === "revenue")?.formula_or_adjustment || "", /less prior year-to-date q3/);
  // The fiscal year-end balance is kept; an instant on no fiscal period end is not a quarter.
  assert.deepEqual(rows.filter((row) => row.metric_key === "total_assets").map((row) => row.period_end), ["2024-09-28"]);
  assert.deepEqual(latestSecQuarterlyFact(
    facts, "us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding", "shares", new Date("2025-01-01")
  ), { value: 15350, start: "2024-03-31", end: "2024-06-29", filed: "2024-08-02", accession_number: "q3" });
});

test("SEC quarters of a June fiscal year derive Q4 from the July-start year to date", () => {
  const facts = { facts: { "us-gaap": { NetIncomeLoss: { units: { USD: [
    { start: "2023-07-01", end: "2024-03-31", val: 63, filed: "2024-04-25", accn: "q3", form: "10-Q" },
    { start: "2024-01-01", end: "2024-03-31", val: 22, filed: "2024-04-25", accn: "q3", form: "10-Q" },
    { start: "2023-07-01", end: "2024-06-30", val: 88, filed: "2024-07-30", accn: "fy", form: "10-K" },
  ] } } } } };
  const rows = secQuarterlyObservations(facts, new Date("2025-01-01"));
  assert.deepEqual(rows.map((row) => [row.period_start, row.period_end, row.value_numeric]), [
    ["2024-01-01", "2024-03-31", 22],
    ["2024-04-01", "2024-06-30", 25],
  ]);
});
