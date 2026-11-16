/**
 * npm run eval:score: score stored research runs with code checks and depth probes. SELECT-only (the
 * connection is opened read-only) and no model calls, so it may run against the live dev database.
 *
 *   npm run eval:score -- <run-id>            score one run; its eval case is found by asset
 *   npm run eval:score -- --case META         score the case's first baseline run
 *   npm run eval:score -- --all               every case
 *   npm run eval:score -- --stability META    compare the case's baseline runs (per-case CV, model choices)
 *   npm run eval:score -- --latest            each case's newest completed or approved v3 run (--case META for one)
 *   npm run eval:score -- --check             the trend in evals/scores.csv; exits 1 when a case regressed
 *   --no-write                                print only; by default results go to evals/results/ and evals/scores.csv
 *
 * After a change: score the latest runs (--latest), then --check, and quote the rows in the PR.
 * DATABASE_URL comes from the environment, then .env.local. --check reads only evals/scores.csv and needs none.
 */
import postgres from "postgres";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Sql } from "../src/lib/research/run-context";
import { loadRunSnapshot, latest, type RunSnapshot } from "../src/lib/research/scoring/load";
import { runChecks, traitPresence } from "../src/lib/research/scoring/checks";
import { runProbes, type ProbeSpec } from "../src/lib/research/scoring/depth-probes";
import { stabilityReport } from "../src/lib/research/scoring/stability";
import { RUBRIC_DIMENSIONS } from "../src/lib/research/scoring/rubric";
import { parseScoreArgs, SCORE_USAGE } from "../src/lib/research/scoring/command";
import { formatTrend, parseScores, scoreTrend } from "../src/lib/research/scoring/trend";
import { defaultPriorRunId } from "../src/lib/research/lineage/runs";

interface EvalCase { id: string; role: "depth" | "coverage_stress"; asset_slug: string; symbol: string; cutoff: string;
  baseline_runs: string[]; probes: ProbeSpec[]; expected?: { statement_quarters_min?: number } }

function loadEnvFile(fileName: string) {
  const path = resolve(process.cwd(), fileName);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
  }
}

const command = parseScoreArgs(process.argv.slice(2));
// --check needs no environment; every other mode reads .env.local first, as before.
if (command.mode !== "check") loadEnvFile(".env.local");
const write = "write" in command && command.write;
const SET_PATH = resolve(process.cwd(), "evals", "eval-set.json");
const SCORES_PATH = resolve(process.cwd(), "evals", "scores.csv");
const cases: EvalCase[] = JSON.parse(readFileSync(SET_PATH, "utf8")).cases;
// Opened on first use, so --check never reads .env.local for it or opens a connection.
let client: Sql | undefined;
function db(): Sql {
  if (client) return client;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (environment or .env.local)");
  client = postgres(process.env.DATABASE_URL, { max: 2, connection: { default_transaction_read_only: true } }) as unknown as Sql;
  return client;
}
const commit = (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "unknown"; } })();

async function score(runId: string, evalCase?: EvalCase) {
  const sql = db();
  const snapshot = await loadRunSnapshot(sql, runId);
  const found = evalCase ?? cases.find((c) => c.asset_slug === snapshot.run.asset_slug);
  const checks = runChecks(snapshot);
  if (found?.role === "coverage_stress") checks.push(coverageStress(snapshot, found));
  const probes = found?.probes?.length ? await runProbes(sql, runId, snapshot.document, found.probes) : [];
  const traits = traitPresence(snapshot.document);
  const applicable = checks.filter((c) => c.status !== "n/a");
  const rubric = snapshot.run.metadata?.review_rubric ?? null;
  const ratings: Record<string, number> = rubric?.ratings ?? {};
  const rated = RUBRIC_DIMENSIONS.filter((d) => typeof ratings[d.id] === "number");
  return {
    case: found?.id ?? null, run_id: runId, asset: snapshot.run.asset_slug, run_created_at: snapshot.run.created_at, cutoff: snapshot.run.cutoff,
    status: snapshot.run.status, scored_at: new Date().toISOString(), scoring_commit: commit,
    summary: {
      checks_passed: applicable.filter((c) => c.status === "pass").length, checks_applicable: applicable.length,
      probes_flagged: probes.filter((p) => p.flagged).length, probes_total: probes.filter((p) => p.status !== "not_in_data").length,
      traits_present: traits.filter((t) => t.present).length, traits_total: traits.length,
      human_rating_mean: rated.length ? Number((rated.reduce((n, d) => n + ratings[d.id], 0) / rated.length).toFixed(2)) : null,
      human_rated_dimensions: rated.length,
    },
    checks, probes, traits, human_ratings: rubric,
  };
}

/** JD-type issuers: statement capture must cover enough quarters before a depth score means anything. */
function coverageStress(snapshot: RunSnapshot, evalCase: EvalCase) {
  const pack = latest(snapshot.artifacts, "financial_analytics");
  const quarters = Array.isArray(pack?.quarterly?.rows) ? pack.quarterly.rows.length : 0;
  const min = evalCase.expected?.statement_quarters_min ?? 12;
  return { id: "statement_coverage", label: `Statements cover at least ${min} quarters`, status: quarters >= min ? "pass" as const : "fail" as const,
    detail: `${quarters} quarters in financial_analytics`, value: quarters };
}

