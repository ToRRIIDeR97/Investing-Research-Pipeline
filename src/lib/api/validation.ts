import { z } from "zod";

// Asset schemas
export const createAssetSchema = z.object({
  canonical_name: z.string().min(1).max(500),
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9-]+$/),
  asset_kind: z.enum([
    "equity",
    "crypto_asset",
    "commodity",
    "fund",
    "index",
    "private_asset",
    "special_situation",
  ]),
  base_currency: z.string().max(10).optional(),
  home_country: z.string().max(100).optional(),
  sector: z.string().max(200).optional(),
  industry: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
});

// valuation_refresh and source_update are no longer created: they ran all 24 stages on lower evidence targets.
// A refresh is a new run of the original type linked through prior_run_id. Historical rows stay readable.
export const createResearchRunSchema = z.object({
  run_type: z.enum([
    "quick_scan",
    "deep_dive",
    "thesis_investigation",
    "backtest_only",
    "full_initiation_report",
  ]),
  // Omitted: link the asset's latest completed or approved run. null: start fresh. An id: that run of the same asset.
  prior_run_id: z.string().uuid().nullable().optional(),
  research_question: z.string().max(5000).optional(),
  requested_by: z.string().max(200).optional(),
  profile_id: z.string().uuid().optional(),
  budget_limit_usd: z.number().positive().optional(),
  forecast_years: z.number().int().min(3).max(10).optional(),
  source_cutoff_at: z.string().datetime().optional(),
  market_data_cutoff_at: z.string().datetime().optional(),
});

export const reviewDecisionSchema = z.object({
  status: z.enum([
    "reject",
    "watchlist",
    "needs_more_work",
    "approved_for_tracking",
    "approved_for_position",
    "archived",
  ]),
  conviction: z.string().max(200).optional(),
  priority: z.string().max(100).optional(),
  watchlist_reason: z.string().max(2000).optional(),
  position_sizing_note: z.string().max(2000).optional(),
  what_would_change_mind: z.string().max(2000).optional(),
  open_questions: z.string().max(5000).optional(),
  reviewed_by: z.string().max(200),
});

export const evidenceClaimSchema = z.object({
  claim_text: z.string().min(1).max(10000),
  claim_type: z.string().min(1).max(200),
  claim_category: z.enum(["fact", "estimate", "assumption", "opinion"]),
  polarity: z.string().max(100).optional(),
  period_start: z.string().optional(),
  period_end: z.string().optional(),
  as_of_date: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  generated_by: z.string().min(1).max(200),
  no_source_reason: z.string().max(2000).optional(),
  source_document_id: z.string().uuid().optional(),
  document_chunk_id: z.string().uuid().optional(),
  extracted_table_id: z.string().uuid().optional(),
});

export const stageOutputSchema = z.object({
  target_table: z.string().min(1),
  output_schema_key: z.string().min(1),
  output_schema_version: z.number().int().positive(),
  payload_json: z.record(z.unknown()),
  created_by_agent: z.string().min(1),
});
