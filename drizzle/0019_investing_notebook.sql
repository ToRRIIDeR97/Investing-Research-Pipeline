-- The investing notebook (Implementations/investing-notebook): the operator's pins, KPIs, report annotations and
-- journal per asset. Rows hold references and text, not computed values. Re-runnable.
CREATE TABLE IF NOT EXISTS "notebook_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL REFERENCES "assets"("id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"ref_key" text NOT NULL,
	"frequency" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notebook_pins_kind_check" CHECK ("kind" IN ('exhibit', 'metric'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notebook_pins_asset_idx" ON "notebook_pins" USING btree ("asset_id", "position");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notebook_pins_unique_ref" ON "notebook_pins" USING btree ("asset_id", "kind", "ref_key", "frequency");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notebook_kpis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL REFERENCES "assets"("id") ON DELETE CASCADE,
	"label" text NOT NULL,
	"metric_key" text NOT NULL,
	"segment" text,
	"bear_line" double precision,
	"bull_line" double precision,
	"note" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notebook_kpis_asset_idx" ON "notebook_kpis" USING btree ("asset_id", "position");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notebook_annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL REFERENCES "assets"("id") ON DELETE CASCADE,
	"research_run_id" uuid REFERENCES "research_runs"("id") ON DELETE SET NULL,
	"section_id" text NOT NULL,
	"section_title" text DEFAULT '' NOT NULL,
	"section_coverage" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exhibit_key" text,
	"paragraph_index" integer,
	"quote" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notebook_annotations_asset_idx" ON "notebook_annotations" USING btree ("asset_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notebook_journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL REFERENCES "assets"("id") ON DELETE CASCADE,
	"research_run_id" uuid REFERENCES "research_runs"("id") ON DELETE SET NULL,
	"entry_date" date NOT NULL,
	"thesis" text DEFAULT '' NOT NULL,
	"price" double precision,
	"currency" text,
	"change_my_mind" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"kpi_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notebook_journal_asset_idx" ON "notebook_journal_entries" USING btree ("asset_id", "entry_date");
