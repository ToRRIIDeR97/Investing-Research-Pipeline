import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import postgres from "postgres";
import { historicalDiagnosisHandler } from "../src/lib/research/handlers/historical-diagnosis";
import { persistDecisionRows } from "../src/lib/research/handlers/decision-synthesis";
import { persistValuationSignals } from "../src/lib/research/handlers/asset-valuation";
import { persistReviewArtifacts } from "../src/lib/research/handlers/ai-reviewer";

describe("stage output persistence", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, () => {
  let sql: ReturnType<typeof postgres>;
  const assetId = crypto.randomUUID(), runId = crypto.randomUUID(), slug = `stage-output-${assetId.slice(0, 8)}`;
  let profileId: string;
  const ctx = () => ({ runId, assetId, assetSlug: slug, profileId, cutoffAt: new Date("2025-06-30T00:00:00Z"), marketDataCutoffAt: null }) as any;

  before(async () => {
    sql = postgres(process.env.DATABASE_URL!);
    [{ id: profileId }] = await sql`SELECT id FROM research_profiles ORDER BY created_at LIMIT 1`;
    await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind) VALUES (${assetId}, 'Stage Output Fixture', ${slug}, 'equity')`;
    await sql`INSERT INTO research_runs (id, asset_id, run_type, status, pipeline_version, profile_id) VALUES (${runId}, ${assetId}, 'deep_dive', 'running', 3, ${profileId})`;
    await sql`INSERT INTO research_stages (research_run_id, stage_key, stage_order, status) VALUES (${runId}, 'historical_diagnosis', 7, 'running')`;
  });

  after(async () => {
    await sql`DELETE FROM research_artifact_claim_links WHERE artifact_id IN (SELECT id FROM research_artifacts WHERE research_run_id = ${runId})`;
    for (const table of ["research_artifacts", "research_tasks", "metric_observations", "theses", "risks", "catalysts", "valuation_signals", "research_stages"]) {
      await sql`DELETE FROM ${sql(table)} WHERE research_run_id = ${runId}`;
    }
    await sql`DELETE FROM metric_definitions WHERE metric_key = ${`fixture_revenue_${assetId.slice(0, 8)}`}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql`DELETE FROM assets WHERE id = ${assetId}`;
    await sql.end();
  });

  it("historical diagnosis keeps 13-week fiscal quarters and drops year-to-date rows", async () => {
    const metricKey = `fixture_revenue_${assetId.slice(0, 8)}`;
    const [definition] = await sql`
      INSERT INTO metric_definitions (metric_key, display_name, metric_category) VALUES (${metricKey}, 'Fixture revenue', 'income_statement') RETURNING id`;
    const rows: [string, string, number][] = [
      ["2023-12-31", "2024-03-30", 90], ["2024-03-31", "2024-06-29", 86], ["2024-06-30", "2024-09-28", 95],
      ["2024-09-29", "2024-12-28", 124], ["2023-12-31", "2024-09-28", 271],
    ];
    for (const [start, end, value] of rows) {
      await sql`
        INSERT INTO metric_observations (asset_id, research_run_id, metric_definition_id, period_start, period_end, value_numeric, unit, review_status)
        VALUES (${assetId}, ${runId}, ${definition.id}, ${start}, ${end}, ${value}, 'USD', 'accepted')`;
    }
    const output = await historicalDiagnosisHandler.execute(ctx()) as any;
    const diagnosis = output.historical_diagnosis.diagnoses.find((item: any) => item.metric_key === metricKey);
    assert.equal(diagnosis?.observation_count, 4);
  });

  it("decision rows replace the previous attempt and keep the thesis row", async () => {
    const answer = (thesis: string, risks: string[], catalysts: string[]) => ({
      investment_thesis: { thesis_statement: thesis, why_now: "now" },
      risk_register: { risks: risks.map((risk_name) => ({ risk_name, severity: "high" })) },
      catalyst_register: { catalysts: catalysts.map((catalyst_name) => ({ catalyst_name })) },
    });
    await persistDecisionRows(sql, ctx(), answer("First thesis", ["Credit", "Funding", "Credit"], ["Q3 results", "Charter"]));
    const [first] = await sql`SELECT id FROM theses WHERE research_run_id = ${runId}`;
    await persistDecisionRows(sql, ctx(), answer("Second thesis", ["Funding", "Regulation"], ["Q4 results"]));
    const theses = await sql`SELECT id, one_sentence_thesis FROM theses WHERE research_run_id = ${runId}`;
    assert.deepEqual(theses.map((row) => [row.id, row.one_sentence_thesis]), [[first.id, "Second thesis"]]);
    const risks = await sql`SELECT risk_name FROM risks WHERE research_run_id = ${runId} ORDER BY risk_name`;
    assert.deepEqual(risks.map((row) => row.risk_name), ["Funding", "Regulation"]);
    const catalysts = await sql`SELECT catalyst_name FROM catalysts WHERE research_run_id = ${runId}`;
    assert.deepEqual(catalysts.map((row) => row.catalyst_name), ["Q4 results"]);
  });

  it("valuation signals from an earlier attempt are removed when their keys are gone", async () => {
    const signal = (signal_key: string, value: string) => ({ signal_key, signal_name: signal_key, lens_family: "scenario_valuation",
      current_value_text: value, comparison_range_json: {}, signal: "scenario_range", cheapness_score: 0.5, confidence: 0.7 });
    await persistValuationSignals(sql, ctx(), [signal("scenario_price_target_range", "100"), signal("ev_ebitda_scenario_price_target", "100")]);
    await persistValuationSignals(sql, ctx(), [signal("scenario_price_target_range", "120")]);
    const rows = await sql`SELECT signal_key, current_value_text FROM valuation_signals WHERE research_run_id = ${runId}`;
    assert.deepEqual(rows.map((row) => [row.signal_key, row.current_value_text]), [["scenario_price_target_range", "120"]]);
  });

  it("a review quality_score of 0 is saved", async () => {
    await persistReviewArtifacts(sql, ctx(), {
      review_summary: "Failing report", findings: [], quality_score: 0, recommendations: [], review_verdict: "fail",
    });
    const rows = await sql`SELECT artifact_type, content_json FROM research_artifacts
      WHERE research_run_id = ${runId} AND artifact_type <> 'historical_diagnosis' ORDER BY artifact_type`;
    assert.deepEqual(rows.map((row) => row.artifact_type), ["findings", "quality_score", "recommendations", "review_summary", "review_verdict"]);
    assert.equal(rows.find((row) => row.artifact_type === "quality_score")?.content_json, 0);
  });
});
