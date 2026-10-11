import assert from "node:assert/strict";
import { test } from "node:test";
import { validateArtifactContent } from "@/lib/research/stage-contracts";
import { forecastPeriodErrors, normalizeReconciliation } from "@/lib/research/handlers/operating-model";

const scenario = (threat: string) => ({ scenario_name: "Response", threat_description: threat, response_mechanism: "Price", time_to_response: "1 year", financial_impact: "Lower margin" });

test("undisclosed market share and capacity are null, and a null share skips the share-loss rule", () => {
  const matrix = { artifact_type: "competitive_response_matrix", competitors: [
    { competitor_name: "Rival", market_share: null, main_advantages: ["Scale"], response_scenarios: [scenario("Price war")] },
  ] };
  assert.equal(validateArtifactContent("competitive_response_matrix", matrix).valid, true);
  // A disclosed share above 10% still needs a share-loss scenario.
  const disclosed = { ...matrix, competitors: [{ ...matrix.competitors[0], market_share: 0.25 }] };
  assert.equal(validateArtifactContent("competitive_response_matrix", disclosed).valid, false);
  const register = { artifact_type: "bottleneck_register", bottlenecks: [
    { name: "Licensing", description: "Regulatory approval limits new markets.", capacity_limit: null, unit: "not disclosed", current_utilization: 0.5, mitigation_strategy: "Apply early" },
  ] };
  assert.equal(validateArtifactContent("bottleneck_register", register).valid, true);
});

test("the bottom-up total is the segment sum and is checked against the TAM", () => {
  const output = {
    operating_model: { segments: [{ segment_name: "Ads", forecast_revenue: 900 }, { segment_name: "Other", forecast_revenue: 300 }] },
    top_down_bottom_up_reconciliation: { artifact_type: "top_down_bottom_up_reconciliation", top_down_forecast_total: 1000,
      bottom_up_forecast_total: 1000, tam_limit: 1100, customer_budget_limit: 0 },
  };
  const normalized = normalizeReconciliation(output).top_down_bottom_up_reconciliation;
  assert.equal(normalized.bottom_up_forecast_total, 1200);
  assert.equal(normalized.customer_budget_limit, null);
  // The model said 1000, but the segments sum to 1200, above the 1100 TAM: the stored artifact and the model check both fail.
  assert.equal(output.top_down_bottom_up_reconciliation.bottom_up_forecast_total, 1000);
  assert.match(validateArtifactContent("top_down_bottom_up_reconciliation", normalized).errors.join(" "), /exceeds the TAM limit/);
  assert.equal(validateArtifactContent("top_down_bottom_up_reconciliation", { ...normalized, tam_limit: 1500 }).valid, true);
});

test("an operating model that restates the reported base year as its forecast is rejected (paid META check e13c7632)", () => {
  const period = { fiscal_year: 2026, base_fiscal_year: 2025, base_revenue_millions: 200_966 };
  const model = (revenue: number) => ({ operating_model: { consolidated_revenue: revenue, consolidated_operating_income: revenue * 0.4 } });
  // Reported FY2025 revenue, given in dollars or in millions, is not a FY2026 forecast.
  assert.match(forecastPeriodErrors(model(200_966_000_000), period).map((e) => e.message).join(" "), /repeats reported FY2025 revenue; it must be the FY2026 forecast/);
  assert.equal(forecastPeriodErrors(model(200_966), period).length, 1);
  // A real forecast passes, and so does any answer when the base year is unknown.
  assert.deepEqual(forecastPeriodErrors(model(255_800), period), []);
  assert.deepEqual(forecastPeriodErrors(model(200_966), { ...period, base_revenue_millions: null }), []);
});
