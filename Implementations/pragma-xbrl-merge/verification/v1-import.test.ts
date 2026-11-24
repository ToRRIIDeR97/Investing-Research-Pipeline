// V1: AC-1..AC-3 boundary checks on the imported warehouse.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { root, read } from "./support";

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

test("AC-1: the warehouse keeps its own guide and data contract", () => {
  const tracked = new Set(git("ls-files", "services/xbrl").split("\n"));
  for (const p of ["services/xbrl/AGENTS.md", "services/xbrl/sec-xbrl-warehouse/AGENTS.md", "services/xbrl/sec-xbrl-warehouse/HANDOFF.md",
    "services/xbrl/sec-xbrl-warehouse/docker-compose.yml", "services/xbrl/sec-xbrl-warehouse/.env.example"]) {
    assert.ok(tracked.has(p), `${p} tracked`);
  }
});

test("AC-1: the subtree was added with history, not squashed", () => {
  const count = Number(git("rev-list", "--count", "HEAD", "--", "services/xbrl").trim());
  assert.ok(count > 40, `expected the warehouse's commits, got ${count}`);
});

test("AC-2: warehouse local data and secrets are ignored", () => {
  for (const p of ["services/xbrl/sec-xbrl-warehouse/.env", "services/xbrl/sec-xbrl-warehouse/data/backups/x.sql.gz"]) {
    assert.match(execFileSync("git", ["check-ignore", p], { cwd: root, encoding: "utf8" }), /./, `${p} ignored`);
  }
});

test("AC-3: the root guide points to the warehouse and its checks", () => {
  const agents = read("AGENTS.md");
  assert.match(agents, /services\/xbrl/);
  assert.match(agents, /XBRL_WAREHOUSE_URL/);
});
