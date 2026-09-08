import { describe, it } from "node:test";
import assert from "node:assert";
import { activeRunStage, countOpenTaskFailures } from "@/lib/research/run-console";

describe("run console status", () => {
  it("selects a human checkpoint before later pending stages", () => {
    const stage = activeRunStage([
      { key: "ai_reviewer", status: "completed" },
      { key: "human_review", status: "waiting_for_human" },
      { key: "export", status: "pending" },
    ]);
    assert.equal(stage?.key, "human_review");
  });

  it("does not display recovered retry attempts as open blockers", () => {
    assert.equal(countOpenTaskFailures([
      { task_key: "source-reader:batch:06", status: "failed" },
      { task_key: "source-reader:batch:06:revision-1", status: "failed" },
      { task_key: "source-reader:batch:06:revision-2", status: "completed" },
      { task_key: "other-task", status: "failed" },
    ]), 1);
  });

  it("does not display failed attempts from completed stages as open blockers", () => {
    assert.equal(countOpenTaskFailures([
      { task_key: "historical-diagnosis:old", status: "failed", stage_id: "history" },
      { task_key: "current-task", status: "failed", stage_id: "current" },
    ], new Set(["history"])), 1);
  });
});
