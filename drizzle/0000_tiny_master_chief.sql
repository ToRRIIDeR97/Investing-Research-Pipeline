CREATE TABLE "agent_output_staging" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"target_table" text NOT NULL,
	"target_record_id" uuid,
	"output_schema_key" text NOT NULL,
	"output_schema_version" integer NOT NULL,
	"payload_json" jsonb NOT NULL,
	"validation_status" text DEFAULT 'pending' NOT NULL,
	"validation_errors_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"created_by_agent" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text
);
--> statement-breakpoint
CREATE TABLE "agent_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid,
	"task_id" uuid,
	"agent_name" text NOT NULL,
	"tool_name" text,
	"tool_input_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_output_json" jsonb,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_budget_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_call_log_id" uuid,
	"research_run_id" uuid,
	"stage_id" uuid,
	"task_id" uuid,
	"model_tier" text NOT NULL,
	"cost_usd" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_budget_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"model_tier" text,
	"period" text,
	"limit_usd" numeric NOT NULL,
	"hard_limit" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_call_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid,
	"stage_id" uuid,
	"task_id" uuid,
	"agent_name" text,
	"model_provider" text NOT NULL,
	"model_name" text NOT NULL,
	"model_tier" text NOT NULL,
	"prompt_version" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric,
	"latency_ms" integer,
	"status" text NOT NULL,
	"error_message" text,
	"request_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"classification_system" text NOT NULL,
	"classification_key" text NOT NULL,
	"confidence" numeric,
	"assigned_by" text NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_classifications_unique" UNIQUE("asset_id","classification_system","classification_key")
);
--> statement-breakpoint
CREATE TABLE "asset_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"relationship_type" text NOT NULL,
	"active_from" date,
	"active_to" date,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_name" text NOT NULL,
	"slug" text NOT NULL,
	"asset_kind" text NOT NULL,
	"base_currency" text,
	"home_country" text,
	"sector" text,
	"industry" text,
	"description" text,
	"primary_profile_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"instrument_type" text NOT NULL,
	"name" text NOT NULL,
	"currency" text,
	"isin" text,
	"cusip" text,
	"figi" text,
	"contract_specs_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active_from" date,
	"active_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"entity_type" text NOT NULL,
	"country" text,
	"lei" text,
	"cik" text,
	"website_url" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"exchange" text,
	"mic" text,
	"currency" text,
	"listing_type" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"active_from" date,
	"active_to" date,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_document_id" uuid NOT NULL,
	"document_parse_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"section_title" text,
	"page_start" integer,
	"page_end" integer,
	"char_start" integer,
	"char_end" integer,
	"text" text NOT NULL,
	"token_count" integer,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_chunk_id" uuid NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding_dimension" integer NOT NULL,
	"embedding" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_embeddings_chunk_model_unique" UNIQUE("document_chunk_id","embedding_model")
);
--> statement-breakpoint
CREATE TABLE "document_parses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_document_id" uuid NOT NULL,
	"parser_name" text NOT NULL,
	"parser_version" text NOT NULL,
	"parse_config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"warnings_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output_storage_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "document_parses_unique" UNIQUE("source_document_id","parser_name","parser_version","parse_config_json")
);
--> statement-breakpoint
CREATE TABLE "extracted_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_document_id" uuid NOT NULL,
	"document_parse_id" uuid NOT NULL,
	"table_index" integer NOT NULL,
	"page_start" integer,
	"page_end" integer,
	"table_title" text,
	"table_json" jsonb NOT NULL,
	"table_csv_path" text,
	"confidence" numeric,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid,
	"research_run_id" uuid,
	"source_type" text NOT NULL,
	"title" text NOT NULL,
	"publisher" text,
	"author" text,
	"url" text,
	"canonical_url" text,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"period_start" timestamp,
	"period_end" timestamp,
	"file_hash" text NOT NULL,
	"mime_type" text,
	"language" text,
	"storage_path" text NOT NULL,
	"source_quality_score" numeric,
	"license_notes" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_documents_file_hash_unique" UNIQUE("file_hash")
);
--> statement-breakpoint
CREATE TABLE "source_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_document_id" uuid NOT NULL,
	"document_parse_id" uuid,
	"document_chunk_id" uuid,
	"extracted_table_id" uuid,
	"page_start" integer,
	"page_end" integer,
	"char_start" integer,
	"char_end" integer,
	"table_row" integer,
	"table_column" integer,
	"locator_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_claim_id" uuid NOT NULL,
	"to_claim_id" uuid NOT NULL,
	"relationship_type" text NOT NULL,
	"confidence" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"research_run_id" uuid,
	"claim_text" text NOT NULL,
	"claim_type" text NOT NULL,
	"claim_category" text NOT NULL,
	"polarity" text,
	"period_start" date,
	"period_end" date,
	"as_of_date" date,
	"confidence" numeric,
	"generated_by" text NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"no_source_reason" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supersedes_id" uuid
);
--> statement-breakpoint
CREATE TABLE "evidence_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_claim_id" uuid NOT NULL,
	"source_location_id" uuid NOT NULL,
	"support_type" text DEFAULT 'supports' NOT NULL,
	"quoted_text" text,
	"confidence" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"research_run_id" uuid,
	"gap_key" text,
	"description" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"owner" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_note" text
);
--> statement-breakpoint
CREATE TABLE "metric_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metric_key" text NOT NULL,
	"display_name" text NOT NULL,
	"metric_category" text NOT NULL,
	"unit_type" text,
	"default_unit" text,
	"default_currency" text,
	"description" text,
	"applicable_profile_keys" text[] DEFAULT '{}' NOT NULL,
	"calculation_method" text,
	"cheaper_when" text,
	"higher_is_better" boolean,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_definitions_metric_key_unique" UNIQUE("metric_key")
);
--> statement-breakpoint
CREATE TABLE "metric_observation_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metric_observation_id" uuid NOT NULL,
	"input_metric_observation_id" uuid NOT NULL,
	"relationship_type" text DEFAULT 'calculation_input' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"research_run_id" uuid,
	"metric_definition_id" uuid NOT NULL,
	"period_start" date,
	"period_end" date,
	"as_of_date" date,
	"available_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"retrieved_at" timestamp with time zone,
	"value_numeric" numeric,
	"value_text" text,
	"unit" text,
	"currency" text,
	"data_provider" text,
	"source_document_id" uuid,
	"evidence_claim_id" uuid,
	"calculation_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" numeric,
	"revision_number" integer DEFAULT 0 NOT NULL,
	"is_revised" boolean DEFAULT false NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supersedes_id" uuid
);
--> statement-breakpoint
CREATE TABLE "asset_profile_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"research_run_id" uuid,
	"profile_id" uuid NOT NULL,
	"assignment_reason" text,
	"assigned_by" text NOT NULL,
	"confidence" numeric,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_module_schemas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"module_key" text NOT NULL,
	"schema_version" integer NOT NULL,
	"json_schema" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_module_schemas_unique" UNIQUE("profile_id","module_key","schema_version")
);
--> statement-breakpoint
CREATE TABLE "research_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_key" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"asset_kinds" text[] DEFAULT '{}' NOT NULL,
	"description" text,
	"required_modules_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"optional_modules_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"forbidden_methods_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_valuation_lenses_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_scenario_drivers_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completion_criteria_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"validator_config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_profiles_key_version_unique" UNIQUE("profile_key","version")
);
--> statement-breakpoint
CREATE TABLE "catalysts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"research_run_id" uuid NOT NULL,
	"catalyst_name" text NOT NULL,
	"catalyst_type" text NOT NULL,
	"expected_date" date,
	"date_confidence" text,
	"description" text,
	"upside_downside" text,
	"evidence_claim_ids" uuid[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid,
	"research_run_id" uuid,
	"export_type" text NOT NULL,
	"template_version" text,
	"storage_path" text NOT NULL,
	"content_hash" text,
	"generated_by" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notebook_id" uuid NOT NULL,
	"parent_block_id" uuid,
	"block_order" integer NOT NULL,
	"block_type" text NOT NULL,
	"content_json" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_block_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"relationship_type" text DEFAULT 'references' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notebooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid,
	"research_run_id" uuid,
	"title" text NOT NULL,
	"notebook_type" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"research_run_id" uuid NOT NULL,
	"status" text NOT NULL,
	"conviction" text,
	"priority" text,
	"watchlist_reason" text,
	"position_sizing_note" text,
	"what_would_change_mind" text,
	"open_questions" text,
	"follow_up_date" date,
	"reviewed_by" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"research_run_id" uuid NOT NULL,
	"risk_name" text NOT NULL,
	"risk_type" text NOT NULL,
	"description" text,
	"severity" text NOT NULL,
	"probability" text,
	"evidence_claim_ids" uuid[] DEFAULT '{}' NOT NULL,
	"mitigants_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"what_would_confirm" text,
	"what_would_disconfirm" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "theses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"research_run_id" uuid NOT NULL,
	"one_sentence_thesis" text NOT NULL,
	"why_now" text,
	"market_missing" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thesis_drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thesis_id" uuid NOT NULL,
	"driver_name" text NOT NULL,
	"driver_type" text NOT NULL,
	"description" text,
	"value_impact" text,
	"confidence" numeric,
	"evidence_claim_ids" uuid[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"research_run_id" uuid NOT NULL,
	"scenario_name" text NOT NULL,
	"scenario_type" text NOT NULL,
	"time_horizon" text,
	"probability" numeric,
	"value_anchor" numeric,
	"currency" text,
	"assumptions_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"supporting_claim_ids" uuid[] DEFAULT '{}' NOT NULL,
	"confidence" numeric,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "valuation_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"method_key" text NOT NULL,
	"name" text NOT NULL,
	"method_family" text NOT NULL,
	"description" text,
	"applicable_profile_keys" text[] DEFAULT '{}' NOT NULL,
	"forbidden_profile_keys" text[] DEFAULT '{}' NOT NULL,
	"requires_code" boolean DEFAULT false NOT NULL,
	"requires_market_data" boolean DEFAULT false NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "valuation_methods_method_key_unique" UNIQUE("method_key")
);
--> statement-breakpoint
CREATE TABLE "valuation_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"research_run_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"valuation_method_id" uuid,
	"metric_definition_id" uuid,
	"signal_key" text NOT NULL,
	"signal_name" text NOT NULL,
	"lens_family" text NOT NULL,
	"current_value" numeric,
	"current_value_text" text,
	"comparison_range_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"percentile" numeric,
	"z_score" numeric,
	"cheaper_when" text,
	"signal" text NOT NULL,
	"cheapness_score" numeric,
	"confidence" numeric,
	"source_document_id" uuid,
	"evidence_claim_id" uuid,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"run_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"research_question" text,
	"requested_by" text,
	"profile_id" uuid,
	"profile_version" integer,
	"source_cutoff_at" timestamp with time zone,
	"market_data_cutoff_at" timestamp with time zone,
	"budget_limit_usd" numeric,
	"actual_cost_usd" numeric DEFAULT '0' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure_reason" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid NOT NULL,
	"stage_key" text NOT NULL,
	"stage_order" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"allowed_model_tiers" text[] DEFAULT '{}' NOT NULL,
	"max_retries" integer DEFAULT 2 NOT NULL,
	"budget_limit_usd" numeric,
	"completion_criteria_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"validator_config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"validation_result_json" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_stages_run_key_unique" UNIQUE("research_run_id","stage_key"),
	CONSTRAINT "research_stages_run_order_unique" UNIQUE("research_run_id","stage_order")
);
--> statement-breakpoint
CREATE TABLE "research_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"task_type" text NOT NULL,
	"agent_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"input_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_json" jsonb,
	"validation_status" text,
	"validation_result_json" jsonb,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric DEFAULT '0' NOT NULL,
	"idempotency_key" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_validation_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"validator_key" text NOT NULL,
	"status" text NOT NULL,
	"findings_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_missing_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	"dependency_type" text DEFAULT 'success' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_output_staging" ADD CONSTRAINT "agent_output_staging_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_output_staging" ADD CONSTRAINT "agent_output_staging_stage_id_research_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."research_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_output_staging" ADD CONSTRAINT "agent_output_staging_task_id_research_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."research_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_traces" ADD CONSTRAINT "agent_traces_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_traces" ADD CONSTRAINT "agent_traces_task_id_research_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."research_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_budget_ledger" ADD CONSTRAINT "model_budget_ledger_model_call_log_id_model_call_logs_id_fk" FOREIGN KEY ("model_call_log_id") REFERENCES "public"."model_call_logs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_budget_ledger" ADD CONSTRAINT "model_budget_ledger_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_budget_ledger" ADD CONSTRAINT "model_budget_ledger_stage_id_research_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."research_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_budget_ledger" ADD CONSTRAINT "model_budget_ledger_task_id_research_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."research_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_call_logs" ADD CONSTRAINT "model_call_logs_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_call_logs" ADD CONSTRAINT "model_call_logs_stage_id_research_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."research_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_call_logs" ADD CONSTRAINT "model_call_logs_task_id_research_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."research_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_classifications" ADD CONSTRAINT "asset_classifications_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_entities" ADD CONSTRAINT "asset_entities_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_entities" ADD CONSTRAINT "asset_entities_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_primary_profile_id_research_profiles_id_fk" FOREIGN KEY ("primary_profile_id") REFERENCES "public"."research_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_parse_id_document_parses_id_fk" FOREIGN KEY ("document_parse_id") REFERENCES "public"."document_parses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_embeddings" ADD CONSTRAINT "document_embeddings_document_chunk_id_document_chunks_id_fk" FOREIGN KEY ("document_chunk_id") REFERENCES "public"."document_chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_parses" ADD CONSTRAINT "document_parses_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_tables" ADD CONSTRAINT "extracted_tables_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_tables" ADD CONSTRAINT "extracted_tables_document_parse_id_document_parses_id_fk" FOREIGN KEY ("document_parse_id") REFERENCES "public"."document_parses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_locations" ADD CONSTRAINT "source_locations_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_locations" ADD CONSTRAINT "source_locations_document_parse_id_document_parses_id_fk" FOREIGN KEY ("document_parse_id") REFERENCES "public"."document_parses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_locations" ADD CONSTRAINT "source_locations_document_chunk_id_document_chunks_id_fk" FOREIGN KEY ("document_chunk_id") REFERENCES "public"."document_chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_locations" ADD CONSTRAINT "source_locations_extracted_table_id_extracted_tables_id_fk" FOREIGN KEY ("extracted_table_id") REFERENCES "public"."extracted_tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_relationships" ADD CONSTRAINT "claim_relationships_from_claim_id_evidence_claims_id_fk" FOREIGN KEY ("from_claim_id") REFERENCES "public"."evidence_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_relationships" ADD CONSTRAINT "claim_relationships_to_claim_id_evidence_claims_id_fk" FOREIGN KEY ("to_claim_id") REFERENCES "public"."evidence_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_claims" ADD CONSTRAINT "evidence_claims_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_claims" ADD CONSTRAINT "evidence_claims_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_evidence_claim_id_evidence_claims_id_fk" FOREIGN KEY ("evidence_claim_id") REFERENCES "public"."evidence_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_source_location_id_source_locations_id_fk" FOREIGN KEY ("source_location_id") REFERENCES "public"."source_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_gaps" ADD CONSTRAINT "source_gaps_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_gaps" ADD CONSTRAINT "source_gaps_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_observation_inputs" ADD CONSTRAINT "metric_observation_inputs_metric_observation_id_metric_observations_id_fk" FOREIGN KEY ("metric_observation_id") REFERENCES "public"."metric_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_observation_inputs" ADD CONSTRAINT "metric_observation_inputs_input_metric_observation_id_metric_observations_id_fk" FOREIGN KEY ("input_metric_observation_id") REFERENCES "public"."metric_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_metric_definition_id_metric_definitions_id_fk" FOREIGN KEY ("metric_definition_id") REFERENCES "public"."metric_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_evidence_claim_id_evidence_claims_id_fk" FOREIGN KEY ("evidence_claim_id") REFERENCES "public"."evidence_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_supersedes_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."metric_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_profile_assignments" ADD CONSTRAINT "asset_profile_assignments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_profile_assignments" ADD CONSTRAINT "asset_profile_assignments_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_profile_assignments" ADD CONSTRAINT "asset_profile_assignments_profile_id_research_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."research_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_module_schemas" ADD CONSTRAINT "profile_module_schemas_profile_id_research_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."research_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalysts" ADD CONSTRAINT "catalysts_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalysts" ADD CONSTRAINT "catalysts_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_blocks" ADD CONSTRAINT "note_blocks_notebook_id_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."notebooks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_blocks" ADD CONSTRAINT "note_blocks_parent_block_id_fk" FOREIGN KEY ("parent_block_id") REFERENCES "public"."note_blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_note_block_id_note_blocks_id_fk" FOREIGN KEY ("note_block_id") REFERENCES "public"."note_blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebooks" ADD CONSTRAINT "notebooks_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebooks" ADD CONSTRAINT "notebooks_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theses" ADD CONSTRAINT "theses_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theses" ADD CONSTRAINT "theses_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thesis_drivers" ADD CONSTRAINT "thesis_drivers_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "valuation_signals" ADD CONSTRAINT "valuation_signals_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "valuation_signals" ADD CONSTRAINT "valuation_signals_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "valuation_signals" ADD CONSTRAINT "valuation_signals_profile_id_research_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."research_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "valuation_signals" ADD CONSTRAINT "valuation_signals_valuation_method_id_valuation_methods_id_fk" FOREIGN KEY ("valuation_method_id") REFERENCES "public"."valuation_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "valuation_signals" ADD CONSTRAINT "valuation_signals_metric_definition_id_metric_definitions_id_fk" FOREIGN KEY ("metric_definition_id") REFERENCES "public"."metric_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "valuation_signals" ADD CONSTRAINT "valuation_signals_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "valuation_signals" ADD CONSTRAINT "valuation_signals_evidence_claim_id_evidence_claims_id_fk" FOREIGN KEY ("evidence_claim_id") REFERENCES "public"."evidence_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_profile_id_research_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."research_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_stages" ADD CONSTRAINT "research_stages_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_stage_id_research_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."research_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_validation_results" ADD CONSTRAINT "stage_validation_results_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_validation_results" ADD CONSTRAINT "stage_validation_results_stage_id_research_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."research_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_research_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."research_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_research_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."research_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_budget_ledger_run_idx" ON "model_budget_ledger" USING btree ("research_run_id");--> statement-breakpoint
