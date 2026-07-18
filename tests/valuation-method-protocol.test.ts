import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_CONFIGS } from "../src/lib/agent-harness/registry";
import { validateSchema } from "../src/lib/agent-harness/validation";
import {
  executeValuationMethod,
  methodSatisfiesRequiredModel,
  validateValuationMethodSet,
  valuationMethodSpecSchema,
} from "../src/lib/valuation/method-protocol";

function meliRevenueSotp() {
  return {
    protocol_version: "1.0",
    method_key: "meli_revenue_sotp",
    method_name: "MELI Commerce and Fintech Revenue SOTP",
    method_version: "1.0.0",
    method_family: "sum_of_parts",
    origin: "proposed",
    rationale: "Values commerce and fintech independently when segment operating income is unavailable, while making the proxy limitation explicit.",
    replaces_method_keys: ["fintech_platform_sotp"],
    inputs: [
      { key: "commerce_revenue", label: "Commerce revenue", source: "metric", metric_key: "commerce_revenue", unit: "USD" },
      { key: "fintech_revenue", label: "Fintech revenue", source: "metric", metric_key: "fintech_revenue", unit: "USD" },
      { key: "commerce_multiple", label: "Commerce revenue multiple", source: "assumption", value: 4, unit: "multiple", rationale: "Explicit valuation assumption" },
      { key: "fintech_multiple", label: "Fintech revenue multiple", source: "assumption", value: 8, unit: "multiple", rationale: "Explicit valuation assumption" },
      { key: "cash", label: "Cash", source: "metric", metric_key: "cash_and_equivalents", unit: "USD" },
      { key: "debt", label: "Debt", source: "metric", metric_key: "total_debt", unit: "USD" },
      { key: "shares", label: "Diluted shares", source: "metric", metric_key: "shares_outstanding", unit: "shares" },
    ],
    formulas: [
      { key: "commerce_value", label: "Commerce value", operation: "multiply", args: ["commerce_revenue", "commerce_multiple"], unit: "USD" },
      { key: "fintech_value", label: "Fintech value", operation: "multiply", args: ["fintech_revenue", "fintech_multiple"], unit: "USD" },
      { key: "enterprise_value", label: "Enterprise value", operation: "add", args: ["commerce_value", "fintech_value"], unit: "USD" },
      { key: "value_plus_cash", label: "Value plus cash", operation: "add", args: ["enterprise_value", "cash"], unit: "USD" },
      { key: "equity_value", label: "Equity value", operation: "subtract", args: ["value_plus_cash", "debt"], unit: "USD" },
      { key: "per_share_value", label: "Per-share value", operation: "divide", args: ["equity_value", "shares"], unit: "USD_per_share" },
    ],
    outputs: {
      enterprise_value: "enterprise_value",
      equity_value: "equity_value",
      per_share_value: "per_share_value",
    },
    scenarios: [
      { scenario_name: "Bull", scenario_type: "bull", probability: 0.2, overrides: { commerce_multiple: 6, fintech_multiple: 10 }, confidence: 0.5, rationale: "Sustained segment growth" },
      { scenario_name: "Base", scenario_type: "base", probability: 0.55, overrides: { commerce_multiple: 4, fintech_multiple: 8 }, confidence: 0.7, rationale: "Current operating trajectory" },
      { scenario_name: "Bear", scenario_type: "bear", probability: 0.25, overrides: { commerce_multiple: 2, fintech_multiple: 4 }, confidence: 0.5, rationale: "Multiple compression" },
    ],
    tables: [{
      table_key: "sotp_summary",
      title: "Sum-of-the-parts summary",
      columns: ["value"],
      rows: [
        { label: "Commerce", cells: { value: "commerce_value" } },
        { label: "Fintech", cells: { value: "fintech_value" } },
        { label: "Equity value", cells: { value: "equity_value" } },
        { label: "Per share", cells: { value: "per_share_value" } },
      ],
    }],
    limitations: ["Revenue multiples are a proxy because segment operating income is unavailable."],
  };
}

