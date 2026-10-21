// The asset_valuation stage on an operating company with the mock provider: valuation v2 end to end, and a foreign
// listing withheld without an FX rate and depositary ratio.
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { assetValuationHandler } from "../src/lib/research/handlers/asset-valuation";
import { storeDiscoveredSources } from "../src/lib/research/sources/corpus";
import { saveReportArtifact } from "../src/lib/research/reporting/store";
import { cleanup, createRun, loadEnv, skipDb as skip, stageCtx, type Run } from "../Implementations/research-request-routing/acceptance/fixtures";

loadEnv();
process.env.RESEARCH_ACCEPTANCE_PROVIDER = "mock";

const m = 1e6;
const obs = (metric_key: string, period_end: string, value: number, currency: string, periodicity = "annual", quarter: number | null = null) => ({
  metric_key, period_end, value_numeric: value, currency, periodicity, fiscal_year: Number(period_end.slice(0, 4)), fiscal_quarter: quarter,
  unit: metric_key.includes("Shares") ? "shares" : currency, metadata_json: {} });

async function seed(sql: postgres.Sql, run: Run, currency: string) {
  const rows = [2023, 2024, 2025].flatMap((year, i) => {
    const end = `${year}-12-31`, revenue = (1000 + 100 * i) * m;
    return [obs("revenue", end, revenue, currency), obs("operating_income", end, revenue * 0.25, currency),
      obs("us_gaap_DepreciationDepletionAndAmortization", end, revenue * 0.05, currency), obs("us_gaap_PaymentsToAcquirePropertyPlantAndEquipment", end, revenue * 0.07, currency),
      obs("pretax_income", end, revenue * 0.26, currency), obs("income_tax_expense", end, revenue * 0.26 * 0.2, currency),
      obs("us_gaap_PropertyPlantAndEquipmentNet", end, (400 + 50 * i) * m, currency), obs("stockholders_equity", end, (900 + 100 * i) * m, currency),
      obs("us_gaap_CashAndCashEquivalentsAtCarryingValue", end, 200 * m, currency), obs("us_gaap_LongTermDebtNoncurrent", end, 100 * m, currency),
      obs("us_gaap_WeightedAverageNumberOfDilutedSharesOutstanding", end, 100 * m, currency)];
  });
  const quarters = ["2026-03-31", "2026-06-30"].flatMap((end, q) => [
    obs("revenue", end, 300 * m, currency, "quarterly", q + 1), obs("operating_income", end, 75 * m, currency, "quarterly", q + 1),
    obs("us_gaap_DepreciationDepletionAndAmortization", end, 15 * m, currency, "quarterly", q + 1),
    obs("us_gaap_PaymentsToAcquirePropertyPlantAndEquipment", end, 20 * m, currency, "quarterly", q + 1),
    obs("us_gaap_CashAndCashEquivalentsAtCarryingValue", end, 220 * m, currency, "quarterly", q + 1)]);
  await saveReportArtifact(sql, run, "financial_statement_set", "fss", { observations: [...rows, ...quarters], tables: [] });
  const drivers = (g: number, margin: number) => [2026, 2027, 2028, 2029, 2030].map((fiscal_year) => ({ fiscal_year, revenue_growth: g, operating_margin: margin }));
  await saveReportArtifact(sql, run, "operating_scenario_set", "oss", { probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25,
    forecast_horizon: { base_fiscal_year: 2025, years: [2026, 2027, 2028, 2029, 2030] },
    scenarios: [["bear", 0.03, 0.2], ["base", 0.08, 0.25], ["bull", 0.12, 0.28]].map(([scenario_type, g, margin]) => ({ scenario_type, yearly_drivers: drivers(g as number, margin as number) })) });
  await storeDiscoveredSources(sql, { runId: run.runId, runType: "deep_dive", assetId: run.assetId, assetName: run.assetName, assetSlug: run.assetSlug,
    symbol: run.symbol, profileId: "", profileKey: "", requiredModules: [], requiredLenses: [], marketDataCutoffAt: null, pipelineVersion: 3 } as any, [{
    sourceType: "market_data_snapshot", title: `${run.assetName} market snapshot`, publisher: "fixture", url: `https://fixture.example/${randomUUID()}`,
    content: JSON.stringify({ retrieved_at: "2026-10-01T00:00:00.000Z", meta: { currency: "USD", regularMarketPrice: 30 } }),
    mimeType: "application/json", qualityScore: "0.9", publishedAt: "2026-10-01", periodEnd: null, metadata: { system_generated: true }, chunkTitle: "snapshot" }] as any);
}

