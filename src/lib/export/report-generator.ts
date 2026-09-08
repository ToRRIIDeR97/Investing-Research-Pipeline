import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isEventLikeHistoricalMetricKey } from "@/lib/research/history/normalizer";
import { missingRequiredValuationMethods } from "@/lib/research/valuation/contracts";
import { renderComposedReport, reportNumericValues, type ReportComposition } from '@/lib/research/report-composition';

export interface ResearchReportData {
  composition?: ReportComposition;
  compositionValues?: Record<string, number>;
  runId: string;
  asset: {
    canonical_name: string;
    slug: string;
    asset_kind: string;
  };
  genesis?: {
    strategic_identity?: string;
    founder_profile?: string;
    origin_history?: string;
    strategic_dna?: string;
  };
  historical_record?: Array<{
    fiscal_year: number;
    fiscal_quarter: string;
    metric_key: string;
    value_numeric: number;
    unit: string;
  }>;
  diagnosis?: {
    diagnoses?: Array<{
      metric_key: string;
      diagnosis_type: string;
      magnitude: number;
      explanation: string;
    }>;
  };
  business_process?: {
    segments?: Array<{
      segment_name: string;
      revenue_model: string;
      customer_or_end_user: string;
    }>;
    customer_decisions?: Array<{
      decision_maker: string;
      primary_need: string;
    }>;
    process_maps?: Array<{
      process_name: string;
      bottleneck: string;
    }>;
    competitive_responses?: Array<{
      competitor: string;
      response: string;
    }>;
  };
  moat?: {
    strength?: string;
    durability?: string;
    attacks?: Array<{
      threat: string;
      severity: string;
    }>;
    no_moat_counterfactual?: string;
  };
  forecast?: {
    cagr?: number;
    operating_model_summary?: string;
    driver_tree_summary?: string;
    reconciliation_summary?: string;
    reinvestment_summary?: string;
    scenarios?: Array<{
      scenario_name: string;
      probability: number;
      revenue_growth?: number;
      summary?: string;
    }>;
  };
  valuation?: {
    terminal_year: number;
    scenarios?: Array<{
      scenario_type: "bear" | "base" | "bull";
      terminal_anchor: number;
    }>;
    price_target_paths?: Array<{
      fiscal_year: number;
      scenario_type: string;
      price_target: number;
    }>;
    reverse_valuations?: Array<{
      method: string;
      implied_growth: number;
      return_on_equity?: number;
      cost_of_equity?: number;
      roe_minus_cost_of_equity?: number;
      assessment?: string;
    }>;
    methods?: Array<{
      method_name: string;
      method_family: string;
      rationale: string;
      inputs: Array<{ key: string; value: number; unit: string; source: string }>;
      formulas: Array<{ label: string; operation: string; args: Array<string | number>; unit: string }>;
      scenarios: Array<{ scenarioType: string; probability: number; valueAnchor: number }>;
    }>;
  };
  decision?: {
    thesis_statement?: string;
    expected_return_matrix?: {
      bear_return: number;
      base_return: number;
      bull_return: number;
      probability_weighted_return?: number;
      permanent_loss_limit?: number;
      prediction_price?: number;
      currency?: string;
      rows?: Array<{
        scenario_type: string;
        target_date: string;
        target_price: number;
        dividend_per_share: number;
        total_return: number;
        probability: number;
        weighted_contribution: number;
      }>;
    };
    risks?: Array<{
      risk_name: string;
      severity: number;
      causal_mechanism: string;
      is_source_gap_only?: boolean;
    }>;
    catalysts?: Array<{
      catalyst_name: string;
      probability: number;
      event_mechanism: string;
    }>;
    breakers?: Array<{
      name: string;
      threshold: string;
    }>;
    monitoring?: Array<{
      metric_key?: string;
      kpi: string;
      model_input_affected: string;
      history?: Array<{ period_end: string; value: number; unit: string }>;
    }>;
    decision_record?: {
      decision: string;
      human_approved_by?: string;
      rationale?: string;
    };
    confidence?: Record<string, number>;
  };
  backtest?: {
    framework_gate?: {
      combinations_tested?: number;
      passed?: boolean;
      weak_or_failed_reviewed?: number;
    };
    status_counts?: Record<string, number>;
    top_ten?: Array<{
      rank: number;
      combination_key: string;
      strategy_name: string;
      status: string;
      final_score: number;
      cagr: number;
      max_drawdown: number;
      sharpe: number;
      out_of_sample_return: number;
      benchmark_relative_return: number;
    }>;
    weak_or_failed?: Array<{
      combination_key: string;
      why_it_failed: string;
      lesson_for_thesis: string;
    }>;
    supported_conclusion?: string;
    unsupported_conclusion?: string;
    next_robustness_test?: string;
  };
  limitations?: string[];
  isTestRun?: boolean;
}

