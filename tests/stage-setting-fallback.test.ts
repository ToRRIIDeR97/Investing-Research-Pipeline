// report_draft was split out of ai_reviewer (architecture-9 P4): its RESEARCH_STAGE_* settings fall back to the
// reviewer's, each setting on its own; no other stage falls back. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveTaskEffort, resolveTaskModel, taskSettingVariables } from "../src/lib/agent-harness/registry";
import { taskExecution } from "../src/lib/research/model-tiering";

const KEYS = ["RESEARCH_STAGE_REPORT_DRAFT_MODEL", "RESEARCH_STAGE_REPORT_DRAFT_EFFORT", "RESEARCH_STAGE_AI_REVIEWER_MODEL",
  "RESEARCH_STAGE_AI_REVIEWER_EFFORT", "RESEARCH_STAGE_AI_REVIEWER_FALLBACK_MODEL", "RESEARCH_STAGE_REPORT_DRAFT_FALLBACK_MODEL",
  "RESEARCH_MID_MODEL", "RESEARCH_MID_EFFORT", "RESEARCH_EFFORT", "RESEARCH_ALL_AGENTS_MODEL", "RESEARCH_EXPORT_WRITER_MODEL",
  "RESEARCH_STAGE_DECISION_SYNTHESIS_MODEL", "RESEARCH_STAGE_MOAT_ANALYSIS_MODEL"];
async function withEnv<T>(values: Record<string, string>, run: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try { return await run(); } finally {
    for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
}
const model = (stageKey: string) => resolveTaskModel({ agentName: "export-writer", tier: "mid", stageKey });
const effort = (stageKey: string) => resolveTaskEffort({ tier: "mid", stageKey });
const vars = (stageKey: string) => taskSettingVariables({ agentName: "export-writer", tier: "mid", stageKey });

test("report_draft uses the reviewer's stage settings when its own are unset", async () => {
  await withEnv({ RESEARCH_STAGE_AI_REVIEWER_MODEL: "claude-sonnet-5-5", RESEARCH_STAGE_AI_REVIEWER_EFFORT: "high",
    RESEARCH_STAGE_AI_REVIEWER_FALLBACK_MODEL: "claude-haiku-5-5", RESEARCH_MID_MODEL: "claude-opus-5-5" }, () => {
    assert.deepEqual(model("report_draft"), { model: "claude-sonnet-5-5", source: "stage", fallbackModel: "claude-haiku-5-5" });
    assert.equal(effort("report_draft"), "high");
    assert.deepEqual(vars("report_draft"), { model: "RESEARCH_STAGE_AI_REVIEWER_MODEL", effort: "RESEARCH_STAGE_AI_REVIEWER_EFFORT" });
    const execution = taskExecution({ agentName: "export-writer", modelTier: "mid", stageKey: "report_draft" });
    assert.equal(execution.modelVariable, "RESEARCH_STAGE_AI_REVIEWER_MODEL", "the record names the variable that applied");
    assert.equal(execution.effortVariable, "RESEARCH_STAGE_AI_REVIEWER_EFFORT");
  });
});

test("report_draft's own settings win, and model and effort fall back independently", async () => {
  await withEnv({ RESEARCH_STAGE_AI_REVIEWER_MODEL: "claude-sonnet-5-5", RESEARCH_STAGE_AI_REVIEWER_EFFORT: "high",
    RESEARCH_STAGE_REPORT_DRAFT_MODEL: "claude-opus-5-5", RESEARCH_STAGE_REPORT_DRAFT_FALLBACK_MODEL: "claude-haiku-5-5" }, () => {
    assert.deepEqual(model("report_draft"), { model: "claude-opus-5-5", source: "stage", fallbackModel: "claude-haiku-5-5" });
    assert.equal(effort("report_draft"), "high", "no REPORT_DRAFT effort: the reviewer's applies");
    assert.deepEqual(vars("report_draft"), { model: "RESEARCH_STAGE_REPORT_DRAFT_MODEL", effort: "RESEARCH_STAGE_AI_REVIEWER_EFFORT" });
    assert.equal(model("ai_reviewer").model, "claude-sonnet-5-5", "the reviewer keeps its own");
  });
  await withEnv({ RESEARCH_STAGE_AI_REVIEWER_MODEL: "claude-sonnet-5-5", RESEARCH_STAGE_REPORT_DRAFT_EFFORT: "low" }, () => {
    assert.equal(model("report_draft").model, "claude-sonnet-5-5", "no REPORT_DRAFT model: the reviewer's applies");
    assert.equal(effort("report_draft"), "low");
    assert.deepEqual(vars("report_draft"), { model: "RESEARCH_STAGE_AI_REVIEWER_MODEL", effort: "RESEARCH_STAGE_REPORT_DRAFT_EFFORT" });
  });
});

test("with neither stage setting the tier applies, and no other stage falls back", async () => {
  await withEnv({ RESEARCH_MID_MODEL: "claude-opus-5-5", RESEARCH_MID_EFFORT: "xhigh" }, () => {
    assert.deepEqual(model("report_draft"), { model: "claude-opus-5-5", source: "tier", fallbackModel: null });
    assert.equal(effort("report_draft"), "xhigh");
    assert.deepEqual(vars("report_draft"), { model: "RESEARCH_MID_MODEL", effort: "RESEARCH_MID_EFFORT" });
  });
  await withEnv({ RESEARCH_STAGE_AI_REVIEWER_MODEL: "claude-sonnet-5-5", RESEARCH_STAGE_DECISION_SYNTHESIS_MODEL: "claude-opus-5-5" }, () => {
    for (const stage of ["decision_synthesis", "human_review", "export", "moat_analysis"])
      assert.notEqual(model(stage).model, "claude-sonnet-5-5", `${stage} does not read the reviewer's model`);
    assert.equal(vars("moat_analysis").model, null, "a default model names no variable");
    assert.equal(vars("moat_analysis").effort, null, "the tier default effort names no variable");
  });
});
