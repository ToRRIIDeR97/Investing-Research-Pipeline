import { describe, it } from "node:test";
import assert from "node:assert";
import {
  validateSegmentModel,
  validateCustomerDecisionMap,
  validateBusinessProcessMap,
  validateBottleneckRegister,
  validateCompetitiveResponseMatrix,
} from "@/lib/research/business/validation";
import type {
  SegmentModel,
  CustomerDecisionMap,
  BusinessProcessMap,
  CompetitiveResponseMatrix,
} from "@/lib/research/business/contracts";

const uuid1 = "00000000-0000-0000-0000-000000000001";
const uuid2 = "00000000-0000-0000-0000-000000000002";

describe("business process and segment artifacts (Component 8)", () => {
  it("C8-T1: Segment has revenue description but no customer decision maker is rejected", () => {
    const model: SegmentModel = {
      artifact_type: "segment_model",
      segments: [
        {
          segment_name: "Commerce",
          product_or_service: "Marketplace auctions",
          customer_or_end_user: "", // empty customer/decision maker
          revenue_model: "Take rate on transactions",
          contract_structure: "Transactional",
          pricing_unit: "Per transaction",
          costs_and_reinvestment: "Hosting, customer support",
          working_capital_mechanics: "Favorable customer float",
          suppliers_or_complements: ["Cloud service providers"],
          competitors_or_substitutes: ["Traditional retail"],
          regulation: "Standard digital commerce rules",
          revenue_recognition_and_cash_conversion_chain: "Immediate recognition",
        },
      ],
    };
    const result = validateSegmentModel(model);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("lacks a customer decision maker")));
  });

  it("C8-T3: Marketplace model omits buyers, transactions, GMV, and take rate", () => {
    const model: SegmentModel = {
      artifact_type: "segment_model",
      segments: [
        {
          segment_name: "Marketplace Commerce",
          product_or_service: "E-commerce auctions",
          customer_or_end_user: "Consumers",
          revenue_model: "Take rate on transactions",
          contract_structure: "Transactional",
          pricing_unit: "Per transaction",
          costs_and_reinvestment: "Hosting, marketing",
          working_capital_mechanics: "Float",
          suppliers_or_complements: ["Sellers"],
          competitors_or_substitutes: ["Amazon"],
          regulation: "None",
          revenue_recognition_and_cash_conversion_chain: "Immediate",
          // omitted marketplace_details
        },
      ],
    };
    const result = validateSegmentModel(model);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("marketplace_details are missing")));
  });

  it("C8-T4: Lender model omits funding cost and credit losses", () => {
    const model: SegmentModel = {
      artifact_type: "segment_model",
      segments: [
        {
          segment_name: "Credit Lender",
          product_or_service: "Working capital loans",
          customer_or_end_user: "Merchants",
          revenue_model: "Interest income",
          contract_structure: "Loan agreement",
          pricing_unit: "Interest rate",
          costs_and_reinvestment: "Funding cost",
          working_capital_mechanics: "Lending book capital",
          suppliers_or_complements: ["Banks"],
          competitors_or_substitutes: ["Traditional banks"],
          regulation: "Fintech laws",
          revenue_recognition_and_cash_conversion_chain: "Accrued interest",
          // omitted lender_details
        },
      ],
    };
    const result = validateSegmentModel(model);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("lender_details are missing")));
  });

  it("C8-T5: Revenue and cash collection treated as simultaneous without evidence fails", () => {
    const map: BusinessProcessMap = {
      artifact_type: "business_process_map",
      process_nodes: [
        {
          process_node: "Order placement",
          starting_condition: "Customer orders",
          decision_maker: "Buyer",
          trigger: "Need product",
          economic_incentive: "Fast delivery",
          required_resources: ["Logistics"],
          main_constraint: "Warehouse space",
          downside_central_upside_outcomes: {
            downside: "Poor service",
            central: "Average service",
            upside: "Excellent service",
          },
          competitive_response: "Competitors copy",
          time_lag: "Simultaneous", // treats as simultaneous
          financial_line_affected: "Revenue",
          leading_indicator: "Orders",
          failure_condition: "System down",
          supporting_claim_ids: [uuid1], // only 1 supporting claim
          confidence: 0.8,
        },
      ],
    };
    const result = validateBusinessProcessMap(map);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("treats revenue and cash collection as simultaneous")));
  });

  it("C8-T6: Competitor loses share but no response is modeled fails", () => {
    const matrix: CompetitiveResponseMatrix = {
      artifact_type: "competitive_response_matrix",
      competitors: [
        {
          competitor_name: "Incumbent Co",
          market_share: 0.35,
          main_advantages: ["Scale", "Brand"],
          response_scenarios: [
            {
              scenario_name: "Price cut",
              threat_description: "Competitor cuts price 20%",
              response_mechanism: "Match price",
              time_to_response: "1 month",
              financial_impact: "-5% margin",
            },
            // missing scenario where competitor loses market share
          ],
        },
      ],
    };
    const result = validateCompetitiveResponseMatrix(matrix);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("no market share loss response scenario is modeled")));
  });

  it("C8-T7: Customer can multi-home warning is triggered if switching costs not addressed", () => {
    const map: CustomerDecisionMap = {
      artifact_type: "customer_decision_map",
      customer_groups: [
        {
          customer_group: "Enterprise Merchants",
          problem_initiating_demand: "Need reliable gateway",
          economic_value_or_roi: "Higher conversion rate",
          budget_owner: "CTO",
          alternatives: ["Adyen", "Stripe"],
          purchase_criteria: ["Reliability", "Pricing"],
          deployment_constraints: ["API integration"],
          renewal_replacement_or_repeat_purchase_mechanism: "Annual renewal",
          churn_or_cancellation_triggers: ["Outage"],
          switching_or_multihoming_path: "They multi-home across multiple gateways.", // multi-home mentioned but switching cost not addressed
          time_to_financial_effect: "1 month",
        },
      ],
    };
    const result = validateCustomerDecisionMap(map);
    assert.equal(result.valid, true);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes("multi-home but switching cost is not explicitly addressed"));
  });

  it("C8-T8: MELI process maps contain required process nodes", () => {
    const map: BusinessProcessMap = {
      artifact_type: "business_process_map",
      process_nodes: [
        {
          process_node: "Marketplace transaction",
          starting_condition: "Listing view",
          decision_maker: "Buyer",
          trigger: "Click buy",
          economic_incentive: "Convenience",
          required_resources: ["Platform"],
          main_constraint: "Buyer trust",
          downside_central_upside_outcomes: { downside: "Low sales", central: "Normal sales", upside: "High sales" },
          competitive_response: "Rebates",
          time_lag: "3 days",
          financial_line_affected: "GMV",
          leading_indicator: "Listing views",
          failure_condition: "Low inventory",
          supporting_claim_ids: [uuid1, uuid2],
          confidence: 0.9,
        },
        {
          process_node: "Payments processing",
          starting_condition: "Payment attempt",
          decision_maker: "Merchant",
          trigger: "Card swipe",
          economic_incentive: "Instant settlement",
          required_resources: ["Network"],
          main_constraint: "Acquirer uptime",
          downside_central_upside_outcomes: { downside: "Declined", central: "Approved", upside: "Loyalty point" },
          competitive_response: "Lower fee",
          time_lag: "1 day",
          financial_line_affected: "TPV",
          leading_indicator: "Active accounts",
          failure_condition: "Gateway failure",
          supporting_claim_ids: [uuid1, uuid2],
          confidence: 0.9,
        },
      ],
    };
    const result = validateBusinessProcessMap(map);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });
});
