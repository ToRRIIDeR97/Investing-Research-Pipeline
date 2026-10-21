import { describe, it } from "node:test";
import assert from "node:assert";
import {
  validateMoatAssessment,
  validateMoatAttackMatrix,
  validateNoMoatCounterfactual,
  capMoatClassifications,
  attackTargetErrors,
} from "@/lib/research/moat/validation";
import type {
  MoatAssessment,
  MoatAttackMatrix,
  NoMoatCounterfactual,
} from "@/lib/research/moat/contracts";

const SCORED = {
  classification: "moderate" as const, supporting_claim_ids: [], artifact_paths: [],
  scores: { current_strength: 3, breadth_across_revenue: 3, replication_difficulty: 3, pricing_power: 3, attack_resistance: 3, expected_durability: 3 },
};

describe("moat proof and attack artifacts (Component 9)", () => {
  it("a strong moat must cite stored history, a peer in a complete benchmark and a run claim, or it is capped at moderate", () => {
    type Entry = { claimed_moat: string; classification: string; artifact_paths: string[]; supporting_claim_ids?: string[]; classification_note?: string };
    const claim = "6f9619ff-8b86-4d11-b42d-00c04fc964ff";
    const stored = { financial_analytics: { segments: { quarterly: { columns: ["period", "operating_margin"], rows: [] } } },
      peer_benchmark: { status: "complete", peers: [{ ticker: "GOOGL" }] } };
    const context = { artifacts: stored, claimIds: new Set([claim]) };
    const entry: Entry = { claimed_moat: "Scale", classification: "strong", supporting_claim_ids: [claim],
      artifact_paths: ["financial_analytics.segments.quarterly.operating_margin", "peer_benchmark.peers.GOOGL"] };
    const cap = (e: Entry, ctx = context) => capMoatClassifications({ assessments: [e] }, ctx).assessments[0];
    assert.equal(cap(entry).classification, "strong", "every citation resolves");
    // The bypass: the right-looking strings, but the benchmark is unavailable and holds no peer.
    const unavailable = { artifacts: { ...stored, peer_benchmark: { status: "unavailable", peers: [] } }, claimIds: context.claimIds };
    assert.equal(cap(entry, unavailable).classification, "moderate");
    assert.match(cap(entry, unavailable).classification_note!, /peer in a complete peer_benchmark/);
    assert.equal(cap({ ...entry, artifact_paths: ["financial_analytics.invented.path", "peer_benchmark.peers.GOOGL"] }).classification, "moderate", "a path that does not resolve");
    assert.equal(cap({ ...entry, artifact_paths: [...entry.artifact_paths.slice(0, 1), "peer_benchmark.peers.SNAP"] }).classification, "moderate", "a peer the benchmark lacks");
    assert.match(cap({ ...entry, supporting_claim_ids: [] }).classification_note!, /supporting claim/);
    assert.equal(cap({ ...entry, classification: "weak" }).classification, "weak", "code never raises a rating");
    assert.deepEqual(attackTargetErrors({ assessments: [{ claimed_moat: "Scale" }] },
      { attacks: [{ targets_moat: "scale", primary_attacker: "A" }, { targets_moat: "Brand", primary_attacker: "B" }] }).length, 1);
  });

  it("C9-T1: High margins as only evidence is rejected", () => {
    const assessment: MoatAssessment = {
      artifact_type: "moat_assessment",
      assessments: [
        {
          claimed_moat: "Scale advantage",
          moat_source: "Proprietary logistics network",
          protected_profit_pool: "Commerce operating income",
          customer_consequence: "Faster shipping times",
          competitor_consequence: "Competitors cannot match speed",
          company_value_capture: "Higher conversion rate",
          financial_evidence: ["High margins"], // only high margins
          operating_evidence: ["300 warehouses"],
          maintenance_requirement: "Capex reinvestment of $1B annually",
          current_strength: "Strong",
          durability: "High",
          decay_velocity: "Low",
          failure_indicators: ["Competitor third-party warehouse adoption"],
          confidence: 0.8,
          ...SCORED,
        },
      ],
    };
    const result = validateMoatAssessment(assessment);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("circular")));
  });

  it("C9-T2: Network effect claim with declining engagement is rejected", () => {
    const assessment: MoatAssessment = {
      artifact_type: "moat_assessment",
      assessments: [
        {
          claimed_moat: "Network effects on Marketplace",
          moat_source: "Two-sided buyer/seller base",
          protected_profit_pool: "Take rates",
          customer_consequence: "More options, more buyers",
          competitor_consequence: "Harder to bootstrap new platform",
          company_value_capture: "Pricing power",
          financial_evidence: ["Rising revenue per merchant"],
          operating_evidence: ["84M quarterly buyers"],
          maintenance_requirement: "Marketing spend of $500M",
          current_strength: "Strong",
          durability: "High",
          decay_velocity: "Low",
          failure_indicators: ["Lower buyer frequency"],
          confidence: 0.9,
          engagement_per_participant: -0.05, // declining engagement
          ...SCORED,
        },
      ],
    };
    const result = validateMoatAssessment(assessment);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("declining engagement")));
  });

  it("C9-T3: Brand moat with no maintenance spending is rejected", () => {
    const assessment: MoatAssessment = {
      artifact_type: "moat_assessment",
      assessments: [
        {
          claimed_moat: "MercadoLibre Brand",
          moat_source: "Consumer trust",
          protected_profit_pool: "Organic search share",
          customer_consequence: "Default destination",
          competitor_consequence: "Higher CAC for newcomers",
          company_value_capture: "Premium pricing",
          financial_evidence: ["Low marketing spend relative to sales"],
          operating_evidence: ["95% brand awareness"],
          maintenance_requirement: "none", // no maintenance spend
          current_strength: "Strong",
          durability: "High",
          decay_velocity: "Low",
          failure_indicators: ["Deteriorating NPS"],
          confidence: 0.85,
          ...SCORED,
        },
      ],
    };
    const result = validateMoatAssessment(assessment);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("maintenance reinvestment requirement")));
  });

  it("C9-T4: Attack has no financial translation is rejected", () => {
    const matrix: MoatAttackMatrix = {
      artifact_type: "moat_attack_matrix",
      attacks: [
        {
          primary_attacker: "Amazon",
          attack_mechanism: "Free shipping and sub-24h delivery expansion",
          capital_and_time_required: "$500M over 2 years",
          first_vulnerable_customer: "Prime-eligible buyers",
          switching_path: "Install Amazon app, buy membership",
          incumbent_defense: "Match shipping speeds, expand loyalty program",
          leading_indicators: ["Amazon warehouse additions", "Prime adoption rates"],
          financial_translation: "None", // no translation
          residual_moat: "Weakened",
          targets_moat: "Scale advantage",
          survives: "partially",
        },
      ],
    };
    const result = validateMoatAttackMatrix(matrix);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("no financial translation")));
  });

  it("C9-T5: No-moat counterfactual duplicates bear case without changed economics is rejected", () => {
    const counterfactual: NoMoatCounterfactual = {
      artifact_type: "no_moat_counterfactual",
      expected_margin_no_moat: 0.05,
      expected_growth_no_moat: 0.08,
      expected_reinvestment_no_moat: 0.15,
      changed_economics_description: "same as bear case", // duplicate
      bear_case_margin_reconciliation: "Bear case margin reconciles.",
    };
    const result = validateNoMoatCounterfactual(counterfactual);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("distinct changed economics")));
  });
});
