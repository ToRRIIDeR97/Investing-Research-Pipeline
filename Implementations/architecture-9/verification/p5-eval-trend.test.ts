import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as trend from "../../../src/lib/research/scoring/trend";
import { DB, ROOT, read } from "../acceptance/fixtures";

const { parseScores, scoreTrend } = trend as unknown as {
  parseScores: (csv: string) => Record<string, unknown>[];
  scoreTrend: (rows: Record<string, unknown>[]) => { case: string; runs: number; latest_run_id: string; pass_rate: number | null;
    previous_pass_rate: number | null; regressed: boolean; reasons: string[] }[];
};

const HEADER = "scoring_commit,case,run_id,run_created_at,cutoff,checks_passed,checks_applicable,probes_flagged,probes_total,traits_present,traits_total,figure_trace_rate,reader_leaks,effective_verdict,human_rating_mean,scored_at";
const line = (o: { c: string; run: string; created: string; passed: number | ""; applicable: number | ""; leaks?: number | ""; scored?: string }) =>
  `bbbbbbb,${o.c},${o.run},${o.created},${o.created},${o.passed},${o.applicable},0,0,0,12,,${o.leaks ?? ""},,,${o.scored ?? "2026-11-01T00:00:00.000Z"}`;
const csv = (...rows: string[]) => [HEADER, ...rows].join("\r\n") + "\r\n";

test("V-5.1: a run scored twice counts once, by its latest scoring", () => {
  const [sofi] = scoreTrend(parseScores(csv(
    line({ c: "SOFI", run: "a", created: "2026-08-05T00:00:00.000Z", passed: 1, applicable: 6, scored: "2026-10-21T00:00:00.000Z" }),
    line({ c: "SOFI", run: "a", created: "2026-08-05T00:00:00.000Z", passed: 3, applicable: 6, scored: "2026-11-12T00:00:00.000Z" }))));
  assert.equal(sofi.runs, 1);
  assert.equal(sofi.pass_rate, 0.5);
  assert.equal(sofi.previous_pass_rate, null);
  assert.equal(sofi.regressed, false);
});

test("V-5.2: more reader leaks at the same pass rate is a regression; a missing leak count is not", () => {
  const leaks = scoreTrend(parseScores(csv(
    line({ c: "META", run: "a", created: "2026-10-01T00:00:00.000Z", passed: 5, applicable: 10, leaks: 3 }),
    line({ c: "META", run: "b", created: "2026-11-01T00:00:00.000Z", passed: 5, applicable: 10, leaks: 9 }))))[0];
  assert.equal(leaks.regressed, true);
  const unknown = scoreTrend(parseScores(csv(
    line({ c: "META", run: "a", created: "2026-10-01T00:00:00.000Z", passed: 5, applicable: 10, leaks: 3 }),
    line({ c: "META", run: "b", created: "2026-11-01T00:00:00.000Z", passed: 5, applicable: 10 }))))[0];
  assert.equal(unknown.regressed, false);
});

test("V-5.3: cases are independent, and no applicable checks gives a null rate without a regression", () => {
  const result = scoreTrend(parseScores(csv(
    line({ c: "META", run: "a", created: "2026-10-01T00:00:00.000Z", passed: 5, applicable: 10 }),
    line({ c: "META", run: "b", created: "2026-11-01T00:00:00.000Z", passed: 2, applicable: 10 }),
    line({ c: "JD", run: "j1", created: "2026-10-01T00:00:00.000Z", passed: 4, applicable: 8 }),
    line({ c: "JD", run: "j2", created: "2026-11-01T00:00:00.000Z", passed: 0, applicable: 0 }))));
  const byCase = Object.fromEntries(result.map(r => [r.case, r]));
  assert.equal(byCase.META.regressed, true);
  assert.equal(byCase.JD.pass_rate, null);
  assert.equal(byCase.JD.regressed, false);
});

test("V-5.4: an empty score file has no cases", () => {
  assert.deepEqual(scoreTrend(parseScores(HEADER + "\n")), []);
});

test("V-5.5: the committed scores parse into one entry per case", () => {
  const cases = scoreTrend(parseScores(read("evals/scores.csv"))).map(r => r.case).sort();
  assert.deepEqual(cases, [...new Set(cases)]);
  assert.ok(cases.includes("META") && cases.includes("MELI"));
});

test("V-5.6 (AC-5.3): --latest with no stored runs reports that and exits 0, writing nothing", { skip: !DB }, () => {
  const before = read("evals/scores.csv");
  const result = spawnSync("npx", ["tsx", "scripts/score-research.ts", "--latest", "--no-write"], { cwd: ROOT, env: process.env, shell: true, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /no run yet/i);
  assert.equal(read("evals/scores.csv"), before);
});

test("V-5.7 (AC-5.4): the docs describe both flags", () => {
  for (const file of ["AGENTS.md", "docs/system.md"]) {
    assert.match(read(file), /--latest/);
    assert.match(read(file), /--check/);
  }
});
