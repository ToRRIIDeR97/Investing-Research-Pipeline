CREATE TABLE IF NOT EXISTS "research_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid NOT NULL REFERENCES "research_runs"("id"),
	"asset_id" uuid NOT NULL REFERENCES "assets"("id"),
	"profile_id" uuid REFERENCES "research_profiles"("id"),
	"artifact_type" text NOT NULL,
	"scope_key" text NOT NULL,
	"artifact_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"content_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schema_version" text DEFAULT '3.0.0' NOT NULL,
	"validator_version" text DEFAULT '1.0.0' NOT NULL,
	"prompt_version" text DEFAULT '1.0.0' NOT NULL,
	"validation_result_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"supersedes_artifact_id" uuid REFERENCES "research_artifacts"("id"),
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_artifact_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL REFERENCES "research_artifacts"("id"),
	"depends_on_artifact_id" uuid NOT NULL REFERENCES "research_artifacts"("id"),
	"dependency_type" text DEFAULT 'required' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_artifact_dependencies_unique" UNIQUE("artifact_id","depends_on_artifact_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_artifact_claim_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL REFERENCES "research_artifacts"("id"),
	"evidence_claim_id" uuid NOT NULL REFERENCES "evidence_claims"("id"),
	"support_type" text DEFAULT 'supports' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_artifact_claim_links_unique" UNIQUE("artifact_id","evidence_claim_id","support_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_assumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid NOT NULL REFERENCES "research_runs"("id"),
	"assumption_key" text NOT NULL,
	"assumption_category" text NOT NULL,
	"value_numeric" numeric,
	"value_text" text,
	"unit" text,
	"currency" text,
	"range_low" numeric,
	"range_high" numeric,
	"classification" text NOT NULL,
	"causal_mechanism" text,
	"time_lag" text,
	"falsification_condition" text,
	"model_input_path" text,
	"confidence" numeric,
	"status" text DEFAULT 'draft' NOT NULL,
	"assumption_version" integer DEFAULT 1 NOT NULL,
	"supersedes_assumption_id" uuid REFERENCES "research_assumptions"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_assumption_claim_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assumption_id" uuid NOT NULL REFERENCES "research_assumptions"("id"),
	"evidence_claim_id" uuid NOT NULL REFERENCES "evidence_claims"("id"),
	"support_type" text DEFAULT 'supports' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_assumption_claim_links_unique" UNIQUE("assumption_id","evidence_claim_id","support_type")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_artifacts_run_idx" ON "research_artifacts" ("research_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_artifacts_type_idx" ON "research_artifacts" ("artifact_type");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "research_artifacts_run_type_scope_current_unique" ON "research_artifacts" ("research_run_id","artifact_type","scope_key") WHERE "research_artifacts"."status" = 'accepted';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_assumptions_run_idx" ON "research_assumptions" ("research_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_assumptions_key_idx" ON "research_assumptions" ("assumption_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "research_assumptions_run_key_current_unique" ON "research_assumptions" ("research_run_id","assumption_key") WHERE "research_assumptions"."status" = 'accepted';
