import assert from "node:assert/strict";
import test from "node:test";
import { teamBriefScheduler } from "../src/lib/research/team";

const ctx = {} as any;
const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settled = async (promise: Promise<unknown>) => {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  return done;
};

test("ingestion and extraction run while the briefs are written; the first briefed stage waits for them", async () => {
  const brief = deferred();
  let calls = 0;
  const briefs = teamBriefScheduler(() => { calls++; return calls === 1 ? brief.promise : Promise.resolve(); });
  assert.equal(await settled(briefs.before(ctx, ["source_ingestion"])), true, "ingestion does not wait for the briefs");
  assert.equal(await settled(briefs.before(ctx, ["evidence_extraction"])), true, "neither does extraction");
  assert.equal(calls, 1, "briefs still in flight are not started again");
  const specialists = briefs.before(ctx, ["historical_record", "company_genesis"]);
  assert.equal(await settled(specialists), false, "specialist stages wait for the briefs");
  brief.resolve();
  await specialists;
});

test("a brief call that finished early (discovery not done yet) is started again on a later pass", async () => {
  const startedAt: string[] = [];
  let pass = "";
  const brief = deferred();
  const briefs = teamBriefScheduler(() => { startedAt.push(pass); return pass === "source_ingestion" ? brief.promise : Promise.resolve(); });
  for (pass of ["research_plan", "source_discovery"]) {
    await briefs.before(ctx, [pass]);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  pass = "source_ingestion";
  await briefs.before(ctx, [pass]);
  assert.deepEqual(startedAt, ["research_plan", "source_discovery", "source_ingestion"], "a finished call does not stand in for later briefs");
  pass = "historical_record";
  const specialists = briefs.before(ctx, [pass]);
  assert.equal(await settled(specialists), false, "the specialists wait for the briefs started after discovery");
  brief.resolve();
  await specialists;
  assert.equal(startedAt.length, 3);
});

test("a brief failure stops the run before a briefed stage, and drain waits for calls in flight", async () => {
  const failing = teamBriefScheduler(async () => { throw new Error("brief failed"); });
  await failing.before(ctx, ["source_ingestion"]);
  await assert.rejects(failing.before(ctx, ["company_genesis"]), /brief failed/);

  const brief = deferred();
  const inFlight = teamBriefScheduler(() => brief.promise);
  await inFlight.before(ctx, ["evidence_extraction"]);
  const drained = inFlight.drain();
  assert.equal(await settled(drained), false, "the lock is not released under a running brief call");
  brief.reject(new Error("late failure"));
  await drained;
});
