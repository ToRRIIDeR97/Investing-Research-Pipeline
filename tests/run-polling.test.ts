import test from "node:test";
import assert from "node:assert/strict";
import { pollTick, runProgressIsLive } from "../src/lib/research/run-polling";

test("the run page polls only while the run or a queued job can still change", () => {
  assert.equal(runProgressIsLive("running", "running"), true);
  assert.equal(runProgressIsLive("pending", "queued"), true, "a newly queued run");
  assert.equal(runProgressIsLive("waiting_for_human", "queued"), true, "an approval or re-run decision re-arms polling for its job");
  assert.equal(runProgressIsLive("waiting_for_human", "completed"), false, "a run waiting at a gate is not polled");
  assert.equal(runProgressIsLive("completed", "completed"), false);
  assert.equal(runProgressIsLive("needs_more_work", "failed"), false);
  assert.equal(runProgressIsLive(undefined, undefined), false);
});

test("a poll tick is skipped while the previous request is in flight or the tab is hidden", async () => {
  let calls = 0, hidden = false;
  let finish!: () => void;
  const tick = pollTick(() => { calls += 1; return new Promise<void>(resolve => { finish = resolve; }); }, () => hidden);
  tick();
  tick();
  assert.equal(calls, 1, "no overlapping request");
  finish();
  await new Promise(resolve => setImmediate(resolve));
  hidden = true;
  tick();
  assert.equal(calls, 1, "no request while hidden");
  hidden = false;
  tick();
  assert.equal(calls, 2);
});
