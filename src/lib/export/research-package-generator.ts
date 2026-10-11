import postgres from "postgres";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { evaluateResearchQuality } from "@/lib/workflow/quality-gates";
import type { ResearchQualityGateResult } from "@/lib/workflow/quality-gates";

type Row = Record<string, any>;

interface ResearchPackageResult {
  exportId: string;
  storagePath: string;
  contentHash: string;
  files: string[];
}

interface ResearchPackageData {
  asset: Row;
  run: Row;
  listing?: Row;
  profile?: Row;
  theses: Row[];
  drivers: Row[];
  risks: Row[];
  catalysts: Row[];
  evidence: Row[];
  metrics: Row[];
  signals: Row[];
  scenarios: Row[];
  sourceGaps: Row[];
  sources: Row[];
  backtests: Row[];
  backtestArtifacts: Row[];
  modelCalls: Row[];
  tasks: Row[];
  quality?: ResearchQualityGateResult;
}

interface IndicatorCandidate {
  id: string;
  name: string;
  family: string;
  hypothesis: string;
  source: string;
  quality: string;
  updateFrequency: string;
  backtestability: string;
  lookaheadRisk: string;
  calculation: string;
  useCase: string;
  failureCase: string;
  backtestPlan: string;
}

interface StrategyCombination {
  id: string;
  name: string;
  indicators: string[];
  families: string[];
  hypothesis: string;
  entryRule: string;
  exitRule: string;
  riskControl: string;
  positionSizing: string;
  regime: string;
  rationale: string;
}

const CANONICAL_FILES = [
  "AGENT.md",
  "00_intake.md",
  "01_company_or_asset_profile.md",
  "02_source_intelligence.md",
  "02_industry_research.md",
  "03_investment_thesis.md",
  "04_risk_reward.md",
  "05_valuation.md",
  "06_custom_indicators.md",
  "07_strategy_design.md",
  "08_backtest_results.md",
  "09_review_packet.md",
  "10_strategy_combinations.md",
  "sources.md",
  "quality_gates.json",
];

export async function generateResearchPackage(params: {
  runId: string;
  assetId: string;
  generatedBy: string;
}): Promise<ResearchPackageResult> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const data = await loadPackageData(sql, params.runId, params.assetId);
    data.quality = await evaluateResearchQuality(params.runId);
    const indicators = buildIndicators(data);
    const combinations = buildStrategyCombinations(indicators);
    const generatedAt = new Date().toISOString();
    const folderName = `${safeSlug(data.asset.slug || data.asset.canonical_name)}_${data.run.run_type}_${Date.now()}_research_package`;
    const storagePath = `storage/exports/${folderName}`;
    const absoluteDir = join(process.cwd(), storagePath);

    await mkdir(absoluteDir, { recursive: true });
    await mkdir(join(absoluteDir, "source_intelligence"), { recursive: true });
    await mkdir(join(absoluteDir, "data", "processed"), { recursive: true });
    await mkdir(join(absoluteDir, "data", "backtest_outputs"), { recursive: true });
    await mkdir(join(absoluteDir, "charts", "backtests"), { recursive: true });
    await mkdir(join(absoluteDir, "charts", "indicators"), { recursive: true });
    await mkdir(join(absoluteDir, "charts", "price"), { recursive: true });
    await mkdir(join(absoluteDir, "code"), { recursive: true });
    await mkdir(join(absoluteDir, "filings", "raw"), { recursive: true });
    await mkdir(join(absoluteDir, "filings", "parsed"), { recursive: true });
    await mkdir(join(absoluteDir, "filings", "extracted_tables"), { recursive: true });

    const files: Record<string, string> = {
      "AGENT.md": renderAgentInstructions(),
      "00_intake.md": renderIntake(data, generatedAt),
      "01_company_or_asset_profile.md": renderAssetProfile(data),
      "02_source_intelligence.md": renderSourceIntelligence(data),
      "02_industry_research.md": renderIndustryResearch(data),
      "03_investment_thesis.md": renderInvestmentThesis(data),
      "04_risk_reward.md": renderRiskReward(data),
      "05_valuation.md": renderValuation(data),
      "06_custom_indicators.md": renderIndicators(indicators),
      "07_strategy_design.md": renderStrategyDesign(data, indicators),
      "08_backtest_results.md": renderBacktests(data, combinations),
      "09_review_packet.md": renderReviewPacket(data, indicators, combinations),
      "10_strategy_combinations.md": renderCombinations(combinations),
      "sources.md": renderSources(data),
      "quality_gates.json": `${JSON.stringify(data.quality, null, 2)}\n`,
      "source_intelligence/AGENT.md": renderSourceAgentInstructions(),
      "source_intelligence/source_inventory.md": renderSourceInventory(data),
      "source_intelligence/source_quality_scores.md": renderSourceQuality(data),
      "source_intelligence/data_availability_map.md": renderDataAvailability(data),
      "source_intelligence/asset_specific_source_plan.md": renderAssetSpecificSourcePlan(data),
      "source_intelligence/filing_download_log.md": renderFilingDownloadLog(data),
      "source_intelligence/source_to_indicator_map.md": renderSourceToIndicatorMap(data, indicators),
      "source_intelligence/failed_source_attempts.md": renderFailedSourceAttempts(data),
      "source_intelligence/regulatory_source_map.md": renderRegulatorySourceMap(data),
      "source_intelligence/refresh_schedule.md": renderRefreshSchedule(data),
      "data/processed/indicator_metadata.csv": indicatorMetadataCsv(indicators),
      "data/processed/indicator_combinations.csv": combinationsCsv(combinations),
      "data/processed/aligned_research_dataset.csv": alignedResearchDatasetCsv(data, indicators),
      "data/processed/valuation_dashboard.csv": valuationDashboardCsv(data.signals),
      "data/backtest_outputs/combo_rankings.csv": comboRankingsCsv(combinations, data.backtests),
      "data/backtest_outputs/backtest_summary.csv": backtestSummaryCsv(data.backtests),
      "data/backtest_outputs/backtest_artifacts.csv": backtestArtifactsCsv(data.backtestArtifacts),
      "code/README.md": renderCodeReadme(data),
    };

    await Promise.all(
      Object.entries(files).map(([relativePath, content]) =>
        writeFile(join(absoluteDir, relativePath), content, "utf8")
      )
    );
    const copiedArtifacts = await copyBacktestArtifacts(data, absoluteDir);

    const manifest = {
      generated_at: generatedAt,
      asset_id: params.assetId,
      run_id: params.runId,
      canonical_files: CANONICAL_FILES,
      section_counts: {
        evidence: data.evidence.length,
        metrics: data.metrics.length,
        valuation_signals: data.signals.length,
        scenarios: data.scenarios.length,
        risks: data.risks.length,
        catalysts: data.catalysts.length,
        indicators: indicators.length,
        strategy_combinations: combinations.length,
        backtests: data.backtests.length,
        backtest_artifacts: data.backtestArtifacts.length,
        sources: data.sources.length,
        inferred_source_gaps: inferredSourceGaps(data).length,
        quality_status: data.quality.status,
        action_readiness: data.quality.actionReadiness,
      },
      quality_gates: data.quality,
      copied_artifacts: copiedArtifacts,
    };
    const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(join(absoluteDir, "manifest.json"), manifestContent, "utf8");

    const contentHash = createHash("sha256")
      .update(Object.values(files).join("\n\n---FILE---\n\n"))
      .update(manifestContent)
      .digest("hex");

    const rows = await sql`
      INSERT INTO exports (
        asset_id, research_run_id, export_type,
        template_version, storage_path, content_hash,
        generated_by, generated_at, metadata_json
      ) VALUES (
        ${params.assetId}, ${params.runId}, 'research_package',
        'sofi-folder-standard-v1', ${storagePath}, ${contentHash},
        ${params.generatedBy}, NOW(), ${sql.json(manifest as any)}
      )
      RETURNING id
    `;

    return {
      exportId: rows[0].id,
      storagePath,
      contentHash,
      files: [...Object.keys(files), ...copiedArtifacts.map((artifact) => artifact.package_path), "manifest.json"],
    };
  } finally {
    await sql.end();
  }
}

