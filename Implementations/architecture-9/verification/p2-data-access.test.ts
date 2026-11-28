import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, describe } from "node:test";
import postgres from "postgres";
import { claimNextResearchRun, renewResearchRunLease } from "../../../src/lib/research/run-queue";
import { DB, code, sourceFiles } from "../acceptance/fixtures";

test("V-2.1: no module outside src/db ends a shared pool or builds its own drizzle client on a new connection", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles().filter(f => !f.startsWith("src/db/"))) {
    const source = code(file);
    if (/pipeline(Sql|Db)\(\)\s*\.end\(/.test(source)) offenders.push(`${file}: ends a shared pool`);
    if (/drizzle\(\s*postgres\(/.test(source)) offenders.push(`${file}: drizzle on an ad-hoc client`);
    if (/drizzle\(\s*pipelineSql\(\)/.test(source)) offenders.push(`${file}: drizzle wraps the raw pool`);
  }
  assert.deepEqual(offenders, []);
});

test("V-2.2: the session lock keeps its own connection", () => {
  const source = code("src/lib/research/pipeline-runner.ts");
  assert.match(source, /pg_try_advisory_lock/);
  assert.match(source, /pg_advisory_unlock/);
});

describe("queue connections", { skip: !DB }, () => {
  const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  const open = async () => Number((await probe`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database()`)[0].n);
  after(() => probe.end({ timeout: 5 }));

  test("V-2.3 (AC-2.4): 40 concurrent claims share a pool", async () => {
    const before = await open();
    let peak = before;
    const sampler = setInterval(() => { open().then(n => { peak = Math.max(peak, n); }).catch(() => undefined); }, 15);
    try {
      const claims = await Promise.all(Array.from({ length: 40 }, () => claimNextResearchRun(`probe-${crypto.randomUUID()}`, 1000, { runId: crypto.randomUUID() })));
      assert.ok(claims.every(job => job === null), "claims scoped to unknown runs take nothing");
      peak = Math.max(peak, await open());
    } finally { clearInterval(sampler); }
    assert.ok(peak - before <= 15, `opened ${peak - before} connections for 40 claims`);
  });

  test("V-2.4: 30 sequential lease renewals do not open 30 connections", async () => {
    const [{ sessions: start }] = await probe`SELECT COALESCE(sessions, 0) AS sessions FROM pg_stat_database WHERE datname = current_database()`;
    for (let i = 0; i < 30; i++) assert.equal(await renewResearchRunLease(crypto.randomUUID(), "nobody"), null);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const [{ sessions: end }] = await probe`SELECT COALESCE(sessions, 0) AS sessions FROM pg_stat_database WHERE datname = current_database()`;
    // pg_stat_database.sessions is cumulative and may lag; a per-call client would add about 30.
    assert.ok(Number(end) - Number(start) < 20, `${Number(end) - Number(start)} new sessions for 30 renewals`);
  });
});
