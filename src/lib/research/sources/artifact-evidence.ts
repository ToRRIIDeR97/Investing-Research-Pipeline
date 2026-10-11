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

/**
 * Remove citation IDs that are not in the accepted packet, in place, and return the removed IDs.
 * Used where an invented or stale citation should be dropped and reported rather than fail a stage.
 * With `pruneUncited`, an array entry whose supporting citations were all dropped is removed too,
 * since an entry with no evidence would fail its contract.
 */
export function dropInvalidCitationIds(artifact: unknown, allowedIds: Iterable<string>, options: { pruneUncited?: boolean } = {}): string[] {
  const allowed = new Set(allowedIds);
  const dropped = new Set<string>();
  const uncited = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      if (options.pruneUncited) value.splice(0, value.length, ...value.filter((item) => !(item && typeof item === "object" && uncited.has(item))));
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (CITATION_KEYS.has(key) && Array.isArray(child)) {
        record[key] = child.filter((item) => {
          if (typeof item !== "string" || !item.trim()) return true;
          const keep = allowed.has(item.trim());
          if (!keep) dropped.add(item.trim());
          return keep;
        });
        // Contradicting citations are optional; losing all supporting ones leaves the entry unsupported.
        if (key !== "contradicting_claim_ids" && child.length && !(record[key] as unknown[]).length) uncited.add(record);
      } else {
        visit(child);
      }
    }
  };
  visit(artifact);
  return [...dropped];
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
