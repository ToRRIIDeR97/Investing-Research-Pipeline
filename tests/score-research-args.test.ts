// npm run eval:score argument rules and the trend formatting (architecture-9 P5). No database.
import test from "node:test";
import assert from "node:assert/strict";
import { parseScoreArgs } from "../src/lib/research/scoring/command";
import { formatTrend, parseScores, scoreTrend } from "../src/lib/research/scoring/trend";

test("the older modes keep their precedence and their write default", () => {
  assert.deepEqual(parseScoreArgs(["run-1", "run-2"]), { mode: "runs", runIds: ["run-1", "run-2"], write: true });
  assert.deepEqual(parseScoreArgs(["run-1", "--no-write"]), { mode: "runs", runIds: ["run-1"], write: false });
  assert.deepEqual(parseScoreArgs(["--case", "META"]), { mode: "case", caseId: "META", write: true });
  assert.deepEqual(parseScoreArgs(["--all", "--case", "META"]), { mode: "all", write: true }, "--all wins over --case, as before");
  assert.deepEqual(parseScoreArgs(["--stability", "META", "--all"]), { mode: "stability", caseId: "META" }, "--stability wins");
  assert.deepEqual(parseScoreArgs([]), { mode: "usage" });
  assert.deepEqual(parseScoreArgs(["--no-write"]), { mode: "usage" });
});

test("--check and --latest", () => {
  assert.deepEqual(parseScoreArgs(["--check"]), { mode: "check" });
  assert.deepEqual(parseScoreArgs(["--check", "--latest", "--case", "META"]), { mode: "check" }, "--check never opens the database");
  assert.deepEqual(parseScoreArgs(["--latest"]), { mode: "latest", write: true });
  assert.deepEqual(parseScoreArgs(["--latest", "--no-write"]), { mode: "latest", write: false });
  assert.deepEqual(parseScoreArgs(["--latest", "--case", "SOFI"]), { mode: "latest", caseId: "SOFI", write: true });
  assert.deepEqual(parseScoreArgs(["--all", "--latest"]), { mode: "latest", write: true });
});

const HEADER = "scoring_commit,case,run_id,run_created_at,cutoff,checks_passed,checks_applicable,probes_flagged,probes_total,traits_present,traits_total,figure_trace_rate,reader_leaks,effective_verdict,human_rating_mean,scored_at";

test("parseScores: CRLF, empty fields as null, numbers as numbers, an empty file as no rows", () => {
  const [row] = parseScores(`${HEADER}\r\nabc,META,r1,2026-10-13T00:00:00.000Z,2026-10-13T00:00:00.000Z,2,13,8,8,3,12,0.805,,needs_more_work,,2026-10-21T00:00:00.000Z\r\n`);
  assert.equal(row.checks_passed, 2);
  assert.equal(row.figure_trace_rate, 0.805);
  assert.equal(row.reader_leaks, null);
  assert.equal(row.effective_verdict, "needs_more_work");
  assert.equal(row.scored_at, "2026-10-21T00:00:00.000Z", "no carriage return left on the last field");
  assert.deepEqual(parseScores(""), []);
  assert.deepEqual(scoreTrend(parseScores(`${HEADER}\n`)), []);
});

test("scoreTrend: a re-scored run counts once, with its latest score; leaks alone can regress; no applicable checks is not a rate", () => {
  const line = (run: string, created: string, passed: number, applicable: number, leaks: string, scored: string) =>
    `c,META,${run},${created},${created},${passed},${applicable},0,8,3,12,0.8,${leaks},pass,,${scored}`;
  const rows = parseScores([HEADER,
    line("r1", "2026-10-01T00:00:00.000Z", 5, 10, "3", "2026-10-02T00:00:00.000Z"),
    line("r2", "2026-11-01T00:00:00.000Z", 2, 10, "1", "2026-11-02T00:00:00.000Z"),
    line("r2", "2026-11-01T00:00:00.000Z", 6, 10, "5", "2026-11-03T00:00:00.000Z")].join("\n"));
  const [meta] = scoreTrend(rows);
  assert.equal(meta.runs, 2);
  assert.equal(meta.pass_rate, 0.6, "the later score of r2 is used");
  assert.equal(meta.regressed, true);
  assert.deepEqual(meta.reasons, ["reader leaks rose from 3 to 5"]);
  assert.match(formatTrend([meta])[0], /^META .*REGRESSED: reader leaks rose from 3 to 5$/);
  const [unrated] = scoreTrend(parseScores([HEADER, line("r1", "2026-10-01T00:00:00.000Z", 5, 10, "", "2026-10-02T00:00:00.000Z"),
    line("r2", "2026-11-01T00:00:00.000Z", 0, 0, "", "2026-11-02T00:00:00.000Z")].join("\n")));
  assert.equal(unrated.pass_rate, null);
  assert.equal(unrated.regressed, false);
});
