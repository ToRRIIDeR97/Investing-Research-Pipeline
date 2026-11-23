import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGE_KEY, runStatusWord, stageOf, statusTone } from "../src/lib/research/run-status";
import type { AssetOverview } from "../src/lib/research/asset-overview";
import { researchBriefAction } from "../src/lib/research/brief-presentation";
import { runBars } from "../src/lib/research/run-bars";

test("runStatusWord: the plan gate reads Needs plan approval only with its stage key", () => {
  assert.equal(runStatusWord("waiting_for_human"), "Needs your decision");
  assert.equal(runStatusWord("waiting_for_human", "human_review"), "Needs your decision");
  assert.equal(runStatusWord("waiting_for_human", "research_plan"), "Needs plan approval");
  assert.equal(runStatusWord("completed", "research_plan"), "Decided");
  assert.equal(runStatusWord("cancelled"), "Stopped");
  assert.equal(runStatusWord(null), "Not started");
  assert.equal(runStatusWord("running"), "Researching");
  assert.equal(statusTone("Needs plan approval"), "waiting");
});

const asset = (id: string, status: string | null, waiting_stage_key: string | null = null) => ({
  id, canonical_name: id, slug: id, asset_kind: "equity", sector: null, status: null, ticker: null,
  latest_run: status ? { id: `${id}-run`, status, run_type: "full_initiation", created_at: "2026-11-01T00:00:00Z", waiting_stage_key } : null,
  snapshot: null, snapshot_run: null,
}) as unknown as AssetOverview;

test("stageOf: every asset counts under exactly one stage, plan approval apart from decisions", () => {
  const assets = [asset("a", "waiting_for_human", "research_plan"), asset("b", "waiting_for_human", "human_review"), asset("c", "needs_more_work"),
    asset("d", "running"), asset("e", "completed"), asset("f", "failed"), asset("g", null)];
  const reviewing = new Set(["b"]);
  const keys = assets.map((a) => stageOf(a, reviewing).key);
  assert.deepEqual(keys, ["plan", "review", "review", "running", "done", "stopped", "idea"]);
  const stageKeys = [...new Set(Object.values(STAGE_KEY))];
  const counted = stageKeys.reduce((n, key) => n + assets.filter((a) => stageOf(a, reviewing).key === key).length, 0);
  assert.equal(counted, assets.length);
});

test("the hero, the cards and the runs chart agree on a run waiting for plan approval", () => {
  const run = { id: "r", status: "waiting_for_human", stages: [{ stage_key: "research_plan", status: "waiting_for_human" }] };
  assert.equal(researchBriefAction(run, "x").label, "Needs plan approval");
  assert.equal(stageOf(asset("x", "waiting_for_human", "research_plan")).label, "Needs plan approval");
  assert.equal(runBars([{ id: "r", created_at: "2026-11-01T00:00:00Z", status: "waiting_for_human", waiting_stage_key: "research_plan" }]).runs[0].outcome, "Needs plan approval");
});