type Scored = Awaited<ReturnType<typeof score>>;
const CSV_HEADER = "scoring_commit,case,run_id,run_created_at,cutoff,checks_passed,checks_applicable,probes_flagged,probes_total,traits_present,traits_total,figure_trace_rate,reader_leaks,effective_verdict,human_rating_mean,scored_at";
function record(result: Scored) {
  const dir = resolve(process.cwd(), "evals", "results", result.case ?? result.asset);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${result.run_id}.json`), JSON.stringify(result, null, 2) + "\n");
  const value = (id: string) => result.checks.find((c) => c.id === id)?.value ?? "";
  const row = [result.scoring_commit, result.case ?? "", result.run_id, result.run_created_at, result.cutoff, result.summary.checks_passed,
    result.summary.checks_applicable, result.summary.probes_flagged, result.summary.probes_total, result.summary.traits_present,
    result.summary.traits_total, value("figure_trace"), value("reader_leaks"), value("effective_verdict"), result.summary.human_rating_mean ?? "", result.scored_at].join(",");
  // One row per run per scoring commit: a re-score on the same commit replaces its row.
  const lines = existsSync(SCORES_PATH) ? readFileSync(SCORES_PATH, "utf8").split(/\r?\n/).filter(Boolean).slice(1) : [];
  const kept = lines.filter((line) => !line.startsWith(`${result.scoring_commit},${result.case ?? ""},${result.run_id},`));
  writeFileSync(SCORES_PATH, [CSV_HEADER, ...kept, row].join("\n") + "\n");
}

function print(result: Scored) {
  const s = result.summary;
  console.log(`\n${result.case ?? result.asset} ${result.run_id} (${result.run_created_at.slice(0, 10)}, cutoff ${result.cutoff.slice(0, 10)})`);
  console.log(`checks ${s.checks_passed}/${s.checks_applicable} · probes flagged ${s.probes_flagged}/${s.probes_total} · JD traits ${s.traits_present}/${s.traits_total}` +
    (s.human_rating_mean !== null ? ` · human mean ${s.human_rating_mean} over ${s.human_rated_dimensions}` : ""));
  for (const c of result.checks) console.log(`  ${c.status.padEnd(4)} ${c.id}: ${c.detail}`);
  for (const p of result.probes) console.log(`  probe ${p.status.padEnd(20)} ${p.id} (data ${p.data_count})${p.sentence ? `: "${p.sentence.slice(0, 140)}"` : ""}`);
  console.log(`  traits present: ${result.traits.filter((t) => t.present).map((t) => t.id).join(", ") || "none"}`);
  console.log(`  traits absent: ${result.traits.filter((t) => !t.present).map((t) => t.id).join(", ") || "none"}`);
}

/** --check: the trend in evals/scores.csv. Reads that file only and writes nothing; exits 1 when a case regressed. */
function check() {
  const trend = scoreTrend(parseScores(existsSync(SCORES_PATH) ? readFileSync(SCORES_PATH, "utf8") : ""));
  if (!trend.length) console.log("No scored runs in evals/scores.csv");
  for (const line of formatTrend(trend)) console.log(line);
  if (trend.some((c) => c.regressed)) process.exitCode = 1;
}

/** --latest: each case's newest pipeline-v3 run that is completed or approved, the rule lineage uses for a prior run. */
async function latestTargets(only?: string) {
  const selected = only ? cases.filter((c) => c.id === only) : cases;
  if (only && !selected.length) throw new Error(`No eval case ${only}`);
  const targets: { runId: string; evalCase: EvalCase }[] = [];
  for (const c of selected) {
    const [asset] = await db()`SELECT id FROM assets WHERE slug = ${c.asset_slug}`;
    const runId = asset ? await defaultPriorRunId(db(), String(asset.id)) : null;
    if (runId) targets.push({ runId, evalCase: c });
    else console.log(`\n${c.id}: no run yet (${asset ? "no completed or approved v3 run" : `no asset ${c.asset_slug}`})`);
  }
  return targets;
}

async function main() {
  if (command.mode === "check") return check();
  if (command.mode === "usage") throw new Error(SCORE_USAGE);
  if (command.mode === "stability") {
    const evalCase = cases.find((c) => c.id === command.caseId);
    if (!evalCase) throw new Error(`No eval case ${command.caseId}`);
    const snapshots = [];
    for (const runId of evalCase.baseline_runs) snapshots.push(await loadRunSnapshot(db(), runId));
    console.log(JSON.stringify({ case: evalCase.id, ...stabilityReport(snapshots) }, null, 2));
    return;
  }
  const caseTarget = (caseId: string) => {
    const c = cases.find((x) => x.id === caseId);
    if (!c) throw new Error(`No eval case ${caseId}`);
    if (!c.baseline_runs.length) throw new Error(`Eval case ${caseId} has no run yet`);
    return [{ runId: c.baseline_runs[0], evalCase: c }];
  };
  const targets: { runId: string; evalCase?: EvalCase }[] = command.mode === "latest" ? await latestTargets(command.caseId)
    : command.mode === "all" ? cases.flatMap((c) => c.baseline_runs.length ? [{ runId: c.baseline_runs[0], evalCase: c }] : [])
    : command.mode === "case" ? caseTarget(command.caseId)
    : command.runIds.map((runId) => ({ runId }));
  // --latest with no scored run is not an error: each case already printed "no run yet".
  if (command.mode !== "latest" && !targets.length) throw new Error(SCORE_USAGE);
  if (command.mode === "all") for (const c of cases.filter((x) => !x.baseline_runs.length)) console.log(`\n${c.id}: no run yet (${c.role})`);
  for (const target of targets) {
    const result = await score(target.runId, target.evalCase);
    print(result);
    if (write) record(result);
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => (client as unknown as { end: () => Promise<void> } | undefined)?.end());
