// P4: AC-9 the Quant snapshot API: day cache, error codes, partial snapshots. AC-11 (part): no model calls, no artifacts.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fixtureInputs as inputs, root } from "./support";

function memoryStore() {
  const rows = new Map<string, any>();
  return { rows, store: { get: async (t: string, d: string) => rows.get(`${t}|${d}`) ?? null, put: async (s: any, d: string, status: string) => { rows.set(`${s.ticker}|${d}`, { ...s, _status: status }); } } };
}

test("AC-9: the second request the same day comes from the cache, without loading", async () => {
  const { getQuantSnapshot } = await import("../../../src/lib/api/quant");
  const { store, rows } = memoryStore();
  let loads = 0;
  const deps = { store, load: async () => { loads++; return inputs(); }, research: async () => null, now: new Date("2025-11-21T15:00:00Z") };
  const first = await getQuantSnapshot("fixa", deps);
  assert.equal(first.cached, false);
  assert.equal(first.snapshot.ticker, "FIXA");
  assert.ok(first.snapshot.value, "value computed");
  assert.equal(first.snapshot.value!.engine, "A");
  assert.ok(first.snapshot.trend.conditions.rules.length === 9);
  assert.equal(rows.get("FIXA|2025-11-21")._status, "ok");
  const second = await getQuantSnapshot("FIXA", deps);
  assert.equal(second.cached, true);
  assert.equal(loads, 1);
  // Changed in review (AC-9, throttle): a refresh within five minutes of the cached snapshot returns it unchanged;
  // a refresh after that recomputes. See "Test changes" in implementation.md.
  const throttled = await getQuantSnapshot("FIXA", { ...deps, refresh: true });
  assert.equal(throttled.cached, true);
  assert.equal(loads, 1);
  const refreshed = await getQuantSnapshot("FIXA", { ...deps, refresh: true, now: new Date("2025-11-21T15:06:00Z") });
  assert.equal(refreshed.cached, false);
  assert.equal(loads, 2);
});

test("AC-9: unknown ticker 404, ETF 422, malformed 400", async () => {
  const { getQuantSnapshot } = await import("../../../src/lib/api/quant");
  const { QuantInputError } = await import("../../../src/lib/quant/inputs");
  const { store } = memoryStore();
  const failing = (code: string) => ({ store, research: async () => null, load: async () => { throw new QuantInputError(code as any, `fails ${code}`); } });
  await assert.rejects(getQuantSnapshot("ZZZZ", failing("unknown_ticker")), (e: any) => e.statusCode === 404 || e.status === 404);
  await assert.rejects(getQuantSnapshot("SPY", failing("not_equity")), (e: any) => (e.statusCode ?? e.status) === 422 && /not_equity|PragValue|fails/.test(e.message));
  await assert.rejects(getQuantSnapshot("not a ticker!", failing("unknown_ticker")), (e: any) => (e.statusCode ?? e.status) === 400);
});

test("AC-9: a non-SEC issuer gives a partial snapshot: Value unavailable with a reason, Trend computed", async () => {
  const { getQuantSnapshot } = await import("../../../src/lib/api/quant");
  const { store, rows } = memoryStore();
  const r = await getQuantSnapshot("FORN", { store, research: async () => null, now: new Date("2025-11-21T15:00:00Z"),
    load: async () => inputs({ ticker: "FORN", cik: null, fundamentals: null, fundamentals_reason: "Not an SEC filer." }) });
  assert.equal(r.snapshot.value, null);
  assert.equal(r.snapshot.value_reason, "Not an SEC filer.");
  assert.equal(r.snapshot.trend.conditions.evaluated, 9);
  assert.equal(rows.get("FORN|2025-11-21")._status, "partial");
});

test("AC-11: the Quant code makes no model calls and writes no research artifacts", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(n)) files.push(p); } };
  walk(join(root, "src/lib/quant"));
  files.push(join(root, "src/lib/api/quant.ts"), join(root, "src/app/api/quant/[ticker]/route.ts"));
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /callResearchAgent|runResearchAgent|agent-harness/, `${f} calls a model`);
    assert.doesNotMatch(text, /INSERT INTO research_artifacts|upsertArtifact|saveReportArtifact/, `${f} writes research artifacts`);
  }
});