CREATE INDEX "model_budget_ledger_stage_idx" ON "model_budget_ledger" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "model_budget_ledger_tier_idx" ON "model_budget_ledger" USING btree ("model_tier");--> statement-breakpoint
CREATE INDEX "model_budget_limits_scope_idx" ON "model_budget_limits" USING btree ("scope_type","scope_id","model_tier");--> statement-breakpoint
CREATE INDEX "model_call_logs_run_idx" ON "model_call_logs" USING btree ("research_run_id");--> statement-breakpoint
CREATE INDEX "model_call_logs_agent_model_idx" ON "model_call_logs" USING btree ("agent_name","model_name");--> statement-breakpoint
CREATE INDEX "model_call_logs_created_idx" ON "model_call_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "listings_symbol_exchange_idx" ON "listings" USING btree ("symbol","exchange");--> statement-breakpoint
CREATE INDEX "listings_active_symbol_idx" ON "listings" USING btree ("symbol") WHERE "listings"."active_to" IS NULL;--> statement-breakpoint
CREATE INDEX "document_chunks_parse_idx" ON "document_chunks" USING btree ("document_parse_id","chunk_index");--> statement-breakpoint
CREATE INDEX "document_chunks_text_fts_idx" ON "document_chunks" USING gin (to_tsvector('english', "text"));--> statement-breakpoint
CREATE INDEX "metric_obs_asset_metric_asof_idx" ON "metric_observations" USING btree ("asset_id","metric_definition_id","as_of_date");--> statement-breakpoint
CREATE INDEX "metric_obs_period_idx" ON "metric_observations" USING btree ("period_start","period_end");--> statement-breakpoint
CREATE INDEX "metric_obs_available_idx" ON "metric_observations" USING btree ("available_at");--> statement-breakpoint
CREATE INDEX "research_tasks_status_priority_idx" ON "research_tasks" USING btree ("status","priority","created_at");--> statement-breakpoint
CREATE INDEX "research_tasks_run_stage_idx" ON "research_tasks" USING btree ("research_run_id","stage_id");--> statement-breakpoint
CREATE INDEX "research_tasks_idempotency_idx" ON "research_tasks" USING btree ("idempotency_key");