ALTER TABLE "claim_relationships" ADD COLUMN "extractor" text;
--> statement-breakpoint
ALTER TABLE "claim_relationships" ADD COLUMN "extractor_version" text;
--> statement-breakpoint
ALTER TABLE "claim_relationships" ADD COLUMN "evidence_location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "claim_relationships" ADD COLUMN "review_status" text DEFAULT 'unreviewed' NOT NULL;
--> statement-breakpoint
ALTER TABLE "claim_relationships" ADD COLUMN "description" text;
--> statement-breakpoint
DELETE FROM "claim_relationships" a USING "claim_relationships" b
WHERE a."from_claim_id" = b."from_claim_id" AND a."to_claim_id" = b."to_claim_id" AND a."relationship_type" = b."relationship_type"
  AND (a."created_at", a."id") > (b."created_at", b."id");
--> statement-breakpoint
ALTER TABLE "claim_relationships" ADD CONSTRAINT "claim_relationships_from_to_type_unique" UNIQUE("from_claim_id","to_claim_id","relationship_type");
--> statement-breakpoint
CREATE INDEX "claim_relationships_to_claim_idx" ON "claim_relationships" USING btree ("to_claim_id");