async function loadPackageData(sql: ReturnType<typeof postgres>, runId: string, assetId: string): Promise<ResearchPackageData> {
  const [asset] = await sql`SELECT * FROM assets WHERE id = ${assetId}`;
  const [run] = await sql`SELECT * FROM research_runs WHERE id = ${runId}`;
  if (!asset || !run) throw new Error("Asset or research run not found");

  const [listing] = await sql`
    SELECT l.* FROM listings l
    JOIN instruments i ON i.id = l.instrument_id
    WHERE i.asset_id = ${assetId}
    ORDER BY l.is_primary DESC NULLS LAST, l.created_at ASC NULLS LAST
    LIMIT 1
  `;
  const [profile] = run.profile_id
    ? await sql`SELECT * FROM research_profiles WHERE id = ${run.profile_id}`
    : [];
  const theses = await sql`
    SELECT * FROM theses
    WHERE research_run_id = ${runId} AND status != 'rejected'
    ORDER BY created_at DESC
  `;
  const thesisIds = theses.map((thesis) => thesis.id);
  const drivers = thesisIds.length
    ? await sql`SELECT * FROM thesis_drivers WHERE thesis_id IN ${sql(thesisIds)} ORDER BY created_at DESC`
    : [];

  const [
    risks,
    catalysts,
    evidence,
    metrics,
    signals,
    scenarios,
    sourceGaps,
    sources,
    backtests,
    backtestArtifacts,
    modelCalls,
    tasks,
  ] = await Promise.all([
    sql`SELECT * FROM risks WHERE research_run_id = ${runId} ORDER BY severity DESC, created_at DESC`,
    sql`SELECT * FROM catalysts WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
    sql`SELECT * FROM evidence_claims WHERE research_run_id = ${runId} AND review_status != 'rejected' ORDER BY confidence DESC NULLS LAST, created_at DESC`,
    sql`
      SELECT mo.*, md.metric_key, md.display_name as metric_display_name, md.metric_category
      FROM metric_observations mo
      LEFT JOIN metric_definitions md ON md.id = mo.metric_definition_id
      WHERE mo.research_run_id = ${runId}
      ORDER BY mo.period_end DESC NULLS LAST, mo.created_at DESC
    `,
    sql`SELECT * FROM valuation_signals WHERE research_run_id = ${runId} ORDER BY lens_family, signal_name`,
    sql`SELECT * FROM scenarios WHERE research_run_id = ${runId} ORDER BY probability DESC NULLS LAST, scenario_type`,
    sql`SELECT * FROM source_gaps WHERE research_run_id = ${runId} ORDER BY severity DESC, created_at DESC`,
    sql`
      SELECT DISTINCT sd.*
      FROM source_documents sd
      LEFT JOIN research_run_sources rrs ON rrs.source_document_id = sd.id
      WHERE sd.research_run_id = ${runId} OR rrs.research_run_id = ${runId}
      ORDER BY sd.created_at DESC
    `,
    sql`SELECT * FROM backtest_runs WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
    sql`SELECT * FROM backtest_artifacts WHERE research_run_id = ${runId} ORDER BY artifact_type, created_at DESC`,
    sql`SELECT * FROM model_call_logs WHERE research_run_id = ${runId} ORDER BY created_at ASC`,
    sql`SELECT * FROM research_tasks WHERE research_run_id = ${runId} ORDER BY created_at ASC`,
  ]);

  return {
    asset,
    run,
    listing,
    profile,
    theses: dedupeBy(theses, (row) => row.one_sentence_thesis),
    drivers: dedupeBy(
      drivers.filter((row) => !isPlaceholder(row.driver_name) || row.description || row.value_impact),
      (row) => `${row.driver_name}|${row.description}|${row.value_impact}`
    ),
    risks: dedupeBy(risks, (row) => `${row.risk_name}|${row.description}`),
    catalysts: dedupeBy(catalysts, (row) => `${row.catalyst_name}|${row.description}`),
    evidence: dedupeBy(evidence, (row) => row.claim_text),
    metrics: dedupeBy(metrics, (row) => `${row.metric_key}|${row.period_end}|${row.as_of_date}|${row.value_numeric}|${row.value_text}`),
    signals: dedupeBy(signals, (row) => `${row.lens_family}|${row.signal_name}|${row.signal}|${row.current_value_text}`),
    scenarios: dedupeBy(scenarios, (row) => `${row.scenario_name}|${row.scenario_type}|${stringifyBrief(row.assumptions_json)}`),
    sourceGaps: dedupeBy(sourceGaps, (row) => `${row.gap_key}|${row.description}`),
    sources: dedupeBy(sources, (row) => `${row.title}|${row.url}|${row.storage_path}`),
    backtests: dedupeBy(backtests, (row) => `${row.name}|${row.strategy_name}|${stringifyBrief(row.metrics_json)}`),
    backtestArtifacts: dedupeBy(backtestArtifacts, (row) => `${row.backtest_run_id}|${row.artifact_type}|${row.storage_path}`),
    modelCalls,
    tasks,
  };
}

function renderAgentInstructions() {
  return [
    "# Research Folder Agent Instructions",
    "",
    "This folder contains one investment research run. Keep the work evidence-first, source-aware, and tied to an investment hypothesis.",
    "",
    "## Research Order",
    "",
    "1. Complete `00_intake.md`.",
    "2. Complete `02_source_intelligence.md` and the `source_intelligence/` source map.",
    "3. Complete `01_company_or_asset_profile.md`.",
    "4. Complete `02_industry_research.md` when the asset profile requires it.",
    "5. Write `03_investment_thesis.md`.",
    "6. Write `04_risk_reward.md`.",
    "7. Select the valuation playbook and build `05_valuation.md`.",
    "8. Write `06_custom_indicators.md` with at least 10 candidate indicators.",
    "9. Write `07_strategy_design.md`.",
    "10. Generate `10_strategy_combinations.md` with at least 50 thesis-driven combinations.",
    "11. Run `08_backtest_results.md` when data allows.",
    "12. Write `09_review_packet.md`.",
    "13. Update `sources.md` throughout the work.",
    "",
    "## Completion Checklist",
    "",
    "- Canonical main files exist.",
    "- `source_intelligence/` is populated.",
    "- `data/processed/indicator_combinations.csv` exists.",
    "- `data/backtest_outputs/combo_rankings.csv` exists when backtesting is applicable.",
    "- Facts, assumptions, estimates, opinions, and backtest results are separated.",
    "- Any blocker is documented with the incomplete stage and next required action.",
    "",
  ].join("\n");
}

function renderIntake(data: ResearchPackageData, generatedAt: string) {
  const symbol = data.listing?.symbol || data.asset.slug;
  const firstThesis = data.theses[0];
  return [
    "# 00 Intake",
    "",
    "## Basic Information",
    "",
    `Ticker: ${symbol}`,
    `Asset name: ${data.asset.canonical_name}`,
    `Asset type: ${data.asset.asset_kind}`,
    `Sector/category: ${data.asset.sector || "Not recorded"}${data.asset.industry ? `; ${data.asset.industry}` : ""}`,
    `Country: ${data.asset.home_country || "Not recorded"}`,
    `Currency: ${data.asset.base_currency || "Not recorded"}`,
    `Current price: Not stored in this run unless present in market-data artifacts.`,
    `Date opened: ${formatDate(data.run.created_at)}`,
    `Generated package: ${generatedAt}`,
    `Initial reason for research: ${data.run.research_question || firstThesis?.one_sentence_thesis || "System research run"}`,
    `Primary question: ${data.run.research_question || "Is the asset attractive given the current evidence, valuation, risks, and backtest context?"}`,
    "Expected time horizon: 2 to 3 years for investment review; shorter-term trading signals are secondary unless the strategy section says otherwise.",
    `Research status: ${data.run.status}`,
    "",
    "## Classification",
    "",
    `Selected classification: ${data.profile?.profile_key || data.asset.asset_kind}`,
    "",
    "Why this classification fits:",
    "",
    `The system classified this as ${data.asset.asset_kind}. Required research modules are ${listValues(data.profile?.required_modules_json)} and valuation lenses are ${listValues(data.profile?.required_valuation_lenses_json)}.`,
    "",
    "What this classification implies for research:",
    "",
    "The conclusion must blend evidence quality, business or asset fundamentals, valuation discipline, risk/reward, source completeness, and testable indicators.",
    "",
    "## Required Benchmarks",
    "",
    "| Benchmark | Ticker | Why selected |",
    "| --- | --- | --- |",
    `| Asset buy-and-hold | ${symbol} | Primary asset being researched |`,
    "| Market benchmark | SPY | Broad US equity market benchmark |",
    "| Sector or asset-class benchmark | TBD | Should be selected by profile and source map |",
    "| Cash baseline | Cash | 0% return baseline unless otherwise stated |",
    "",
    "## Initial Hypotheses",
    "",
    `Potential bull thesis: ${firstThesis?.one_sentence_thesis || "No thesis generated yet."}`,
    "",
    `Potential bear thesis: ${data.risks[0]?.description || "Research must identify what would invalidate the thesis."}`,
    "",
    `What the market may be missing: ${firstThesis?.market_missing || "Not yet established."}`,
    "",
    "What would make this idea not worth continuing:",
    "",
    data.risks.slice(0, 5).map((risk) => `- ${risk.risk_name}: ${risk.what_would_disconfirm || risk.description || "Monitor this risk."}`).join("\n") || "- Source completeness gate failed - additional source discovery required.",
    "",
    "## Data Availability",
    "",
    "| Data needed | Source | Available? | Notes |",
    "| --- | --- | --- | --- |",
    `| Price and volume | Market data provider | ${data.backtests.length ? "Yes" : "Unknown"} | Backtest records: ${data.backtests.length} |`,
    `| Financial statements | Filings/company sources | ${data.sources.length ? "Partial" : "Unknown"} | Source documents: ${data.sources.length} |`,
    `| Segment or asset-specific data | Agent evidence extraction | ${data.evidence.length ? "Partial" : "No"} | Evidence claims: ${data.evidence.length} |`,
    `| Valuation data | Valuation agent | ${data.signals.length ? "Partial" : "No"} | Signals: ${data.signals.length}; scenarios: ${data.scenarios.length} |`,
    `| Source gaps | Source intelligence | ${data.sourceGaps.length ? "Yes" : "No"} | Open gaps must be reviewed |`,
    "",
    "## Work Log",
    "",
    "| Date | Work completed | Open issues |",
    "| --- | --- | --- |",
    `| ${formatDate(data.run.created_at)} | System run created; generated ${data.evidence.length} evidence claims, ${data.metrics.length} metric observations, ${data.signals.length} valuation signals, and ${data.backtests.length} backtests | See source gaps and review packet |`,
    "",
  ].join("\n");
}

function renderAssetProfile(data: ResearchPackageData) {
  const drivers = effectiveDrivers(data);
  return [
    "# 01 Company Or Asset Profile",
    "",
    "## What It Is",
    "",
    data.asset.description || `${data.asset.canonical_name} is recorded as a ${data.asset.asset_kind}.`,
    "",
    "## How It Creates Value",
    "",
    drivers.slice(0, 8).map((driver) => `- **${driver.driver_name}**: ${driver.description || "Driver identified by system analysis."}`).join("\n") || "- Driver evidence is incomplete.",
    "",
    "## Financial And Operating History",
    "",
    metricTable(data.metrics.slice(0, 15)),
    "",
    "## Important Operating Metrics",
    "",
    data.metrics.slice(0, 12).map((metric) => `- **${metric.metric_display_name || metric.metric_key}**: ${formatMetric(metric)} (${metric.period_end || metric.as_of_date || "no period"})`).join("\n") || "- No normalized metrics stored.",
    "",
    "## What Has Gone Wrong Before",
    "",
    data.risks.slice(0, 8).map((risk) => `- **${risk.risk_name}**: ${risk.description || "Risk identified."}`).join("\n") || "- Risk history not established.",
    "",
    "## Ownership, Governance, And Management",
    "",
    "Source completeness gate failed - additional source discovery required for ownership, governance, management quality, and incentive alignment unless dedicated source records exist.",
    "",
  ].join("\n");
}

