import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { DB, ROOT, code, sourceFiles } from "./fixtures";

const ALLOWED = (file: string) => file.startsWith("src/db/") || file === "src/lib/research/pipeline-runner.ts";

test("AC-2.1: only the connection modules and the runner's session lock construct a postgres client", () => {
  const offenders = sourceFiles().filter(file => !ALLOWED(file))
    .filter(file => code(file).split("\n").some(line => /\bpostgres\(/.test(line) && !/^\s*import\b/.test(line)));
  assert.deepEqual(offenders, []);
});

test("AC-2.2: the pipeline module exports a raw pool and a drizzle client", () => {
  const source = code("src/db/pipeline-sql.ts");
  assert.match(source, /export function pipelineSql\b/);
  assert.match(source, /export function pipelineDb\b/);
});

test("AC-2.3: a script using both pools exits by itself", { skip: !DB }, () => {
  const result = spawnSync("npx", ["tsx", join("Implementations", "architecture-9", "acceptance", "exit-probe.ts")],
    { cwd: ROOT, env: process.env, shell: true, timeout: 20_000, encoding: "utf8" });
  assert.equal(result.error, undefined, "the probe must exit within 20 s without calling end()");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /probe ok/);
});
