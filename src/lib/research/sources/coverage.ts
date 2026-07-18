/**
 * Source coverage matrix and gap detection for Research OS v3.
 */

import type { SourceRole } from "./roles";
import { SOURCE_ROLE_HIERARCHY, sourceRoleRank } from "./roles";

export type CoverageEntry = {
  source_role: SourceRole;
  artifact_type: string;
  status: "covered" | "uncovered" | "gap" | "waived";
  source_document_ids: string[];
  confidence?: number;
  rationale?: string;
  blocked?: boolean;
  human_waived: boolean;
};

export type CoverageMatrix = {
  run_id: string;
  entries: CoverageEntry[];
  covered_roles: SourceRole[];
  uncovered_roles: SourceRole[];
  gaps: {
    source_role: SourceRole;
    artifact_type: string;
    why_it_matters: string;
    what_was_attempted: string;
    why_unavailable: string;
    blocked_artifact: string;
    human_waiver_possible: boolean;
  }[];
};

export type CoverageInput = {
  run_id: string;
  plan_roles: SourceRole[];
  assignments: { source_document_id: string; role: SourceRole; confidence?: number; rationale?: string }[];
  requiredArtifacts: { artifact_type: string; rationale: string }[];
};

export function buildCoverageMatrix(input: CoverageInput): CoverageMatrix {
  const entries: CoverageEntry[] = [];

  for (const role of SOURCE_ROLE_HIERARCHY) {
    if (!input.plan_roles.includes(role)) continue;

    const assignmentsForRole = input.assignments.filter((a) => a.role === role);
    const isCovered = assignmentsForRole.length > 0;

    for (const artifact of input.requiredArtifacts) {
      const normalizedRationale = (artifact.rationale ?? "").toLowerCase().replace(/_/g, " ");
      const normalizedRole = role.replace(/_/g, " ");
      const blocked = normalizedRationale.includes(normalizedRole);
      entries.push({
        source_role: role,
        artifact_type: artifact.artifact_type,
        status: isCovered ? "covered" : "uncovered",
        source_document_ids: assignmentsForRole.map((a) => a.source_document_id),
        confidence: isCovered ? Math.max(...assignmentsForRole.map((a) => a.confidence ?? 0)) : undefined,
        rationale: isCovered
          ? assignmentsForRole.map((a) => a.rationale).filter(Boolean).join("; ")
          : `No substantive source assigned to ${role}`,
        blocked,
        human_waived: false,
      });
    }
  }

  const covered_roles = [...new Set(entries.filter((e) => e.status === "covered").map((e) => e.source_role))];
  const uncovered_roles = [...new Set(entries.filter((e) => e.status !== "covered").map((e) => e.source_role))];

  const gaps = entries
    .filter((e) => e.status === "uncovered" && e.blocked)
    .map((e) => ({
      source_role: e.source_role,
      artifact_type: e.artifact_type,
      why_it_matters: `Required for ${e.artifact_type}`,
      what_was_attempted: "Search and retrieval attempted; no substantive source accepted.",
      why_unavailable: e.rationale ?? "No source document met role and content requirements.",
      blocked_artifact: e.artifact_type,
      human_waiver_possible: true,
    }));

  return { run_id: input.run_id, entries, covered_roles, uncovered_roles, gaps };
}

export function coverageGate(matrix: CoverageMatrix): {
  passed: boolean;
  missingCritical: SourceRole[];
  waived: CoverageEntry[];
} {
  const missingCritical = [...new Set(matrix.gaps.map((g) => g.source_role))];
  const waived = matrix.entries.filter((e) => e.status === "waived");
  const passed = missingCritical.length === 0 || waived.length === missingCritical.length;
  return { passed, missingCritical, waived };
}

export function sortByRoleHierarchy<T extends { source_role: SourceRole }>(items: T[]): T[] {
  return [...items].sort((a, b) => sourceRoleRank(a.source_role) - sourceRoleRank(b.source_role));
}

export function inferRoleFromMetadata(title?: string, metadata?: Record<string, unknown>): SourceRole[] {
  // This is intentionally conservative: only assign roles when explicit signals exist.
  const roles: SourceRole[] = [];
  const text = (title ?? "").toLowerCase();
  if (text.includes("10-k") || text.includes("10-q") || text.includes("annual report") || text.includes("20-f")) {
    roles.push("regulatory_filing");
  }
  if (text.includes("earnings") && text.includes("release")) roles.push("earnings_release");
  if (text.includes("earnings") && text.includes("presentation")) roles.push("earnings_presentation");
  if (text.includes("transcript")) roles.push("earnings_transcript");
  if (text.includes("proxy")) roles.push("proxy_and_governance");
  if (text.includes("yahoo") || text.includes("market data")) roles.push("market_data");
  return roles;
}
