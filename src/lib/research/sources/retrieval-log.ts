/**
 * Source retrieval attempt logging and validation for Research OS v3.
 */

import type { SourceRole } from "./roles";

export type RetrievalAttempt = {
  research_run_id: string;
  source_role: SourceRole;
  source_url?: string;
  source_title?: string;
  status: "attempted" | "fetched" | "failed" | "unavailable";
  failure_reason?: string;
  metadata?: Record<string, unknown>;
};

export function classifyFetchFailure(error: unknown): {
  status: "failed" | "unavailable";
  reason: string;
} {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("rate limit") || msg.includes("429")) return { status: "failed", reason: "rate_limited" };
    if (msg.includes("not found") || msg.includes("404")) return { status: "unavailable", reason: "not_found" };
    if (msg.includes("timeout")) return { status: "failed", reason: "timeout" };
    if (msg.includes("parse") || msg.includes("malformed")) return { status: "failed", reason: "parse_error" };
  }
  return { status: "failed", reason: "unknown" };
}

export function isSubstantiveSource(attempt: RetrievalAttempt): boolean {
  return attempt.status === "fetched" && !!attempt.source_url && !!attempt.source_title;
}

export function candidateUrlIsNotCoverage(attempt: RetrievalAttempt): boolean {
  // A candidate URL only (not fetched) does not satisfy coverage.
  if (attempt.status === "attempted" && !attempt.source_url?.trim()) return true;
  if (attempt.status === "failed" && !attempt.source_url?.trim()) return true;
  return false;
}

export function retrievalAttemptToCoverageStatus(attempt: RetrievalAttempt): {
  coverage_status: "covered" | "gap" | "uncovered";
  reason: string;
} {
  if (attempt.status === "fetched") {
    if (isSubstantiveSource(attempt)) {
      return { coverage_status: "covered", reason: "Substantive source fetched and assigned to role" };
    }
    return { coverage_status: "gap", reason: "Fetch succeeded but source lacks substance or URL" };
  }
  if (attempt.status === "failed" || attempt.status === "unavailable") {
    return { coverage_status: "gap", reason: attempt.failure_reason ?? "Retrieval failed" };
  }
  return { coverage_status: "uncovered", reason: "Retrieval attempted but not completed" };
}

export function validateRetrievalAttempt(attempt: RetrievalAttempt): string[] {
  const errors: string[] = [];
  if (!attempt.research_run_id) errors.push("research_run_id is required");
  if (!attempt.source_role) errors.push("source_role is required");
  if (attempt.status === "failed" && !attempt.failure_reason) {
    errors.push("failure_reason is required for failed attempts");
  }
  return errors;
}
