-- Investment checklists (Implementations/research-workspace P3): global checklists and per-asset evaluations, each
-- evaluation keeping a snapshot of the checklist, its results and score. Never a report input. Re-runnable.
CREATE TABLE IF NOT EXISTS "investment_checklists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"items_json" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "investment_checklists_name_unique" ON "investment_checklists" USING btree ("name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "investment_checklists_one_default" ON "investment_checklists" USING btree ("is_default") WHERE "is_default";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "checklist_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL REFERENCES "assets"("id") ON DELETE CASCADE,
	"research_run_id" uuid REFERENCES "research_runs"("id") ON DELETE SET NULL,
	"checklist_id" uuid REFERENCES "investment_checklists"("id") ON DELETE SET NULL,
	"checklist_json" jsonb NOT NULL,
	"results_json" jsonb NOT NULL,
	"score" integer NOT NULL,
	"max" integer NOT NULL,
	"percent" double precision,
	"unknown" integer NOT NULL,
	"judged_by" text DEFAULT 'none' NOT NULL,
	"judgement_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checklist_evaluations_judged_by_check" CHECK ("judged_by" IN ('model', 'none'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checklist_evaluations_asset_idx" ON "checklist_evaluations" USING btree ("asset_id", "created_at");
