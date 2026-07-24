import type { SourceRole } from "./roles";

export type CitationValidationResult = {
  valid: boolean;
  citedIds: string[];
  invalidIds: string[];
};

const CITATION_KEYS = new Set([
  "evidence_claim_ids",
  "supporting_claim_ids",
  "contradicting_claim_ids",
]);

export function validateArtifactCitationIds(
  artifact: unknown,
  allowedIds: Iterable<string>
): CitationValidationResult {
  const allowed = new Set(allowedIds);
  const citedIds = [...collectCitationIds(artifact)];
  const invalidIds = citedIds.filter((id) => !allowed.has(id));
  return {
    valid: invalidIds.length === 0,
    citedIds,
    invalidIds,
  };
}

export function missingRequiredSourceRoles(
  required: SourceRole[],
  assigned: Iterable<string>
): SourceRole[] {
  const covered = new Set(assigned);
  return required.filter((role) => !covered.has(role));
}

function collectCitationIds(value: unknown, key?: string, target = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    if (key && CITATION_KEYS.has(key)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) target.add(item.trim());
      }
      return target;
    }
    for (const item of value) collectCitationIds(item, undefined, target);
    return target;
  }
  if (!value || typeof value !== "object") return target;
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    collectCitationIds(childValue, childKey, target);
  }
  return target;
}
