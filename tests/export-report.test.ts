import { describe, it } from "node:test";
import assert from "node:assert";
import {
  generateV3MarkdownReport,
  V3ReportData,
} from "@/lib/export/v3-report-generator";

describe("v3 report export (Component 15)", () => {
  it("C15-T1: Accepted complete fixture renders all 25 canonical sections in order", () => {
    const data: V3ReportData = {
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
    };

    const report = generateV3MarkdownReport(data);

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
      "## 23. Confidence assessment",
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
    const data: V3ReportData = {
      runId: "run-123",
      asset: {
        canonical_name: "MercadoLibre",
        slug: "meli",
        asset_kind: "equity",
      },
      // genesis omitted
    };

    const report = generateV3MarkdownReport(data);
    assert.ok(report.includes("Incomplete Section"));
    assert.ok(report.includes("Missing Company Genesis"));
    assert.equal(report.includes("Galperin"), false); // no filler Marcos Galperin info
  });

  it("C15-T4: Price-target path with non-monotonic bear case renders accurately", () => {
    const data: V3ReportData = {
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

    const report = generateV3MarkdownReport(data);
    assert.ok(report.includes("2025 | bear | 80"));
    assert.ok(report.includes("2026 | bear | 70"));
    assert.ok(report.includes("2027 | bear | 90"));
  });
});