function renderSourceIntelligence(data: ResearchPackageData) {
  const inferredGaps = inferredSourceGaps(data);
  const quality = data.quality;
  return [
    "# 02 Source Intelligence",
    "",
    "## Source Completeness Gate",
    "",
    quality?.status === "pass"
      ? "Source map is populated, but should still be reviewed before final action."
      : "Source completeness gate failed - additional source discovery required.",
    "",
    "## Source Inventory Summary",
    "",
    `- Source documents recorded: ${data.sources.length}`,
    `- Evidence claims recorded: ${data.evidence.length}`,
    `- Open source gaps recorded: ${data.sourceGaps.length}`,
    `- Inferred source gaps: ${inferredGaps.length}`,
    `- Quality gate status: ${quality?.status || "not evaluated"}`,
    `- Action readiness: ${quality?.actionReadiness || "not evaluated"}`,
    `- Model calls recorded: ${data.modelCalls.length}`,
    "",
    "## Open Source Gaps",
    "",
    sourceGapList(data),
    "",
    "## Inferred Source Gaps",
    "",
    (quality?.missingCoverage.length
      ? quality.missingCoverage.map((gap) => `- **${gap.severity}** ${gap.area}: ${gap.description}`).join("\n")
      : inferredGaps.map((gap) => `- **${gap.severity}** ${gap.area}: ${gap.description}`).join("\n")) || "- No inferred gaps.",
    "",
    "## Source Quality Notes",
    "",
    data.sources.map((source) => `- **${source.title || source.source_type}** (${source.publisher || "unknown publisher"}): quality ${source.source_quality_score || "not scored"}`).join("\n") || "- No source documents stored.",
    "",
    "## Source-To-Research Mapping",
    "",
    "| Research area | Current source support | Missing checks |",
    "| --- | --- | --- |",
    `| Thesis | ${data.evidence.length} evidence claims | Confirm recent filings, industry context, and management commentary |`,
    `| Valuation | ${data.signals.length} signals | Peer multiples, historical range, sensitivity tables |`,
    `| Backtests | ${data.backtests.length} runs | Point-in-time low-frequency data alignment |`,
    `| Risks | ${data.risks.length} risks | Confirm risks with primary sources |`,
    "",
  ].join("\n");
}

function renderIndustryResearch(data: ResearchPackageData) {
  const industry = data.asset.industry || data.asset.sector || data.profile?.profile_key || data.asset.asset_kind;
  const evidenceByTopic = groupEvidenceByTopic(data.evidence);
  return [
    "# 02 Industry Research",
    "",
    "## Industry Definition",
    "",
    `${data.asset.canonical_name} is mapped to ${industry}. The industry work should explain the addressable market, competitive structure, regulation, cycle sensitivity, and benchmark set before the thesis is treated as action-ready.`,
    "",
    "## Market Structure",
    "",
    "| Question | Current system evidence | Status |",
    "| --- | --- | --- |",
    `| Main demand driver | ${cell(evidenceByTopic.demand || "Not established")} | ${evidenceByTopic.demand ? "Partial" : "Missing"} |`,
    `| Competitive set | ${cell(evidenceByTopic.competition || "Not established")} | ${evidenceByTopic.competition ? "Partial" : "Missing"} |`,
    `| Funding / input-cost driver | ${cell(evidenceByTopic.cost || "Not established")} | ${evidenceByTopic.cost ? "Partial" : "Missing"} |`,
    `| Regulation / policy driver | ${cell(evidenceByTopic.regulation || "Not established")} | ${evidenceByTopic.regulation ? "Partial" : "Missing"} |`,
    `| Cycle sensitivity | ${cell(evidenceByTopic.cycle || "Not established")} | ${evidenceByTopic.cycle ? "Partial" : "Missing"} |`,
    "",
    "## Benchmark Set",
    "",
    "| Benchmark | Current status | Why it matters |",
    "| --- | --- | --- |",
    "| SPY | Default market benchmark | Broad equity opportunity cost |",
    "| Sector ETF | Needs source-map confirmation | Tests whether returns are asset-specific or sector beta |",
    "| Close peer basket | Needs source-map confirmation | Tests relative sponsorship, valuation, and business quality |",
    "| Cash baseline | Default baseline | Separates true return from idle capital |",
    "",
    "## Industry Questions The Pipeline Must Answer",
    "",
    "- Is the asset's growth driven by industry expansion, share gain, pricing power, leverage, or one-off cycle effects?",
    "- Which peers set the valuation range and which peers should be rejected as false comparables?",
    "- What macro, regulation, commodity, funding, credit, or liquidity variables can break the thesis?",
    "- Which data series can become point-in-time indicators without lookahead bias?",
    "",
    "## Current Industry Gate",
    "",
    data.sources.length >= 5
      ? "Partial pass. Industry research has enough source breadth to summarize, but still needs manual review."
      : "Fail. The system has not collected enough industry or peer sources for an investment-quality industry section.",
    "",
  ].join("\n");
}

function renderInvestmentThesis(data: ResearchPackageData) {
  const thesis = data.theses[0];
  const drivers = effectiveDrivers(data);
  return [
    "# 03 Investment Thesis",
    "",
    "## One-Sentence Thesis",
    "",
    thesis?.one_sentence_thesis || "Conclusion withheld - research incomplete.",
    "",
    "## Why Now",
    "",
    thesis?.why_now || "Why-now evidence is incomplete.",
    "",
    "## What The Market May Be Missing",
    "",
    thesis?.market_missing || "Market-missing claim is not established.",
    "",
    "## Main Upside Drivers",
    "",
    "| Driver | Evidence | How it could affect value |",
    "| --- | --- | --- |",
    drivers.map((driver) => `| ${cell(driver.driver_name)} | ${cell(driver.description)} | ${cell(driver.value_impact)} |`).join("\n") || "| Insufficient driver evidence | n/a | n/a |",
    "",
    "## Main Downside Risks",
    "",
    "| Risk | Evidence | How it could hurt value |",
    "| --- | --- | --- |",
    data.risks.slice(0, 10).map((risk) => `| ${cell(risk.risk_name)} | ${cell(risk.description)} | ${cell(risk.what_would_confirm || risk.severity)} |`).join("\n") || "| No risks recorded | n/a | n/a |",
    "",
    "## Expected Time Horizon",
    "",
    "2 to 3 years for investment review unless the strategy section defines a shorter trading-only setup.",
    "",
    "## Key Evidence",
    "",
    data.evidence.slice(0, 20).map((claim) => `- ${claim.claim_text} *(confidence: ${claim.confidence || "n/a"})*`).join("\n") || "- No accepted evidence claims.",
    "",
    "## What Would Prove The Thesis Wrong",
    "",
    data.risks.slice(0, 8).map((risk) => `- ${risk.what_would_disconfirm || risk.what_would_confirm || risk.description || risk.risk_name}`).join("\n") || "- Missing risk disconfirmation checklist.",
    "",
    "## Scenario Framework",
    "",
    scenarioBlocks(data.scenarios),
    "",
    "## Facts, Assumptions, Estimates, And Opinions",
    "",
    "Facts:",
    "",
    data.evidence.filter((claim) => String(claim.claim_category || "").includes("fact")).slice(0, 8).map((claim) => `- ${claim.claim_text}`).join("\n") || "- No fact claims categorized.",
    "",
    "Assumptions:",
    "",
    data.signals.slice(0, 6).map((signal) => `- ${signal.signal_name}: ${stringifyBrief(signal.comparison_range_json)}`).join("\n") || "- No assumptions stored.",
    "",
    "Estimates:",
    "",
    data.scenarios.map((scenario) => `- ${scenario.scenario_name}: ${scenario.value_anchor || "n/a"} ${scenario.currency || ""}`).join("\n") || "- No scenario estimates stored.",
    "",
    "Opinions:",
    "",
    "- The final recommendation remains subject to source completeness, valuation review, and backtest review.",
    "",
  ].join("\n");
}

function renderRiskReward(data: ResearchPackageData) {
  return [
    "# 04 Risk Reward",
    "",
    "## Scenario Table",
    "",
    "| Scenario | Probability | Value anchor | Confidence | Key assumptions |",
    "| --- | --- | --- | --- | --- |",
    data.scenarios.map((scenario) => `| ${cell(scenario.scenario_name)} | ${percent(scenario.probability)} | ${cell(formatCurrency(scenario.value_anchor, scenario.currency))} | ${percent(scenario.confidence)} | ${cell(stringifyBrief(scenario.assumptions_json))} |`).join("\n") || "| No scenarios | n/a | n/a | n/a | n/a |",
    "",
    "## Risk Register",
    "",
    "| Risk | Type | Severity | Probability | Mitigants | What would confirm |",
    "| --- | --- | --- | --- | --- | --- |",
    data.risks.map((risk) => `| ${cell(risk.risk_name)} | ${cell(risk.risk_type)} | ${cell(risk.severity)} | ${cell(risk.probability)} | ${cell(stringifyBrief(risk.mitigants_json))} | ${cell(risk.what_would_confirm)} |`).join("\n") || "| No risks | n/a | n/a | n/a | n/a | n/a |",
    "",
    "## Catalysts",
    "",
    "| Catalyst | Type | Expected date | Upside/downside | Status |",
    "| --- | --- | --- | --- | --- |",
    data.catalysts.map((catalyst) => `| ${cell(catalyst.catalyst_name)} | ${cell(catalyst.catalyst_type)} | ${cell(catalyst.expected_date)} | ${cell(catalyst.upside_downside)} | ${cell(catalyst.status)} |`).join("\n") || "| No catalysts | n/a | n/a | n/a | n/a |",
    "",
    "## Position Sizing Implications",
    "",
    "Sizing should remain provisional until the source map, valuation abnormality review, and backtest review are complete.",
    "",
  ].join("\n");
}

