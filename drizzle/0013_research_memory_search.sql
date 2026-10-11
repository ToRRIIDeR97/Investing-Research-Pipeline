ALTER TABLE "document_chunks" ADD COLUMN "search_tsv" tsvector;
--> statement-breakpoint
UPDATE "document_chunks" dc SET "search_tsv" = setweight(to_tsvector('english', COALESCE(dc."metadata_json"->'section_path', '[]'::jsonb)), 'A')
  || setweight(to_tsvector('english', dc."text"), 'B')
FROM "document_parses" dp WHERE dp."id" = dc."document_parse_id" AND dp."parser_name" = 'research-memory';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_chunks_search_tsv_idx" ON "document_chunks" USING gin ("search_tsv") WHERE "search_tsv" IS NOT NULL;
