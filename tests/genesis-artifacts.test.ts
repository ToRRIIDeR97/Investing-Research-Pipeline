import { describe, it } from "node:test";
import assert from "node:assert";
import {
  validateGenesisArtifact,
  validateFounderProfile,
  validateStrategicHistoryTimeline,
} from "@/lib/research/genesis/validation";
import type { EvidenceWeight, HistoricalClaim } from "@/lib/research/genesis/contracts";

describe("company genesis artifacts", () => {
  const claimIds = ["00000000-0000-0000-0000-000000000001"];

  const baseGenesis = () => ({
    artifact_type: "company_genesis" as const,
    pre_founding_environment: "Latin American e-commerce was fragmented.",
    customer_problem: "No trusted online marketplace for sellers and buyers.",
    incumbent_failure: "Traditional classifieds lacked payments and logistics.",
    enabling_change: "Internet penetration and payment digitization.",
    founder_background: "Marcos Galperin founded the company from Stanford MBA.",
    founder_motivations: [
      { motivation: "commercial_opportunity" as const, evidence_claim_ids: claimIds, confidence: 0.8 },
    ],
    alternative_motivation_interpretations: ["Could also be mission-driven."],
    original_product: "Online auction site.",
    original_customer: "Small merchants and consumers in Argentina.",
    original_geography: "Argentina",
    original_revenue_model: "Transaction fees and advertising.",
    initial_funding: "Seed funding from family and investors.",
    early_constraints: "Currency volatility and low credit-card penetration.",
    first_proof_point: "Early marketplace traction in Argentina.",
    present_day_implications: ["The company retains a marketplace-plus-payments DNA."],
    material_claims: [
      {
        claim: "Founder identified a commercial opportunity.",
        evidence_weight: "contemporary_direct_founder_statement" as EvidenceWeight,
        evidence_claim_ids: claimIds,
        confidence: 0.8,
      },
    ] as HistoricalClaim[],
  });

  it("C5-T1: Direct contemporary founder quote supports motivation", () => {
    const result = validateGenesisArtifact(baseGenesis());
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it("C5-T2: Only a recent corporate biography supports motivation", () => {
    const genesis = baseGenesis();
    genesis.material_claims[0].evidence_weight = "later_retrospective_founder_statement";
    const result = validateGenesisArtifact(genesis);
    assert.equal(result.valid, true);
    assert.equal(result.warnings.length, 0);
  });

  it("C5-T3: Agent asserts founder wanted wealth without evidence", () => {
    const genesis = baseGenesis();
    genesis.founder_motivations[0].evidence_claim_ids = [];
    const result = validateGenesisArtifact(genesis);
    assert.equal(result.valid, false);
  });

  it("C5-T4: Conflicting founder accounts both preserved", () => {
    const genesis = baseGenesis();
    genesis.material_claims.push({
      claim: "Founder later described the mission as democratizing commerce.",
      evidence_weight: "later_retrospective_founder_statement",
      evidence_claim_ids: ["00000000-0000-0000-0000-000000000002"],
      confidence: 0.6,
      alternative_interpretations: ["Retrospective myth-making possible."],
      contradictions: ["Contemporary statements emphasized commercial opportunity."],
    });
    const result = validateGenesisArtifact(genesis);
    assert.equal(result.valid, true);
  });

  it("C5-T5: Original business differs from current business records pivot", () => {
    const timeline = {
      artifact_type: "strategic_history_timeline" as const,
      events: [
        {
          date_or_period: "1999",
          event: "Launch as online auction site.",
          objective_at_the_time: "Build a Latin American eBay.",
          decision: "Create MercadoLibre auction marketplace.",
          evidence_claim_ids: claimIds,
          immediate_effect: "Sellers and buyers adopted the platform.",
          lasting_consequence: "Marketplace foundation remains.",
          strategy_changed: true,
          mission_changed: false,
          confidence: 0.9,
        },
      ],
      major_pivots: ["Added payments, credit, logistics, and advertising."],
    };
    const result = validateStrategicHistoryTimeline(timeline);
    assert.equal(result.valid, true);
  });

  it("C5-T6: Timeline event lacks a date and evidence is not accepted", () => {
    const timeline = {
      artifact_type: "strategic_history_timeline" as const,
      events: [
        {
          date_or_period: "",
          event: "Some pivot.",
          objective_at_the_time: "unknown",
          decision: "unknown",
          evidence_claim_ids: [],
          immediate_effect: "unknown",
          lasting_consequence: "unknown",
          strategy_changed: true,
          mission_changed: true,
          confidence: 0.5,
        },
      ],
      major_pivots: ["pivot"],
    };
    const result = validateStrategicHistoryTimeline(timeline);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it("C5-T7: Genesis artifact with biography but no current implication fails", () => {
    const genesis = baseGenesis();
    genesis.present_day_implications = [];
    const result = validateGenesisArtifact(genesis);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });
});

describe("founder profile validation", () => {
  const claimIds = ["00000000-0000-0000-0000-000000000001"];

  it("C5-T3: Founder wealth assertion without evidence fails", () => {
    const profile = {
      artifact_type: "founder_profile" as const,
      founder_name: "Founder",
      background_summary: "Background.",
      motivations: [
        { motivation: "financial_ambition" as const, evidence_claim_ids: [], confidence: 0.9 },
      ],
      alternative_interpretations: ["Other motivations possible."],
      control_evolution: "Maintained control.",
      influence_today: "Still influential.",
    };
    const result = validateFounderProfile(profile);
    assert.equal(result.valid, false);
  });
});
