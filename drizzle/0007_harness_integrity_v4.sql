ALTER TABLE "research_runs" ALTER COLUMN "pipeline_version" SET DEFAULT 4;
--> statement-breakpoint
ALTER TABLE "model_call_logs" ADD COLUMN "cost_source" text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_budget_ledger" ADD COLUMN "cost_source" text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
CREATE TABLE "model_budget_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "research_run_id" uuid,
  "stage_id" uuid,
  "task_id" uuid,
  "model_tier" text NOT NULL,
  "reserved_usd" numeric NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "resolved_at" timestamp with time zone,
  CONSTRAINT "model_budget_reservations_run_fk" FOREIGN KEY ("research_run_id") REFERENCES "research_runs"("id"),
  CONSTRAINT "model_budget_reservations_stage_fk" FOREIGN KEY ("stage_id") REFERENCES "research_stages"("id"),
  CONSTRAINT "model_budget_reservations_task_fk" FOREIGN KEY ("task_id") REFERENCES "research_tasks"("id")
);
--> statement-breakpoint
CREATE INDEX "model_budget_reservations_run_idx" ON "model_budget_reservations" USING btree ("research_run_id", "status");
--> statement-breakpoint
CREATE INDEX "model_budget_reservations_expires_idx" ON "model_budget_reservations" USING btree ("status", "expires_at");
