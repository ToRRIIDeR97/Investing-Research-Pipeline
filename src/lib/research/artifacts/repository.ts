import { eq, ne, and, desc, inArray, sql } from "drizzle-orm";
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
import { type ArtifactStatus, ASSUMPTION_CLASSIFICATIONS } from "./contracts";
import type { schema } from "@/db";
import { ARTIFACT_SCHEMAS, validateArtifactContent } from "../stage-contracts";
import { fingerprint } from "../reporting/report";

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
  /** Link the artifact to the run's claims its content cites. */
  async function linkCitations(artifact: typeof research_artifacts.$inferSelect, executor: Pick<Db, "select" | "insert"> = db) {
    const cited = citedClaimIds(artifact.content_json);
    const claims = cited.length ? await executor.select({ id: evidence_claims.id }).from(evidence_claims)
      .where(and(inArray(evidence_claims.id, cited), eq(evidence_claims.research_run_id, artifact.research_run_id))) : [];
    if (claims.length) {
      await executor.insert(research_artifact_claim_links)
        .values(claims.map((claim) => ({ artifact_id: artifact.id, evidence_claim_id: claim.id, support_type: "cites" })))
        .onConflictDoNothing();
    }
    return artifact;
  }

  /**
   * Save the run's current artifact for (type, scope). Unchanged content keeps the current row (an accepted row
   * stays accepted); anything else inserts the next version and supersedes every earlier row, so a stage retry or
   * re-run never leaves two current artifacts and an accepted artifact is never rewritten.
   */
  async function upsertArtifact(input: CreateArtifactInput) {
    if (ARTIFACT_SCHEMAS[input.artifact_type] && ["validated", "accepted"].includes(input.status)) {
      const validation = validateArtifactContent(input.artifact_type, input.content_json);
      if (!validation.valid) throw new Error(`Invalid ${input.artifact_type}: ${validation.errors.join("; ")}`);
    }
    const key = and(
      eq(research_artifacts.research_run_id, input.research_run_id),
      eq(research_artifacts.artifact_type, input.artifact_type),
      eq(research_artifacts.scope_key, input.scope_key)
    );
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`research-artifact:${input.research_run_id}:${input.artifact_type}:${input.scope_key}`}, 0))`);
      const [prior] = await tx.select().from(research_artifacts).where(key)
        .orderBy(desc(research_artifacts.artifact_version), desc(research_artifacts.created_at)).limit(1);
      const sameStatus = prior?.status === input.status || (prior?.status === "accepted" && input.status === "validated");
      if (prior && sameStatus && fingerprint(prior.content_json) === fingerprint(input.content_json)) {
        return linkCitations(prior, tx);
      }
      const [inserted] = await tx
        .insert(research_artifacts)
        .values({
          research_run_id: input.research_run_id,
          asset_id: input.asset_id,
          profile_id: input.profile_id,
          artifact_type: input.artifact_type,
          scope_key: input.scope_key,
          artifact_version: (prior?.artifact_version ?? 0) + 1,
          status: input.status,
          content_json: input.content_json,
          schema_version: input.schema_version,
          validator_version: input.validator_version,
          prompt_version: input.prompt_version,
          validation_result_json: input.validation_result_json ?? {},
          created_by: input.created_by,
          supersedes_artifact_id: prior?.id,
        })
        .returning();
      await tx.update(research_artifacts).set({ status: "superseded", updated_at: new Date() })
        .where(and(key, ne(research_artifacts.status, "superseded"), ne(research_artifacts.id, inserted.id)));
      return linkCitations(inserted, tx);
    });
  }

  /** The latest usable version: accepted after a human gate, validated before it. */
  async function getCurrentArtifact(research_run_id: string, artifact_type: string, scope_key: string) {
    const [artifact] = await db
      .select()
      .from(research_artifacts)
      .where(
        and(
          eq(research_artifacts.research_run_id, research_run_id),
          eq(research_artifacts.artifact_type, artifact_type),
          eq(research_artifacts.scope_key, scope_key),
          inArray(research_artifacts.status, ["validated", "accepted"])
        )
      )
      .orderBy(desc(research_artifacts.artifact_version), desc(research_artifacts.created_at))
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
