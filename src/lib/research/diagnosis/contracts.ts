/**
 * Historical diagnosis contracts for Research OS v3.
 */

import { z } from "zod/v4";

export const StructuralCyclicalTemporary = z.enum([
  "structural",
  "cyclical",
  "temporary",
  "accounting",
  "unexplained",
]);

export type StructuralCyclicalTemporary = z.infer<typeof StructuralCyclicalTemporary>;

export const TrendDirection = z.enum(["increasing", "decreasing", "stable", "non_monotonic", "insufficient_history"]);
export type TrendDirection = z.infer<typeof TrendDirection>;

export const DiagnosisRecord = z.object({
  metric_key: z.string().min(1),
  current_level: z.number(),
  historical_mean: z.number(),
  historical_median: z.number(),
  historical_min: z.number(),
  historical_max: z.number(),
  historical_std_dev: z.number(),
  observation_count: z.number().int().positive().optional(),
  trend: TrendDirection,
  stability: z.number().min(0).max(1),
  inflection_period: z.string().optional(),
  inflection_z_score: z.number().optional(),
  causal_process_node: z.string().optional(),
  management_control: z.enum(["high", "medium", "low", "unassigned"]).default("unassigned"),
  structural_cyclical_temporary_or_accounting: StructuralCyclicalTemporary,
  moat_implication: z.string().optional(),
  forecast_implication: z.string().min(1),
  supporting_claim_ids: z.array(z.guid()),
  supporting_observation_ids: z.array(z.guid()).optional(),
  source_gap: z.string().optional(),
  contradicting_claim_ids: z.array(z.guid()).default([]),
  confidence: z.number().min(0).max(1),
});

export type DiagnosisRecord = z.infer<typeof DiagnosisRecord>;

export const HistoricalDiagnosisArtifact = z.object({
  artifact_type: z.literal("historical_diagnosis"),
  run_id: z.guid().optional(),
  asset_id: z.guid(),
  diagnoses: z.array(DiagnosisRecord).min(1),
  unexplained_inflections: z.array(
    z.object({
      metric_key: z.string(),
      period: z.string(),
      z_score: z.number(),
    })
  ).default([]),
});

export type HistoricalDiagnosisArtifact = z.infer<typeof HistoricalDiagnosisArtifact>;

export type DiagnosisValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export function validateHistoricalDiagnosis(content: unknown): DiagnosisValidationResult {
  const parsed = HistoricalDiagnosisArtifact.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const d of parsed.data.diagnoses) {
    if (d.structural_cyclical_temporary_or_accounting === "structural" && !d.causal_process_node) {
      errors.push(
        `Metric ${d.metric_key} labeled structural without a causal process node.`
      );
    }
    if (d.inflection_period && !d.causal_process_node && d.structural_cyclical_temporary_or_accounting !== "unexplained") {
      warnings.push(
        `Metric ${d.metric_key} has an inflection period but no causal process node.`
      );
    }
    if (!d.forecast_implication || d.forecast_implication.length < 3) {
      errors.push(`Metric ${d.metric_key} lacks a forecast implication.`);
    }
    if (d.supporting_claim_ids.length === 0 && !d.supporting_observation_ids?.length) {
      if (!d.source_gap) errors.push(`Metric ${d.metric_key} has no evidence or disclosed source gap.`);
      else warnings.push(`Metric ${d.metric_key}: ${d.source_gap}`);
    }
    if (d.structural_cyclical_temporary_or_accounting === "structural" && d.confidence < 0.5) {
      warnings.push(`Metric ${d.metric_key} claims structural change with low confidence.`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
