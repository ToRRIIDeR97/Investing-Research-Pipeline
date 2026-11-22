// AC-5 (verification): npm audit lists no advisory for next. Needs the npm registry (free, read-only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ADVISORIES = ["GHSA-mfr8-8qww-v76h", "GHSA-vc7v-qv4w-wrv8", "GHSA-7qx7-33qx-rqx2", "GHSA-f3mh-rxg3-f5g2", "GHSA-pc58-hwjq-p385", "GHSA-rhh4-g77r-r9qj", "GHSA-vvgp-ww4w-46vf"];

test("AC-5: npm audit reports nothing for next", (t) => {
  const run = spawnSync("npm", ["audit", "--json"], { cwd: resolve(__dirname, "../../.."), encoding: "utf8", shell: true });
  let report: any;
  try { report = JSON.parse(run.stdout); } catch { report = null; }
  // Offline (no registry answer) is not a finding: npm run test:db runs this file too and must not need the network.
  if (!report || (report.error && !report.vulnerabilities)) { t.skip("npm registry unreachable"); return; }
  assert.ok(report.vulnerabilities, "npm audit returned no report");
  assert.equal(report.vulnerabilities.next, undefined, JSON.stringify(report.vulnerabilities.next));
  for (const id of ADVISORIES) assert.ok(!run.stdout.includes(id), `${id} still reported`);
});
