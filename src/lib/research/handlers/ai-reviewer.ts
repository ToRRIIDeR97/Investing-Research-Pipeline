import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { AI_REVIEWER_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createHash } from "node:crypto";
import { artifactHandoff, reportNumericValues, reportInputs, type SavedReportArtifact } from '../report-composition';
import { taskInputFingerprint } from '../artifact-packets';
import { validateArtifactCitationIds } from '../sources/artifact-evidence';
import { requestFocusedReviewRepair } from '../review-repairs';

export function reviewArtifactGroups(artifacts: SavedReportArtifact[]) {
  const groups = new Map<string, SavedReportArtifact[]>();
  for (const artifact of artifacts) {
    const key = /genesis|founder|strategic/.test(artifact.artifact_type) ? 'history'
      : /segment|customer|business_process|bottleneck|competitive|moat/.test(artifact.artifact_type) ? 'business'
      : /historical|driver|operating|reinvestment|reconciliation/.test(artifact.artifact_type) ? 'operations'
      : /valuation|price_target|expected_return/.test(artifact.artifact_type) ? 'valuation' : 'decision';
    groups.set(key, [...(groups.get(key) || []), artifact]);
  }
  return [...groups.entries()];
}

export function validateAiReviewSelfConsistency(
  value: unknown,
  backtestReview: unknown,
  artifactKeys?: string[]
): Array<{ path: string; message: string }> {
  const review = value as Record<string, any>;
  const backtest = backtestReview as Record<string, any> | undefined;
  const errors: Array<{ path: string; message: string }> = [];
  if (artifactKeys && review.findings?.some((finding: any) => !finding.artifact_refs?.length
    || finding.artifact_refs.some((key: string) => !artifactKeys.includes(key)))) {
    errors.push({ path: 'findings', message: 'Each finding must reference a supplied artifact' });
  }
  if (review.pass_fail === "pass" && review.findings?.some((finding: any) => finding.severity === "blocker")) {
    errors.push({ path: "pass_fail", message: "A passing review cannot contain blocker findings." });
  }

  const expected = Number(backtest?.framework_gate?.combinations_tested);
  const counts = Object.values(backtest?.status_counts || {}).map(Number);
  const countsReconcile = Number.isFinite(expected)
    && counts.length > 0
    && counts.every(Number.isFinite)
    && counts.reduce((sum, count) => sum + count, 0) === expected;
  const prose = [review.review_summary, ...(review.findings || []).map((finding: any) => finding.message)]
    .filter(Boolean)
    .join(" ");
  const falseCountClaim = prose.split(/[.!?]/).some((sentence) =>
    /status[_ ]counts?/i.test(sentence)
    && /not summing|do not sum|does not sum|don't sum|doesn't sum|fail(?:s|ed)? to sum|(?:minor|some|an?|the)\s+(?:apparent\s+)?(?:inconsistenc(?:y|ies)|mismatch(?:es)?)/i.test(sentence)
  );
  if (countsReconcile && falseCountClaim) {
    errors.push({ path: "review_summary", message: "Backtest status counts do sum to the executed combination count." });
  }
  return errors;
}

