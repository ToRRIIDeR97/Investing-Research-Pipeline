import { describe, it } from "node:test";
import assert from "node:assert";
import {
  generateMarkdownReport,
  mapArtifactsToReportData,
  ResearchReportData,
} from "@/lib/export/report-generator";

describe("v3 report export (Component 15)", () => {
  it("C15-T1: Accepted complete fixture renders all 25 canonical sections in order", () => {
    const data: ResearchReportData = {
      runId: "run-123",
      asset: {
        canonical_name: "MercadoLibre",
        slug: "meli",
        asset_kind: "equity",
      },
      genesis: {
        strategic_identity: "E-commerce platform",
        founder_profile: "Marcos Galperin",
        origin_history: "Founded in 1999",
      },
      historical_record: [
        { fiscal_year: 2024, fiscal_quarter: "Q1", metric_key: "revenue", value_numeric: 4300, unit: "USD" },
      ],
      diagnosis: {
        diagnoses: [
          { metric_key: "revenue", diagnosis_type: "structural", magnitude: 0.15, explanation: "Continued penetration" },
        ],
      },
      business_process: {
        segments: [
          { segment_name: "Commerce", revenue_model: "Take rate", customer_or_end_user: "Consumers" },
        ],
        customer_decisions: [
          { decision_maker: "Consumer", primary_need: "Fast shipping" },
        ],
        process_maps: [
          { process_name: "Fulfillment", bottleneck: "Warehouse capacity" },
        ],
      },
      moat: {
        strength: "strong",
        durability: "high",
        attacks: [
          { threat: "Amazon expansion", severity: "high" },
        ],
        no_moat_counterfactual: "Low margins",
      },
      forecast: {
        cagr: 0.25,
        operating_model_summary: "Robust commerce driver model",
        scenarios: [
          { scenario_name: "base", probability: 0.6, revenue_growth: 0.25 },
        ],
      },
      valuation: {
        terminal_year: 2028,
        scenarios: [
          { scenario_type: "base", terminal_anchor: 1500 },
        ],
        price_target_paths: [
          { fiscal_year: 2025, scenario_type: "base", price_target: 1600 },
        ],
        reverse_valuations: [
          { method: "reverse DCF", implied_growth: 0.18 },
        ],
      },
      decision: {
        thesis_statement: "MELI will grow due to e-commerce and fintech dominance.",
        expected_return_matrix: {
          bear_return: -0.1,
          base_return: 0.2,
          bull_return: 0.4,
        },
        risks: [
          { risk_name: "Regulatory risk", severity: 2, causal_mechanism: "Increased regulation of fintech take rates" },
        ],
        catalysts: [
          { catalyst_name: "Fulfillment center expansion", probability: 0.8, event_mechanism: "Increases delivery speeds" },
        ],
        breakers: [
          { name: "Fintech take rate < 3%", threshold: "3%" },
        ],
        monitoring: [
          { kpi: "Take rate", model_input_affected: "fintech_take_rate" },
        ],
        decision_record: {
          decision: "approve",
          human_approved_by: "John Doe",
        },
      },
      backtest: {
        framework_gate: {
          combinations_tested: 50,
          passed: true,
          weak_or_failed_reviewed: 5,
        },
        top_ten: [{
          rank: 1,
          combination_key: "COMBO-001",
          strategy_name: "Price confirmation",
          status: "Promising",
          final_score: 0.42,
          cagr: 0.14,
          max_drawdown: -0.22,
          sharpe: 0.8,
          out_of_sample_return: 0.06,
          benchmark_relative_return: 0.03,
        }],
        weak_or_failed: [{
          combination_key: "COMBO-050",
          why_it_failed: "Negative out-of-sample return.",
          lesson_for_thesis: "The signal did not generalize.",
        }],
        supported_conclusion: "Useful timing evidence.",
        unsupported_conclusion: "Does not prove the fundamental thesis.",
        next_robustness_test: "Add release-date fundamental history.",
      },
    };

    const report = generateMarkdownReport(data);

    // Verify all canonical headings exist and are in order
    const headings = [
      "## 1. Executive conclusion",
      "## 2. Company genesis and strategic identity",
      "## 3. Asset definition",
      "## 4. Evidence and source-role map",
      "## 5. Twenty-quarter historical record",
      "## 6. Historical diagnosis",
      "## 7. Segment and value-chain map",
      "## 8. Customer decision processes",
      "## 9. Operational process and bottlenecks",
      "## 10. Competitive response",
      "## 11. Moat proof, attacks, and no-moat counterfactual",
      "## 12. Driver tree and operating model",
      "## 13. Top-down/bottom-up reconciliation",
      "## 14. Reinvestment economics",
      "## 15. Operating scenarios",
      "## 16. Valuation scenario matrix",
      "## 17. Annual bear/base/bull price-target table",
      "## 18. Reverse valuation",
      "## 19. Expected-return matrix",
      "## 20. Risks and catalysts",
      "## 21. Thesis breakers",
      "## 22. Monitoring dashboard",
      "## 23. Backtesting evidence and confidence assessment",
      "## 24. Human decision",
      "## 25. Limitations and open research",
    ];

    let lastIndex = -1;
    for (const h of headings) {
      const index = report.indexOf(h);
      assert.ok(index !== -1, `Heading not found: ${h}`);
      assert.ok(index > lastIndex, `Heading out of order: ${h}`);
      lastIndex = index;
    }
  });

  it("C15-T2: Missing genesis artifact displays a visible incomplete section and no filler", () => {
    const data: ResearchReportData = {
      runId: "run-123",
      asset: {
        canonical_name: "MercadoLibre",
        slug: "meli",
        asset_kind: "equity",
      },
      // genesis omitted
    };

    const report = generateMarkdownReport(data);
    assert.ok(report.includes("Incomplete Section"));
    assert.ok(report.includes("Missing Company Genesis"));
    assert.equal(report.includes("Galperin"), false); // no filler Marcos Galperin info
  });

  it("C15-T4: Price-target path with non-monotonic bear case renders accurately", () => {
    const data: ResearchReportData = {
      runId: "run-123",
      asset: {
        canonical_name: "MercadoLibre",
        slug: "meli",
        asset_kind: "equity",
      },
      valuation: {
        terminal_year: 2027,
        price_target_paths: [
          { fiscal_year: 2025, scenario_type: "bear", price_target: 80 },
          { fiscal_year: 2026, scenario_type: "bear", price_target: 70 }, // non-monotonic (declining)
          { fiscal_year: 2027, scenario_type: "bear", price_target: 90 }, // recovering
        ],
      },
    };

    const report = generateMarkdownReport(data);
    assert.ok(report.includes("2025 | bear | 80"));
    assert.ok(report.includes("2026 | bear | 70"));
    assert.ok(report.includes("2027 | bear | 90"));
  });

  it("maps persisted v3 artifact shapes into the canonical report", () => {
    const data = mapArtifactsToReportData({
      runId: "run-actual-shapes",
      asset: { canonical_name: "SoFi", slug: "sofi", asset_kind: "equity" },
      requiredValuationMethods: ["residual_income"],
      artifacts: [
        { artifact_type: "company_genesis", content_json: { customer_problem: "Expensive fragmented finance.", incumbent_failure: "Legacy banks were slow.", original_product: "Student-loan refinancing." } },
        { artifact_type: "founder_profile", content_json: { founder_name: "Founding team", background_summary: "Built a digital lender.", influence_today: "Member-first strategy." } },
        { artifact_type: "historical_record", content_json: { observations: [{ fiscal_year: 2025, fiscal_quarter: 2, metric_key: "revenue", value_numeric: 900, unit: "USDm" }], coverage: { cells: [{ present: true }, { present: false }] }, reconciliation_issues: [] } },
        { artifact_type: "segment_model", content_json: { segments: [{ segment_name: "Lending", revenue_model: "Net interest income", customer_or_end_user: "Members" }] } },
        { artifact_type: "customer_decision_map", content_json: { customer_groups: [{ customer_group: "Borrowers", budget_owner: "Household", problem_initiating_demand: "Refinancing" }] } },
        { artifact_type: "business_process_map", content_json: { process_nodes: [{ process_node: "Underwriting", main_constraint: "Credit quality" }] } },
        { artifact_type: "moat_assessment", content_json: { assessments: [{ claimed_moat: "Member data", current_strength: "moderate", durability: "medium" }] } },
        { artifact_type: "no_moat_counterfactual", content_json: { changed_economics_description: "Pricing compresses.", expected_margin_no_moat: 0.1, expected_growth_no_moat: 0.05 } },
        { artifact_type: "operating_model", content_json: { consolidated_revenue: 1000, consolidated_operating_income: 200, segments: [{ segment_name: "Lending", forecast_revenue: 700, forecast_operating_income: 150 }] } },
        { artifact_type: "operating_scenario_set", content_json: { probability_bear: 0.2, probability_base: 0.6, probability_bull: 0.2, scenarios: [{ scenario_type: "bear", end_market: "recession", customer_economics: "weaker", competitive_response: "price cuts", margin_formation: "compression" }, { scenario_type: "base", end_market: "steady", customer_economics: "stable", competitive_response: "rational", margin_formation: "expansion" }, { scenario_type: "bull", end_market: "strong", customer_economics: "better", competitive_response: "limited", margin_formation: "scale" }] } },
        { artifact_type: "valuation_scenario_set", content_json: { terminal_year: 2030, terminal_anchor_bear: 9, terminal_anchor_base: 15, terminal_anchor_bull: 22 } },
        { artifact_type: "annual_price_target_path", content_json: { price_target_path: [{ fiscal_year: 2027, scenario_type: "base", valuation_method: "residual_income", price_target: 18 }] } },
        { artifact_type: "reverse_valuation", content_json: { implied_growth: 0.12, implied_margin: 0.2 } },
        { artifact_type: "investment_thesis", content_json: { thesis_statement: "Scale can improve returns if credit remains controlled." } },
        { artifact_type: "expected_return_matrix", content_json: { bear_return: -0.3, base_return: 0.2, bull_return: 0.6, probability_weighted_return: 0.18, permanent_loss_limit: -0.4 } },
        { artifact_type: "thesis_breakers", content_json: { breakers: [{ name: "Credit loss spike", threshold: "> 5%" }] } },
        { artifact_type: "monitoring_dashboard", content_json: { items: [{ kpi: "Net charge-offs", model_input_affected: "credit_losses" }] } },
      ],
    });

    const report = generateMarkdownReport(data);
    assert.ok(report.includes("Expensive fragmented finance."));
    assert.ok(report.includes("2025 Q2 | revenue | 900 | USDm"));
    assert.ok(report.includes("| base | 60.0% |"));
    assert.ok(report.includes("| 2027 | N/A | 18 | N/A |"));
    assert.ok(report.includes("residual_income"));
    assert.ok(report.includes("Credit loss spike"));
    assert.ok(report.includes("Net charge-offs"));
    assert.ok(report.includes("Historical coverage is partial: 1 of 2"));
    assert.equal(report.includes("[object Object]"), false);
    assert.equal(report.includes('{"'), false);
  });
});
