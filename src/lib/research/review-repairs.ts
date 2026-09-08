import { ARTIFACT_DEPENDENCIES } from './artifact-packets';
import { STAGE_OUTPUT_CONTRACTS } from './stage-contracts';
import { STAGE_DEPENDENCIES } from '../workflow/stages';
import type { Sql } from './run-context';

export function focusedReviewRepairPlan(findings: Array<{ severity?: string; artifact_refs?: string[] }>) {
  const roots = [...new Set(findings.filter((finding) => finding.severity === 'blocker').flatMap((finding) => finding.artifact_refs || []))];
  const supported = new Set([...Object.keys(ARTIFACT_DEPENDENCIES).filter((key) => key !== 'expected_return_matrix'), 'report_composition']);
  if (!roots.length || roots.some((key) => !supported.has(key))) return null;
  const artifacts = new Set(roots);
  for (let changed = true; changed;) {
    changed = false;
    for (const [key, dependencies] of Object.entries(ARTIFACT_DEPENDENCIES)) {
      if (!artifacts.has(key) && dependencies.some((dependency) => artifacts.has(dependency))) { artifacts.add(key); changed = true; }
    }
  }
  const stages = new Set(Object.entries(STAGE_OUTPUT_CONTRACTS).filter(([, contract]) => contract.requiredKeys.some((key) => artifacts.has(key))).map(([key]) => key));
  if (artifacts.has('report_composition')) stages.add('decision_synthesis');
  for (let changed = true; changed;) {
    changed = false;
    for (const [key, dependencies] of Object.entries(STAGE_DEPENDENCIES)) {
      if (!stages.has(key) && dependencies.some((dependency) => stages.has(dependency))) { stages.add(key); changed = true; }
    }
  }
  return { roots, artifacts: [...artifacts], stages: [...stages] };
}

/** One targeted review repair round per run. Analytical revisions use the remaining task budget. */
export async function requestFocusedReviewRepair(sql: Sql, runId: string, findings: Array<{ severity?: string; artifact_refs?: string[]; message?: string }>) {
  const plan = focusedReviewRepairPlan(findings);
  if (!plan) return false;
  return sql.begin(async (tx) => {
    const [run] = await tx`SELECT metadata_json FROM research_runs WHERE id = ${runId} FOR UPDATE`;
    if (Number(run?.metadata_json?.ai_review_repairs_used || 0) >= 1) return false;
    const reason = `AI section review requested repair: ${findings.filter((finding) => finding.severity === 'blocker').map((finding) => finding.message).join('; ')}`;
    await tx`UPDATE research_tasks SET status = 'failed', validation_status = 'invalid', failure_reason = ${reason}, updated_at = NOW()
      WHERE research_run_id = ${runId} AND status = 'completed'
        AND (output_json ?| ${plan.artifacts} OR (task_type = 'report_composition' AND ${plan.artifacts.includes('report_composition')}))`;
    await tx`UPDATE research_artifacts SET status = 'rejected', updated_at = NOW()
      WHERE research_run_id = ${runId} AND artifact_type = ANY(${plan.artifacts})`;
    await tx`UPDATE research_stages SET status = 'pending', completed_at = NULL, failure_reason = NULL,
      validation_result_json = '{}'::jsonb, updated_at = NOW() WHERE research_run_id = ${runId} AND stage_key = ANY(${plan.stages})`;
    await tx`UPDATE research_runs SET status = 'running', metadata_json = metadata_json || ${tx.json({ ai_review_repairs_used: 1, ai_review_repair: { ...plan, reason } })},
      updated_at = NOW() WHERE id = ${runId}`;
    return true;
  });
}
