import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { getTeamRequests, ownerArtifactTypes, REQUEST_CONTRACT } from "../src/lib/research/team";
import { validateSchema } from "../src/lib/agent-harness/validation";
import { saveReportArtifact } from "../src/lib/research/reporting/store";
import { cleanup, createRun, drain, loadEnv, saveBatch, scriptModel, skipDb as skip } from "../Implementations/research-request-routing/verification/fixtures";

loadEnv();

test("an owner answers from its role's artifacts and its home stage's inputs, not the whole archive", () => {
  const valuation = ownerArtifactTypes("valuation");
  for (const type of ["valuation_scenario_set", "reverse_valuation", "annual_price_target_path", "operating_scenario_set"]) assert.ok(valuation.has(type), type);
  for (const type of ["historical_record", "strategic_dna", "moat_assessment", "investment_thesis"]) assert.ok(!valuation.has(type), type);

  const financials = ownerArtifactTypes("financials");
  assert.ok(financials.has("historical_record"));
  assert.ok(!financials.has("operating_scenario_set") && !financials.has("valuation_scenario_set"));

  const business = ownerArtifactTypes("business");
  for (const type of ["company_genesis", "historical_diagnosis", "moat_assessment", "operating_model", "operating_scenario_set"]) assert.ok(business.has(type), type);
  for (const type of ["historical_record", "valuation_scenario_set", "investment_thesis"]) assert.ok(!business.has(type), type);
});

test("team requests past the fifth are dropped before validation instead of failing it", () => {
  const request = (i: number) => ({ role: "financials", question: `Reconcile segment revenue for quarter ${i}.`, material: true,
    needs_sources: false, source_role: "regulatory_filing" });
  assert.deepEqual(validateSchema({ requests: [1, 2, 3, 4, 5, 6, 7].map(request) }, REQUEST_CONTRACT), []);
  const invalid = [request(1), { ...request(2), role: "regulatory_filing" }, request(3)];
  assert.ok(validateSchema({ requests: invalid }, REQUEST_CONTRACT).length > 0, "the kept requests are still validated");
});

test("a valuation answer gets valuation and scenario artifacts only, and may still cite any current artifact", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    const record = await saveReportArtifact(sql, run, "historical_record", `${run.assetSlug}-historical-record`, { artifact_type: "historical_record", fixture: run.runId });
    const scenarios = await saveReportArtifact(sql, run, "operating_scenario_set", `${run.assetSlug}-scenarios`, { artifact_type: "operating_scenario_set", fixture: run.runId });
    const value = await saveReportArtifact(sql, run, "valuation_scenario_set", `${run.assetSlug}-valuation`, { artifact_type: "valuation_scenario_set", fixture: run.runId });
    const model = scriptModel(packet => packet.output_contract !== "team_answer" ? undefined : { status: "answered",
      answer: "The terminal value uses the reported diluted share count.", evidence_ids: [], artifact_ids: [String(record.id)] });
    try {
      await saveBatch(sql, run, [{ id: "request-1-1", role: "valuation", source_role: "regulatory_filing",
        question: "Which share count does the terminal value use?", material: true, needs_sources: false }]);
      await drain(sql, run);
      const [answer] = model.answers();
      assert.ok(answer, "the valuation owner answered");
      assert.deepEqual(answer.packet.artifacts.map((a: any) => a.id).sort(), [String(scenarios.id), String(value.id)].sort());
      const response = (await getTeamRequests(sql, run.runId))!.requests[0].response!;
      assert.deepEqual(response.artifact_ids, [String(record.id)], "citations are checked against every current input");
    } finally { model.restore(); }
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});
