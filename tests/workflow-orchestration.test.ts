import { describe, it } from "node:test";
import assert from "node:assert";
import {
  getAllStagesForRun,
  getStageConfig,
  STAGE_CONFIGS,
} from "@/lib/workflow/stages";
import {
  evaluateLoadedResearchQuality,
} from "@/lib/workflow/quality-gates";
import {
  requireEvidenceLinks,
} from "@/lib/research/artifacts/validation";
import type { ResearchArtifact } from "@/lib/research/artifacts/contracts";

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
});
