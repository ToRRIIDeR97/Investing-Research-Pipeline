// research_tasks.input_json keeps a model request's packet once, and budget reservations never rewrite it.
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createV3Task, exactJsonPrompt, runContextFirst, storedTaskRequest } from "../src/lib/research/run-context";
import { assertModelBudgetAvailable, recordModelCall } from "../src/lib/agents/model-calls";

const skip = process.env.RUN_DB_INTEGRATION !== "1";
if (!process.env.DATABASE_URL && existsSync(".env.local")) {
  const line = readFileSync(".env.local", "utf8").split(/\r?\n/).find(l => l.startsWith("DATABASE_URL="));
  if (line) process.env.DATABASE_URL = line.slice("DATABASE_URL=".length).trim().replace(/^['"]|['"]$/g, "");
}

const packet = { output_contract: "section", artifacts: [{ id: "a1", body: "z".repeat(200_000) }], asset: { name: "Fixture Co" } };

test("a prompt that ends with its packet is stored as instructions, hash and size, and the packet once", () => {
  const prompt = exactJsonPrompt({ agentName: "export-writer", requiredKeys: ["section"], packet, extraRules: ["Write one section."] });
  const request = { packet, prompt, output_format: { requiredKeys: ["section"] }, agent: "export-writer" };
  const stored = storedTaskRequest(request) as Record<string, any>;
  assert.equal("prompt" in stored, false);
  assert.equal(stored.agent, "export-writer");
  assert.equal(`${stored.prompt_instructions}Task packet:\n${JSON.stringify(runContextFirst(packet))}`, prompt);
  assert.equal(stored.prompt_sha256, createHash("sha256").update(prompt).digest("hex"));
  assert.equal(stored.prompt_bytes, Buffer.byteLength(prompt));
  assert.ok(JSON.stringify(stored).length < JSON.stringify(request).length * 0.6, "the packet is no longer stored twice");
});

test("any other prompt is stored whole", () => {
  const other = { packet, prompt: `Task packet:\n\n${JSON.stringify(packet)}` };
  assert.equal(storedTaskRequest(other), other, "a different layout keeps the full prompt");
  const changed = { packet, prompt: exactJsonPrompt({ agentName: "export-writer", requiredKeys: ["section"], packet: { ...packet, extra: 1 } }) };
  assert.equal(storedTaskRequest(changed), changed, "a prompt carrying a different packet keeps the full prompt");
  const plain = { packet, prompt: "No packet here." };
  assert.equal(storedTaskRequest(plain), plain);
});

test("budget reservations use their own column and leave input_json untouched", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const assetId = randomUUID(), runId = randomUUID();
  await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind, status, base_currency)
    VALUES (${assetId}, 'Budget Co', ${`budget-${assetId.slice(0, 8)}`}, 'equity', 'active', 'USD')`;
  await sql`INSERT INTO research_runs (id, asset_id, run_type, status, source_cutoff_at, pipeline_version, budget_limit_usd)
    VALUES (${runId}, ${assetId}, 'deep_dive', 'running', '2026-10-01', 3, 0.15)`;
  await sql`INSERT INTO research_stages (research_run_id, stage_key, stage_order, status) VALUES (${runId}, 'historical_record', 8, 'running')`;
  try {
    const [first, second] = [await createV3Task(sql, runId, "historical_record", "budget-a", "team_brief", "metric-normalizer", { packet }),
      await createV3Task(sql, runId, "historical_record", "budget-b", "team_brief", "metric-normalizer", { packet })];
    const [before] = await sql`SELECT input_json::text AS input FROM research_tasks WHERE id = ${first.id}`;
    const reserve = (task: { id: string; stage_id: string }) => assertModelBudgetAvailable({ researchRunId: runId, taskId: task.id,
      stageId: task.stage_id, modelTier: "cheap", reserveUsd: 0.1 });
    await reserve(first);
    const [held] = await sql`SELECT input_json::text AS input, budget_reservation_usd FROM research_tasks WHERE id = ${first.id}`;
    assert.equal(Number(held.budget_reservation_usd), 0.1);
    assert.equal(held.input, before.input, "reserving must not rewrite input_json");
    await assert.rejects(reserve(second), /budget exceeded/, "an outstanding reservation counts against the run budget");
    await recordModelCall({ researchRunId: runId, taskId: first.id, stageId: first.stage_id, modelProvider: "mock",
      modelName: "test", modelTier: "cheap", costUsd: 0.01, status: "success" });
    const [released] = await sql`SELECT input_json::text AS input, budget_reservation_usd FROM research_tasks WHERE id = ${first.id}`;
    assert.equal(released.budget_reservation_usd, null);
    assert.equal(released.input, before.input);
    await reserve(second);
  } finally {
    await sql`DELETE FROM model_budget_ledger WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM model_call_logs WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_tasks WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_stages WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql`DELETE FROM assets WHERE id = ${assetId}`;
    await sql.end();
  }
});
