/**
 * Source planning: map artifact needs to source roles.
 */

import {
  SOURCE_ROLES,
  type SourceRole,
  isValidSourceRole,
  REQUIRED_SOURCE_ROLES_FOR_INITIATION,
} from "./roles";

export type SourcePlanItem = {
  source_role: SourceRole;
  required: boolean;
  rationale: string;
  artifact_types: string[];
  search_keywords: string[];
  expected_documents: string[];
};

export type SourcePlan = {
  run_id: string;
  asset_id: string;
  items: SourcePlanItem[];
  required_roles: SourceRole[];
  optional_roles: SourceRole[];
};

const ROLE_DOCUMENT_HINTS: Record<SourceRole, string[]> = {
  regulatory_filing: ["10-K", "10-Q", "20-F", "6-K", "annual report", "quarterly report"],
  company_investor_relations: ["IR presentation", "investor day", "fact sheet", "guidance"],
  earnings_release: ["earnings release", "press release"],
  earnings_presentation: ["earnings deck", "supplemental materials"],
  earnings_transcript: ["earnings call transcript", "Q&A transcript"],
  proxy_and_governance: ["proxy statement", "DEF 14A", "board composition"],
  founder_and_company_history: ["founder interview", "company history", "biography"],
  peer_company_primary: ["peer 10-K", "peer earnings", "competitor report"],
  industry_primary: ["industry report", "trade association", "market sizing"],
  customer_or_channel: ["customer survey", "channel check", "user review"],
  supplier_or_partner: ["supplier report", "partner announcement", "supply chain"],
  regulatory_or_government: ["SEC filing", "central bank", "regulatory announcement"],
  macro_dataset: ["GDP", "inflation", "unemployment", "currency", "commodity price"],
  market_data: ["Yahoo Finance", "OHLCV", "dividend", "split", "market cap"],
};

export function buildSourcePlan(
  runId: string,
  assetId: string,
  requiredArtifacts: { artifact_type: string; rationale?: string }[],
  overrides: { role: SourceRole; required?: boolean; rationale?: string }[] = []
): SourcePlan {
  const items: SourcePlanItem[] = [];

  // Extract roles referenced by required artifacts.
  const artifactRequiredRoles = new Set<SourceRole>();
  for (const artifact of requiredArtifacts) {
    const normalizedRationale = normalizeRationale(artifact.rationale);
    for (const role of SOURCE_ROLES) {
      if (normalizedRationale.includes(role) || normalizedRationale.includes(role.replace(/_/g, " "))) {
        artifactRequiredRoles.add(role);
      }
    }
  }

  for (const role of SOURCE_ROLES) {
    const override = overrides.find((o) => o.role === role);
    const blockedArtifacts = requiredArtifacts
      .filter((a) => normalizeRationale(a.rationale).includes(role) || normalizeRationale(a.rationale).includes(role.replace(/_/g, " ")))
      .map((a) => a.artifact_type);

    const defaultRequired = REQUIRED_SOURCE_ROLES_FOR_INITIATION.includes(role) || artifactRequiredRoles.has(role);
    const required = override?.required ?? defaultRequired;
    const rationale = override?.rationale ?? defaultArtifactRationale(role, requiredArtifacts);

    items.push({
      source_role: role,
      required,
      rationale,
      artifact_types: blockedArtifacts,
      search_keywords: ROLE_DOCUMENT_HINTS[role],
      expected_documents: ROLE_DOCUMENT_HINTS[role],
    });
  }

  const required_roles = items.filter((i) => i.required).map((i) => i.source_role);
  const optional_roles = items.filter((i) => !i.required).map((i) => i.source_role);

  return { run_id: runId, asset_id: assetId, items, required_roles, optional_roles };
}

function defaultArtifactRationale(
  role: SourceRole,
  artifacts: { artifact_type: string; rationale?: string }[]
): string {
  return `Supports ${artifacts.map((a) => a.artifact_type).join(", ")}`;
}

function normalizeRationale(rationale?: string): string {
  return (rationale ?? "").toLowerCase().replace(/_/g, " ");
}

export function validateSourcePlan(plan: SourcePlan): string[] {
  const errors: string[] = [];
  for (const item of plan.items) {
    if (!isValidSourceRole(item.source_role)) {
      errors.push(`Invalid source role: ${item.source_role}`);
    }
    if (item.required && item.artifact_types.length === 0) {
      errors.push(`Required role ${item.source_role} has no linked artifacts`);
    }
  }
  return errors;
}

export function planMissingRoles(plan: SourcePlan, coveredRoles: SourceRole[]): SourceRole[] {
  return plan.required_roles.filter((r) => !coveredRoles.includes(r));
}

export { SOURCE_ROLES, REQUIRED_SOURCE_ROLES_FOR_INITIATION };
export type { SourceRole };
