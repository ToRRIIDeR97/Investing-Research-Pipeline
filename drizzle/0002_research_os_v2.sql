ALTER TABLE "research_runs" ADD COLUMN IF NOT EXISTS "pipeline_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "scenarios" ADD COLUMN IF NOT EXISTS "valuation_model_run_id" uuid;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_run_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "research_run_id" uuid NOT NULL,
  "source_document_id" uuid NOT NULL,
  "role" text DEFAULT 'supporting_source' NOT NULL,
  "discovery_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "research_run_sources_run_document_unique" UNIQUE("research_run_id", "source_document_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_document_relations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "parent_source_document_id" uuid NOT NULL,
  "child_source_document_id" uuid NOT NULL,
  "relationship_type" text NOT NULL,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "source_document_relations_unique" UNIQUE("parent_source_document_id", "child_source_document_id", "relationship_type")
);
--> statement-breakpoint
ALTER TABLE "research_run_sources" ADD CONSTRAINT "research_run_sources_run_fk" FOREIGN KEY ("research_run_id") REFERENCES "research_runs"("id");
--> statement-breakpoint
ALTER TABLE "research_run_sources" ADD CONSTRAINT "research_run_sources_source_fk" FOREIGN KEY ("source_document_id") REFERENCES "source_documents"("id");
--> statement-breakpoint
ALTER TABLE "source_document_relations" ADD CONSTRAINT "source_document_relations_parent_fk" FOREIGN KEY ("parent_source_document_id") REFERENCES "source_documents"("id");
--> statement-breakpoint
ALTER TABLE "source_document_relations" ADD CONSTRAINT "source_document_relations_child_fk" FOREIGN KEY ("child_source_document_id") REFERENCES "source_documents"("id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_run_sources_run_idx" ON "research_run_sources" ("research_run_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analysis_sections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "research_run_id" uuid NOT NULL,
  "profile_id" uuid,
  "module_key" text NOT NULL,
  "title" text NOT NULL,
  "content_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "supporting_claim_ids" uuid[] DEFAULT '{}' NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "analysis_sections_run_module_unique" UNIQUE("research_run_id", "module_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "valuation_model_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "research_run_id" uuid NOT NULL,
  "asset_id" uuid NOT NULL,
  "profile_id" uuid NOT NULL,
  "valuation_method_id" uuid,
  "model_key" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "input_manifest_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "assumptions_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "outputs_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "validation_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "reproducible" boolean DEFAULT false NOT NULL,
  "error_message" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "valuation_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "valuation_model_run_id" uuid NOT NULL,
  "artifact_type" text NOT NULL,
  "title" text NOT NULL,
  "storage_path" text NOT NULL,
  "content_hash" text,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "indicator_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "research_run_id" uuid NOT NULL,
  "profile_id" uuid NOT NULL,
  "indicator_key" text NOT NULL,
  "name" text NOT NULL,
  "family" text NOT NULL,
  "hypothesis" text NOT NULL,
  "calculation_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "input_metric_ids" uuid[] DEFAULT '{}' NOT NULL,
  "supporting_claim_ids" uuid[] DEFAULT '{}' NOT NULL,
  "lookahead_risk" text NOT NULL,
  "backtestability" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "indicator_definitions_run_key_unique" UNIQUE("research_run_id", "indicator_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "indicator_observations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "indicator_definition_id" uuid NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "available_at" timestamp with time zone NOT NULL,
  "value_numeric" numeric,
  "value_text" text,
  "input_observation_ids" uuid[] DEFAULT '{}' NOT NULL,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strategy_combinations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "research_run_id" uuid NOT NULL,
  "combination_key" text NOT NULL,
  "name" text NOT NULL,
  "hypothesis" text NOT NULL,
  "definition_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'proposed' NOT NULL,
  "backtest_run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "strategy_combinations_run_key_unique" UNIQUE("research_run_id", "combination_key")
);
--> statement-breakpoint
ALTER TABLE "analysis_sections" ADD CONSTRAINT "analysis_sections_run_fk" FOREIGN KEY ("research_run_id") REFERENCES "research_runs"("id");
--> statement-breakpoint
ALTER TABLE "analysis_sections" ADD CONSTRAINT "analysis_sections_profile_fk" FOREIGN KEY ("profile_id") REFERENCES "research_profiles"("id");
--> statement-breakpoint
ALTER TABLE "valuation_model_runs" ADD CONSTRAINT "valuation_model_runs_run_fk" FOREIGN KEY ("research_run_id") REFERENCES "research_runs"("id");
--> statement-breakpoint
ALTER TABLE "valuation_model_runs" ADD CONSTRAINT "valuation_model_runs_asset_fk" FOREIGN KEY ("asset_id") REFERENCES "assets"("id");
--> statement-breakpoint
ALTER TABLE "valuation_model_runs" ADD CONSTRAINT "valuation_model_runs_profile_fk" FOREIGN KEY ("profile_id") REFERENCES "research_profiles"("id");
--> statement-breakpoint
ALTER TABLE "valuation_model_runs" ADD CONSTRAINT "valuation_model_runs_method_fk" FOREIGN KEY ("valuation_method_id") REFERENCES "valuation_methods"("id");
--> statement-breakpoint
ALTER TABLE "valuation_artifacts" ADD CONSTRAINT "valuation_artifacts_model_fk" FOREIGN KEY ("valuation_model_run_id") REFERENCES "valuation_model_runs"("id");
--> statement-breakpoint
ALTER TABLE "indicator_definitions" ADD CONSTRAINT "indicator_definitions_run_fk" FOREIGN KEY ("research_run_id") REFERENCES "research_runs"("id");
--> statement-breakpoint
ALTER TABLE "indicator_definitions" ADD CONSTRAINT "indicator_definitions_profile_fk" FOREIGN KEY ("profile_id") REFERENCES "research_profiles"("id");
--> statement-breakpoint
ALTER TABLE "indicator_observations" ADD CONSTRAINT "indicator_observations_definition_fk" FOREIGN KEY ("indicator_definition_id") REFERENCES "indicator_definitions"("id");
--> statement-breakpoint
ALTER TABLE "strategy_combinations" ADD CONSTRAINT "strategy_combinations_run_fk" FOREIGN KEY ("research_run_id") REFERENCES "research_runs"("id");
--> statement-breakpoint
ALTER TABLE "strategy_combinations" ADD CONSTRAINT "strategy_combinations_backtest_fk" FOREIGN KEY ("backtest_run_id") REFERENCES "backtest_runs"("id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analysis_sections_run_idx" ON "analysis_sections" ("research_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "valuation_model_runs_run_idx" ON "valuation_model_runs" ("research_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "valuation_artifacts_model_idx" ON "valuation_artifacts" ("valuation_model_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "indicator_definitions_run_idx" ON "indicator_definitions" ("research_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "indicator_observations_definition_available_idx" ON "indicator_observations" ("indicator_definition_id", "available_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategy_combinations_run_idx" ON "strategy_combinations" ("research_run_id");
--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_valuation_model_run_fk" FOREIGN KEY ("valuation_model_run_id") REFERENCES "valuation_model_runs"("id");
