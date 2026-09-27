import { test } from "node:test";
import assert from "node:assert/strict";
import { researchBriefAction } from "../src/lib/research/brief-presentation";

test("the brief opens the correct persisted human gate and selected run", () => {
  const run = { id: "older-run", status: "waiting_for_human" };
  const plan = researchBriefAction({ ...run, stages: [{ stage_key: "research_plan", status: "waiting_for_human" }] }, "asset");
  assert.equal(plan.action, "Review plan");
  assert.equal(plan.href, "/assets/asset/run?run=older-run");
  const final = researchBriefAction({ ...run, stages: [{ stage_key: "research_plan", status: "completed" }, { stage_key: "human_review", status: "waiting_for_human" }] }, "asset");
  assert.equal(final.action, "Review");
  assert.equal(final.href, "/review?run=older-run");
  assert.equal(researchBriefAction({ ...run, stages: [] }, "asset").action, "Run details");
  assert.equal(researchBriefAction({ ...run, status: "completed" }, "asset").label, "Completed");
  assert.equal(researchBriefAction({ ...run, status: "failed" }, "asset").tone, "error");
  assert.equal(researchBriefAction(null, "asset").action, "Start research");
});
