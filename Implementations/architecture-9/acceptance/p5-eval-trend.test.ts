import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as trend from "../../../src/lib/research/scoring/trend";
import { ROOT, read } from "./fixtures";

const { parseScores, scoreTrend } = trend as unknown as {
  parseScores: (csv: string) => Record<string, unknown>[];
  scoreTrend: (rows: Record<string, unknown>[]) => { case: string; runs: number; latest_run_id: string; pass_rate: number | null;
    previous_pass_rate: number | null; regressed: boolean; reasons: string[] }[];
};

const HEADER = "scoring_commit,case,run_id,run_created_at,cutoff,checks_passed,checks_applicable,probes_flagged,probes_total,traits_present,traits_total,figure_trace_rate,reader_leaks,effective_verdict,human_rating_mean,scored_at";
const row = (c: string, run: string, created: string, passed: number, applicable: number, leaks: number | "", scored = "2026-11-01T00:00:00.000Z", commit = "aaaaaaa") =>
  `${commit},${c},${run},${created},${created},${passed},${applicable},0,8,3,12,0.8,${leaks},needs_more_work,,${scored}`;
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n") + "\n";

test("AC-5.1: one run per case never regresses", () => {
  const [meta] = scoreTrend(parseScores(csv(row("META", "run-1", "2026-10-13T00:00:00.000Z", 2, 13, 33))));
  assert.equal(meta.case, "META");
  assert.equal(meta.runs, 1);
  assert.equal(meta.latest_run_id, "run-1");
  assert.ok(Math.abs(meta.pass_rate! - 2 / 13) < 1e-9);
  assert.equal(meta.previous_pass_rate, null);
  assert.equal(meta.regressed, false);
});

test("AC-5.1: a higher pass rate and fewer leaks is an improvement", () => {
  const [meta] = scoreTrend(parseScores(csv(
    row("META", "run-2", "2026-11-10T00:00:00.000Z", 9, 13, 4),
    row("META", "run-1", "2026-10-13T00:00:00.000Z", 2, 13, 33))));
  assert.equal(meta.runs, 2);
  assert.equal(meta.latest_run_id, "run-2", "runs are ordered by run_created_at, not by file order");
  assert.ok(Math.abs(meta.previous_pass_rate! - 2 / 13) < 1e-9);
  assert.equal(meta.regressed, false);
  assert.deepEqual(meta.reasons, []);
});

test("AC-5.1: a lower pass rate is a regression with a reason", () => {
  const [meli] = scoreTrend(parseScores(csv(
    row("MELI", "run-1", "2026-09-29T00:00:00.000Z", 6, 13, 10),
    row("MELI", "run-2", "2026-11-10T00:00:00.000Z", 4, 13, 10))));
  assert.equal(meli.regressed, true);
  assert.ok(meli.reasons.length >= 1);
});

test("AC-5.2: --check needs no database and passes on the committed scores", () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const result = spawnSync("npx", ["tsx", "scripts/score-research.ts", "--check"], { cwd: ROOT, env, shell: true, encoding: "utf8", timeout: 60_000 });
  const expected = scoreTrend(parseScores(read("evals/scores.csv"))).some(c => c.regressed) ? 1 : 0;
  assert.equal(result.status, expected, result.stderr || result.stdout);
  assert.match(result.stdout, /META/);
});
