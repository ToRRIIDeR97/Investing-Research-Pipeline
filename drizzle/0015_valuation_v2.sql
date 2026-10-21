-- Valuation engine v2: a per-run forecast horizon (set at the plan gate; null uses RESEARCH_FORECAST_YEARS, else 5)
-- and the depositary ratio of a listed instrument (ordinary shares per ADS; 1 for an ordinary listing).
ALTER TABLE "research_runs" ADD COLUMN IF NOT EXISTS "forecast_years" integer;
--> statement-breakpoint
ALTER TABLE "research_runs" DROP CONSTRAINT IF EXISTS "research_runs_forecast_years_range";
--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_forecast_years_range" CHECK ("forecast_years" IS NULL OR "forecast_years" BETWEEN 3 AND 10);
--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "depositary_ratio" numeric;
--> statement-breakpoint
ALTER TABLE "instruments" DROP CONSTRAINT IF EXISTS "instruments_depositary_ratio_positive";
--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_depositary_ratio_positive" CHECK ("depositary_ratio" IS NULL OR "depositary_ratio" > 0);
