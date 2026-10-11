ALTER TABLE "research_tasks" ADD COLUMN IF NOT EXISTS "budget_reservation_usd" numeric;
--> statement-breakpoint
UPDATE "research_tasks"
SET "budget_reservation_usd" = ("input_json"->'budget_reservation'->>'usd')::numeric,
    "input_json" = "input_json" - 'budget_reservation'
WHERE "input_json" ? 'budget_reservation';
