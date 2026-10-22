ALTER TABLE "research_runs" ADD COLUMN IF NOT EXISTS "prior_run_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_prior_run_id_research_runs_id_fk" FOREIGN KEY ("prior_run_id") REFERENCES "public"."research_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_runs_prior_run_idx" ON "research_runs" USING btree ("prior_run_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asset_monitor_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"research_run_id" uuid,
	"status" text NOT NULL,
	"refresh_due" boolean DEFAULT false NOT NULL,
	"reasons_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"filings_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kpis_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_monitor_checks" ADD CONSTRAINT "asset_monitor_checks_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_monitor_checks" ADD CONSTRAINT "asset_monitor_checks_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_monitor_checks_asset_checked_idx" ON "asset_monitor_checks" USING btree ("asset_id","checked_at");
