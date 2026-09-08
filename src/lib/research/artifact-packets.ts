import { createHash } from "node:crypto";

export const ARTIFACT_DEPENDENCIES: Record<string, string[]> = {
  founder_profile: [], strategic_history_timeline: [], company_genesis: ["founder_profile"],
  strategic_dna: ["founder_profile", "strategic_history_timeline", "company_genesis"],
  segment_model: [], customer_decision_map: [],
  business_process_map: ["segment_model", "customer_decision_map"],
  bottleneck_register: ["business_process_map"],
  competitive_response_matrix: ["segment_model", "customer_decision_map", "business_process_map"],
  moat_assessment: [], moat_attack_matrix: ["moat_assessment"],
  no_moat_counterfactual: ["moat_assessment", "moat_attack_matrix"],
  driver_tree: [], operating_model: ["driver_tree"], reinvestment_model: ["driver_tree", "operating_model"],
  top_down_bottom_up_reconciliation: ["operating_model", "reinvestment_model"],
  risk_register: [], catalyst_register: [], confidence_assessment: [], expected_return_matrix: [],
  investment_thesis: ["risk_register", "catalyst_register", "confidence_assessment", "expected_return_matrix"],
  thesis_breakers: ["risk_register"], monitoring_dashboard: ["risk_register"],
  decision_record: ["investment_thesis", "thesis_breakers", "monitoring_dashboard", "confidence_assessment", "expected_return_matrix"],
};

const HISTORY = /founder|founded|origin|history|mission|early|pivot|acquisition|strategic|control|capital allocation/i;
const BUSINESS = /segment|customer|member|product|revenue|margin|lending|funding|credit|competition|competitor|platform|market|process|supplier|channel|transaction/i;
const FIELDS: Record<string, string[]> = {
  risk_register: ["risk_context", "operating_scenarios", "backtest_review"],
  catalyst_register: ["risk_context", "operating_scenarios"],
  confidence_assessment: ["accepted_valuation", "backtest_review", "risk_context"],
  investment_thesis: ["accepted_valuation", "operating_scenarios", "backtest_review"],
  thesis_breakers: ["risk_context", "operating_scenarios"],
  monitoring_dashboard: ["metric_trends", "risk_context"],
  decision_record: ["accepted_valuation", "backtest_review"],
};
const UPSTREAM: Record<string, string[]> = {
  moat_assessment: ["segment_model", "customer_decision_map", "business_process_map", "competitive_response_matrix"],
  moat_attack_matrix: ["competitive_response_matrix", "bottleneck_register", "customer_decision_map"],
  no_moat_counterfactual: ["segment_model", "historical_diagnosis"],
  driver_tree: ["segment_model", "business_process_map", "historical_diagnosis", "historical_record", "moat_assessment"],
  operating_model: ["segment_model", "historical_record", "no_moat_counterfactual"],
  reinvestment_model: ["historical_record", "segment_model"],
  top_down_bottom_up_reconciliation: ["segment_model", "historical_record"],
};

export function scopedArtifactPacket(base: Record<string, unknown>, key: string) {
  const packet: Record<string, unknown> = { asset: base.asset, required_modules: [key] };
  for (const field of FIELDS[key] || []) if (base[field] !== undefined) packet[field] = base[field];
  if (base.upstream_artifacts) {
    const upstream = base.upstream_artifacts as Record<string, unknown>;
    packet.upstream_artifacts = Object.fromEntries((UPSTREAM[key] || []).filter((name) => upstream[name] !== undefined).map((name) => [name, upstream[name]]));
  }
  if (Array.isArray(base.evidence_claims)) {
    const pattern = ["founder_profile", "company_genesis", "strategic_history_timeline", "strategic_dna"].includes(key) ? HISTORY : BUSINESS;
    const referenced = JSON.stringify(packet);
    packet.evidence_claims = base.evidence_claims.filter((claim) => pattern.test(`${claim.claim_type} ${claim.claim_text}`)
      || (typeof claim.id === "string" && referenced.includes(claim.id)));
  }
  return packet;
}

export function taskInputFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => item instanceof Date ? item.toISOString() : Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex").slice(0, 20);
}
