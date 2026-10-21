/**
 * Validators for moat proof and attack matrix.
 */

import {
  MoatAssessment,
  MoatAttackMatrix,
  NoMoatCounterfactual,
} from "./contracts";

export type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export function validateMoatAssessment(content: unknown): ValidationResult {
  const parsed = MoatAssessment.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  for (const a of data.assessments) {
    const isBrand = a.claimed_moat.toLowerCase().includes("brand");
    const isNetworkEffect = a.claimed_moat.toLowerCase().includes("network effect") || a.claimed_moat.toLowerCase().includes("network-effect");

    // C9-T1: "High margins" is the only moat evidence -> Rejected
    const hasOnlyHighMargins = a.financial_evidence.length === 1 &&
      (a.financial_evidence[0].toLowerCase().includes("high margins") || a.financial_evidence[0].toLowerCase().includes("high margin"));
    if (hasOnlyHighMargins) {
      errors.push(`Moat assessment for '${a.claimed_moat}' lists 'high margins' as the only evidence, which is circular.`);
    }

    // C9-T2: Network-effect claim with declining engagement per participant
    if (isNetworkEffect && a.engagement_per_participant !== undefined && a.engagement_per_participant < 0) {
      errors.push(`Network-effect claim for '${a.claimed_moat}' shows declining engagement per participant (${a.engagement_per_participant}), contradicting the moat thesis.`);
    }

    // C9-T3: Brand moat with no maintenance spending
    if (isBrand) {
      const noSpending = a.maintenance_requirement.toLowerCase().includes("no spend") ||
                         a.maintenance_requirement.toLowerCase().includes("no maintenance spend") ||
                         a.maintenance_requirement.toLowerCase().includes("none") ||
                         a.maintenance_requirement.trim().length === 0;
      if (noSpending) {
        errors.push(`Brand moat '${a.claimed_moat}' must specify a maintenance reinvestment requirement.`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

const HISTORY_TYPES = ["financial_analytics", "historical_record", "historical_diagnosis"];

/** What the run actually stores, so a cited path is checked against data rather than trusted as a string. */
export interface MoatEvidenceContext { artifacts: Record<string, any>; claimIds: Set<string> }

/** A dotted path that exists in a stored artifact: object keys, array indexes, or a columnar table's column name. */
export function resolvesInArtifacts(path: string, artifacts: Record<string, any>): boolean {
  const [type, ...keys] = path.split(".").map((part) => part.trim()).filter(Boolean);
  let node = artifacts[type];
  if (node === undefined || node === null) return false;
  for (const key of keys) {
    if (Array.isArray(node?.columns) && Array.isArray(node?.rows) && !(key in node)) return node.columns.includes(key);
    if (Array.isArray(node)) { node = node[Number(key)]; if (!/^\d+$/.test(key)) return false; }
    else if (node && typeof node === "object" && key in node) node = node[key];
    else return false;
    if (node === undefined || node === null) return false;
  }
  return true;
}

/** A peer path names a peer the stored, complete peer_benchmark holds: peer_benchmark.peers.<TICKER>[.field]. */
export function resolvesToPeer(path: string, artifacts: Record<string, any>): boolean {
  const [type, list, ticker] = path.split(".").map((part) => part.trim());
  const benchmark = artifacts.peer_benchmark;
  if (type !== "peer_benchmark" || list !== "peers" || !ticker || benchmark?.status !== "complete" || !Array.isArray(benchmark.peers)) return false;
  return benchmark.peers.some((peer: any) => String(peer?.ticker ?? "").toUpperCase() === ticker.toUpperCase());
}

/**
 * Framework §7.7: a moat rated strong or exceptional must be tested against the multi-year record and against peers.
 * Code resolves every cited path against the run's stored artifacts: it needs a history path that exists, a peer path
 * naming a peer in a complete peer_benchmark, and at least one supporting claim that is the run's own. Otherwise the
 * moat is capped at moderate with the reason; code never raises a rating.
 */
export function capMoatClassifications<T extends { assessments: Array<{ classification: string; artifact_paths: string[]; supporting_claim_ids?: string[]; classification_note?: string }> }>(
  assessment: T, context: MoatEvidenceContext): T {
  return { ...assessment, assessments: assessment.assessments.map((entry) => {
    if (!["strong", "exceptional"].includes(entry.classification)) return entry;
    const history = entry.artifact_paths.some((p) => HISTORY_TYPES.includes(p.split(".")[0]) && resolvesInArtifacts(p, context.artifacts));
    const peer = entry.artifact_paths.some((p) => resolvesToPeer(p, context.artifacts));
    const claims = (entry.supporting_claim_ids ?? []).some((id) => context.claimIds.has(id));
    const missing = [!history && "a stored history path", !peer && "a peer in a complete peer_benchmark", !claims && "a supporting claim"].filter(Boolean);
    return missing.length ? { ...entry, classification: "moderate",
      classification_note: `Rated ${entry.classification} by the analyst; capped at moderate without ${missing.join(", ")}.` } : entry;
  }) };
}

/** Every attack names a moat the assessment lists. */
export function attackTargetErrors(assessment: { assessments: { claimed_moat: string }[] }, matrix: { attacks: { targets_moat: string; primary_attacker: string }[] }) {
  const moats = new Set(assessment.assessments.map((a) => a.claimed_moat.trim().toLowerCase()));
  return matrix.attacks.filter((a) => !moats.has(a.targets_moat.trim().toLowerCase()))
    .map((a) => `Attack by '${a.primary_attacker}' targets '${a.targets_moat}', which is not a claimed_moat in moat_assessment.`);
}

export function validateMoatAttackMatrix(content: unknown): ValidationResult {
  const parsed = MoatAttackMatrix.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  for (const attack of data.attacks) {
    // C9-T4: Attack has no financial translation
    const noFinancialTranslation = attack.financial_translation.toLowerCase().includes("none") ||
                                   attack.financial_translation.toLowerCase().includes("no financial translation") ||
                                   attack.financial_translation.trim().length < 5;
    if (noFinancialTranslation) {
      errors.push(`Attack scenario by '${attack.primary_attacker}' has no financial translation.`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateNoMoatCounterfactual(content: unknown): ValidationResult {
  const parsed = NoMoatCounterfactual.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  // C9-T5: No-moat counterfactual duplicates bear case without changed economics
  if (data.changed_economics_description.toLowerCase().includes("same as bear case") ||
      data.changed_economics_description.toLowerCase().includes("duplicate bear") ||
      data.changed_economics_description.trim().length < 10) {
    errors.push("No-moat counterfactual must demonstrate distinct changed economics from the base/bear cases.");
  }

  return { valid: errors.length === 0, errors, warnings };
}