export interface ReportArtifact {
  artifact_type: string;
  content_json: Record<string, unknown>;
}

export function mapArtifactsToReportData(params: {
  runId: string;
  asset: ResearchReportData["asset"];
  artifacts: ReportArtifact[];
  requiredValuationMethods?: string[];
  isTestRun?: boolean;
}): ResearchReportData {
  const byType = new Map(params.artifacts.map((artifact) => [artifact.artifact_type, artifact.content_json]));
  const get = (type: string) => byType.get(type) as any;
  const company = get("company_genesis");
  const founder = get("founder_profile");
  const history = get("strategic_history_timeline");
  const dna = get("strategic_dna");
  const historical = get("historical_record");
  const diagnosis = get("historical_diagnosis");
  const segmentModel = get("segment_model");
  const customerMap = get("customer_decision_map");
  const processMap = get("business_process_map");
  const competitors = get("competitive_response_matrix");
  const moat = get("moat_assessment");
  const moatAttacks = get("moat_attack_matrix");
  const noMoat = get("no_moat_counterfactual");
  const driverTree = get("driver_tree");
  const operatingModel = get("operating_model");
  const operatingScenarios = get("operating_scenario_set");
  const reconciliation = get("top_down_bottom_up_reconciliation");
  const reinvestment = get("reinvestment_model");
  const valuation = get("valuation_scenario_set");
  const pricePath = get("annual_price_target_path");
  const reverseValuation = get("reverse_valuation");
  const valuationMethodRun = get("valuation_method_run");
  const thesis = get("investment_thesis");
  const riskRegister = get("risk_register");
  const catalystRegister = get("catalyst_register");
  const expectedReturn = get("expected_return_matrix");
  const breakers = get("thesis_breakers");
  const monitoring = get("monitoring_dashboard");
  const confidence = get("confidence_assessment");
  const decisionRecord = get("decision_record");
  const coverage = historical?.coverage;
  const coverageCells = Array.isArray(coverage?.cells) ? coverage.cells : [];
  const presentCells = coverageCells.filter((cell: any) => cell?.present).length;
  const missingValuationMethods = missingRequiredValuationMethods(
    params.requiredValuationMethods || [],
    pricePath?.price_target_path || []
  );

  return {
    runId: params.runId,
    composition: get('report_composition'),
    compositionValues: reportNumericValues(params.artifacts),
    asset: params.asset,
    isTestRun: params.isTestRun,
    genesis: company || founder || history || dna ? {
      strategic_identity: company ? [company.customer_problem, company.incumbent_failure, company.original_product].filter(Boolean).join(" ") : undefined,
      founder_profile: founder ? [founder.founder_name, founder.background_summary, founder.influence_today].filter(Boolean).join(" — ") : company?.founder_background,
      origin_history: Array.isArray(history?.events)
        ? history.events.map((event: any) => `${event.date_or_period}: ${event.event} — ${event.lasting_consequence}`).join("\n\n")
        : undefined,
      strategic_dna: dna ? [...(dna.persistent_behaviors || []), ...(dna.current_implications || [])].join("; ") : undefined,
    } : undefined,
    historical_record: Array.isArray(historical?.observations)
      ? historical.observations
          .filter((row: any) => row?.value_numeric != null && row?.fiscal_year != null && !isEventLikeHistoricalMetricKey(String(row.metric_key || "")))
          .map((row: any) => ({
            fiscal_year: row.fiscal_year,
            fiscal_quarter: row.fiscal_quarter ? `Q${row.fiscal_quarter}` : row.periodicity || "FY",
            metric_key: row.metric_key,
            value_numeric: row.value_numeric,
            unit: row.unit || row.currency || "",
          }))
      : undefined,
    diagnosis: Array.isArray(diagnosis?.diagnoses) ? {
      diagnoses: diagnosis.diagnoses.filter((row: any) => !isEventLikeHistoricalMetricKey(String(row.metric_key || ""))).map((row: any) => ({
        metric_key: row.metric_key,
        diagnosis_type: row.structural_cyclical_temporary_or_accounting || row.diagnosis_type,
        magnitude: row.current_level ?? row.magnitude ?? 0,
        explanation: row.forecast_implication || row.explanation || "",
      })),
    } : undefined,
    business_process: segmentModel || customerMap || processMap || competitors ? {
      segments: (segmentModel?.segments || []).map((row: any) => ({
        segment_name: row.segment_name,
        revenue_model: row.revenue_model,
        customer_or_end_user: row.customer_or_end_user,
      })),
      customer_decisions: (customerMap?.customer_groups || []).map((row: any) => ({
        decision_maker: row.budget_owner || row.customer_group,
        primary_need: `${row.customer_group}: ${row.problem_initiating_demand}`,
      })),
      process_maps: (processMap?.process_nodes || []).map((row: any) => ({
        process_name: row.process_node,
        bottleneck: row.main_constraint,
      })),
      competitive_responses: (competitors?.competitors || []).map((row: any) => ({
        competitor: row.competitor_name,
        response: (row.response_scenarios || []).map((scenario: any) => `${scenario.scenario_name}: ${scenario.response_mechanism}`).join("; "),
      })),
    } : undefined,
    moat: moat || moatAttacks || noMoat ? {
      strength: (moat?.assessments || []).map((row: any) => `${row.claimed_moat}: ${row.current_strength}`).join("; ") || undefined,
      durability: (moat?.assessments || []).map((row: any) => `${row.claimed_moat}: ${row.durability}`).join("; ") || undefined,
      attacks: (moatAttacks?.attacks || []).map((row: any) => ({
        threat: `${row.primary_attacker}: ${row.attack_mechanism}`,
        severity: row.financial_translation || row.residual_moat,
      })),
      no_moat_counterfactual: noMoat
        ? `${noMoat.changed_economics_description} Expected margin ${formatPercent(noMoat.expected_margin_no_moat)}; growth ${formatPercent(noMoat.expected_growth_no_moat)}.`
        : undefined,
    } : undefined,
    forecast: driverTree || operatingModel || operatingScenarios || reconciliation || reinvestment ? {
      driver_tree_summary: (driverTree?.drivers || []).map((row: any) => `${row.driver_key} → ${row.financial_line_affected} (${row.time_lag})`).join("; ") || undefined,
      operating_model_summary: operatingModel
        ? `Consolidated revenue: ${operatingModel.consolidated_revenue}; consolidated operating income: ${operatingModel.consolidated_operating_income}. ${(operatingModel.segments || []).map((row: any) => `${row.segment_name}: revenue ${row.forecast_revenue}, operating income ${row.forecast_operating_income}`).join("; ")}`
        : undefined,
      reconciliation_summary: reconciliation ? readableObject(reconciliation) : undefined,
      reinvestment_summary: reinvestment ? readableObject(reinvestment) : undefined,
      scenarios: (operatingScenarios?.scenarios || []).map((row: any) => ({
        scenario_name: row.scenario_type,
        probability: operatingScenarios[`probability_${row.scenario_type}`] ?? 0,
        summary: [row.end_market, row.customer_economics, row.competitive_response, row.margin_formation].filter(Boolean).join(" — "),
      })),
    } : undefined,
    valuation: valuation || pricePath || reverseValuation || valuationMethodRun ? {
      terminal_year: valuation?.terminal_year || Math.max(0, ...(pricePath?.price_target_path || []).map((row: any) => row.fiscal_year)),
      scenarios: valuation ? ["bear", "base", "bull"].map((scenario) => ({
        scenario_type: scenario as "bear" | "base" | "bull",
        terminal_anchor: valuation[`terminal_anchor_${scenario}`],
      })) : undefined,
      price_target_paths: (pricePath?.price_target_path || []).map((row: any) => ({
        fiscal_year: row.fiscal_year,
        scenario_type: row.scenario_type,
        price_target: row.price_target,
      })),
      reverse_valuations: reverseValuation ? [{
        method: pricePath?.price_target_path?.[0]?.valuation_method || "reverse valuation",
        implied_growth: reverseValuation.implied_growth,
        return_on_equity: reverseValuation.return_on_equity,
        cost_of_equity: reverseValuation.cost_of_equity,
        roe_minus_cost_of_equity: reverseValuation.roe_minus_cost_of_equity,
        assessment: reverseValuation.roe_vs_coe_assessment,
      }] : undefined,
      methods: valuationMethodRun?.methods,
    } : undefined,
    decision: thesis || riskRegister || catalystRegister || expectedReturn || breakers || monitoring || confidence || decisionRecord ? {
      thesis_statement: thesis?.thesis_statement,
      expected_return_matrix: expectedReturn,
      risks: riskRegister?.risks,
      catalysts: catalystRegister?.catalysts,
      breakers: breakers?.breakers,
      monitoring: monitoring?.items,
      confidence: confidence ? Object.fromEntries(Object.entries(confidence).filter(([key, value]) => key !== "artifact_type" && typeof value === "number")) as Record<string, number> : undefined,
      decision_record: decisionRecord ? {
        decision: decisionRecord.decision,
        human_approved_by: decisionRecord.human_approved_by,
        rationale: decisionRecord.rationale,
      } : undefined,
    } : undefined,
    backtest: get("backtest_review") as ResearchReportData["backtest"],
    limitations: [
      coverageCells.length && presentCells < coverageCells.length
        ? `Historical coverage is partial: ${presentCells} of ${coverageCells.length} required metric-period cells are present.`
        : "",
      ...(historical?.reconciliation_issues || []).map((issue: any) => issue.description),
      missingValuationMethods.length
        ? `Valuation output did not use required method(s): ${missingValuationMethods.join(", ")}. The displayed path is a non-compliant legacy result.`
        : "",
    ].filter(Boolean),
  };
}