const metrics = [
  { id: "commerce", metricKey: "commerce_revenue", value: 1_000, evidenceClaimId: "27c7bd9e-4948-4ac6-8558-84ff4d06db1a" },
  { id: "fintech", metricKey: "fintech_revenue", value: 500, evidenceClaimId: "dc445f5b-fc6d-4f98-89a6-a26120895665" },
  { id: "cash", metricKey: "cash_and_equivalents", value: 100 },
  { id: "debt", metricKey: "total_debt", value: 50 },
  { id: "shares", metricKey: "shares_outstanding", value: 10 },
];

test("executes a novel MELI method through the deterministic protocol", () => {
  const result = executeValuationMethod(meliRevenueSotp(), metrics);
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.equal(result.methodState, "validated");
  assert.equal(result.outputs.per_share_value, 805);
  assert.equal(result.scenarios.find((scenario) => scenario.scenarioType === "bull")?.valueAnchor, 1_105);
  assert.equal(result.scenarios.find((scenario) => scenario.scenarioType === "bear")?.valueAnchor, 405);
  assert.equal(result.tables[0].rows.at(-1)?.cells.value, 805);
  assert.equal(result.inputManifest.find((input) => input.key === "commerce_revenue")?.metricObservationId, "commerce");
  assert.equal(methodSatisfiesRequiredModel(result.spec!, "fintech_platform_sotp"), true);
});

test("blocks a method when a declared metric is unavailable", () => {
  const result = executeValuationMethod(meliRevenueSotp(), metrics.filter((metric) => metric.metricKey !== "fintech_revenue"));
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /fintech_revenue.*unavailable/);
});

test("rejects arbitrary generated code and expression fields", () => {
  const candidate = { ...meliRevenueSotp(), code: "process.exit(0)" };
  const result = executeValuationMethod(candidate, metrics);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /Unrecognized key.*code/);
});

test("rejects forward formula references", () => {
  const candidate = meliRevenueSotp();
  candidate.formulas[0].args = ["future_value", "commerce_multiple"];
  const result = executeValuationMethod(candidate, metrics);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /forward-referenced/);
});

test("the method schema requires exactly three scenarios and a reproducible table", () => {
  const candidate = meliRevenueSotp();
  candidate.scenarios = candidate.scenarios.slice(0, 2);
  candidate.tables = [];
  const parsed = valuationMethodSpecSchema.safeParse(candidate);
  assert.equal(parsed.success, false);
});

test("required models can be satisfied by a conforming replacement method", () => {
  const validation = validateValuationMethodSet(
    [meliRevenueSotp()],
    ["fintech_platform_sotp"],
    metrics
  );
  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.equal(validation.executions.get("fintech_platform_sotp")?.valid, true);

  const missing = validateValuationMethodSet([meliRevenueSotp()], ["driver_based_dcf"], metrics);
  assert.equal(missing.valid, false);
  assert.match(missing.errors[0], /no conforming method proposal/);

  const invalid = { ...meliRevenueSotp(), protocol_version: "2.0" };
  const repairFeedback = validateValuationMethodSet([invalid], ["fintech_platform_sotp"], metrics);
  assert.equal(repairFeedback.valid, false);
  assert.match(repairFeedback.errors.join("\n"), /protocol_version/);
});

test("valuation agent schema gives nested method-shape errors before semantic execution", () => {
  const output: any = {
    applicable_methods: [], not_applicable_methods: [], valuation_signals: [], scenarios: [],
    method_proposals: [meliRevenueSotp()], assumptions: [], sensitivity_notes: [], method_risks: [], source_gaps: [],
  };
  const schema = AGENT_CONFIGS["valuation-analyst"].outputFormat;
  assert.deepEqual(validateSchema(output, schema), []);

  delete output.method_proposals[0].formulas[0].operation;
  const errors = validateSchema(output, schema);
  assert.ok(errors.some((error) => error.path.endsWith("formulas[0].operation")));
});
