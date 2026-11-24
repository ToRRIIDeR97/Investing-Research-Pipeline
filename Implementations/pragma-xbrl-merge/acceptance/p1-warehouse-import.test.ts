// P1: AC-1..AC-3 the XBRL warehouse lives in this repo under services/xbrl, with its history.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { root, read } from "./support";

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

test("AC-1: warehouse sources are present", () => {
  assert.ok(existsSync(join(root, "services/xbrl/sec-xbrl-warehouse/pyproject.toml")));
  assert.ok(existsSync(join(root, "services/xbrl/sec-xbrl-warehouse/src/sec_xbrl_warehouse/api/app.py")));
});

test("AC-1: warehouse history came with it", () => {
  const log = git("log", "--format=%s", "--", "services/xbrl");
  assert.match(log, /Pin the public IFRS 2019 and 2020 taxonomy packages for ESEF/);
});

test("AC-2: no .DS_Store or .env tracked under services/xbrl", () => {
  const tracked = git("ls-files", "services/xbrl").split("\n");
  assert.ok(tracked.length > 100, "warehouse files are tracked");
  assert.deepEqual(tracked.filter((p) => /(^|\/)(\.DS_Store|\.env)$/.test(p)), []);
});

test("AC-2: the warehouse .env is ignored", () => {
  const out = execFileSync("git", ["check-ignore", "services/xbrl/sec-xbrl-warehouse/.env"], { cwd: root, encoding: "utf8" });
  assert.match(out, /sec-xbrl-warehouse\/\.env/);
});

test("AC-3: xbrl:compose targets the warehouse compose project", () => {
  const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
  const cmd = scripts["xbrl:compose"];
  assert.ok(cmd, "xbrl:compose script exists");
  assert.match(cmd, /docker compose/);
  assert.match(cmd, /services\/xbrl\/sec-xbrl-warehouse\/docker-compose\.yml/);
  assert.match(cmd, /--project-directory services\/xbrl\/sec-xbrl-warehouse/);
  assert.doesNotMatch(cmd, /\s-v(\s|$)|--volumes/);
});

test("AC-3: ESLint ignores services/**", () => {
  assert.match(read("eslint.config.mjs"), /"services\/\*\*"/);
});
