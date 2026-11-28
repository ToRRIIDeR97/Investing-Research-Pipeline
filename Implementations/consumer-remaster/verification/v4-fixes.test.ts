// V4 (P7): other angles on the run choice, decisions, zones and test assets.
import "./v-support";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://test@127.0.0.1:1/none";

test("V4/AC-19: a newer waiting report wins over an older decided one; ties break by newest", async () => {
  const { primaryRun } = await import("../../../src/lib/research/primary-run");
  assert.equal(primaryRun([
    { id: "dec", created_at: "2026-10-01T00:00:00Z", status: "waiting_for_human", waiting_stage_key: "human_review", latest_decision: "reject" },
    { id: "wait", created_at: "2026-10-03T00:00:00Z", status: "waiting_for_human", waiting_stage_key: "human_review", latest_decision: null },
  ]), "wait");
  assert.equal(primaryRun([
    { id: "a", created_at: "2026-10-01T00:00:00Z", status: "completed" },
    { id: "b", created_at: "2026-10-02T00:00:00Z", status: "approved" },
  ]), "b");
});

test("V4/AC-19: a sent-back report still waiting is the one under review", async () => {
  const { primaryRun } = await import("../../../src/lib/research/primary-run");
  assert.equal(primaryRun([
    { id: "done", created_at: "2026-10-01T00:00:00Z", status: "completed" },
    { id: "back", created_at: "2026-10-02T00:00:00Z", status: "waiting_for_human", waiting_stage_key: "human_review", latest_decision: "needs_more_work" },
  ]), "back");
});

test("V4/AC-20: approvals on a waiting run read Decided; companyStatusWord agrees", async () => {
  const { runStatusWord, companyStatusWord } = await import("../../../src/lib/research/run-status");
  assert.equal(runStatusWord("waiting_for_human", "human_review", "approved_for_tracking"), "Decided");
  const runs = [{ id: "w", created_at: "2026-11-18T11:05:00Z", status: "waiting_for_human", waiting_stage_key: "human_review", latest_decision: "watchlist" }];
  assert.equal(companyStatusWord(runs as never), "Decided");
});

test("V4/AC-21: no zone given still labels runs", async () => {
  const { runBars } = await import("../../../src/lib/research/run-bars");
  const bars = runBars([{ id: "a", created_at: "2026-10-01T12:00:00Z", status: "completed", actual_cost_usd: "1", budget_limit_usd: null }]);
  assert.match(bars.runs[0].label, /^(30 Sep|1 Oct|2 Oct)$/);
});

test("V4/AC-22: a short hex tail or the word test alone isn't enough", async () => {
  const mod = await import("../../../src/lib/research/asset-overview");
  const isTestAsset = (mod as unknown as { isTestAsset: (a: { slug: string; canonical_name: string; status: string | null }) => boolean }).isTestAsset;
  assert.equal(isTestAsset({ slug: "acme-e2e-12345", canonical_name: "Acme", status: "active" }), false);
  assert.equal(isTestAsset({ slug: "testco", canonical_name: "Test Co", status: "active" }), false);
  assert.equal(isTestAsset({ slug: "meli-e2e-a1b2c3", canonical_name: "MercadoLibre", status: null }), true);
});
