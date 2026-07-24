CREATE TABLE "source_document_metadata" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_document_id" uuid NOT NULL,
	"document_type" text,
	"publication_date" timestamp with time zone,
	"reporting_period_start" timestamp with time zone,
	"reporting_period_end" timestamp with time zone,
	"market_availability_date" timestamp with time zone,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parser_version" text DEFAULT 'unknown' NOT NULL,
	"parse_status" text DEFAULT 'pending' NOT NULL,
	"parse_error" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_document_metadata_source_document_id_unique" UNIQUE("source_document_id")
);
--> statement-breakpoint
CREATE TABLE "source_retrieval_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid NOT NULL,
	"source_role" text NOT NULL,
	"source_url" text,
	"source_title" text,
	"attempt_status" text DEFAULT 'attempted' NOT NULL,
	"failure_reason" text,
	"attempt_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_document_id" uuid NOT NULL,
	"role" text NOT NULL,
	"confidence" integer,
	"rationale" text,
	"assigned_by" text DEFAULT 'system' NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_role_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid NOT NULL,
	"source_role" text NOT NULL,
	"artifact_type" text NOT NULL,
	"source_document_id" uuid,
	"coverage_status" text DEFAULT 'uncovered' NOT NULL,
	"confidence" integer,
	"rationale" text,
	"blocked_artifact_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"human_waived" boolean DEFAULT false NOT NULL,
	"waived_by" text,
	"waived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_document_metadata" ADD CONSTRAINT "source_document_metadata_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_retrieval_attempts" ADD CONSTRAINT "source_retrieval_attempts_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_role_assignments" ADD CONSTRAINT "source_role_assignments_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_role_coverage" ADD CONSTRAINT "source_role_coverage_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_role_coverage" ADD CONSTRAINT "source_role_coverage_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_document_metadata_type_idx" ON "source_document_metadata" USING btree ("document_type");--> statement-breakpoint
CREATE INDEX "source_document_metadata_pub_date_idx" ON "source_document_metadata" USING btree ("publication_date");--> statement-breakpoint
CREATE INDEX "source_retrieval_attempts_run_idx" ON "source_retrieval_attempts" USING btree ("research_run_id");--> statement-breakpoint
CREATE INDEX "source_retrieval_attempts_role_idx" ON "source_retrieval_attempts" USING btree ("source_role");--> statement-breakpoint
CREATE UNIQUE INDEX "source_role_assignments_document_role_unique" ON "source_role_assignments" USING btree ("source_document_id","role");--> statement-breakpoint
CREATE INDEX "source_role_assignments_document_idx" ON "source_role_assignments" USING btree ("source_document_id");--> statement-breakpoint
CREATE INDEX "source_role_assignments_role_idx" ON "source_role_assignments" USING btree ("role");--> statement-breakpoint
CREATE UNIQUE INDEX "source_role_coverage_run_role_artifact_unique" ON "source_role_coverage" USING btree ("research_run_id","source_role","artifact_type");--> statement-breakpoint
CREATE INDEX "source_role_coverage_run_idx" ON "source_role_coverage" USING btree ("research_run_id");--> statement-breakpoint
CREATE INDEX "source_role_coverage_role_idx" ON "source_role_coverage" USING btree ("source_role");