function renderValuation(data: ResearchPackageData) {
  const drivers = effectiveDrivers(data);
  const scenarioValues = data.scenarios
    .map((scenario) => Number(scenario.value_anchor))
    .filter((value) => Number.isFinite(value));
  const valuationConclusion = scenarioValues.length
    ? `Scenario value range: ${Math.min(...scenarioValues).toFixed(2)} to ${Math.max(...scenarioValues).toFixed(2)} ${data.scenarios.find((scenario) => scenario.currency)?.currency || ""}`.trim()
    : "Scenario value range: not established. The valuation is not action-ready until at least bear/base/bull value anchors are populated.";
  return [
    "# 05 Valuation",
    "",
    "## Valuation Summary",
    "",
    `Ticker or asset: ${data.listing?.symbol || data.asset.slug}`,
    "",
    `Asset type: ${data.asset.asset_kind}${data.asset.sector ? `; ${data.asset.sector}` : ""}`,
    "",
    `Selected valuation playbook: ${data.profile?.profile_key || data.asset.asset_kind}`,
    "",
    valuationConclusion,
    "",
    `Dashboard conclusion: ${valuationDashboardConclusion(data.signals)}`,
    "",
    `Main data limitation: ${sourceGapList(data).replace(/\n/g, " ")}`,
    "",
    "## Valuation Method Selection",
    "",
    "| Candidate lens | Use / reject | Reason |",
    "| --- | --- | --- |",
    ...valuationLensRows(data),
    "",
    "## Valuation Playbook",
    "",
    `Profile: ${data.profile?.profile_key || data.asset.asset_kind}`,
    "",
    `Required valuation lenses: ${listValues(data.profile?.required_valuation_lenses_json)}`,
    "",
    "## Valuation Signal Dashboard",
    "",
    "| Signal | Lens | Current value | Signal | Cheapness score | Confidence |",
    "| --- | --- | --- | --- | --- | --- |",
    data.signals.map((signal) => `| ${cell(signal.signal_name)} | ${cell(signal.lens_family)} | ${cell(signal.current_value_text || signal.current_value)} | ${cell(signal.signal)} | ${cell(signal.cheapness_score)} | ${percent(signal.confidence)} |`).join("\n") || "| No signals | n/a | n/a | n/a | n/a | n/a |",
    "",
    "Dashboard file:",
    "",
    "```text",
    "data/processed/valuation_dashboard.csv",
    "```",
    "",
    "## Historical Cheapness / Expensiveness",
    "",
    valuationSignalSummary(data.signals),
    "",
    "## Value Driver Map",
    "",
    "| Driver | Current evidence | Forecast or scenario role | Data need |",
    "| --- | --- | --- | --- |",
    drivers.slice(0, 8).map((driver) => `| ${cell(driver.driver_name)} | ${cell(driver.description)} | ${cell(driver.value_impact)} | ${cell(driver.source || "Confirm with primary sources and historical context")} |`).join("\n") || "| No drivers | n/a | n/a | n/a |",
    "",
    "## Scenario Valuation",
    "",
    "| Scenario | Type | Time horizon | Probability | Value anchor | Assumptions |",
    "| --- | --- | --- | --- | --- | --- |",
    data.scenarios.map((scenario) => `| ${cell(scenario.scenario_name)} | ${cell(scenario.scenario_type)} | ${cell(scenario.time_horizon)} | ${percent(scenario.probability)} | ${cell(formatCurrency(scenario.value_anchor, scenario.currency))} | ${cell(stringifyBrief(scenario.assumptions_json))} |`).join("\n") || "| No scenarios | n/a | n/a | n/a | n/a | n/a |",
    "",
    "## What Must Be True",
    "",
    drivers.slice(0, 8).map((driver) => `- ${driver.driver_name}: ${driver.value_impact || driver.description || "Must hold for valuation to work."}`).join("\n") || "- Value drivers are incomplete.",
    "",
    "## Abnormality Review",
    "",
    "- Check whether valuation uses stale periods, fiscal-period end dates instead of release dates, or unsupported peer ranges.",
    "- Check whether cheapness scores disagree with scenario value anchors.",
    "- Check whether source gaps make any valuation lens non-actionable.",
    "",
    "## Valuation Limitations",
    "",
    data.quality?.missingCoverage
      .filter((item) => item.area.includes("valuation"))
      .map((item) => `- **${item.severity}** ${item.description}`)
      .join("\n") || "No valuation-specific quality gate blockers recorded.",
    "",
    sourceGapList(data),
    "",
  ].join("\n");
}

function renderIndicators(indicators: IndicatorCandidate[]) {
  return [
    "# 06 Custom Indicators",
    "",
    "Minimum standard: at least 10 candidate indicators, each tied to a real investment hypothesis.",
    "",
    ...indicators.map((indicator) => [
      `## ${indicator.id}: ${indicator.name}`,
      "",
      `Indicator family: ${indicator.family}`,
      "",
      `Investment hypothesis: ${indicator.hypothesis}`,
      "",
      `Source: ${indicator.source}`,
      "",
      `Quality: ${indicator.quality}`,
      "",
      `Update frequency: ${indicator.updateFrequency}`,
      "",
      `Backtestability: ${indicator.backtestability}`,
      "",
      `Lookahead risk: ${indicator.lookaheadRisk}`,
      "",
      `Calculation: ${indicator.calculation}`,
      "",
      `Expected use case: ${indicator.useCase}`,
      "",
      `Failure case: ${indicator.failureCase}`,
      "",
      `Backtest plan: ${indicator.backtestPlan}`,
      "",
    ].join("\n")),
  ].join("\n");
}

function renderStrategyDesign(data: ResearchPackageData, indicators: IndicatorCandidate[]) {
  return [
    "# 07 Strategy Design",
    "",
    "## Strategy Objective",
    "",
    `Test whether the ${data.asset.canonical_name} thesis has observable confirmation, valuation support, and risk controls.`,
    "",
    "## Indicator Families",
    "",
    [...new Set(indicators.map((indicator) => indicator.family))].map((family) => `- ${family}`).join("\n"),
    "",
    "## Entry Logic",
    "",
    "- Require at least one thesis-confirming indicator and one risk or valuation filter.",
    "- Avoid entries when source gaps make the relevant signal stale, manual-only, or non-point-in-time.",
    "",
    "## Exit Logic",
    "",
    "- Exit when the thesis-confirming indicator breaks, the key risk indicator confirms deterioration, or valuation support disappears.",
    "",
    "## Risk Controls",
    "",
    "- Compare against asset buy-and-hold, market benchmark, sector benchmark, and cash.",
    "- Include transaction costs where backtesting data allows.",
    "- Separate investment-only conclusions from trade-only conclusions.",
    "",
    "## Data Alignment Requirements",
    "",
    "- Price and volume data can be daily.",
    "- Fundamental and filing-derived indicators must use availability dates, not period-end dates.",
    "- Qualitative claims cannot be used as daily point-in-time signals unless converted into a documented timestamped series.",
    "",
  ].join("\n");
}

function renderBacktests(data: ResearchPackageData, combinations: StrategyCombination[]) {
  return [
    "# 08 Backtest Results",
    "",
    "## Backtest Coverage",
    "",
    `Backtest runs stored: ${data.backtests.length}`,
    "",
    "## Backtest Summary",
    "",
    "| Backtest | Status | Return | Sharpe | Max drawdown | Benchmark return |",
    "| --- | --- | --- | --- | --- | --- |",
    data.backtests.map((backtest) => {
      const metrics = asObject(backtest.metrics_json);
      return `| ${cell(backtest.name || backtest.strategy_name || backtest.id)} | ${cell(backtest.status)} | ${percent(metricValue(metrics, "total_return"))} | ${cell(formatNumber(metricValue(metrics, "sharpe", "sharpe_ratio")))} | ${percent(metricValue(metrics, "max_drawdown"))} | ${percent(metricValue(metrics, "benchmark_total_return"))} |`;
    }).join("\n") || "| No backtests | n/a | n/a | n/a | n/a | n/a |",
    "",
    "## Trade Statistics",
    "",
    "| Backtest | Trades | Invested days | Observations | Ending equity | Volatility |",
    "| --- | --- | --- | --- | --- | --- |",
    data.backtests.map((backtest) => {
      const metrics = asObject(backtest.metrics_json);
      return `| ${cell(backtest.name || backtest.strategy_name || backtest.id)} | ${cell(metricValue(metrics, "trade_count"))} | ${cell(metricValue(metrics, "invested_days"))} | ${cell(metricValue(metrics, "observations"))} | ${cell(formatNumber(metricValue(metrics, "ending_equity")))} | ${percent(metricValue(metrics, "volatility"))} |`;
    }).join("\n") || "| No backtests | n/a | n/a | n/a | n/a | n/a |",
    "",
    "## Backtest Artifacts",
    "",
    data.backtestArtifacts.map((artifact) => `- **${artifact.title || artifact.artifact_type}**: \`${artifact.storage_path}\` (${artifact.artifact_type})`).join("\n") || "- No backtest artifacts stored.",
    "",
    "## Copied Package Outputs",
    "",
    "- `data/backtest_outputs/backtest_summary.csv`",
    "- `data/backtest_outputs/backtest_artifacts.csv`",
    "- `data/backtest_outputs/equity_curves.csv` when available",
    "- `data/backtest_outputs/trade_log.csv` when available",
    "",
    "## Top 10 Combination Review",
    "",
    combinations.slice(0, 10).map((combo, index) => `- ${index + 1}. **${combo.id} ${combo.name}**: ${combo.hypothesis}`).join("\n"),
    "",
    "## Weak Or Failed Combination Review",
    "",
    combinations.slice(-5).map((combo) => `- **${combo.id} ${combo.name}**: Treat as weak until tested against point-in-time data and benchmark drawdowns.`).join("\n"),
    "",
    "## Source Data Alignment Note",
    "",
    "Current package requires review of low-frequency source availability dates before fundamental or valuation signals are treated as point-in-time backtest inputs.",
    "",
  ].join("\n");
}

