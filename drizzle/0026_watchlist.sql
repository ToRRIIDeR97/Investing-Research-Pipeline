-- Watchlist (Implementations/quant-intl-watchlist-settings P6): stocks starred on the Quant or Research pages, one
-- row per ticker. Reader data; never a research input. Re-runnable.
CREATE TABLE IF NOT EXISTS "watchlist_items" (
	"ticker" text PRIMARY KEY NOT NULL,
	"name" text,
	"asset_id" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
