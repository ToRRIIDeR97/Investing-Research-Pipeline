import { z } from "zod";
import {
  artifactStatusSchema,
  type ArtifactStatus,
  type ArtifactValidationResult,
  type ResearchArtifact,
  type ResearchAssumption,
  ASSUMPTION_CLASSIFICATIONS,
} from "./contracts";

export interface ValidationOutcome {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function ok(warnings: string[] = []): ValidationOutcome {
  return { valid: true, errors: [], warnings };
}

export function fail(errors: string[], warnings: string[] = []): ValidationOutcome {
  return { valid: false, errors, warnings };
}

export function requireStatus(
  artifact: ResearchArtifact,
  allowed: ArtifactStatus[]
): ValidationOutcome {
  const parsed = artifactStatusSchema.safeParse(artifact.status);
  if (!parsed.success) {
    return fail([`Invalid artifact status: ${artifact.status}`]);
  }
  if (!allowed.includes(parsed.data)) {
    return fail([
      `Artifact ${artifact.artifact_type}:${artifact.scope_key} status is ${artifact.status}; expected one of ${allowed.join(", ")}`,
    ]);
  }
  return ok();
}

export function requireEvidenceLinks(
  artifact: ResearchArtifact,
  claimIds: string[],
  minLinks = 1
): ValidationOutcome {
  if (artifact.status === "evidence_only") {
    return fail([
      `Artifact ${artifact.artifact_type}:${artifact.scope_key} is evidence_only and cannot satisfy analytical completion`,
    ]);
  }
  if (claimIds.length < minLinks) {
    return fail([
      `Artifact ${artifact.artifact_type}:${artifact.scope_key} requires at least ${minLinks} evidence claim link(s); found ${claimIds.length}`,
    ]);
  }
  return ok();
}

export function requireAssumptionRanges(assumption: ResearchAssumption): ValidationOutcome {
  if (assumption.classification === "disclosed_fact") return ok();
  if (assumption.range_low == null || assumption.range_high == null) {
    return fail([
      `Assumption ${assumption.assumption_key} classification ${assumption.classification} requires range_low and range_high`,
    ]);
  }
  if (Number(assumption.range_low) > Number(assumption.range_high)) {
    return fail([
      `Assumption ${assumption.assumption_key} range_low (${assumption.range_low}) exceeds range_high (${assumption.range_high})`,
    ]);
  }
  return ok();
}

export function requireVersionedMetadata(artifact: ResearchArtifact): ValidationOutcome {
  const errors: string[] = [];
  if (!artifact.schema_version) errors.push("schema_version is required");
  if (!artifact.validator_version) errors.push("validator_version is required");
  if (!artifact.prompt_version) errors.push("prompt_version is required");
  if (!artifact.created_by) errors.push("created_by is required");
  return errors.length ? fail(errors) : ok();
}

export function validationResultFromZod(result: z.SafeParseReturnType<unknown, unknown>): ValidationOutcome {
  if (result.success) return ok();
  return fail(
    result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
  );
}

export function toArtifactValidationResult(outcome: ValidationOutcome): ArtifactValidationResult {
  return {
    valid: outcome.valid,
    errors: outcome.errors,
    warnings: outcome.warnings,
    checkedAt: new Date().toISOString(),
  };
}

export function validateArtifactCanAccept(
  artifact: ResearchArtifact,
  dependencies: { status: string }[]
): ValidationOutcome {
  const status = artifactStatusSchema.safeParse(artifact.status);
  if (!status.success) return fail(["Invalid artifact status"]);
  if (["accepted", "superseded", "rejected"].includes(status.data)) {
    return fail(["Artifact is already in a terminal state"]);
  }

  const versionCheck = requireVersionedMetadata(artifact);
  if (!versionCheck.valid) return versionCheck;

  const badDeps = dependencies.filter(
    (d) => d.status === "rejected" || d.status === "superseded" || d.status === "needs_more_work"
  );
  if (badDeps.length > 0) {
    return fail(["Artifact depends on rejected, superseded, or incomplete dependencies"]);
  }

  return ok();
}

export function validateAssumption(assumption: ResearchAssumption): ValidationOutcome {
  if (!ASSUMPTION_CLASSIFICATIONS.includes(assumption.classification as any)) {
    return fail([`Invalid assumption classification: ${assumption.classification}`]);
  }
  const rangeCheck = requireAssumptionRanges(assumption);
  if (!rangeCheck.valid) return rangeCheck;
  if (assumption.confidence != null && (assumption.confidence < 0 || assumption.confidence > 1)) {
    return fail(["Assumption confidence must be between 0 and 1"]);
  }
  return ok();
}
