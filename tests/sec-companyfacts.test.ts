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
