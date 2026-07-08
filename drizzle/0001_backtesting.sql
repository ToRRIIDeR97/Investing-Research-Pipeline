CREATE TABLE "backtest_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backtest_run_id" uuid NOT NULL,
	"research_run_id" uuid NOT NULL,
	"artifact_type" text NOT NULL,
	"title" text NOT NULL,
	"storage_path" text NOT NULL,
	"mime_type" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backtest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid NOT NULL,
	"research_task_id" uuid,
	"asset_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"strategy_name" text,
	"strategy_prompt" text NOT NULL,
	"symbol" text NOT NULL,
	"benchmark_symbol" text,
	"data_provider" text DEFAULT 'yfinance' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"market_data_cutoff_at" timestamp with time zone,
	"initial_capital" numeric DEFAULT '100000' NOT NULL,
	"params_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assumptions_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_code_path" text,
	"metrics_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backtest_artifacts" ADD CONSTRAINT "backtest_artifacts_backtest_run_id_backtest_runs_id_fk" FOREIGN KEY ("backtest_run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_artifacts" ADD CONSTRAINT "backtest_artifacts_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_research_task_id_research_tasks_id_fk" FOREIGN KEY ("research_task_id") REFERENCES "public"."research_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backtest_artifacts_run_idx" ON "backtest_artifacts" USING btree ("backtest_run_id");--> statement-breakpoint
CREATE INDEX "backtest_artifacts_research_run_idx" ON "backtest_artifacts" USING btree ("research_run_id");--> statement-breakpoint
CREATE INDEX "backtest_runs_research_run_idx" ON "backtest_runs" USING btree ("research_run_id");--> statement-breakpoint
CREATE INDEX "backtest_runs_task_idx" ON "backtest_runs" USING btree ("research_task_id");--> statement-breakpoint
CREATE INDEX "backtest_runs_status_idx" ON "backtest_runs" USING btree ("status");