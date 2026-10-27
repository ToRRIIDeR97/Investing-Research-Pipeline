// The run page polls model calls and backtests with ?summary=1: only the listed fields, never metadata or results.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { NextRequest } from "next/server";

const skip = process.env.RUN_DB_INTEGRATION !== "1";
if (!process.env.DATABASE_URL && existsSync(".env.local")) {
  const line = readFileSync(".env.local", "utf8").split(/\r?\n/).find(l => l.startsWith("DATABASE_URL="));
  if (line) process.env.DATABASE_URL = line.slice("DATABASE_URL=".length).trim().replace(/^['"]|['"]$/g, "");
}

// Both routes read through the app's drizzle client; close it so the test process can exit.
after(async () => {
  if (!skip) await (await import("../src/db")).db.$client.end();
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const big = "x".repeat(20_000);

test("model calls and backtests ?summary=1 return only the list fields; the default response is unchanged", { skip }, async () => {
  const modelCalls = await import("../src/app/api/research-runs/[id]/model-calls/route");
  const backtests = await import("../src/app/api/research-runs/[id]/backtests/route");
  const sql = postgres(process.env.DATABASE_URL!);
  const assetId = randomUUID(), runId = randomUUID();
  await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind, status, base_currency)
    VALUES (${assetId}, 'Poll Summary Co', ${`poll-summary-${assetId.slice(0, 8)}`}, 'equity', 'active', 'USD')`;
  await sql`INSERT INTO research_runs (id, asset_id, run_type, status, source_cutoff_at, pipeline_version)
    VALUES (${runId}, ${assetId}, 'deep_dive', 'running', '2026-10-01', 3)`;
  try {
    await sql`INSERT INTO model_call_logs (research_run_id, agent_name, model_provider, model_name, model_tier, status,
        cost_usd, latency_ms, error_message, request_metadata_json, response_metadata_json)
      VALUES (${runId}, 'analyst', 'mock', 'mock-1', 'standard', 'failed', 0.25, 1200, 'timed out',
        ${sql.json({ prompt: big })}, ${sql.json({ raw: big })})`;
    await sql`INSERT INTO backtest_runs (research_run_id, asset_id, status, strategy_name, strategy_prompt, symbol, start_date,
        params_json, metrics_json)
      VALUES (${runId}, ${assetId}, 'completed', 'Momentum', 'Buy strength', 'POLL', '2020-01-01',
        ${sql.json({ window: 20 })}, ${sql.json({ curve: big })})`;
    const get = async (route: typeof modelCalls | typeof backtests, query: string) => {
      const response = await route.GET(new NextRequest(`http://localhost/api/test${query}`), params(runId));
      assert.equal(response.status, 200);
      return response.json();
    };

    const [call] = await get(modelCalls, "?summary=1");
    assert.deepEqual(Object.keys(call).sort(),
      ["agent_name", "cost_usd", "created_at", "error_message", "id", "latency_ms", "model_name", "model_provider", "model_tier", "status"]);
    assert.equal(call.error_message, "timed out");
    const [fullCall] = await get(modelCalls, "");
    assert.equal(fullCall.request_metadata_json.prompt, big);
    assert.equal(fullCall.id, call.id);

    const [backtest] = await get(backtests, "?summary=1");
    assert.deepEqual(Object.keys(backtest).sort(),
      ["benchmark_symbol", "created_at", "error_message", "id", "status", "strategy_name", "strategy_prompt", "symbol"]);
    assert.equal(backtest.strategy_name, "Momentum");
    const [fullBacktest] = await get(backtests, "");
    assert.equal(fullBacktest.metrics_json.curve, big);
    assert.equal(fullBacktest.id, backtest.id);
  } finally {
    await sql`DELETE FROM backtest_runs WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM model_call_logs WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql`DELETE FROM assets WHERE id = ${assetId}`;
    await sql.end();
  }
});