/** The run's context on the seeded operating_company profile, whose required lenses are dcf, multiple and cash_flow. */
async function context(sql: postgres.Sql, run: Run) {
  const [profile] = await sql`SELECT id FROM research_profiles WHERE profile_key = 'operating_company' LIMIT 1`;
  assert.ok(profile, "the operating_company profile must be seeded");
  await sql`UPDATE research_runs SET profile_id = ${profile.id} WHERE id = ${run.runId}`;
  return { ...stageCtx(run), profileId: String(profile.id), profileKey: "operating_company" };
}

const latest = async (sql: postgres.Sql, runId: string, type: string) => (await sql`SELECT content_json FROM research_artifacts
  WHERE research_run_id = ${runId} AND artifact_type = ${type} ORDER BY artifact_version DESC, created_at DESC LIMIT 1`)[0]?.content_json;

test("an operating company is valued with v2: three sets, the case x set matrix, cross-checks, stress and lens signals", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const run = await createRun(sql);
  try {
    await seed(sql, run, "USD");
    await assetValuationHandler.execute(await context(sql, run));
    const set = await latest(sql, run.runId, "valuation_scenario_set");
    assert.equal(set.valuation_status, "complete");
    assert.equal(set.engine_version, "valuation-v2");
    assert.deepEqual(set.valuation_sets.map((s: any) => s.set), ["conservative", "base", "aggressive"]);
    assert.equal(set.valuation_matrix.rows.length, 9);
    assert.ok(set.value_today_base > 0 && set.terminal_anchor_base > 0);
    assert.equal(set.terminal_year, 2030);
    assert.ok(set.method_inputs.every((m: any) => m.terminal.type === "value_driver" && m.years.some((y: any) => y.fade)));
    assert.equal(set.equity_bridge_detail.period_end, "2026-06-30");
    assert.equal(set.timing.reported_basis, "reported");
    assert.equal(set.stress_cases.length, 2);
    assert.ok(set.scenario_statements.base.every((y: any) => y.depreciation_basis === "ppe_roll_forward"));
    const reverse = await latest(sql, run.runId, "reverse_valuation");
    assert.ok("implied_terminal_multiple" in reverse && "implied_fcf_growth_10y" in reverse);
    const path = await latest(sql, run.runId, "annual_price_target_path");
    assert.equal(path.currency, path.market_price_currency);
    const signals = await sql`SELECT lens_family, signal, current_value_text FROM valuation_signals WHERE research_run_id = ${run.runId}`;
    assert.ok(signals.some((s) => s.lens_family === "scenario_valuation"));
    // DCF is computed; with no analytics pack the multiple and cash-flow lenses are not applicable, with the reason.
    const lens = Object.fromEntries(signals.map((s) => [s.lens_family, s]));
    assert.notEqual(lens.dcf.signal, "not_applicable");
    assert.equal(Number(lens.dcf.current_value_text), Number(set.lens_values[0].value_per_share));
    assert.equal(lens.multiple.signal, "not_applicable");
    assert.match(lens.cash_flow.current_value_text, /Not computed/);
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("statements in RMB against a USD price are withheld without an FX rate and the depositary ratio", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const run = await createRun(sql);
  try {
    await seed(sql, run, "CNY");
    await assetValuationHandler.execute(await context(sql, run));
    const set = await latest(sql, run.runId, "valuation_scenario_set");
    assert.equal(set.valuation_status, "withheld");
    assert.match(set.withheld_reason, /FX rate from CNY to USD.*DEXCHUS.*depositary ratio/);
    assert.equal(set.terminal_anchor_base, 0);
    const calls = await sql`SELECT count(*)::int AS n FROM model_call_logs WHERE research_run_id = ${run.runId}`;
    assert.equal(calls[0].n, 0, "withheld without a model call");
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("an ADS listing is withheld without its depositary ratio even when statements and price are both in USD", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const run = await createRun(sql);
  try {
    await seed(sql, run, "USD");
    await sql`INSERT INTO instruments (asset_id, instrument_type, name, currency) VALUES (${run.assetId}, 'listed_security', 'Fixture Holdings ADS', 'USD')`;
    await assetValuationHandler.execute(await context(sql, run));
    const set = await latest(sql, run.runId, "valuation_scenario_set");
    assert.equal(set.valuation_status, "withheld");
    assert.match(set.withheld_reason, /depositary ratio/);
    await sql`UPDATE instruments SET depositary_ratio = 2 WHERE asset_id = ${run.assetId}`;
    await assetValuationHandler.execute(await context(sql, run));
    const valued = await latest(sql, run.runId, "valuation_scenario_set");
    assert.equal(valued.valuation_status, "complete");
    assert.equal(valued.currency_conversion.depositary_ratio, 2);
    assert.equal(valued.method_inputs[0].diluted_shares, 50, "100m ordinary shares are 50m ADSs");
  } finally {
    await sql`DELETE FROM instruments WHERE asset_id = ${run.assetId}`;
    await cleanup(sql, [run.runId], [run.assetId]); await sql.end();
  }
});