function renderReviewPacket(data: ResearchPackageData, indicators: IndicatorCandidate[], combinations: StrategyCombination[]) {
  const inferredGaps = inferredSourceGaps(data);
  const quality = data.quality;
  const completeEnough = quality?.status === "pass";
  const recommendation = completeEnough
    ? "Research further"
    : "Research further - incomplete source and artifact gates";
  const drivers = effectiveDrivers(data);
  return [
    "# 09 Review Packet",
    "",
    "## Recommendation Status",
    "",
    recommendation,
    "",
    "Allowed final statuses: Reject, Watchlist, Research further, Small starter position candidate, High-conviction candidate, Trade only, not investment, Investment only, not trade.",
    "",
    "## Completion Gates",
    "",
    `- Canonical files generated: ${CANONICAL_FILES.length}`,
    `- Source documents: ${data.sources.length}`,
    `- Evidence claims: ${data.evidence.length}`,
    `- Metric observations: ${data.metrics.length}`,
    `- Valuation signals: ${data.signals.length}`,
    `- Custom indicators: ${indicators.length}`,
    `- Strategy combinations: ${combinations.length}`,
    `- Backtests: ${data.backtests.length}`,
    `- Backtest artifacts: ${data.backtestArtifacts.length}`,
    `- Open source gaps: ${data.sourceGaps.length}`,
    `- Inferred source gaps: ${inferredGaps.length}`,
    `- Quality gate status: ${quality?.status || "not evaluated"}`,
    `- Action readiness: ${quality?.actionReadiness || "not evaluated"}`,
    `- Gate verdict: ${completeEnough ? "Pass with review" : "Fail for investment action; usable for research direction only"}`,
    "",
    "## Quality Gate Blockers",
    "",
    quality?.missingCoverage.length
      ? quality.missingCoverage.map((item) => `- **${item.severity}** ${item.area}: ${item.description}`).join("\n")
      : "- No quality gate blockers recorded.",
    "",
    "## Main Thesis",
    "",
    data.theses[0]?.one_sentence_thesis || "No thesis generated.",
    "",
    "## Reasons To Continue",
    "",
    drivers.slice(0, 8).map((driver) => `- ${driver.driver_name}: ${driver.description || driver.value_impact || "Driver identified."}`).join("\n") || "- No positive drivers stored.",
    "",
    "## Reasons To Reject Or Wait",
    "",
    data.risks.slice(0, 8).map((risk) => `- ${risk.risk_name}: ${risk.description || risk.severity}`).join("\n") || "- Risk review incomplete.",
    "",
    "## Open Questions",
    "",
    openQuestions(data),
    "",
    "## Source Intelligence Summary",
    "",
    sourceIntelligenceSummary(data),
    "",
    "## Backtest Conclusion",
    "",
    backtestConclusion(data.backtests),
    "",
    "## Final Recommendation",
    "",
    completeEnough
      ? "The run is complete enough for a human review pass, but still requires valuation and source-quality judgment before any position decision."
      : "Do not treat this as action-ready. The package is useful as a first research scaffold, but source breadth, valuation anchors, and backtest artifacts must be upgraded before the recommendation can be trusted.",
    "",
    "## Reviewer Notes",
    "",
    "- Review whether source completeness is good enough for action.",
    "- Review whether valuation and scenario outputs are internally consistent.",
    "- Review whether backtests use point-in-time data and appropriate benchmarks.",
    "",
  ].join("\n");
}

function renderCombinations(combinations: StrategyCombination[]) {
  return [
    "# 10 Strategy Combinations",
    "",
    "Minimum requirement: at least 50 combinations, each tied to a distinct thesis, indicator-family mix, risk control, source type, or regime assumption.",
    "",
    ...combinations.map((combo) => [
      `## ${combo.id}: ${combo.name}`,
      "",
      `Combination ID: ${combo.id}`,
      `Strategy name: ${combo.name}`,
      `Indicators used: ${combo.indicators.join(", ")}`,
      `Indicator families used: ${combo.families.join(", ")}`,
      `Investment hypothesis: ${combo.hypothesis}`,
      `Entry rule: ${combo.entryRule}`,
      `Exit rule: ${combo.exitRule}`,
      `Risk control: ${combo.riskControl}`,
      `Position sizing: ${combo.positionSizing}`,
      `Regime assumption: ${combo.regime}`,
      `Why this combination makes economic sense: ${combo.rationale}`,
      "Why this is not pure curve fitting: The rule tests a named investment condition and one risk-control logic; it does not iterate small parameter changes.",
      "",
    ].join("\n")),
  ].join("\n");
}

function renderSources(data: ResearchPackageData) {
  return [
    "# Sources",
    "",
    "## Source Documents",
    "",
    "| Title | Publisher | Type | Quality | URL |",
    "| --- | --- | --- | --- | --- |",
    data.sources.map((source) => `| ${cell(source.title)} | ${cell(source.publisher)} | ${cell(source.source_type)} | ${cell(source.source_quality_score)} | ${cell(source.url || source.storage_path)} |`).join("\n") || "| No sources | n/a | n/a | n/a | n/a |",
    "",
    "## Evidence Claims",
    "",
    data.evidence.slice(0, 50).map((claim) => `- ${claim.claim_text} *(type: ${claim.claim_type || "n/a"}; confidence: ${claim.confidence || "n/a"})*`).join("\n") || "- No evidence claims stored.",
    "",
    "## Source Gaps",
    "",
    sourceGapList(data),
    "",
  ].join("\n");
}

function renderSourceAgentInstructions() {
  return [
    "# Source Intelligence Instructions",
    "",
    "Track official sources, rejected sources, missing paid-only data, source quality, refresh cadence, and source-to-indicator mapping.",
    "",
  ].join("\n");
}

function renderSourceInventory(data: ResearchPackageData) {
  return [
    "# Source Inventory",
    "",
    "| Source | Publisher | Type | Quality | Storage/URL |",
    "| --- | --- | --- | --- | --- |",
    data.sources.map((source) => `| ${cell(source.title)} | ${cell(source.publisher)} | ${cell(source.source_type)} | ${cell(source.source_quality_score)} | ${cell(source.url || source.storage_path)} |`).join("\n") || "| No sources | n/a | n/a | n/a | n/a |",
    "",
  ].join("\n");
}

function renderSourceQuality(data: ResearchPackageData) {
  return [
    "# Source Quality Scores",
    "",
    data.sources.map((source) => `- **${source.title || source.source_type}**: ${source.source_quality_score || "not scored"} (${source.publisher || "unknown"})`).join("\n") || "No source quality scores recorded.",
    "",
  ].join("\n");
}

function renderDataAvailability(data: ResearchPackageData) {
  const inferredGaps = inferredSourceGaps(data);
  return [
    "# Data Availability Map",
    "",
    "| Dataset | Availability | Rows/records | Notes |",
    "| --- | --- | --- | --- |",
    `| Evidence claims | ${data.evidence.length ? "Available" : "Missing"} | ${data.evidence.length} | Accepted/reviewed claims |`,
    `| Metric observations | ${data.metrics.length ? "Available" : "Missing"} | ${data.metrics.length} | Normalized metrics |`,
    `| Valuation signals | ${data.signals.length ? "Available" : "Missing"} | ${data.signals.length} | Dashboard inputs |`,
    `| Scenarios | ${data.scenarios.length ? "Available" : "Missing"} | ${data.scenarios.length} | Risk/reward anchors |`,
    `| Backtests | ${data.backtests.length ? "Available" : "Missing"} | ${data.backtests.length} | Strategy tests |`,
    `| Backtest artifacts | ${data.backtestArtifacts.length ? "Available" : "Missing"} | ${data.backtestArtifacts.length} | Metrics, equity curve, trades, generated code when produced |`,
    `| Inferred source gaps | ${inferredGaps.length ? "Present" : "None"} | ${inferredGaps.length} | Generator-level quality checks |`,
    "",
  ].join("\n");
}

function renderAssetSpecificSourcePlan(data: ResearchPackageData) {
  const profile = data.profile?.profile_key || data.asset.asset_kind;
  return [
    "# Asset-Specific Source Plan",
    "",
    `Asset: ${data.asset.canonical_name}`,
    `Profile: ${profile}`,
    "",
    "## Required Source Families",
    "",
    "| Source family | Required? | Current status | Why it matters |",
    "| --- | --- | --- | --- |",
    `| Official filings/regulatory records | Yes | ${hasSource(data, ["sec", "filing", "10-k", "10-q"]) ? "Present" : "Missing or thin"} | Financial statements, risk factors, share count, accounting policy |`,
    `| Company investor relations | Yes | ${hasSource(data, ["investor", "ir", "presentation", "earnings"]) ? "Present" : "Missing"} | Guidance, segment KPIs, management commentary |`,
    `| Market price and benchmark data | Yes | ${data.backtests.length ? "Present" : "Missing"} | Drawdown, relative strength, volatility, strategy testing |`,
    `| Peer/industry data | Yes | ${hasSource(data, ["peer", "industry", "fdic", "fred", "federal reserve"]) ? "Present" : "Missing"} | Relative valuation, sector regime, competitive context |`,
    `| Alternative/paid data | Optional | ${hasSource(data, ["paid", "alternative", "app", "credit bureau"]) ? "Present" : "Not used"} | May improve confirmation and leading indicators |`,
    "",
    "## Collection Order",
    "",
    "1. Latest 10-K, latest 10-Q, recent 8-Ks, and proxy statement.",
    "2. Latest earnings release, presentation, transcript, and guidance bridge.",
    "3. Daily price/volume plus SPY and sector/peer benchmarks.",
    "4. Peer valuation and operating metrics.",
    "5. Macro/industry series tied to the core thesis risks.",
    "6. Paid or alternative datasets only after the public-source case is coherent.",
    "",
    "## Required Output Mapping",
    "",
    "- Filings and IR sources should feed `01_company_or_asset_profile.md`, `03_investment_thesis.md`, `04_risk_reward.md`, and `05_valuation.md`.",
    "- Market and benchmark data should feed `06_custom_indicators.md`, `07_strategy_design.md`, and `08_backtest_results.md`.",
    "- Peer/industry data should feed `02_industry_research.md` and valuation cross-checks.",
    "",
  ].join("\n");
}

