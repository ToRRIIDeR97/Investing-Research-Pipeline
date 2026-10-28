import { describe, it } from "node:test";
import assert from "node:assert";
import {
  getAllStagesForRun,
  getStageConfig,
  STAGE_CONFIGS,
} from "@/lib/workflow/stages";
import {
  evaluateLoadedResearchQuality,
  evaluateQualityGates,
  reviewVerdict,
} from "@/lib/workflow/quality-gates";
import { createResearchRunSchema } from "@/lib/api/validation";
import { readyStages, STAGE_DEPENDENCIES } from "@/lib/research/team-plan";
import {
  requireEvidenceLinks,
} from "@/lib/research/artifacts/validation";
import type { ResearchArtifact } from "@/lib/research/artifacts/contracts";
import { ARTIFACT_SCHEMAS } from "@/lib/research/stage-contracts";

const uuid1 = "00000000-0000-0000-0000-000000000001";

describe("workflow orchestration and quality gates (Component 13)", () => {
  it("C13-T1: Evidence exists but analysis artifact is evidence_only -> validation fails", () => {
    const art = {
      id: uuid1,
      research_run_id: uuid1,
      artifact_type: "operating_model",
      scope_key: "meli-operating-model",
      status: "evidence_only", // evidence_only status
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any as ResearchArtifact;
    const result = requireEvidenceLinks(art, [uuid1], 1);
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes("is evidence_only and cannot satisfy analytical completion"));
  });

  it("C13-T2: Entry criteria dependency chain exists for historical record", () => {
    const modelConfig = getStageConfig("operating_model");
    assert.ok(modelConfig);
    // Operating model requires moat assessment and historical diagnosis
    assert.ok(modelConfig.entryCriteria.includes("historical_diagnosis_exists"));
    assert.ok(modelConfig.entryCriteria.includes("moat_assessment_exists"));

    const diagConfig = getStageConfig("historical_diagnosis");
    assert.ok(diagConfig);
    // Historical diagnosis requires metric observations
    assert.ok(diagConfig.entryCriteria.includes("metric_observations_exist"));
  });

  it("C13-T3: Moat artifact missing blocks operating model and operating scenarios", () => {
    const moatConfig = getStageConfig("moat_analysis");
    assert.ok(moatConfig);
    assert.deepEqual(moatConfig.requiredOutputs, ["moat_assessment"]);

    const modelConfig = getStageConfig("operating_model");
    assert.ok(modelConfig);
    assert.ok(modelConfig.entryCriteria.includes("moat_assessment_exists"));

    const scenarioConfig = getStageConfig("operating_scenarios");
    assert.ok(scenarioConfig);
    assert.ok(scenarioConfig.entryCriteria.includes("operating_model_exists"));
  });

  it("C13-T5: Framework backtest stages are skipped for quick_scan run type", () => {
    const { applicable, skipped } = getAllStagesForRun("quick_scan");
    for (const key of ["indicator_design", "strategy_design", "backtest_execution", "backtest_review"]) {
      assert.equal(skipped.some((stage) => stage.key === key), true);
      assert.equal(applicable.some((stage) => stage.key === key), false);
    }
  });

  it("C13-T6: V3 quality gates detect missing genesis, diagnosis, moat, operating model/scenarios", () => {
    const qualityData = {
      run: { id: uuid1, run_type: "deep_dive", pipeline_version: 3 },
      asset: { slug: "meli" },
      profile: { profile_key: "marketplace_lender" },
      stages: [],
      tasks: [], // no completed tasks!
      sources: [
        { id: uuid1, source_type: "sec_filing", source_quality_score: 0.9, metadata_json: {} },
        { id: "s2", source_type: "sec_filing", source_quality_score: 0.9, metadata_json: {} },
        { id: "s3", source_type: "sec_filing", source_quality_score: 0.9, metadata_json: {} },
        { id: "s4", source_type: "sec_filing", source_quality_score: 0.9, metadata_json: {} },
        { id: "s5", source_type: "sec_filing", source_quality_score: 0.9, metadata_json: {} },
      ],
      evidence: Array(25).fill({ claim_text: "evidence text", claim_category: "fact" }),
      metrics: [],
      signals: [],
      scenarios: [{ value_anchor: "100" }],
      sourceGaps: [],
      reviewDecisions: [],
      analysisSections: [],
      valuationModels: [],
      indicators: [],
      combinations: [],
      backtests: [],
      backtestArtifacts: [],
      unlinkedFactClaimCount: 0,
    };
    const result = evaluateLoadedResearchQuality(qualityData);
    assert.equal(result.status, "needs_more_work");
    // Verify errors mention missing v3 artifacts
    const errStr = result.errors.join(" ");
    assert.ok(errStr.includes("Company Genesis"));
    assert.ok(errStr.includes("Historical Diagnosis"));
    assert.ok(errStr.includes("Business Process Map"));
    assert.ok(errStr.includes("Moat Assessment"));
    assert.ok(errStr.includes("Operating Model"));
    assert.ok(errStr.includes("Operating Scenario Set"));
  });

  it("completes an approved tracking report with a conditional AI verdict while retaining its limits", () => {
    const data = {
      run: { run_type: "deep_dive", pipeline_version: 3 },
      profile: { required_modules_json: ["research"] },
      stages: [],
      artifacts: Object.keys(ARTIFACT_SCHEMAS).map((artifact_type) => ({
        artifact_type, status: "validated", content_json: { research: true },
      })),
      tasks: [
        ...["company_genesis", "historical_diagnosis", "business_process_analysis", "moat_analysis", "operating_model", "operating_scenarios"]
          .map((task_type) => ({ task_type, status: "completed", output_json: { research: true } })),
        { task_type: "ai_review", status: "completed", output_json: { review_verdict: "conditional_pass" } },
      ],
      sources: Array.from({ length: 5 }, (_, index) => ({
        source_type: index === 0 ? "sec_filing" : index === 1 ? "investor_presentation" : "fdic_industry",
        source_quality_score: 0.9,
      })),
      evidence: Array(25).fill({ claim_text: "research evidence" }),
      metrics: [], signals: [],
      scenarios: ["bear", "base", "bull"].map((scenario_type) => ({ scenario_type, value_anchor: 100 })),
      sourceGaps: [],
      reviewDecisions: [{ status: "approved_for_tracking" }],
      analysisSections: [], valuationModels: [], indicators: [], combinations: [], backtests: [], backtestArtifacts: [],
      unlinkedFactClaimCount: 0,
    };
    const result = evaluateLoadedResearchQuality(data);
    assert.equal(result.status, "pass");
    assert.equal(result.actionReadiness, "review_ready");
    assert.ok(result.warnings.some((warning) => warning.includes("conditional_pass")));
    assert.ok(result.warnings.some((warning) => warning.includes("tracking/watchlist")));
    assert.deepEqual(result.missingCoverage, []);

    const missingGenesis = evaluateLoadedResearchQuality({
      ...data, artifacts: data.artifacts.filter((artifact) => artifact.artifact_type !== "company_genesis"),
    });
    assert.equal(missingGenesis.status, "needs_more_work", "completed tasks cannot substitute for missing artifacts");
    const invalidGenesis = evaluateLoadedResearchQuality({
      ...data, artifacts: data.artifacts.map((artifact) => artifact.artifact_type === "company_genesis"
        ? { ...artifact, status: "needs_more_work" } : artifact),
    });
    assert.equal(invalidGenesis.status, "needs_more_work");

    const missingVerdict = evaluateLoadedResearchQuality({
      ...data,
      tasks: data.tasks.map((task) => task.task_type === "ai_review" ? { ...task, output_json: {} } : task),
    });
    assert.equal(missingVerdict.status, "needs_more_work");
    assert.ok(missingVerdict.errors.some((error) => error.includes("no parsed verdict")));

    const position = evaluateLoadedResearchQuality({ ...data, reviewDecisions: [{ status: "approved_for_position" }] });
    assert.equal(position.actionReadiness, "review_ready");
  });

  it("a skipped skip_and_continue stage does not block its dependents (#108)", () => {
    const ledger = Object.keys(STAGE_DEPENDENCIES).map((stage_key) => ({ stage_key, status: "completed" }));
    const set = (key: string, status: string) => { ledger.find((s) => s.stage_key === key)!.status = status; };
    for (const key of ["business_process_analysis", "moat_analysis", "operating_model", "operating_scenarios", "asset_valuation",
      "indicator_design", "strategy_design", "backtest_execution", "backtest_review", "decision_synthesis", "ai_reviewer",
      "human_review", "export", "refresh_schedule"]) set(key, "pending");
    set("company_genesis", "skipped");
    assert.deepEqual(readyStages(ledger), ["business_process_analysis"]);
    set("company_genesis", "failed");
    assert.deepEqual(readyStages(ledger), []);
  });

  it("refuses new backtest_only runs, which skipped both human gates (#109)", () => {
    assert.equal(createResearchRunSchema.safeParse({ run_type: "backtest_only" }).success, false);
    assert.equal(createResearchRunSchema.safeParse({ run_type: "quick_scan" }).success, true);
  });

  it("module coverage needs every word of the key in one claim or metric (#110)", () => {
    const gaps = (claims: string[]) => evaluateQualityGates({
      run: { run_type: "deep_dive", pipeline_version: 3 },
      profile: { required_modules_json: ["net_debt", "unit_economics"] },
      evidence: claims.map((claim_text) => ({ claim_text })),
    }).missingCoverage.filter((item) => item.area === "analysis coverage").map((item) => item.key);
    assert.deepEqual(gaps(["Internet revenue grew", "Net income rose", "Each unit shipped"]), ["analysis_net_debt", "analysis_unit_economics"]);
    assert.deepEqual(gaps(["Net debt fell to $2bn", "Unit economics improved"]), []);
    assert.deepEqual(gaps(["Net revenue rose", "Debt was refinanced"]), ["analysis_net_debt", "analysis_unit_economics"],
      "words split across claims do not cover a module");
  });

  it("only required high or critical gaps block the quality gate; the rest are warnings (#111)", () => {
    const result = evaluateQualityGates({
      run: { run_type: "quick_scan", pipeline_version: 3 },
      profile: { required_modules_json: ["research"] },
      sources: [{ source_type: "sec_filing", title: "10-K", source_quality_score: 0.9 }],
      evidence: Array(5).fill({ claim_text: "research evidence" }),
    });
    const optional = result.missingCoverage.filter((item) => !item.requiredForCompletion);
    assert.ok(optional.length >= 2, "investor-relations and peer gaps are reported");
    assert.deepEqual(result.errors, []);
    assert.equal(result.status, "pass");
    for (const item of optional) assert.ok(result.warnings.includes(item.description));
  });

  it("reads one canonical AI-review verdict and fails closed (#112)", () => {
    assert.equal(reviewVerdict({ status: "ok", review_verdict: "fail" }), "fail");
    assert.equal(reviewVerdict({ review_verdict: " FAIL " }), "fail");
    assert.equal(reviewVerdict({ pass_fail: "pass" }), "pass");
    assert.equal(reviewVerdict({ status: "pass" }), "");
    assert.equal(reviewVerdict("not json"), "");
    assert.equal(reviewVerdict('{"review_verdict":"Pass"}'), "pass");
    const gate = (output_json: unknown) => evaluateQualityGates({
      run: { run_type: "thesis_investigation", pipeline_version: 3 },
      tasks: [{ task_type: "ai_review", status: "completed", output_json }],
    }).missingCoverage.filter((item) => item.key === "ai_review_outcome" || item.key === "ai_review_missing");
    assert.equal(gate({ review_verdict: "pass" }).length, 0);
    assert.equal(gate({ review_verdict: "conditional_pass" }).length, 0);
    assert.equal(gate({ status: "ok", review_verdict: "fail" })[0]?.severity, "critical");
    assert.equal(gate({ review_verdict: "looks fine" }).length, 1, "an unknown verdict blocks");
    assert.equal(gate("pass").length, 1, "a non-JSON string has no verdict");
  });
});
