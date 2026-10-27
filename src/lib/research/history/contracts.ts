/**
 * Twenty-quarter historical record contracts and types for Research OS v3.
 */

import { z } from "zod";

export const Periodicity = z.enum(["quarterly", "annual", "ttm"]);
export type Periodicity = z.infer<typeof Periodicity>;

export const ReportingBasis = z.enum(["gaap", "non_gaap", "adjusted", "as_reported"]);
export type ReportingBasis = z.infer<typeof ReportingBasis>;

export const MetricType = z.enum(["reported", "normalized", "calculated", "reconciled"]);
export type MetricType = z.infer<typeof MetricType>;

export const HistoricalObservation = z.object({
  id: z.string().guid().optional(),
  metric_key: z.string().min(1),
  metric_definition_id: z.string().guid().optional(),
  value_numeric: z.number().nullable(),
  value_text: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  segment: z.string().nullable().optional(),
  geography: z.string().nullable().optional(),
  period_start: z.string().date().nullable().optional(),
  period_end: z.string().date().nullable().optional(),
  fiscal_year: z.number().int().nullable(),
  fiscal_quarter: z.number().int().min(1).max(4).nullable().optional(),
  filing_or_release_date: z.string().date().nullable().optional(),
  available_at: z.string().date().nullable().optional(),
  periodicity: Periodicity,
  reporting_basis: ReportingBasis,
  metric_type: MetricType,
  restatement_version: z.number().int().default(0),
  formula_or_adjustment: z.string().nullable().optional(),
  source_document_id: z.string().guid().nullable().optional(),
  evidence_claim_id: z.string().guid().nullable().optional(),
  comparability_status: z.enum(["comparable", "definition_changed", "revised", "estimated", "blocked"]).default("comparable"),
  confidence: z.number().min(0).max(1).default(1),
  metadata_json: z.record(z.string(), z.unknown()).default({}),
});

export type HistoricalObservation = z.infer<typeof HistoricalObservation>;

export const HistoricalCoverageCell = z.object({
  metric_key: z.string(),
  fiscal_year: z.number(),
  fiscal_quarter: z.number().nullable(),
  present: z.boolean(),
  basis: ReportingBasis,
  source_document_id: z.string().guid().nullable().optional(),
  evidence_claim_id: z.string().guid().nullable().optional(),
  why_missing: z.string().optional(),
});

export type HistoricalCoverageCell = z.infer<typeof HistoricalCoverageCell>;

export const HistoricalCoverageMatrix = z.object({
  asset_id: z.string().guid(),
  run_id: z.string().guid().nullable().optional(),
  start_fiscal_year: z.number(),
  start_fiscal_quarter: z.number(),
  end_fiscal_year: z.number(),
  end_fiscal_quarter: z.number(),
  quarters_required: z.number().int(),
  quarters_present: z.number().int(),
  cells: z.array(HistoricalCoverageCell),
  gaps: z.array(z.object({
    metric_key: z.string(),
    fiscal_year: z.number().optional(),
    fiscal_quarter: z.number().nullable().optional(),
    why_missing: z.string(),
    blocks: z.string().optional(),
  })).default([]),
  is_complete: z.boolean(),
});

export type HistoricalCoverageMatrix = z.infer<typeof HistoricalCoverageMatrix>;

export const ReconciliationIssue = z.object({
  issue_type: z.enum([
    "annual_quarterly_mismatch",
    "gaap_non_gaap_conflict",
    "segment_consolidated_mismatch",
    "restatement",
    "fiscal_calendar",
    "currency_definition",
    "cash_flow_bridge",
    "point_in_time_lookahead",
  ]),
  severity: z.enum(["blocking", "warning", "info"]),
  description: z.string(),
  metric_key: z.string().optional(),
  fiscal_year: z.number().optional(),
  left_value: z.number().optional(),
  right_value: z.number().optional(),
  left_basis: z.string().optional(),
  right_basis: z.string().optional(),
});

export type ReconciliationIssue = z.infer<typeof ReconciliationIssue>;

export const HistoricalRecord = z.object({
  asset_id: z.string().guid(),
  run_id: z.string().guid().nullable().optional(),
  observations: z.array(HistoricalObservation),
  coverage: HistoricalCoverageMatrix,
  reconciliation_issues: z.array(ReconciliationIssue).default([]),
  ttm_series: z.array(HistoricalObservation).default([]),
  statistics: z.record(z.string(), z.record(z.string(), z.number())).default({}),
});

export type HistoricalRecord = z.infer<typeof HistoricalRecord>;
