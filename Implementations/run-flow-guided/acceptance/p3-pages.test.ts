// P3 to P6: AC-8 to AC-10, source checks on the route and pages.
import { read } from "./support";
import { test } from "node:test";
import assert from "node:assert/strict";

const run = () => read("src/app/assets/[id]/run/page.tsx");

test("AC-8: the estimates route is read-only, v3 only, and uses runEstimates", () => {
  const src = read("src/app/api/research-runs/estimates/route.ts");
  assert.match(src, /export async function GET/);
  assert.doesNotMatch(src, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE)\b/);
  assert.match(src, /pipeline_version\s*=\s*\$?\{?\s*(3|CURRENT_PIPELINE_VERSION)/);
  assert.match(src, /runEstimates/);
});

test("AC-9: /research/new is step 1 with a company search", () => {
  const src = read("src/app/research/new/page.tsx");
  assert.match(src, /<FlowStepper current=\{0\}/);
  assert.match(src, /type="search"/);
});

test("AC-9: the run page is the guided flow with operator panels folded", () => {
  const src = run();
  assert.match(src, /<FlowStepper/);
  assert.match(src, /<DepthPicker/);
  assert.match(src, /<details[^>]*>[\s\S]{0,200}Advanced/);
  assert.match(src, /<PhaseTrack/);
  assert.match(src, /<RunFeed/);
  const details = src.indexOf("<details", src.indexOf("<RunFeed"));
  assert.ok(details > 0, "a Details disclosure follows the feed");
  assert.ok(src.indexOf("<RunDetails", details) > details, "operator panels sit inside it");
  assert.ok(src.indexOf("Backtests", details) > details);
});

test("AC-9: Home's Waiting on you comes from waitingOnYou", () => {
  const src = read("src/app/page.tsx");
  assert.match(src, /waitingOnYou\(/);
});

test("AC-10: gates and cancel stay behind clicks; step 5 links to /review", () => {
  const src = run();
  for (const path of ["approve-plan", "request-plan-changes", "request-reset", "cancel", "run-system-pipeline"]) assert.match(src, new RegExp(path));
  assert.match(src, /onClick=\{handleApprovePlan\}/);
  assert.match(src, /onClick=\{handleCancelRun\}/);
  assert.match(src, /\/review\?run=/);
  assert.doesNotMatch(src, /useEffect\([^)]*handleApprovePlan|useEffect\([^)]*createAndStartRun/);
});
