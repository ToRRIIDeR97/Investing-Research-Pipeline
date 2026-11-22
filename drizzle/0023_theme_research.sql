-- Theme research v1 (Implementations/research-workspace P4): one row per theme with its request, status and result.
-- Never a report input. Re-runnable.
CREATE TABLE IF NOT EXISTS "theme_research" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"theme" text NOT NULL,
	"request_json" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result_json" jsonb,
	"error" text,
	"cost_usd" numeric DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "theme_research_status_check" CHECK ("status" IN ('pending', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "theme_research_created_idx" ON "theme_research" USING btree ("created_at");
