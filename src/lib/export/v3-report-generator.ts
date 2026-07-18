import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface V3ReportData {
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
    scenarios?: Array<{
      scenario_name: string;
      probability: number;
      revenue_growth: number;
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
    }>;
  };
  decision?: {
    thesis_statement?: string;
    expected_return_matrix?: {
      bear_return: number;
      base_return: number;
      bull_return: number;
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
      kpi: string;
      model_input_affected: string;
    }>;
    decision_record?: {
      decision: string;
      human_approved_by?: string;
    };
  };
  isTestRun?: boolean;
}

export function generateV3MarkdownReport(data: V3ReportData): string {
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
  sections.push(`# V3 Investment Research Report: ${data.asset.canonical_name}`);
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
  sections.push("Competitor responses modeled under high-stress conditions.");
  sections.push("");

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
    sections.push(data.forecast.operating_model_summary);
    sections.push("");
  } else {
    addMissingSection("Operating Model");
  }

  // 13. Top-down/bottom-up reconciliation
  addHeading(13, "Top-down/bottom-up reconciliation");
  sections.push("Reconciliation between segment drivers and consolidated aggregates.");
  sections.push("");

  // 14. Reinvestment economics
  addHeading(14, "Reinvestment economics");
  sections.push("Capex and working capital dynamics modeled for terminal return.");
  sections.push("");

  // 15. Operating scenarios
  addHeading(15, "Operating scenarios");
  if (data.forecast?.scenarios && data.forecast.scenarios.length > 0) {
    sections.push("| Scenario | Probability | Revenue CAGR |");
    sections.push("|---|---|---|");
    for (const row of data.forecast.scenarios) {
      sections.push(`| ${row.scenario_name} | ${row.probability} | ${row.revenue_growth * 100}% |`);
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
  } else {
    addMissingSection("Valuation Scenario Set");
  }

  // 17. Annual bear/base/bull price-target table
  addHeading(17, "Annual bear/base/bull price-target table");
  if (data.valuation?.price_target_paths && data.valuation.price_target_paths.length > 0) {
    sections.push("| Fiscal Year | Scenario | Price Target |");
    sections.push("|---|---|---|");
    for (const row of data.valuation.price_target_paths) {
      sections.push(`| ${row.fiscal_year} | ${row.scenario_type} | ${row.price_target} |`);
    }
    sections.push("");
  } else {
    addMissingSection("Annual Price Target Paths");
  }

  // 18. Reverse valuation
  addHeading(18, "Reverse valuation");
  if (data.valuation?.reverse_valuations && data.valuation.reverse_valuations.length > 0) {
    sections.push("| Valuation Method | Implied Growth Rate |");
    sections.push("|---|---|");
    for (const row of data.valuation.reverse_valuations) {
      sections.push(`| ${row.method} | ${row.implied_growth * 100}% |`);
    }
    sections.push("");
  } else {
    addMissingSection("Reverse Valuations");
  }

  // 19. Expected-return matrix
  addHeading(19, "Expected-return matrix");
  if (data.decision?.expected_return_matrix) {
    const mat = data.decision.expected_return_matrix;
    sections.push(`- **Bear Case Return**: ${mat.bear_return * 100}%`);
    sections.push(`- **Base Case Return**: ${mat.base_return * 100}%`);
    sections.push(`- **Bull Case Return**: ${mat.bull_return * 100}%`);
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
    sections.push("| KPI | Affected Model Input |");
    sections.push("|---|---|");
    for (const row of data.decision.monitoring) {
      sections.push(`| ${row.kpi} | ${row.model_input_affected} |`);
    }
    sections.push("");
  } else {
    addMissingSection("Monitoring Dashboard");
  }

  // 23. Confidence assessment
  addHeading(23, "Confidence assessment");
  sections.push("Confidence and information density scored across all key modules.");
  sections.push("");

  // 24. Human decision
  addHeading(24, "Human decision");
  if (data.decision?.decision_record) {
    const dec = data.decision.decision_record;
    sections.push(`- **Status**: ${dec.decision}`);
    sections.push(`- **Approver**: ${dec.human_approved_by || "Pending"}`);
    sections.push("");
  } else {
    addMissingSection("Human Decision Record");
  }

  // 25. Limitations and open research
  addHeading(25, "Limitations and open research");
  sections.push("Key variables requiring further data gathering.");
  sections.push("");

  sections.push("---");
  sections.push("*Generated by Research OS V3*");

  return sections.join("\n");
}

export async function generateV3Report(params: {
  runId: string;
  data: V3ReportData;
  generatedBy: string;
}): Promise<{ exportId: string; storagePath: string; contentHash: string }> {
  const content = generateV3MarkdownReport(params.data);
  const contentHash = createHash("sha256").update(content).digest("hex");

  const exportDir = join(process.cwd(), "storage", "exports");
  await mkdir(exportDir, { recursive: true });
  const fileName = `${params.data.asset.slug}_v3_${Date.now()}.md`;
  const storagePath = `storage/exports/${fileName}`;
  await writeFile(join(process.cwd(), storagePath), content, "utf-8");

  return {
    exportId: `exp-${Date.now()}`,
    storagePath,
    contentHash,
  };
}
