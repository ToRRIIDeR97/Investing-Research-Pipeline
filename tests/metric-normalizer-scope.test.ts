import assert from "node:assert/strict";
import { test } from "node:test";
import { NORMALIZER_RULES, normalizerCoverage } from "../src/lib/research/handlers/historical-record";

const filed = (metric_key: string, metric_category: string, unit = "USD") =>
  ({ metric_key, value_numeric: 1, unit, metadata_json: { metric_category } });

test("filed statements and companyfacts cover statement families; KPIs stay for the normalizer", () => {
  const observations = [
    filed("revenue", "income_statement"), filed("total_assets", "balance_sheet"), filed("operating_cash_flow", "cash_flow"),
    filed("us_gaap_WeightedAverageNumberOfDilutedSharesOutstanding", "income_statement", "shares"),
    { metric_key: "deposits", value_numeric: 5, unit: "USD", metric_category: "balance_sheet" },
    { ...filed("net_income", "income_statement"), value_numeric: null },
  ];
  const coverage = normalizerCoverage(["income_statement", "balance_sheet", "cash_flow", "share_count", "deposits", "gmv"], observations);
  assert.deepEqual(coverage.uncovered, ["gmv"]);
  assert.ok(coverage.covered.includes("revenue") && coverage.covered.includes("deposits"));
  assert.equal(coverage.covered.includes("net_income"), false);
  assert.deepEqual(normalizerCoverage(["income_statement", "share_count"], observations).uncovered, []);
});

test("the normalizer is told to return a bounded set of uncovered metrics, not every number", () => {
  const rules = NORMALIZER_RULES.join("\n");
  assert.match(rules, /at most 60 normalized_observations, only for metrics absent from covered_metric_keys/);
  assert.doesNotMatch(rules, /standardize all numbers/);
});
