import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStructuredOutput } from "../src/lib/agent-harness/output-parser";
import { resolveTable } from "../src/lib/research/reporting/tables";

test("a single-artifact answer missing its wrapper key is wrapped instead of sent to repair", () => {
  const artifact = { artifact_type: "operating_scenario_set", probability_base: 0.5, scenarios: [] };
  assert.deepEqual(parseStructuredOutput(JSON.stringify(artifact), ["operating_scenario_set"]), { operating_scenario_set: artifact });
  // Only a matching artifact_type is wrapped; anything else still fails as before.
  assert.throws(() => parseStructuredOutput(JSON.stringify({ artifact_type: "other", x: 1 }), ["operating_scenario_set"]), /missing required keys/);
  assert.throws(() => parseStructuredOutput(JSON.stringify(artifact), ["operating_scenario_set", "notes"]), /missing required keys/);
});

test("a fence inside a JSON string is not taken for the answer", () => {
  const report = { report: "Summary\n\n```json\n{\"x\":1}\n```\n\nCode:\n```python\nprint(1)\n```" };
  assert.deepEqual(parseStructuredOutput(JSON.stringify(report), ["report"]), report);
  // A fence that wraps the whole output is unwrapped, even when the answer holds fences of its own.
  assert.deepEqual(parseStructuredOutput("```json\n" + JSON.stringify(report) + "\n```", ["report"]), report);
  // Prose around a fenced answer still parses.
  assert.deepEqual(parseStructuredOutput('Here it is:\n```json\n{"report":"ok"}\n```\nDone.', ["report"]), { report: "ok" });
  // Prose that holds a stray object still falls back to the first fence.
  assert.deepEqual(parseStructuredOutput('Example {"a":1}\n```json\n{"b":2}\n```'), { b: 2 });
});

test("a table path that names content_json resolves inside it", () => {
  const artifacts = [{ id: "a1", artifact_type: "risk_register", content_json: { risks: [{ name: "Credit" }, { name: "Funding" }] } }] as any[];
  const table = (path: string) => ({ title: "Risks", artifact_id: "a1", path }) as any;
  assert.deepEqual(resolveTable(table("content_json.risks.1"), artifacts), { name: "Funding" });
  assert.deepEqual(resolveTable(table("risks.1"), artifacts), { name: "Funding" });
  assert.throws(() => resolveTable(table("content_json.missing"), artifacts), /Unknown table path content_json.missing/);
});
