-- Filing notes (Implementations/research-workspace P2): a notebook annotation can sit on a passage of a stored filing
-- instead of a report chapter. Existing rows stay report notes. Re-runnable.
ALTER TABLE "notebook_annotations" ADD COLUMN IF NOT EXISTS "anchor_kind" text DEFAULT 'report' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notebook_annotations" ADD COLUMN IF NOT EXISTS "source_document_id" uuid REFERENCES "source_documents"("id") ON DELETE SET NULL;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notebook_annotations" ADD CONSTRAINT "notebook_annotations_anchor_kind_check" CHECK ("anchor_kind" IN ('report', 'filing'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notebook_annotations_source_document_idx" ON "notebook_annotations" USING btree ("source_document_id") WHERE "source_document_id" IS NOT NULL;
