ALTER TABLE "market_price_bars" ADD COLUMN "verification_status" text DEFAULT 'unverified' NOT NULL;
--> statement-breakpoint
ALTER TABLE "market_price_bars" ADD COLUMN "verification_json" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "market_price_bars" ADD COLUMN "verified_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "corporate_actions_instrument_type_ex_date_idx" ON "corporate_actions" USING btree ("instrument_id","action_type","ex_date");
