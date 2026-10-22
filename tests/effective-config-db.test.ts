// AR-QOL-3: a run records the settings it ran with: per job (provider, models, limits) and per task type.
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { recordEffectiveRunConfig, recordEffectiveTaskConfig, taskExecution } from "../src/lib/research/model-tiering";
import { cleanup, createRun, loadEnv, skipDb as skip } from "../Implementations/research-request-routing/acceptance/fixtures";

loadEnv();

test("effective_config keeps the run's settings, the history of a changed job, and every model a task type used", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const run = await createRun(sql);
  const saved = process.env.RESEARCH_PREMIUM_MODEL;
  try {
    await recordEffectiveRunConfig(sql, run.runId);
    await recordEffectiveRunConfig(sql, run.runId);
    process.env.RESEARCH_PREMIUM_MODEL = "claude-opus-5-5";
    await recordEffectiveRunConfig(sql, run.runId);
    const premium = taskExecution({ agentName: "asset-analyst", modelTier: "premium", stageKey: "decision_synthesis" });
    delete process.env.RESEARCH_PREMIUM_MODEL;
    const plain = taskExecution({ agentName: "asset-analyst", modelTier: "premium", stageKey: "decision_synthesis" });
    // Parallel writes of one run must not lose each other.
    await Promise.all([
      recordEffectiveTaskConfig(sql, run.runId, "decision_synthesis", { ...premium, agentName: "asset-analyst" }),
      recordEffectiveTaskConfig(sql, run.runId, "team_answer", { ...taskExecution({ agentName: "asset-analyst", modelTier: "cheap", stageKey: "ai_reviewer" }), agentName: "asset-analyst" }),
    ]);
    await recordEffectiveTaskConfig(sql, run.runId, "decision_synthesis", { ...plain, agentName: "asset-analyst" });
    const [row] = await sql`SELECT metadata_json->'effective_config' AS config FROM research_runs WHERE id = ${run.runId}`;
    const config = row.config;
    assert.equal(config.run.tier_models.premium, "claude-opus-5-5");
    assert.equal(config.history.length, 1, "an unchanged job adds nothing; a changed one keeps the earlier settings");
    assert.equal(config.history[0].tier_models.premium, null);
    assert.deepEqual(Object.keys(config.tasks).sort(), ["decision_synthesis", "team_answer"]);
    assert.equal(config.tasks.decision_synthesis.effort, "high");
    assert.equal(config.tasks.decision_synthesis.max_output_tokens, 65_536);
    assert.equal(config.tasks.team_answer.effort, "low");
    assert.deepEqual([...config.tasks.decision_synthesis.models].sort(), [plain.model, "claude-opus-5-5"].sort());
  } finally {
    if (saved === undefined) delete process.env.RESEARCH_PREMIUM_MODEL; else process.env.RESEARCH_PREMIUM_MODEL = saved;
    await cleanup(sql, [run.runId], [run.assetId]); await sql.end();
  }
});
