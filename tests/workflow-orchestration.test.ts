import { describe, it } from "node:test";
import assert from "node:assert";
import {
  getAllStagesForRun,
  getStageConfig,
  STAGE_CONFIGS,
  readyStageKeys,
  stageDependencies,
  shouldSkipOptionalBacktest,
} from "@/lib/workflow/stages";
import {
  actionReadinessFor,
  evaluateLoadedResearchQuality,
} from "@/lib/workflow/quality-gates";
import {
  requireEvidenceLinks,
} from "@/lib/research/artifacts/validation";
import type { ResearchArtifact } from "@/lib/research/artifacts/contracts";

const uuid1 = "00000000-0000-0000-0000-000000000001";

describe("workflow orchestration and quality gates (Component 13)", () => {
  it("marks a completed report awaiting only human approval as review ready", () => {
    assert.equal(actionReadinessFor(
      { run: { run_type: "full_initiation_report" }, reviewDecisions: [] } as any,
      { requireHumanReview: true } as any,
      "needs_more_work",
      [{ key: "human_review_decision", severity: "high", area: "human review", description: "Human review required.", requiredForCompletion: true }]
    ), "review_ready");
  });

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

  it("skips framework stages without an accepted timing hypothesis", () => {
    assert.equal(shouldSkipOptionalBacktest("backtest_review", false), true);
    assert.equal(shouldSkipOptionalBacktest("decision_synthesis", false), false);
    assert.equal(shouldSkipOptionalBacktest("backtest_review", true), false);
    assert.ok(getStageConfig("decision_synthesis")?.entryCriteria.includes("asset_valuation_completed"));
  });

  it("releases independent evidence branches together", () => {
    const stages = STAGE_CONFIGS.map((stage) => ({
      stage_key: stage.key,
      status: stage.key === "evidence_extraction" ? "completed" : stage.order < 7 ? "completed" : "pending",
    }));
    assert.deepEqual(
      readyStageKeys(stages).sort(),
      ["business_process_analysis", "company_genesis", "historical_record"].sort()
    );
    assert.deepEqual(stageDependencies("business_process_analysis"), ["evidence_extraction"]);
    assert.deepEqual(stageDependencies("indicator_design"), ["historical_record"]);
  });

  it("makes reviewed backtests a conditional decision dependency", () => {
    assert.deepEqual(stageDependencies("decision_synthesis", false), ["asset_valuation", "company_genesis"]);
    assert.deepEqual(stageDependencies("decision_synthesis", true), ["asset_valuation", "company_genesis", "backtest_review"]);
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

  it("does not block completion on warnings or non-required coverage gaps", () => {
    const result = evaluateLoadedResearchQuality({
      run: { id: uuid1, run_type: "quick_scan", pipeline_version: 1 },
      profile: {},
      stages: [],
      tasks: [],
      sources: [{ id: uuid1, source_type: "sec_filing", metadata_json: {} }],
      evidence: Array(5).fill({ claim_text: "supported evidence", claim_category: "fact" }),
      metrics: [], signals: [], scenarios: [], sourceGaps: [], reviewDecisions: [],
      analysisSections: [], valuationModels: [], indicators: [], combinations: [],
      backtests: [], backtestArtifacts: [], unlinkedFactClaimCount: 0,
    });
    assert.equal(result.status, "pass");
    assert.ok(result.warnings.length > 0 || result.missingCoverage.length > 0);
  });

  it("treats a conditional AI review verdict as blocking", () => {
    const result = evaluateLoadedResearchQuality({
      run: { id: uuid1, run_type: "deep_dive", pipeline_version: 3 },
      profile: {},
      stages: [],
      tasks: [{ task_type: "ai_review", status: "completed", output_json: { review_verdict: "APPROVED WITH CONDITIONS" } }],
      sources: [], evidence: [], metrics: [], signals: [], scenarios: [], sourceGaps: [], reviewDecisions: [],
      analysisSections: [], valuationModels: [], indicators: [], combinations: [],
      backtests: [], backtestArtifacts: [], unlinkedFactClaimCount: 0,
    });
    assert.ok(result.errors.some((error) => error.includes("AI review outcome is approved with conditions")));
  });

  it("requires the canonical reviewer verdict for V4", () => {
    const result = evaluateLoadedResearchQuality({
      run: { id: uuid1, run_type: "quick_scan", pipeline_version: 4 },
      profile: {},
      stages: [],
      tasks: [{ task_type: "ai_review", status: "completed", output_json: { review_verdict: "pass" } }],
      sources: [{ id: uuid1, source_type: "sec_filing", metadata_json: {} }],
      evidence: Array(5).fill({ claim_text: "supported evidence", claim_category: "fact" }),
      metrics: [], signals: [], scenarios: [], sourceGaps: [], reviewDecisions: [],
      analysisSections: [], valuationModels: [], indicators: [], combinations: [],
      backtests: [], backtestArtifacts: [], unlinkedFactClaimCount: 0,
    });
    assert.ok(result.errors.includes("AI review output is missing the canonical pass_fail verdict."));
  });

  it("blocks a full report when twenty-quarter metric coverage is materially incomplete", () => {
    const result = evaluateLoadedResearchQuality({
      run: { id: uuid1, run_type: "full_initiation_report", pipeline_version: 3 },
      profile: {}, stages: [], tasks: [], sources: [], evidence: [], metrics: [], signals: [], scenarios: [],
      sourceGaps: [], reviewDecisions: [], analysisSections: [], valuationModels: [], indicators: [], combinations: [],
      backtests: [], backtestArtifacts: [], unlinkedFactClaimCount: 0,
      historicalRecords: [{ content_json: { coverage: { quarters_present: 22, quarters_required: 740 } } }],
    });
    assert.ok(result.errors.some((error) => error.includes("Historical metric coverage is 3.0% (22/740)")));
  });
});