function renderFilingDownloadLog(data: ResearchPackageData) {
  const filingSources = data.sources.filter((source) =>
    ["sec", "filing", "10-k", "10-q", "8-k", "proxy", "def 14a"].some((keyword) =>
      `${source.source_type || ""} ${source.title || ""} ${source.publisher || ""}`.toLowerCase().includes(keyword)
    )
  );
  return [
    "# Filing Download Log",
    "",
    "| Filing/source | Publisher | Retrieved | Period | Storage/URL | Status |",
    "| --- | --- | --- | --- | --- | --- |",
    filingSources.map((source) => `| ${cell(source.title)} | ${cell(source.publisher)} | ${cell(formatDate(source.retrieved_at))} | ${cell(formatDate(source.period_end || source.published_at))} | ${cell(source.storage_path || source.url)} | Present |`).join("\n") || "| No filing sources recorded | n/a | n/a | n/a | n/a | Missing |",
    "",
    "## Missing Filing Checks",
    "",
    "- Latest annual report.",
    "- Latest quarterly report.",
    "- Recent material 8-Ks or equivalent announcements.",
    "- Proxy/governance document where applicable.",
    "- Filing release dates, not just fiscal period end dates.",
    "",
  ].join("\n");
}

function renderSourceToIndicatorMap(data: ResearchPackageData, indicators: IndicatorCandidate[]) {
  return [
    "# Source To Indicator Map",
    "",
    "| Indicator | Source | Quality | Refresh |",
    "| --- | --- | --- | --- |",
    indicators.map((indicator) => `| ${cell(indicator.name)} | ${cell(indicator.source)} | ${cell(indicator.quality)} | ${cell(indicator.updateFrequency)} |`).join("\n"),
    "",
    "## Source Gap Impact",
    "",
    sourceGapList(data),
    "",
  ].join("\n");
}

function renderFailedSourceAttempts(data: ResearchPackageData) {
  return [
    "# Failed Source Attempts",
    "",
    data.sourceGaps.map((gap) => `- **${gap.severity || "medium"}** ${gap.gap_key || "source_gap"}: ${gap.description}`).join("\n") || "No failed source attempts recorded. This may mean source gaps were not assessed.",
    "",
  ].join("\n");
}

function renderRegulatorySourceMap(data: ResearchPackageData) {
  return [
    "# Regulatory Source Map",
    "",
    `Primary jurisdiction: ${data.asset.home_country || "Not recorded"}`,
    "",
    "| Source type | Status | Notes |",
    "| --- | --- | --- |",
    `| Official filings | ${data.sources.some((source) => String(source.source_type).includes("sec")) ? "Present" : "Needs review"} | Confirm latest annual, quarterly, and event filings |`,
    "| Company IR | Needs review | Add investor presentations, transcripts, and guidance where available |",
    "| Industry or macro data | Needs review | Add authoritative industry datasets and benchmark data |",
    "",
  ].join("\n");
}

function renderRefreshSchedule(data: ResearchPackageData) {
  return [
    "# Refresh Schedule",
    "",
    "| Item | Frequency | Trigger |",
    "| --- | --- | --- |",
    "| Price and benchmark data | Daily/weekly | Any strategy refresh or major drawdown |",
    "| Filings and company releases | Quarterly/event-driven | 10-Q, 10-K, earnings, guidance updates |",
    "| Valuation dashboard | Quarterly | New financials, price move, or peer multiple change |",
    "| Source gap review | Every research refresh | Before thesis or recommendation update |",
    "",
  ].join("\n");
}

function renderCodeReadme(data: ResearchPackageData) {
  return [
    "# Code Artifacts",
    "",
    "This package is generated from Research OS database records. Future versions should place generated valuation, indicator, and backtest code here.",
    "",
    `Asset: ${data.asset.canonical_name}`,
    `Run: ${data.run.id}`,
    "",
  ].join("\n");
}

function buildIndicators(data: ResearchPackageData): IndicatorCandidate[] {
  const candidates: IndicatorCandidate[] = [];
  const metricRows = data.metrics.slice(0, 8);
  for (const metric of metricRows) {
    const name = metric.metric_display_name || metric.metric_key || "Metric trend";
    candidates.push({
      id: `IND-${String(candidates.length + 1).padStart(3, "0")}`,
      name: `${name} confirmation`,
      family: `${metric.metric_category || "Fundamental"} indicators`,
      hypothesis: `If ${name} supports the thesis, forward returns should improve when this metric is stable or improving.`,
      source: metric.data_provider || "metric-normalizer",
      quality: `Confidence ${metric.confidence || "n/a"}`,
      updateFrequency: "Quarterly or when source updates",
      backtestability: "Medium; requires point-in-time availability dates.",
      lookaheadRisk: "High if fiscal period end dates are used instead of filing/release dates.",
      calculation: `Track level and change in ${metric.metric_key || name}.`,
      useCase: "Thesis confirmation and deterioration warning.",
      failureCase: "Metric improves but price/valuation/risk context deteriorates.",
      backtestPlan: "Lag by availability date, compare against buy-and-hold, sector benchmark, market benchmark, and cash.",
    });
  }

  for (const signal of data.signals.slice(0, 6)) {
    const name = signal.signal_name || signal.signal_key || "Valuation signal";
    candidates.push({
      id: `IND-${String(candidates.length + 1).padStart(3, "0")}`,
      name: `${name} cheapness`,
      family: "Valuation indicators",
      hypothesis: `If ${name} identifies cheapness, returns should improve when cheapness score is attractive and thesis evidence is not deteriorating.`,
      source: "valuation-analyst",
      quality: `Confidence ${signal.confidence || "n/a"}`,
      updateFrequency: "Quarterly and after large price moves",
      backtestability: "Medium; requires historical valuation inputs.",
      lookaheadRisk: "High if current valuation ranges are backfilled.",
      calculation: `Use cheapness_score for ${signal.signal_key || name}.`,
      useCase: "Entry filter and valuation risk control.",
      failureCase: "Cheapness reflects structural impairment instead of mispricing.",
      backtestPlan: "Test cheapness score with trend and risk filters across historical windows.",
    });
  }

  const fallbackFamilies = [
    ["Relative strength vs market", "Relative strength indicators"],
    ["Drawdown from 52-week high", "Drawdown/recovery indicators"],
    ["Volatility percentile", "Volatility/risk indicators"],
    ["Benchmark trend regime", "Macro/liquidity indicators"],
    ["Source gap severity", "Source quality indicators"],
    ["Risk count trend", "Risk indicators"],
    ["Catalyst proximity", "Catalyst indicators"],
    ["Evidence confidence breadth", "Evidence quality indicators"],
    ["Scenario skew", "Risk/reward indicators"],
    ["Backtest drawdown filter", "Backtest robustness indicators"],
  ];

  for (const [name, family] of fallbackFamilies) {
    if (candidates.length >= 12) break;
    candidates.push({
      id: `IND-${String(candidates.length + 1).padStart(3, "0")}`,
      name,
      family,
      hypothesis: `${name} should help distinguish confirmed thesis setups from unsupported or high-risk setups.`,
      source: "Research OS package generator",
      quality: "Derived; requires validation",
      updateFrequency: "Each research refresh",
      backtestability: "Medium",
      lookaheadRisk: "Medium; depends on timestamped inputs.",
      calculation: `Compute ${name.toLowerCase()} from stored research, market, or source records.`,
      useCase: "Confirmation, risk control, or regime filter.",
      failureCase: "Signal becomes redundant with price or relies on stale qualitative data.",
      backtestPlan: "Combine with at least one independent indicator family and benchmark against buy-and-hold.",
    });
  }

  return candidates.slice(0, Math.max(10, Math.min(candidates.length, 12)));
}

function buildStrategyCombinations(indicators: IndicatorCandidate[]): StrategyCombination[] {
  const blueprints = [
    ["Price Compression + Fundamental Confirmation", "valuation reset", "fundamental evidence", "avoid value traps after large drawdowns"],
    ["Price Macro Industry + Quality Confirmation", "market regime", "industry/peer sponsorship", "avoid buying asset-specific weakness in sector stress"],
    ["Valuation + Relative Strength Recovery", "cheapness", "relative-strength repair", "avoid cheap stocks that keep underperforming"],
    ["Fundamental Flywheel + Drawdown Control", "growth and operating leverage", "drawdown guardrail", "scale exposure only after risk stabilizes"],
    ["Credit/Funding Risk + Momentum Filter", "credit/funding health", "price confirmation", "avoid deteriorating lenders or balance-sheet assets"],
    ["Catalyst Window + Volatility Sizing", "upcoming catalyst", "volatility regime", "keep event risk bounded"],
    ["Evidence Breadth + Valuation Support", "source quality", "valuation discipline", "avoid acting on thin evidence"],
    ["Peer Leadership + Thesis Confirmation", "peer-relative sponsorship", "thesis driver", "separate alpha from sector beta"],
    ["Risk-Off Avoidance + Reentry", "macro or risk-off filter", "recovery signal", "avoid catching falling knives"],
    ["Backtest Robustness + Investment Thesis", "historical robustness", "business thesis", "reject signals that only work statistically"],
  ];
  const combos: StrategyCombination[] = [];
  for (let index = 0; index < 50; index += 1) {
    const first = indicators[index % indicators.length];
    const second = indicators[(index + 3) % indicators.length];
    const third = indicators[(index + 7) % indicators.length];
    const blueprint = blueprints[index % blueprints.length];
    const families = [...new Set([first.family, second.family, third.family])];
    combos.push({
      id: `COMBO-${String(index + 1).padStart(3, "0")}`,
      name: `${blueprint[0]} ${Math.floor(index / blueprints.length) + 1}`,
      indicators: [first.name, second.name, third.name],
      families,
      hypothesis: `Tests whether ${blueprint[1]} works only when ${blueprint[2]} is also present, with ${third.name} used to ${blueprint[3]}.`,
      entryRule: `${first.id} confirms, ${second.id} confirms, and source availability dates are valid.`,
      exitRule: `Exit or de-risk when ${first.id} fails, ${second.id} rolls over, or ${third.id} breaches its risk threshold.`,
      riskControl: `${third.name} controls downside; cap exposure when source gaps, volatility, or drawdown risk are elevated.`,
      positionSizing: "Start at half exposure, move to full exposure only while all source, confirmation, and risk filters remain true.",
      regime: blueprint[0].toLowerCase(),
      rationale: `Combines ${families.join(", ")} so the test has a thesis input, an independent confirmation input, and a separate risk-control input.`,
    });
  }
  return combos;
}

