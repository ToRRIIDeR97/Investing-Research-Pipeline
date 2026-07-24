ALTER TABLE "research_runs" ALTER COLUMN "pipeline_version" SET DEFAULT 3;
--> statement-breakpoint
CREATE TABLE "research_run_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid NOT NULL,
	"job_type" text DEFAULT 'pipeline' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_by" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"result_json" jsonb,
	"failure_reason" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_run_jobs_research_run_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "research_runs"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "research_run_jobs_one_active_pipeline_per_run" ON "research_run_jobs" ("research_run_id") WHERE "research_run_jobs"."job_type" = 'pipeline' AND "research_run_jobs"."status" IN ('queued', 'running');
--> statement-breakpoint
CREATE INDEX "research_run_jobs_claim_idx" ON "research_run_jobs" USING btree ("status", "queued_at");
--> statement-breakpoint
CREATE INDEX "research_run_jobs_run_idx" ON "research_run_jobs" USING btree ("research_run_id", "created_at");
--> statement-breakpoint
CREATE TABLE "research_worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'healthy' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
