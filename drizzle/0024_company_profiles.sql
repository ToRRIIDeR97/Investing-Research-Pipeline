-- Company profiles (Implementations/ui-remaster P2): the display cache for company logos and leadership from Wikidata
-- and Wikipedia. Never a report input. Re-runnable.
CREATE TABLE IF NOT EXISTS "company_profiles" (
	"key" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"profile_json" jsonb,
	"error" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_profiles_status_check" CHECK ("status" IN ('resolved', 'not_found', 'failed'))
);
