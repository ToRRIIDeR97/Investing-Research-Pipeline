import { eq, and, inArray, notInArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  research_artifacts,
  research_artifact_dependencies,
  research_artifact_claim_links,
  research_assumptions,
  research_assumption_claim_links,
} from "@/db/schema/research-artifacts";
import { evidence_claims } from "@/db/schema/evidence";
import { citedClaimIds } from "../memory/graph";
import {
  artifactStatusSchema,
  type ArtifactAcceptanceCheck,
  type ArtifactStatus,
  ASSUMPTION_CLASSIFICATIONS,
} from "./contracts";
import type { schema } from "@/db";
import { ARTIFACT_SCHEMAS, validateArtifactContent } from "../stage-contracts";

type Db = PostgresJsDatabase<typeof schema>;

export interface CreateArtifactInput {
  research_run_id: string;
  asset_id: string;
  profile_id?: string;
  artifact_type: string;
  scope_key: string;
  status: ArtifactStatus;
  content_json: Record<string, unknown>;
  schema_version: string;
  validator_version: string;
  prompt_version: string;
  validation_result_json?: Record<string, unknown>;
  created_by: string;
  supersedes_artifact_id?: string;
  idempotency_key?: string;
}

export interface CreateAssumptionInput {
  research_run_id: string;
  assumption_key: string;
  assumption_category: string;
  value_numeric?: number;
  value_text?: string;
  unit?: string;
  currency?: string;
  range_low?: number;
  range_high?: number;
  classification: (typeof ASSUMPTION_CLASSIFICATIONS)[number];
  causal_mechanism?: string;
  time_lag?: string;
  falsification_condition?: string;
  model_input_path?: string;
  confidence?: number;
  status: "draft" | "validated" | "accepted" | "superseded" | "rejected";
  supersedes_assumption_id?: string;
  idempotency_key?: string;
}

