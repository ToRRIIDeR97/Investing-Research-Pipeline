CREATE INDEX IF NOT EXISTS "document_chunks_source_document_idx" ON "document_chunks" USING btree ("source_document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_claims_run_review_idx" ON "evidence_claims" USING btree ("research_run_id","review_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_links_claim_idx" ON "evidence_links" USING btree ("evidence_claim_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_locations_chunk_idx" ON "source_locations" USING btree ("document_chunk_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_locations_source_document_idx" ON "source_locations" USING btree ("source_document_id");
