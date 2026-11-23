// P7: AC-19 run choice, AC-20 watchlist/reject are decisions, AC-21 local times, AC-22 test assets, AC-23 operational screens.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { read } from "./support";

process.env.DATABASE_URL ??= "postgres://test@127.0.0.1:1/none";

// SoFi as stored on 23 Nov 2026 (runs API shape).
const SOFI = [
  { id: "c2200dca", created_at: "2026-09-23T08:34:00Z", status: "waiting_for_human", waiting_stage_key: "human_review", latest_decision: null },
  { id: "ce9f6573", created_at: "2026-09-24T09:37:00Z", status: "completed", waiting_stage_key: null, latest_decision: "approved_for_tracking" },
  { id: "d2ea550f", created_at: "2026-09-25T03:47:00Z", status: "waiting_for_human", waiting_stage_key: "human_review", latest_decision: null },
  { id: "89c71c21", created_at: "2026-09-27T04:10:00Z", status: "needs_more_work", waiting_stage_key: null, latest_decision: "approved_for_tracking" },
  { id: "b6c5720f", created_at: "2026-11-18T05:27:00Z", status: "needs_more_work", waiting_stage_key: null, latest_decision: null },
  { id: "3c3fc4ce", created_at: "2026-11-18T05:49:00Z", status: "needs_more_work", waiting_stage_key: null, latest_decision: null },
  { id: "9cd97f72", created_at: "2026-11-18T11:05:00Z", status: "waiting_for_human", waiting_stage_key: "human_review", latest_decision: null },
  { id: "0c9a2731", created_at: "2026-11-18T13:12:00Z", status: "needs_more_work", waiting_stage_key: null, latest_decision: null },
];

test("AC-19: SoFi shows the report under review, not the stopped draft", async () => {
  const { primaryRun } = await import("../../../src/lib/research/primary-run");
  assert.equal(primaryRun([...SOFI].reverse()), "9cd97f72");
});

test("AC-19: without a waiting decision, the newest decided run; then the newest that didn't stop; then the newest", async () => {
  const { primaryRun } = await import("../../../src/lib/research/primary-run");
  const decided = SOFI.filter((r) => !["c2200dca", "d2ea550f", "9cd97f72"].includes(r.id));
  assert.equal(primaryRun(decided), "89c71c21", "a final decision counts as decided even on a stopped run");
  assert.equal(primaryRun([{ id: "a", created_at: "2026-10-01T00:00:00Z", status: "running" }, { id: "b", created_at: "2026-10-02T00:00:00Z", status: "failed" }]), "a");
  assert.equal(primaryRun([{ id: "a", created_at: "2026-10-01T00:00:00Z", status: "failed" }, { id: "b", created_at: "2026-10-02T00:00:00Z", status: "needs_more_work" }]), "b");
  assert.equal(primaryRun([]), null);
});

test("AC-19: a run waiting for plan approval is not the report under review", async () => {
  const { primaryRun } = await import("../../../src/lib/research/primary-run");
  assert.equal(primaryRun([
    { id: "done", created_at: "2026-10-01T00:00:00Z", status: "completed" },
    { id: "plan", created_at: "2026-10-05T00:00:00Z", status: "waiting_for_human", waiting_stage_key: "research_plan" },
  ]), "done");
});

test("AC-20: watchlist and reject read Decided; a send-back doesn't", async () => {
  const { runStatusWord } = await import("../../../src/lib/research/run-status");
  assert.equal(runStatusWord("waiting_for_human", "human_review", "watchlist"), "Decided");
  assert.equal(runStatusWord("waiting_for_human", "human_review", "reject"), "Decided");
  assert.equal(runStatusWord("waiting_for_human", "human_review", "needs_more_work"), "Needs your decision");
  assert.equal(runStatusWord("waiting_for_human", "human_review", null), "Needs your decision");
});

test("AC-20: a decided newest run takes the company out of the queue, older versions too", async () => {
  const { groupReviewQueue, reviewCount } = await import("../../../src/lib/review/review-queue");
  const row = (run_id: string, asset_id: string, created_at: string, latest_decision: string | null) => ({ run_id, asset_id, run_type: "full_initiation",
    research_question: null, asset_name: asset_id, asset_slug: asset_id, asset_kind: "equity", priority: null, created_at, completed_at: null, latest_decision });
  const q = groupReviewQueue([row("old", "sofi", "2026-09-23T00:00:00Z", null), row("new", "sofi", "2026-11-18T00:00:00Z", "watchlist"), row("m", "meli", "2026-11-01T00:00:00Z", "needs_more_work")] as never);
  assert.equal(reviewCount(q), 1);
  assert.ok(!q.some((r: { run_id: string; asset_id: string; replaced_by: string | null }) => r.asset_id === "sofi" && !r.replaced_by), "SoFi has nothing to decide");
});

test("AC-20: runBars reads a watchlisted run as Decided and not current", async () => {
  const { runBars } = await import("../../../src/lib/research/run-bars");
  const bars = runBars([{ id: "w", created_at: "2026-11-18T11:05:00Z", status: "waiting_for_human", actual_cost_usd: "4.86", budget_limit_usd: "10", waiting_stage_key: "human_review", latest_decision: "watchlist" }], { timeZone: "UTC" });
  assert.equal(bars.runs[0].outcome, "Decided");
  assert.ok(!bars.runs[0].current);
});

test("AC-21: run labels use the viewer's zone", async () => {
  const { runBars } = await import("../../../src/lib/research/run-bars");
  const runs = [
    { id: "x", created_at: "2026-11-18T11:05:00Z", status: "waiting_for_human", actual_cost_usd: "4.86", budget_limit_usd: "10", waiting_stage_key: "human_review", latest_decision: null },
    { id: "y", created_at: "2026-11-18T13:12:00Z", status: "needs_more_work", actual_cost_usd: "9.74", budget_limit_usd: "10", waiting_stage_key: null, latest_decision: null },
  ];
  assert.deepEqual(runBars(runs, { timeZone: "Asia/Singapore" }).runs.map((r) => r.label), ["18 Nov 19:05", "18 Nov 21:12"]);
  assert.deepEqual(runBars(runs, { timeZone: "UTC" }).runs.map((r) => r.label), ["18 Nov 11:05", "18 Nov 13:12"]);
});

test("AC-22: test assets are recognised", async () => {
  const mod = await import("../../../src/lib/research/asset-overview");
  const isTestAsset = (mod as unknown as { isTestAsset: (a: { slug: string; canonical_name: string; status: string | null }) => boolean }).isTestAsset;
  assert.equal(isTestAsset({ slug: "sofi-e2e-10e0e85c", canonical_name: "SoFi Technologies, Inc. (Test)", status: "active" }), true);
  assert.equal(isTestAsset({ slug: "anything", canonical_name: "X", status: "test" }), true);
  assert.equal(isTestAsset({ slug: "sofi", canonical_name: "SoFi Technologies, Inc.", status: "active" }), false);
  assert.equal(isTestAsset({ slug: "e2e-labs", canonical_name: "E2E Labs", status: "active" }), false);
});

test("AC-23: run page, workbench and notebook use the primitives", () => {
  assert.match(read("src/app/assets/[id]/run/page.tsx"), /from "@\/components\/ui\/primitives"/);
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const { root } = require("./support") as typeof import("./support");
  for (const dir of ["src/components/workbench", "src/components/notebook"]) {
    const uses = readdirSync(join(root, dir)).filter((f) => f.endsWith(".tsx")).some((f) => /from "@\/components\/ui\/primitives"/.test(read(`${dir}/${f}`)));
    assert.ok(uses, dir);
  }
});
