CREATE INDEX IF NOT EXISTS "source_documents_research_run_idx" ON "source_documents" USING btree ("research_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_documents_url_idx" ON "source_documents" USING btree ("url");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_documents_asset_idx" ON "source_documents" USING btree ("asset_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_runs_asset_status_idx" ON "research_runs" USING btree ("asset_id","status");