export const aiReviewerHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "ai_reviewer",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const artifacts = await sql`
        SELECT artifact_type, content_json
        FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND status IN ('validated', 'accepted')
          AND artifact_type NOT IN (
            'review_summary', 'findings', 'quality_score', 'recommendations',
            'review_verdict', 'synthetic_report', 'pass_fail'
          )
        ORDER BY artifact_type
      `;
      const sourceArtifacts = artifacts.map((row) => ({ artifact_type: String(row.artifact_type), content_json: row.content_json }));
      const asset = {
        runId: ctx.runId, assetId: ctx.assetId, assetName: ctx.assetName, symbol: ctx.symbol, profileKey: ctx.profileKey,
      };
      const [composition] = artifacts.filter((row) => row.artifact_type === 'report_composition');
      if (composition && composition.content_json.input_fingerprint !== taskInputFingerprint(reportInputs(sourceArtifacts))) {
        throw new Error('Report composition is stale; rerun decision synthesis before review');
      }
      const claims = await sql`SELECT id FROM evidence_claims WHERE research_run_id = ${ctx.runId} AND review_status IN ('accepted', 'machine_verified')`;
      const allowedIds = claims.map((row) => String(row.id));
      const reviews = await Promise.allSettled(reviewArtifactGroups(sourceArtifacts).map(async ([section, rows]) => {
        const sectionPacket = { asset, section, artifacts: Object.fromEntries(rows.map((row) => [row.artifact_type, row.content_json])) };
        if (Buffer.byteLength(JSON.stringify(sectionPacket)) > 96_000) throw new Error(`Review section ${section} exceeds 96000 bytes; split the section before review`);
        const result = await callResearchAgent<Record<string, any>>({
          sql, ctx, stageKey: 'ai_reviewer', taskKey: `section-review:v1:${section}:${taskInputFingerprint(sectionPacket)}`,
          taskType: 'section_review', agentName: 'research-reviewer', packet: sectionPacket,
          outputFormat: AI_REVIEWER_CONTRACT, policy: { maxAttempts: 2, maxRepairAttempts: 0 },
          promptFactory: (p) => exactJsonPrompt({ agentName: 'research-reviewer', requiredKeys: AI_REVIEWER_CONTRACT.requiredKeys, packet: p,
            extraRules: ['Review only this assigned section. Check support, internal consistency and disclosed uncertainty.',
              'Every finding must name its responsible artifact in artifact_refs. Copy evidence IDs only from the supplied artifacts.',
              'Do not require artifacts assigned to other reviewers. Report contradictions, do not rewrite analytical conclusions.',
              'For backtests, status_counts covers the complete population. top_ten and weak_or_failed are subsets.'] }),
          validateStructured: (value) => {
            const review = value as any;
            const errors = validateAiReviewSelfConsistency(review, sectionPacket.artifacts.backtest_review, rows.map((row) => row.artifact_type));
            if (!validateArtifactCitationIds(value, allowedIds).valid) errors.push({ path: 'findings', message: 'Unaccepted evidence citation in review' });
            return errors;
          },
        });
        return { section, ...result } as { section: string } & Record<string, any>;
      }));
      const failed = reviews.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      const sectionReviews = reviews.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        section_reviews: sectionReviews,
        section_handoffs: sourceArtifacts.map(artifactHandoff),
        numeric_values: reportNumericValues(sourceArtifacts),
        artifacts: Object.fromEntries(artifacts.filter((row) => ['backtest_review', 'report_composition', 'decision_record'].includes(String(row.artifact_type)))
          .map((row) => [row.artifact_type, row.content_json])),
      };
      if (Buffer.byteLength(JSON.stringify(packet)) > 96_000) throw new Error('Cross-section review exceeds its 96000-byte limit');
      const hasBacktest = artifacts.some((artifact) => artifact.artifact_type === "backtest_review");
      const taskKey = `research-reviewer:review:v3:${createHash("sha256")
        .update(JSON.stringify(packet))
        .digest("hex")
        .slice(0, 12)}`;

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "research-reviewer",
        requiredKeys: AI_REVIEWER_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Review consistency across section handoffs, locked numeric values and the composed narrative. Detailed section checks have already been performed.",
          "Preserve every section finding and its artifact_refs. Do not pass if a section failed or needs more work. Never downgrade a blocker.",
          hasBacktest
            ? "Verify that the backtest executed at least 50 thesis-distinct combinations, ranked a top 10, reviewed at least five weak or failed combinations, used shifted signals and transaction costs, and disclosed proxy-data limitations."
            : "No backtest_review artifact is present. Treat this as acceptable when no timing hypothesis was accepted; do not fail the fundamental report solely because backtesting was skipped.",
          "backtest_review.status_counts covers the full executed population; top_ten and weak_or_failed are reviewed subsets. Do not expect subset status totals to equal the full-population counts. Flag status counts only if they do not sum to the executed combination count or an entry contradicts its own status.",
        ],
      });

      const output = await callResearchAgent<Record<string, unknown>>({
        sql, ctx, stageKey: "ai_reviewer", taskKey,
        taskType: "ai_review", agentName: "research-reviewer", modelTier: "cheap",
        packet, promptFactory,
        outputFormat: AI_REVIEWER_CONTRACT,
        policy: { maxAttempts: 2, maxRepairAttempts: 0 },
        validateStructured: (value) => {
          const review = value as any;
          const errors = validateAiReviewSelfConsistency(value, packet.artifacts.backtest_review, sourceArtifacts.map((row) => row.artifact_type));
          if (review.pass_fail === 'pass' && sectionReviews.some((section) => section.pass_fail !== 'pass')) {
            errors.push({ path: 'pass_fail', message: 'A non-passing section prevents a passing final review' });
          }
          for (const finding of sectionReviews.flatMap((section) => section.findings || [])) {
            if (!review.findings?.some((candidate: any) => taskInputFingerprint(candidate) === taskInputFingerprint(finding))) {
              errors.push({ path: 'findings', message: `Preserve section finding exactly: ${finding.message}` });
            }
          }
          if (!validateArtifactCitationIds(value, allowedIds).valid) errors.push({ path: 'findings', message: 'Unaccepted evidence citation in review' });
          return errors;
        },
      });

      // Persist generated sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = AI_REVIEWER_CONTRACT.requiredKeys;
      for (const k of subKeys) {
        if (output[k] !== undefined && output[k] !== null) {
          await repo.upsertArtifact({
            research_run_id: ctx.runId,
            asset_id: ctx.assetId,
            profile_id: ctx.profileId || undefined,
            artifact_type: k,
            scope_key: `${ctx.assetSlug}-${k.replace(/_/g, "-")}`,
            status: "validated",
            content_json: output[k] as Record<string, unknown>,
            schema_version: "3.0.0",
            validator_version: "1.0.0",
            prompt_version: "current",
            created_by: "system-research-os",
            idempotency_key: `${ctx.runId}-${k}`,
          });
        }
      }

      const repairRequested = output.pass_fail !== 'pass'
        && await requestFocusedReviewRepair(sql, ctx.runId, output.findings as any[] || []);
      return { ...output, repair_requested: repairRequested };
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: ResearchRunContext, _output: unknown): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const errors: string[] = [];
      const artifactKeys = AI_REVIEWER_CONTRACT.requiredKeys;
      for (const k of artifactKeys) {
        const rows = await sql`
          SELECT COUNT(*) as cnt FROM research_artifacts
          WHERE research_run_id = ${ctx.runId}
            AND artifact_type = ${k}
            AND status IN ('validated', 'accepted')
        `;
        if (Number(rows[0].cnt) === 0) {
          errors.push(`Missing required artifact: ${k}`);
        }
      }
      return makeValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
