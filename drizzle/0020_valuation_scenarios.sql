-- The valuation workbench (Implementations/research-workspace P1): named what-if scenarios per run. A row keeps the
-- typed change and the summary the server recomputed from the stored valuation. Never a report input. Re-runnable.
CREATE TABLE IF NOT EXISTS "valuation_scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid NOT NULL REFERENCES "research_runs"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"change_json" jsonb NOT NULL,
	"result_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "valuation_scenarios_source_check" CHECK ("source" IN ('user', 'assistant'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "valuation_scenarios_run_name" ON "valuation_scenarios" USING btree ("research_run_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "valuation_scenarios_run_idx" ON "valuation_scenarios" USING btree ("research_run_id", "created_at");