function metricTable(metrics: Row[]) {
  if (!metrics.length) return "No normalized metrics stored.";
  return [
    "| Metric | Value | Period | Provider | Confidence |",
    "| --- | --- | --- | --- | --- |",
    ...metrics.map((metric) => `| ${cell(metric.metric_display_name || metric.metric_key)} | ${cell(formatMetric(metric))} | ${cell(metric.period_end || metric.as_of_date)} | ${cell(metric.data_provider)} | ${cell(metric.confidence)} |`),
  ].join("\n");
}

function effectiveDrivers(data: ResearchPackageData): Row[] {
  if (data.drivers.length) return data.drivers;

  const metricDrivers = data.metrics.slice(0, 4).map((metric) => ({
    driver_name: `${metric.metric_display_name || metric.metric_key} trend`,
    driver_type: "financial",
    description: `${metric.metric_display_name || metric.metric_key} was recorded at ${formatMetric(metric)} for ${formatDate(metric.period_end || metric.as_of_date) || "the available period"}.`,
    value_impact: "May support or weaken the thesis depending on direction, durability, and valuation context.",
  }));
  const valuationDrivers = data.signals.slice(0, 4).map((signal) => ({
    driver_name: signal.signal_name || `${signal.lens_family} signal`,
    driver_type: "valuation",
    description: signal.current_value_text || signal.signal || "Valuation signal generated by the valuation analyst.",
    value_impact: `Cheapness score: ${signal.cheapness_score || "n/a"}`,
  }));

  return dedupeBy([...metricDrivers, ...valuationDrivers], (row) => `${row.driver_name}|${row.description}`).slice(0, 8);
}

function scenarioBlocks(scenarios: Row[]) {
  if (!scenarios.length) return "No scenarios generated.";
  return scenarios.map((scenario) => [
    `### ${scenario.scenario_name}`,
    "",
    `Type: ${scenario.scenario_type}`,
    "",
    `Probability: ${percent(scenario.probability)}`,
    "",
    `Potential value: ${formatCurrency(scenario.value_anchor, scenario.currency)}`,
    "",
    `Key assumptions: ${stringifyBrief(scenario.assumptions_json)}`,
    "",
  ].join("\n")).join("\n");
}

function sourceGapList(data: ResearchPackageData) {
  return data.sourceGaps.length
    ? data.sourceGaps.map((gap) => `- **${gap.severity || "medium"}** ${gap.description || gap.gap_key}`).join("\n")
    : "- No source gaps recorded. This may indicate gaps were not assessed.";
}

function openQuestions(data: ResearchPackageData) {
  const questions = [
    ...inferredSourceGaps(data).slice(0, 5).map((gap) => `- How should we close inferred source gap: ${gap.area}? ${gap.description}`),
    ...data.sourceGaps.slice(0, 5).map((gap) => `- How should we close source gap: ${gap.description || gap.gap_key}?`),
    ...data.risks.slice(0, 5).map((risk) => `- What evidence would confirm or disconfirm ${risk.risk_name}?`),
  ];
  return questions.join("\n") || "- What additional primary-source evidence is required before action?";
}

function inferredSourceGaps(data: ResearchPackageData) {
  const gaps: Array<{ area: string; severity: string; description: string }> = [];
  if (data.sources.length < 3) {
    gaps.push({
      area: "source breadth",
      severity: "high",
      description: `Only ${data.sources.length} source document(s) recorded; investment-quality research needs filings, company IR, market data, peer/industry data, and macro or asset-specific context.`,
    });
  }
  if (!hasSource(data, ["investor", "ir", "earnings", "presentation", "transcript"])) {
    gaps.push({
      area: "company investor relations",
      severity: "high",
      description: "No company IR, earnings presentation, or transcript source is recorded.",
    });
  }
  if (!hasSource(data, ["peer", "industry", "sector", "fdic", "fred", "federal reserve"])) {
    gaps.push({
      area: "industry and peer context",
      severity: "medium",
      description: "No peer, industry, or macro source is recorded for benchmark and cycle context.",
    });
  }
  if (!data.scenarios.some((scenario) => numericLike(scenario.value_anchor))) {
    gaps.push({
      area: "valuation anchors",
      severity: "high",
      description: "No numeric scenario value anchors are populated, so upside/downside cannot be assessed.",
    });
  }
  if (!data.backtestArtifacts.length && data.backtests.length) {
    gaps.push({
      area: "backtest artifacts",
      severity: "medium",
      description: "Backtest run exists, but no artifact records are attached for metrics, equity curve, trades, or generated code.",
    });
  }
  if (data.evidence.length < 20) {
    gaps.push({
      area: "evidence depth",
      severity: "medium",
      description: `Only ${data.evidence.length} accepted evidence claim(s) are recorded; this is thin for a full research package.`,
    });
  }
  return gaps;
}

function hasSource(data: ResearchPackageData, keywords: string[]) {
  return data.sources.some((source) => {
    const text = `${source.source_type || ""} ${source.title || ""} ${source.publisher || ""} ${source.url || ""}`.toLowerCase();
    return keywords.some((keyword) => text.includes(keyword));
  });
}

function valuationLensRows(data: ResearchPackageData) {
  const required = Array.isArray(data.profile?.required_valuation_lenses_json)
    ? data.profile.required_valuation_lenses_json as string[]
    : [];
  const rows = required.length ? required : [data.profile?.profile_key || data.asset.asset_kind || "asset_specific"];
  return rows.map((lens) => {
    const hasSignal = data.signals.some((signal) => String(signal.lens_family || "").toLowerCase().includes(String(lens).toLowerCase()));
    return `| ${cell(lens)} | ${hasSignal ? "Use" : "Use, but incomplete"} | ${hasSignal ? "Signals exist for this lens." : "Required by profile, but signal coverage is thin or absent."} |`;
  });
}

function valuationDashboardConclusion(signals: Row[]) {
  if (!signals.length) return "No valuation dashboard generated.";
  const counts = signalCounts(signals);
  const cheap = (counts.very_cheap || 0) + (counts.cheap || 0);
  const expensive = (counts.expensive || 0) + (counts.very_expensive || 0);
  const inconclusive = (counts.inconclusive || 0) + (counts.indeterminate || 0) + (counts.not_applicable || 0);
  if (cheap > expensive && cheap > inconclusive) return `Skews cheap (${cheap} cheap signals vs ${expensive} expensive signals), subject to source quality.`;
  if (expensive > cheap) return `Skews expensive or risky (${expensive} expensive signals vs ${cheap} cheap signals).`;
  return `Mixed or inconclusive (${cheap} cheap, ${expensive} expensive, ${inconclusive} inconclusive/not applicable).`;
}

function valuationSignalSummary(signals: Row[]) {
  if (!signals.length) return "No valuation signals available.";
  const counts = signalCounts(signals);
  return [
    "| Signal bucket | Count |",
    "| --- | ---: |",
    ...Object.entries(counts).map(([bucket, count]) => `| ${cell(bucket)} | ${count} |`),
    "",
    `Strongest cheapness signal: ${signals.find((signal) => ["very_cheap", "cheap", "fair_to_mild_cheap"].includes(String(signal.signal)))?.signal_name || "Not established"}`,
    "",
    `Most important caution signal: ${signals.find((signal) => ["expensive", "very_expensive", "expensive_or_risky"].includes(String(signal.signal)))?.signal_name || "Not established"}`,
  ].join("\n");
}

