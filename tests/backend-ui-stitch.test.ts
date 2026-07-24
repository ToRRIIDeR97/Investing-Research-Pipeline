import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createResearchRunSchema } from "@/lib/api/validation";
import { CURRENT_PIPELINE_VERSION } from "@/lib/research/version";
import { STAGE_CONFIGS, getAllStagesForRun } from "@/lib/workflow/stages";

describe("backend/UI stitching contracts", () => {
  it("uses one server-owned current pipeline version", () => {
    assert.equal(CURRENT_PIPELINE_VERSION, 3);
    const parsed = createResearchRunSchema.parse({
      run_type: "deep_dive",
      research_question: "test",
      pipeline_version: 1,
    });
    assert.equal("pipeline_version" in parsed, false);
  });

  it("initializes the complete ordered 24-stage ledger", () => {
    const { applicable, skipped } = getAllStagesForRun("deep_dive");
    const stages = [...applicable, ...skipped].sort((a, b) => a.order - b.order);
    assert.equal(STAGE_CONFIGS.length, 24);
    assert.equal(stages.length, 24);
    assert.deepEqual(stages.map((stage) => stage.order), Array.from({ length: 24 }, (_, index) => index + 1));
    assert.equal(new Set(stages.map((stage) => stage.key)).size, 24);
  });

  it("keeps quick-scan skips explicit in the stage ledger", () => {
    const { skipped } = getAllStagesForRun("quick_scan");
    assert.deepEqual(
      skipped.map((stage) => stage.key),
      ["indicator_design", "strategy_design", "backtest_execution", "backtest_review"]
    );
  });
});