export function createArtifactRepository(db: Db) {
  /** Link the artifact to the run's claims its content cites; an in-place update drops citations it no longer makes. */
  async function linkCitations(artifact: typeof research_artifacts.$inferSelect, replace = false) {
    const cited = citedClaimIds(artifact.content_json);
    const claims = cited.length ? await db.select({ id: evidence_claims.id }).from(evidence_claims)
      .where(and(inArray(evidence_claims.id, cited), eq(evidence_claims.research_run_id, artifact.research_run_id))) : [];
    if (replace) {
      const keep = claims.map((claim) => claim.id);
      await db.delete(research_artifact_claim_links).where(and(
        eq(research_artifact_claim_links.artifact_id, artifact.id),
        eq(research_artifact_claim_links.support_type, "cites"),
        ...(keep.length ? [notInArray(research_artifact_claim_links.evidence_claim_id, keep)] : [])
      ));
    }
    if (claims.length) {
      await db.insert(research_artifact_claim_links)
        .values(claims.map((claim) => ({ artifact_id: artifact.id, evidence_claim_id: claim.id, support_type: "cites" })))
        .onConflictDoNothing();
    }
    return artifact;
  }

  async function upsertArtifact(input: CreateArtifactInput) {
    if (ARTIFACT_SCHEMAS[input.artifact_type] && ["validated", "accepted"].includes(input.status)) {
      const validation = validateArtifactContent(input.artifact_type, input.content_json);
      if (!validation.valid) throw new Error(`Invalid ${input.artifact_type}: ${validation.errors.join("; ")}`);
    }
    if (input.idempotency_key) {
      const existing = await db
        .select()
        .from(research_artifacts)
        .where(
          and(
            eq(research_artifacts.research_run_id, input.research_run_id),
            eq(research_artifacts.artifact_type, input.artifact_type),
            eq(research_artifacts.scope_key, input.scope_key)
          )
        )
        .limit(1);
      if (existing.length > 0) {
        const current = existing[0];
        if (["accepted", "superseded", "rejected"].includes(current.status)) {
          return current;
        }
        const [updated] = await db
          .update(research_artifacts)
          .set({
            profile_id: input.profile_id,
            status: input.status,
            content_json: input.content_json,
            schema_version: input.schema_version,
            validator_version: input.validator_version,
            prompt_version: input.prompt_version,
            validation_result_json: input.validation_result_json ?? {},
            created_by: input.created_by,
            supersedes_artifact_id: input.supersedes_artifact_id,
            updated_at: new Date(),
          })
          .where(eq(research_artifacts.id, current.id))
          .returning();
        return linkCitations(updated, true);
      }
    }

    const [inserted] = await db
      .insert(research_artifacts)
      .values({
        research_run_id: input.research_run_id,
        asset_id: input.asset_id,
        profile_id: input.profile_id,
        artifact_type: input.artifact_type,
        scope_key: input.scope_key,
        status: input.status,
        content_json: input.content_json,
        schema_version: input.schema_version,
        validator_version: input.validator_version,
        prompt_version: input.prompt_version,
        validation_result_json: input.validation_result_json ?? {},
        created_by: input.created_by,
        supersedes_artifact_id: input.supersedes_artifact_id,
      })
      .returning();
    return linkCitations(inserted);
  }

  async function acceptArtifact(
    artifactId: string,
    validatorResult: Record<string, unknown>
  ): Promise<ArtifactAcceptanceCheck> {
    const [artifact] = await db
      .select()
      .from(research_artifacts)
      .where(eq(research_artifacts.id, artifactId))
      .limit(1);
    if (!artifact) return { canAccept: false, errors: ["Artifact not found"], warnings: [] };

    const status = artifactStatusSchema.safeParse(artifact.status);
    if (!status.success || status.data === "accepted" || status.data === "superseded" || status.data === "rejected") {
      return { canAccept: false, errors: ["Artifact is not in an acceptable state"], warnings: [] };
    }

    const deps = await db
      .select({ depStatus: research_artifacts.status })
      .from(research_artifact_dependencies)
      .innerJoin(research_artifacts, eq(research_artifact_dependencies.depends_on_artifact_id, research_artifacts.id))
      .where(eq(research_artifact_dependencies.artifact_id, artifactId));

    const badDeps = deps.filter(
      (d) => d.depStatus === "rejected" || d.depStatus === "superseded" || d.depStatus === "needs_more_work"
    );
    if (badDeps.length > 0) {
      return {
        canAccept: false,
        errors: ["Artifact depends on rejected, superseded, or incomplete dependencies"],
        warnings: [],
      };
    }

    if (!validatorResult || !("valid" in validatorResult)) {
      return { canAccept: false, errors: ["Validation metadata is missing"], warnings: [] };
    }

    const validation = validatorResult as { valid?: boolean; errors?: string[]; warnings?: string[] };
    if (!validation.valid) {
      return {
        canAccept: false,
        errors: validation.errors || ["Validation failed"],
        warnings: validation.warnings || [],
      };
    }

    await db
      .update(research_artifacts)
      .set({
        status: "accepted",
        accepted_at: new Date(),
        validation_result_json: validation,
      })
      .where(eq(research_artifacts.id, artifactId));

    return { canAccept: true, errors: [], warnings: validation.warnings || [] };
  }

  async function supersedeArtifact(artifactId: string, successorId: string) {
    await db
      .update(research_artifacts)
      .set({ status: "superseded" })
      .where(eq(research_artifacts.id, artifactId));
    await db
      .update(research_artifacts)
      .set({ supersedes_artifact_id: artifactId })
      .where(eq(research_artifacts.id, successorId));
  }

  async function getCurrentArtifact(research_run_id: string, artifact_type: string, scope_key: string) {
    const [artifact] = await db
      .select()
      .from(research_artifacts)
      .where(
        and(
          eq(research_artifacts.research_run_id, research_run_id),
          eq(research_artifacts.artifact_type, artifact_type),
          eq(research_artifacts.scope_key, scope_key),
          eq(research_artifacts.status, "accepted")
        )
      )
      .orderBy(sql`${research_artifacts.created_at} DESC`)
      .limit(1);
    return artifact || null;
  }

  async function addDependency(artifactId: string, dependsOnArtifactId: string, dependencyType: "required" | "supports" = "required") {
    const [existing] = await db
      .select()
      .from(research_artifact_dependencies)
      .where(
        and(
          eq(research_artifact_dependencies.artifact_id, artifactId),
          eq(research_artifact_dependencies.depends_on_artifact_id, dependsOnArtifactId)
        )
      )
      .limit(1);
    if (existing) return existing;

    const [inserted] = await db
      .insert(research_artifact_dependencies)
      .values({
        artifact_id: artifactId,
        depends_on_artifact_id: dependsOnArtifactId,
        dependency_type: dependencyType,
      })
      .returning();
    return inserted;
  }

  async function addClaimLink(artifactId: string, evidenceClaimId: string, supportType: "supports" | "contradicts" | "context" = "supports") {
    const [existing] = await db
      .select()
      .from(research_artifact_claim_links)
      .where(
        and(
          eq(research_artifact_claim_links.artifact_id, artifactId),
          eq(research_artifact_claim_links.evidence_claim_id, evidenceClaimId),
          eq(research_artifact_claim_links.support_type, supportType)
        )
      )
      .limit(1);
    if (existing) return existing;

    const [inserted] = await db
      .insert(research_artifact_claim_links)
      .values({
        artifact_id: artifactId,
        evidence_claim_id: evidenceClaimId,
        support_type: supportType,
      })
      .returning();
    return inserted;
  }

  async function upsertAssumption(input: CreateAssumptionInput) {
    if (input.idempotency_key) {
      const existing = await db
        .select()
        .from(research_assumptions)
        .where(
          and(
            eq(research_assumptions.research_run_id, input.research_run_id),
            eq(research_assumptions.assumption_key, input.assumption_key)
          )
        )
        .limit(1);
      if (existing.length > 0) {
        return existing[0];
      }
    }

    const [inserted] = await db
      .insert(research_assumptions)
      .values({
        research_run_id: input.research_run_id,
        assumption_key: input.assumption_key,
        assumption_category: input.assumption_category,
        value_numeric: input.value_numeric !== undefined ? String(input.value_numeric) : undefined,
        value_text: input.value_text,
        unit: input.unit,
        currency: input.currency,
        range_low: input.range_low !== undefined ? String(input.range_low) : undefined,
        range_high: input.range_high !== undefined ? String(input.range_high) : undefined,
        classification: input.classification,
        causal_mechanism: input.causal_mechanism,
        time_lag: input.time_lag,
        falsification_condition: input.falsification_condition,
        model_input_path: input.model_input_path,
        confidence: input.confidence !== undefined ? String(input.confidence) : undefined,
        status: input.status,
        supersedes_assumption_id: input.supersedes_assumption_id,
      })
      .returning();
    return inserted;
  }

  async function acceptAssumption(assumptionId: string) {
    const [assumption] = await db
      .select()
      .from(research_assumptions)
      .where(eq(research_assumptions.id, assumptionId))
      .limit(1);
    if (!assumption) return false;

    if (assumption.classification !== "disclosed_fact") {
      if (assumption.range_low === null || assumption.range_high === null) {
        return false;
      }
    }

    await db.update(research_assumptions).set({ status: "accepted" }).where(eq(research_assumptions.id, assumptionId));
    return true;
  }

  async function addAssumptionClaimLink(assumptionId: string, evidenceClaimId: string, supportType: "supports" | "contradicts" | "context" = "supports") {
    const [existing] = await db
      .select()
      .from(research_assumption_claim_links)
      .where(
        and(
          eq(research_assumption_claim_links.assumption_id, assumptionId),
          eq(research_assumption_claim_links.evidence_claim_id, evidenceClaimId),
          eq(research_assumption_claim_links.support_type, supportType)
        )
      )
      .limit(1);
    if (existing) return existing;

    const [inserted] = await db
      .insert(research_assumption_claim_links)
      .values({
        assumption_id: assumptionId,
        evidence_claim_id: evidenceClaimId,
        support_type: supportType,
      })
      .returning();
    return inserted;
  }

  async function getAssumptionsForRun(research_run_id: string) {
    return db
      .select()
      .from(research_assumptions)
      .where(eq(research_assumptions.research_run_id, research_run_id))
      .orderBy(sql`${research_assumptions.assumption_key}, ${research_assumptions.assumption_version} DESC`);
  }

  return {
    upsertArtifact,
    acceptArtifact,
    supersedeArtifact,
    getCurrentArtifact,
    addDependency,
    addClaimLink,
    upsertAssumption,
    acceptAssumption,
    addAssumptionClaimLink,
    getAssumptionsForRun,
  };
}

export type ArtifactRepository = ReturnType<typeof createArtifactRepository>;