function signalCounts(signals: Row[]) {
  return signals.reduce<Record<string, number>>((acc, signal) => {
    const key = String(signal.signal || "unknown");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function sourceIntelligenceSummary(data: ResearchPackageData) {
  const inferred = inferredSourceGaps(data);
  return [
    `Official/company sources recorded: ${data.sources.length}`,
    "",
    `Evidence claims: ${data.evidence.length}`,
    "",
    `Recorded source gaps: ${data.sourceGaps.length}`,
    "",
    `Inferred source gaps: ${inferred.length}`,
    "",
    inferred.map((gap) => `- ${gap.area}: ${gap.description}`).join("\n") || "- No inferred source gaps.",
  ].join("\n");
}

function backtestConclusion(backtests: Row[]) {
  if (!backtests.length) return "No backtest was run.";
  const lines = backtests.map((backtest) => {
    const metrics = asObject(backtest.metrics_json);
    const totalReturn = metricValue(metrics, "total_return");
    const benchmarkReturn = metricValue(metrics, "benchmark_total_return");
    const sharpe = metricValue(metrics, "sharpe", "sharpe_ratio");
    const maxDrawdown = metricValue(metrics, "max_drawdown");
    return `- ${backtest.strategy_name || backtest.name || backtest.id}: return ${percent(totalReturn)}, benchmark ${percent(benchmarkReturn)}, Sharpe ${formatNumber(sharpe)}, max drawdown ${percent(maxDrawdown)}.`;
  });
  return lines.join("\n");
}

function groupEvidenceByTopic(evidence: Row[]) {
  const topics: Record<string, string> = {};
  const topicKeywords: Record<string, string[]> = {
    demand: ["revenue", "member", "customer", "volume", "growth", "demand", "products"],
    competition: ["peer", "competition", "market share", "platform"],
    cost: ["margin", "cost", "deposit", "funding", "nim", "cash flow"],
    regulation: ["regulation", "regulatory", "sec", "capital", "cet1", "compliance"],
    cycle: ["credit", "cycle", "rate", "macro", "charge-off", "delinquency"],
  };
  for (const claim of evidence) {
    const text = String(claim.claim_text || "");
    const lower = text.toLowerCase();
    for (const [topic, keywords] of Object.entries(topicKeywords)) {
      if (!topics[topic] && keywords.some((keyword) => lower.includes(keyword))) {
        topics[topic] = text;
      }
    }
  }
  return topics;
}

function indicatorMetadataCsv(indicators: IndicatorCandidate[]) {
  return csv([
    ["id", "name", "family", "hypothesis", "source", "quality", "update_frequency", "backtestability", "lookahead_risk", "calculation", "use_case", "failure_case", "backtest_plan"],
    ...indicators.map((indicator) => [
      indicator.id,
      indicator.name,
      indicator.family,
      indicator.hypothesis,
      indicator.source,
      indicator.quality,
      indicator.updateFrequency,
      indicator.backtestability,
      indicator.lookaheadRisk,
      indicator.calculation,
      indicator.useCase,
      indicator.failureCase,
      indicator.backtestPlan,
    ]),
  ]);
}

function combinationsCsv(combinations: StrategyCombination[]) {
  return csv([
    ["id", "name", "indicators", "families", "hypothesis", "entry_rule", "exit_rule", "risk_control", "position_sizing", "regime"],
    ...combinations.map((combo) => [
      combo.id,
      combo.name,
      combo.indicators.join("; "),
      combo.families.join("; "),
      combo.hypothesis,
      combo.entryRule,
      combo.exitRule,
      combo.riskControl,
      combo.positionSizing,
      combo.regime,
    ]),
  ]);
}

function alignedResearchDatasetCsv(data: ResearchPackageData, indicators: IndicatorCandidate[]) {
  const rows: Array<Array<unknown>> = [
    ["record_type", "record_id", "name", "date", "value", "unit_or_signal", "source_or_provider", "confidence", "notes"],
  ];
  for (const metric of data.metrics) {
    rows.push([
      "metric",
      metric.id,
      metric.metric_display_name || metric.metric_key,
      formatDate(metric.period_end || metric.as_of_date),
      metric.value_numeric ?? metric.value_text ?? "",
      metric.unit || metric.currency || "",
      metric.data_provider || "",
      metric.confidence || "",
      metric.metric_category || "",
    ]);
  }
  for (const signal of data.signals) {
    rows.push([
      "valuation_signal",
      signal.id,
      signal.signal_name,
      formatDate(signal.created_at),
      signal.current_value ?? signal.current_value_text ?? "",
      signal.signal || "",
      signal.lens_family || "",
      signal.confidence || "",
      `cheapness_score=${signal.cheapness_score ?? ""}`,
    ]);
  }
  for (const indicator of indicators) {
    rows.push([
      "indicator_candidate",
      indicator.id,
      indicator.name,
      "",
      "",
      indicator.family,
      indicator.source,
      indicator.quality,
      indicator.hypothesis,
    ]);
  }
  return csv(rows);
}

function valuationDashboardCsv(signals: Row[]) {
  return csv([
    ["signal_key", "signal_name", "lens_family", "current_value", "current_value_text", "signal", "cheapness_score", "confidence", "comparison_range"],
    ...signals.map((signal) => [
      signal.signal_key || "",
      signal.signal_name || "",
      signal.lens_family || "",
      signal.current_value ?? "",
      signal.current_value_text || "",
      signal.signal || "",
      signal.cheapness_score ?? "",
      signal.confidence ?? "",
      stringifyBrief(signal.comparison_range_json),
    ]),
  ]);
}

function comboRankingsCsv(combinations: StrategyCombination[], backtests: Row[]) {
  return csv([
    ["rank", "combo_id", "strategy_name", "score", "backtest_status", "notes"],
    ...combinations.map((combo, index) => [
      String(index + 1),
      combo.id,
      combo.name,
      String(Math.max(0.1, 1 - index * 0.01).toFixed(2)),
      backtests.length ? "requires_mapping_to_backtest_run" : "not_tested",
      combo.hypothesis,
    ]),
  ]);
}

function backtestSummaryCsv(backtests: Row[]) {
  return csv([
    ["id", "name", "status", "total_return", "annualized_return", "volatility", "sharpe", "max_drawdown", "trade_count", "invested_days", "ending_equity", "benchmark_total_return"],
    ...backtests.map((backtest) => {
      const metrics = asObject(backtest.metrics_json);
      return [
        backtest.id,
        backtest.name || backtest.strategy_name || "Backtest",
        backtest.status || "",
        metricValue(metrics, "total_return") ?? "",
        metricValue(metrics, "annualized_return") ?? "",
        metricValue(metrics, "volatility") ?? "",
        metricValue(metrics, "sharpe", "sharpe_ratio") ?? "",
        metricValue(metrics, "max_drawdown") ?? "",
        metricValue(metrics, "trade_count") ?? "",
        metricValue(metrics, "invested_days") ?? "",
        metricValue(metrics, "ending_equity") ?? "",
        metricValue(metrics, "benchmark_total_return") ?? "",
      ];
    }),
  ]);
}

function backtestArtifactsCsv(artifacts: Row[]) {
  return csv([
    ["backtest_run_id", "artifact_type", "title", "storage_path", "mime_type", "metadata"],
    ...artifacts.map((artifact) => [
      artifact.backtest_run_id,
      artifact.artifact_type,
      artifact.title,
      artifact.storage_path,
      artifact.mime_type || "",
      stringifyBrief(artifact.metadata_json),
    ]),
  ]);
}

async function copyBacktestArtifacts(data: ResearchPackageData, absoluteDir: string) {
  const copied: Array<{ source_path: string; package_path: string }> = [];
  const appendFiles: Record<string, string[]> = {
    "data/backtest_outputs/equity_curves.csv": [],
    "data/backtest_outputs/trade_log.csv": [],
  };

  for (const artifact of data.backtestArtifacts) {
    const sourcePath = await storedBacktestFile(artifact.storage_path || "");
    // Missing or out-of-tree artifact files are still listed in backtest_artifacts.csv.
    if (!sourcePath) continue;
    const basename = String(artifact.title || "").toLowerCase();
    const artifactType = String(artifact.artifact_type || "").toLowerCase();
    if (artifactType === "equity_curve" || basename === "equity_curve.csv") {
      const content = await readTextIfExists(sourcePath);
      if (content) appendFiles["data/backtest_outputs/equity_curves.csv"].push(prefixCsvRows(content, artifact.backtest_run_id));
    }
    if (artifactType === "trades" || basename === "trades.csv") {
      const content = await readTextIfExists(sourcePath);
      if (content) appendFiles["data/backtest_outputs/trade_log.csv"].push(prefixCsvRows(content, artifact.backtest_run_id));
    }
    if (["metrics", "backtest_code", "runner_log"].includes(artifactType)) {
      const packagePath = `data/backtest_outputs/artifacts/${safeSlug(artifact.backtest_run_id || "backtest")}_${safeSlug(artifact.title || artifactType)}`;
      const targetPath = join(absoluteDir, packagePath);
      await mkdir(join(absoluteDir, "data", "backtest_outputs", "artifacts"), { recursive: true });
      try {
        await copyFile(sourcePath, targetPath);
        copied.push({ source_path: artifact.storage_path, package_path: packagePath });
      } catch {
        // Missing artifact files are still listed in backtest_artifacts.csv.
      }
    }
  }

  for (const [relativePath, chunks] of Object.entries(appendFiles)) {
    if (!chunks.length) continue;
    await writeFile(join(absoluteDir, relativePath), chunks.join("\n"), "utf8");
    copied.push({ source_path: "merged_backtest_artifacts", package_path: relativePath });
  }

  return copied;
}

/**
 * The real path of a stored backtest file, or null when it is missing or resolves, through
 * `..` or a symlink, outside storage/backtests. Backtest results name their own paths (S6).
 */
export async function storedBacktestFile(storagePath: string): Promise<string | null> {
  try {
    const root = await realpath(join(process.cwd(), "storage", "backtests"));
    const path = await realpath(resolve(process.cwd(), storagePath));
    return path.startsWith(root + sep) ? path : null;
  } catch {
    return null;
  }
}

async function readTextIfExists(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function prefixCsvRows(content: string, backtestRunId: string) {
  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return "";
  const [header, ...rows] = lines;
  return [`backtest_run_id,${header}`, ...rows.map((row) => `${csvEscape(backtestRunId)},${row}`)].join("\n");
}

function csv(rows: Array<Array<unknown>>) {
  return `${rows.map((row) => row.map((value) => csvEscape(value)).join(",")).join("\n")}\n`;
}

// Excel and Sheets evaluate a cell that starts with = + - @ tab or CR as a formula even when it
// is quoted, and these cells carry model and source text. Such a cell gets a leading ' unless it
// is a plain number (S7).
export function csvEscape(value: unknown) {
  const text = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(text) && !Number.isFinite(Number(text)) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function safeSlug(value: string) {
  return String(value || "asset").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function formatDate(value: unknown) {
  if (!value) return "n/a";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

function formatMetric(metric: Row) {
  if (metric.value_numeric !== null && metric.value_numeric !== undefined) {
    return `${metric.value_numeric}${metric.unit ? ` ${metric.unit}` : ""}${metric.currency && !metric.unit ? ` ${metric.currency}` : ""}`;
  }
  return metric.value_text || "n/a";
}

function formatCurrency(value: unknown, currency: unknown) {
  if (value === null || value === undefined || value === "") return "n/a";
  return `${value}${currency ? ` ${currency}` : ""}`;
}

function percent(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value ? String(value) : "n/a";
  const percentage = Math.abs(numeric) <= 1 ? numeric * 100 : numeric;
  return `${percentage.toFixed(1)}%`;
}

function cell(value: unknown) {
  return String(value ?? "n/a").replace(/\|/g, "\\|").replace(/\n/g, " ").trim() || "n/a";
}

function listValues(value: unknown) {
  return Array.isArray(value) && value.length ? value.join(", ") : "Not recorded";
}

function stringifyBrief(value: unknown) {
  if (!value) return "n/a";
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value);
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  } catch {
    return "n/a";
  }
}

function asObject(value: unknown): Row {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Row;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {};
    } catch {
      return {};
    }
  }
  return {};
}

function metricValue(metrics: Row, ...keys: string[]) {
  for (const key of keys) {
    if (metrics[key] !== null && metrics[key] !== undefined && metrics[key] !== "") return metrics[key];
  }
  return undefined;
}

function formatNumber(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value === null || value === undefined || value === "" ? "n/a" : String(value);
  if (Math.abs(numeric) >= 1000) return numeric.toFixed(2);
  return numeric.toFixed(3);
}

function numericLike(value: unknown) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function familyShort(value: string) {
  return value.replace(/\s*indicators\s*$/i, "").replace(/\/.*/, "").trim();
}

function dedupeBy<T>(rows: T[], keyFn: (row: T) => unknown): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const row of rows) {
    const key = String(keyFn(row) ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

function isPlaceholder(value: unknown) {
  const text = String(value || "").trim().toLowerCase();
  return text === "agent driver" || text === "system-identified driver" || text === "driver";
}