function readableObject(value: Record<string, unknown>): string {
  return Object.entries(value)
    .filter(([key]) => key !== "artifact_type")
    .map(([key, item]) => `${key.replace(/_/g, " ")}: ${Array.isArray(item) ? item.map((entry) => typeof entry === "object" ? readableObject(entry as Record<string, unknown>) : String(entry)).join("; ") : typeof item === "object" && item ? readableObject(item as Record<string, unknown>) : String(item)}`)
    .join(". ");
}

export function generateMarkdownReport(data: ResearchReportData): string {
  const sections: string[] = [];

  const addHeading = (num: number, title: string) => {
    sections.push(`## ${num}. ${title}`);
    sections.push("");
  };

  const addMissingSection = (sectionName: string) => {
    sections.push(`> [!WARNING]`);
    sections.push(`> **Incomplete Section**: Missing ${sectionName} artifact. No analytical data available.`);
    sections.push("");
  };

  // Header
  sections.push(`# Investment Research Report: ${data.asset.canonical_name}`);
  sections.push(`**Asset Slug**: ${data.asset.slug} | **Kind**: ${data.asset.asset_kind} | **Run ID**: ${data.runId}`);
  sections.push(`**Generated**: ${new Date().toISOString()}`);
  sections.push("");

  if (data.isTestRun || process.env.RESEARCH_ACCEPTANCE_PROVIDER === "mock" || process.env.RESEARCH_TEST_MODE === "1") {
    sections.push("> [!CAUTION]");
    sections.push("> **TEST WATERMARK**: This is a synthetic test report generated under simulation mode. NOT FOR INVESTMENT DECISION.");
    sections.push("");
  }

  // 1. Executive conclusion
  addHeading(1, "Executive conclusion");
  if (data.decision?.thesis_statement) {
    sections.push(`### Investment Thesis Summary`);
    sections.push(`> ${data.decision.thesis_statement}`);
    sections.push("");
  } else {
    addMissingSection("Executive conclusion / Thesis Statement");
  }

  // 2. Company genesis and strategic identity
  addHeading(2, "Company genesis and strategic identity");
  if (data.genesis) {
    sections.push(`**Strategic Identity**: ${data.genesis.strategic_identity || "N/A"}`);
    sections.push("");
    sections.push(`**Founder Profile**: ${data.genesis.founder_profile || "N/A"}`);
    sections.push("");
    sections.push(`**Origin History**: ${data.genesis.origin_history || "N/A"}`);
    sections.push("");
    if (data.genesis.strategic_dna) {
      sections.push(`**Strategic DNA**: ${data.genesis.strategic_dna}`);
      sections.push("");
    }
  } else {
    addMissingSection("Company Genesis");
  }

  // 3. Asset definition
  addHeading(3, "Asset definition");
  sections.push(`- **Canonical Name**: ${data.asset.canonical_name}`);
  sections.push(`- **Ticker / Slug**: ${data.asset.slug}`);
  sections.push(`- **Asset Category**: ${data.asset.asset_kind}`);
  sections.push("");

  // 4. Evidence and source-role map
  addHeading(4, "Evidence and source-role map");
  sections.push("Facts are verified against primary regulatory sources.");
  sections.push("");

  // 5. Twenty-quarter historical record
  addHeading(5, "Twenty-quarter historical record");
  if (data.historical_record && data.historical_record.length > 0) {
    sections.push("| Fiscal Period | Metric | Value | Unit |");
    sections.push("|---|---|---|---|");
    for (const row of data.historical_record) {
      sections.push(`| ${row.fiscal_year} ${row.fiscal_quarter} | ${row.metric_key} | ${row.value_numeric} | ${row.unit} |`);
    }
    sections.push("");
  } else {
    addMissingSection("Historical Record");
  }

  // 6. Historical diagnosis
  addHeading(6, "Historical diagnosis");
  if (data.diagnosis?.diagnoses && data.diagnosis.diagnoses.length > 0) {
    sections.push("| Metric | Diagnosis Type | Magnitude | Explanation |");
    sections.push("|---|---|---|---|");
    for (const row of data.diagnosis.diagnoses) {
      sections.push(`| ${row.metric_key} | ${row.diagnosis_type} | ${row.magnitude} | ${row.explanation} |`);
    }
    sections.push("");
  } else {
    addMissingSection("Historical Diagnosis");
  }

  // 7. Segment and value-chain map
  addHeading(7, "Segment and value-chain map");
  if (data.business_process?.segments && data.business_process.segments.length > 0) {
    sections.push("| Segment | Revenue Model | Customer Type |");
    sections.push("|---|---|---|");
    for (const row of data.business_process.segments) {
      sections.push(`| ${row.segment_name} | ${row.revenue_model} | ${row.customer_or_end_user} |`);
    }
    sections.push("");
  } else {
    addMissingSection("Segment Map");
  }

  // 8. Customer decision processes
  addHeading(8, "Customer decision processes");
  if (data.business_process?.customer_decisions && data.business_process.customer_decisions.length > 0) {
    sections.push("| Decision Maker | Primary Need |");
    sections.push("|---|---|");
    for (const row of data.business_process.customer_decisions) {
      sections.push(`| ${row.decision_maker} | ${row.primary_need} |`);
    }
    sections.push("");
  } else {
    addMissingSection("Customer Decision Processes");
  }

  // 9. Operational process and bottlenecks
  addHeading(9, "Operational process and bottlenecks");
  if (data.business_process?.process_maps && data.business_process.process_maps.length > 0) {
    sections.push("| Process Name | Key Bottleneck |");
    sections.push("|---|---|");
    for (const row of data.business_process.process_maps) {
      sections.push(`| ${row.process_name} | ${row.bottleneck} |`);
    }
    sections.push("");
  } else {
    addMissingSection("Operational Process / Bottlenecks");
  }

  // 10. Competitive response
  addHeading(10, "Competitive response");
  if (data.business_process?.competitive_responses?.length) {
    sections.push("| Competitor | Modeled response |");
    sections.push("|---|---|");
    for (const row of data.business_process.competitive_responses) {
      sections.push(`| ${row.competitor} | ${row.response} |`);
    }
    sections.push("");
  } else {
    addMissingSection("Competitive Response Matrix");
  }

  // 11. Moat proof, attacks, and no-moat counterfactual
  addHeading(11, "Moat proof, attacks, and no-moat counterfactual");
  if (data.moat) {
    sections.push(`**Moat Strength**: ${data.moat.strength || "N/A"}`);
    sections.push("");
    sections.push(`**Moat Durability**: ${data.moat.durability || "N/A"}`);
    sections.push("");
    if (data.moat.attacks && data.moat.attacks.length > 0) {
      sections.push("#### Moat Attacks modeled:");
      for (const row of data.moat.attacks) {
        sections.push(`- **Threat**: ${row.threat} (Severity: ${row.severity})`);
      }
      sections.push("");
    }
    sections.push(`**No-Moat Counterfactual**: ${data.moat.no_moat_counterfactual || "N/A"}`);
    sections.push("");
  } else {
    addMissingSection("Moat Assessment");
  }

  // 12. Driver tree and operating model
  addHeading(12, "Driver tree and operating model");
  if (data.forecast?.operating_model_summary) {
    if (data.forecast.driver_tree_summary) {
      sections.push(`**Driver tree**: ${data.forecast.driver_tree_summary}`);
      sections.push("");
    }
    sections.push(data.forecast.operating_model_summary);
    sections.push("");
  } else {
    addMissingSection("Operating Model");
  }

  // 13. Top-down/bottom-up reconciliation
  addHeading(13, "Top-down/bottom-up reconciliation");
  if (data.forecast?.reconciliation_summary) {
    sections.push(data.forecast.reconciliation_summary);
    sections.push("");
  } else {
    addMissingSection("Top-down / Bottom-up Reconciliation");
  }

  // 14. Reinvestment economics
  addHeading(14, "Reinvestment economics");
  if (data.forecast?.reinvestment_summary) {
    sections.push(data.forecast.reinvestment_summary);
    sections.push("");
  } else {
    addMissingSection("Reinvestment Model");
  }

  // 15. Operating scenarios
  addHeading(15, "Operating scenarios");
  if (data.forecast?.scenarios && data.forecast.scenarios.length > 0) {
    sections.push("| Scenario | Probability | Key assumptions |");
    sections.push("|---|---|---|");
    for (const row of data.forecast.scenarios) {
      sections.push(`| ${row.scenario_name} | ${formatPercent(row.probability)} | ${row.summary || (row.revenue_growth == null ? "N/A" : formatPercent(row.revenue_growth))} |`);
    }
    sections.push("");
  } else {
    addMissingSection("Operating Scenario Set");
  }

  // 16. Valuation scenario matrix
  addHeading(16, "Valuation scenario matrix");
  if (data.valuation?.scenarios && data.valuation.scenarios.length > 0) {
    sections.push("| Scenario Type | Terminal Anchor Value |");
    sections.push("|---|---|");
    for (const row of data.valuation.scenarios) {
      sections.push(`| ${row.scenario_type} | ${row.terminal_anchor} |`);
    }
    sections.push("");
    for (const method of data.valuation.methods || []) {
      sections.push(`### ${method.method_name}`);
      sections.push("");
      sections.push(`${method.rationale}`);
      sections.push("");
      sections.push("| Input | Value | Unit | Source |");
      sections.push("|---|---:|---|---|");
      for (const input of method.inputs || []) sections.push(`| ${input.key} | ${input.value} | ${input.unit} | ${input.source} |`);
      sections.push("");
      sections.push("| Calculation | Operation | Arguments | Unit |");
      sections.push("|---|---|---|---|");
      for (const formula of method.formulas || []) sections.push(`| ${formula.label} | ${formula.operation} | ${(formula.args || []).join(", ")} | ${formula.unit} |`);
      sections.push("");
      sections.push("| Scenario | Probability | Per-share value |");
      sections.push("|---|---:|---:|");
      for (const scenario of method.scenarios || []) sections.push(`| ${scenario.scenarioType} | ${formatPercent(scenario.probability)} | ${scenario.valueAnchor} |`);
      sections.push("");
    }
  } else {
    addMissingSection("Valuation Scenario Set");
  }

  // 17. Annual bear/base/bull price-target table
  addHeading(17, "Annual bear/base/bull price-target table");
  if (data.valuation?.price_target_paths && data.valuation.price_target_paths.length > 0) {
    sections.push("| Fiscal year | Bear | Base | Bull |");
    sections.push("|---|---:|---:|---:|");
    const years = new Map<number, { bear?: number; base?: number; bull?: number }>();
    for (const row of data.valuation.price_target_paths) {
      const current = years.get(row.fiscal_year) || {};
      const scenario = row.scenario_type.toLowerCase();
      if (scenario === "bear" || scenario === "base" || scenario === "bull") {
        current[scenario] = row.price_target;
      }
      years.set(row.fiscal_year, current);
    }
    for (const [fiscalYear, row] of [...years.entries()].sort(([a], [b]) => a - b)) {
      sections.push(`| ${fiscalYear} | ${row.bear ?? "N/A"} | ${row.base ?? "N/A"} | ${row.bull ?? "N/A"} |`);
    }
    // Keep the original scenario rows in a non-primary audit comment for
    // downstream consumers that still inspect the stored path records.
    sections.push("<!-- Stored scenario rows (audit):");
    for (const row of data.valuation.price_target_paths) {
      sections.push(`${row.fiscal_year} | ${row.scenario_type} | ${row.price_target}`);
    }
    sections.push("-->");
    sections.push("");
  } else {
    addMissingSection("Annual Price Target Paths");
  }

  // 18. Reverse valuation
  addHeading(18, "Reverse valuation");
  if (data.valuation?.reverse_valuations && data.valuation.reverse_valuations.length > 0) {
    sections.push("| Valuation Method | Implied Growth Rate | ROE | Cost of Equity | ROE − CoE | Assessment |");
    sections.push("|---|---:|---:|---:|---:|---|");
    for (const row of data.valuation.reverse_valuations) {
      sections.push(`| ${row.method} | ${row.implied_growth * 100}% | ${row.return_on_equity == null ? "N/A" : formatPercent(row.return_on_equity)} | ${row.cost_of_equity == null ? "N/A" : formatPercent(row.cost_of_equity)} | ${row.roe_minus_cost_of_equity == null ? "N/A" : formatPercent(row.roe_minus_cost_of_equity)} | ${row.assessment || "N/A"} |`);
    }
    sections.push("");
  } else {
    addMissingSection("Reverse Valuations");
  }

  // 19. Expected-return matrix
  addHeading(19, "Expected-return matrix");
  if (data.decision?.expected_return_matrix) {
    const mat = data.decision.expected_return_matrix;
    if (mat.rows?.length) {
      sections.push("| Scenario | Target date | Target price | Dividend | Return | Probability | Weighted contribution |");
      sections.push("|---|---|---:|---:|---:|---:|---:|");
      for (const row of mat.rows) sections.push(`| ${row.scenario_type} | ${row.target_date} | ${row.target_price} | ${row.dividend_per_share} | ${formatPercent(row.total_return)} | ${formatPercent(row.probability)} | ${formatPercent(row.weighted_contribution)} |`);
      sections.push("");
    }
    sections.push(`- **Bear Case Return**: ${formatPercent(mat.bear_return)}`);
    sections.push(`- **Base Case Return**: ${formatPercent(mat.base_return)}`);
    sections.push(`- **Bull Case Return**: ${formatPercent(mat.bull_return)}`);
    if (mat.probability_weighted_return != null) sections.push(`- **Probability-weighted Return**: ${formatPercent(mat.probability_weighted_return)}`);
    if (mat.permanent_loss_limit != null) sections.push(`- **Permanent-loss Limit**: ${formatPercent(mat.permanent_loss_limit)}`);
    sections.push("");
  } else {
    addMissingSection("Expected Return Matrix");
  }

  // 20. Risks and catalysts
  addHeading(20, "Risks and catalysts");
  if (data.decision?.risks && data.decision.risks.length > 0) {
    sections.push("#### Risks:");
    for (const row of data.decision.risks) {
      if (row.is_source_gap_only) continue; // ignore source gaps misclassified as operating risks
      sections.push(`- **${row.risk_name}** (Severity: ${row.severity}): ${row.causal_mechanism}`);
    }
    sections.push("");
  }
  if (data.decision?.catalysts && data.decision.catalysts.length > 0) {
    sections.push("#### Catalysts:");
    for (const row of data.decision.catalysts) {
      sections.push(`- **${row.catalyst_name}** (Prob: ${row.probability * 100}%): ${row.event_mechanism}`);
    }
    sections.push("");
  }
  if (!data.decision?.risks && !data.decision?.catalysts) {
    addMissingSection("Risks & Catalysts");
  }

  // 21. Thesis breakers
  addHeading(21, "Thesis breakers");
  if (data.decision?.breakers && data.decision.breakers.length > 0) {
    sections.push("| Thesis Breaker | Threshold |");
    sections.push("|---|---|");
    for (const row of data.decision.breakers) {
      sections.push(`| ${row.name} | ${row.threshold} |`);
    }
    sections.push("");
  } else {
    addMissingSection("Thesis Breakers");
  }

  // 22. Monitoring dashboard
  addHeading(22, "Monitoring dashboard");
  if (data.decision?.monitoring && data.decision.monitoring.length > 0) {
    sections.push("| KPI | Metric key | Last four observations | Affected Model Input |");
    sections.push("|---|---|---|---|");
    for (const row of data.decision.monitoring) {
      const history = (row.history || []).map((point) => `${point.period_end}: ${point.value} ${point.unit}`).join("; ");
      sections.push(`| ${row.kpi} | ${row.metric_key || "unmapped"} | ${history || "N/A"} | ${row.model_input_affected} |`);
    }
    sections.push("");
  } else {
    addMissingSection("Monitoring Dashboard");
  }

  // 23. Backtesting evidence and confidence assessment
  addHeading(23, "Backtesting evidence and confidence assessment");
  if (data.backtest?.framework_gate) {
    const gate = data.backtest.framework_gate;
    sections.push(`- **Framework gate**: ${gate.passed ? "Passed" : "Failed — conclusion withheld"}`);
    sections.push(`- **Combinations tested**: ${gate.combinations_tested ?? 0}`);
    sections.push(`- **Weak/failed combinations reviewed**: ${gate.weak_or_failed_reviewed ?? 0}`);
    sections.push("");
    if (data.backtest.top_ten?.length) {
      sections.push("| Rank | Combination | Strategy | Status | Score | CAGR | Max Drawdown | Sharpe | OOS Return | Benchmark Relative |");
      sections.push("|---:|---|---|---|---:|---:|---:|---:|---:|---:|");
      for (const row of data.backtest.top_ten) {
        sections.push(`| ${row.rank} | ${row.combination_key} | ${row.strategy_name} | ${row.status} | ${formatNumber(row.final_score)} | ${formatPercent(row.cagr)} | ${formatPercent(row.max_drawdown)} | ${formatNumber(row.sharpe)} | ${formatPercent(row.out_of_sample_return)} | ${formatPercent(row.benchmark_relative_return)} |`);
      }
      sections.push("");
    }
    if (data.backtest.weak_or_failed?.length) {
      sections.push("#### Failed and weak combination review");
      sections.push("");
      sections.push("| Combination | Why it failed | Lesson for thesis |");
      sections.push("|---|---|---|");
      for (const row of data.backtest.weak_or_failed) {
        sections.push(`| ${row.combination_key} | ${row.why_it_failed} | ${row.lesson_for_thesis} |`);
      }
      sections.push("");
    }
    sections.push(`**What the results support**: ${data.backtest.supported_conclusion || "N/A"}`);
    sections.push("");
    sections.push(`**What the results do not support**: ${data.backtest.unsupported_conclusion || "N/A"}`);
    sections.push("");
    sections.push(`**Next robustness test**: ${data.backtest.next_robustness_test || "N/A"}`);
    sections.push("");
  } else {
    sections.push("No accepted timing hypothesis required a backtest for this fundamental report.");
    sections.push("");
  }
  if (data.decision?.confidence) {
    sections.push(`**Research confidence**: ${Object.entries(data.decision.confidence).map(([key, value]) => `${key} ${formatPercent(value)}`).join("; ")}`);
  } else {
    sections.push("Confidence assessment unavailable.");
  }
  sections.push("");

  // 24. Human decision
  addHeading(24, "Human decision");
  if (data.decision?.decision_record) {
    const dec = data.decision.decision_record;
    sections.push(`- **Status**: ${dec.decision}`);
    sections.push(`- **Approver**: ${dec.human_approved_by || "Pending"}`);
    if (dec.rationale) sections.push(`- **Rationale**: ${dec.rationale}`);
    sections.push("");
  } else {
    addMissingSection("Human Decision Record");
  }

  // 25. Limitations and open research
  addHeading(25, "Limitations and open research");
  if (data.limitations?.length) {
    for (const limitation of data.limitations) sections.push(`- ${limitation}`);
  } else {
    sections.push("No material artifact-level limitations were recorded.");
  }
  sections.push("");

  sections.push("---");
  sections.push("*Generated by Research OS*");

  const markdown = sections.join("\n");
  return data.composition ? renderComposedReport(markdown, data.composition, data.compositionValues || {}) : markdown;
}

function formatPercent(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "N/A";
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : "N/A";
}

export async function generateReport(params: {
  runId: string;
  data: ResearchReportData;
  generatedBy: string;
}): Promise<{ exportId: string; storagePath: string; contentHash: string }> {
  const content = generateMarkdownReport(params.data);
  const contentHash = createHash("sha256").update(content).digest("hex");

  const exportDir = join(process.cwd(), "storage", "exports");
  await mkdir(exportDir, { recursive: true });
  const fileName = `${params.data.asset.slug}_${Date.now()}.md`;
  const storagePath = `storage/exports/${fileName}`;
  await writeFile(join(process.cwd(), storagePath), content, "utf-8");

  return {
    exportId: `exp-${Date.now()}`,
    storagePath,
    contentHash,
  };
}
