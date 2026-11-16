-- Typed run-control state (architecture-9 P3). Re-runnable: every statement is guarded, and the backfill
-- inserts a row only when no row for the same legacy entry exists. The legacy JSON keys stay in place.
ALTER TABLE "research_stages" ADD COLUMN IF NOT EXISTS "transient_failures" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "research_stages" ADD COLUMN IF NOT EXISTS "last_transient_error" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_run_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"stages" text[] DEFAULT '{}'::text[] NOT NULL,
	"request_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"round" integer,
	"estimated_cost_usd" numeric,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "research_run_resets" ADD CONSTRAINT "research_run_resets_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "research_run_resets" ADD CONSTRAINT "research_run_resets_kind_check" CHECK ("kind" IN ('auto', 'approval'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "research_run_resets" ADD CONSTRAINT "research_run_resets_status_check" CHECK ("status" IN ('pending', 'applied', 'skipped'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_run_resets_run_idx" ON "research_run_resets" USING btree ("research_run_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "research_run_resets_one_pending" ON "research_run_resets" USING btree ("research_run_id") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_plan_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid NOT NULL,
	"notes" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "research_plan_feedback" ADD CONSTRAINT "research_plan_feedback_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_plan_feedback_run_idx" ON "research_plan_feedback" USING btree ("research_run_id","requested_at");
--> statement-breakpoint
-- Backfill: a transient-failure count recorded in validation_result_json moves to the columns.
UPDATE "research_stages"
SET "transient_failures" = GREATEST("transient_failures", ("validation_result_json"->>'transient_failures')::integer),
    "last_transient_error" = COALESCE("last_transient_error", "validation_result_json"->>'last_transient_error')
WHERE jsonb_typeof("validation_result_json") = 'object'
  AND jsonb_typeof("validation_result_json"->'transient_failures') = 'number';
--> statement-breakpoint
-- Backfill: the run's automatic re-run (metadata_json.request_auto_reset). A run has at most one.
INSERT INTO "research_run_resets" ("research_run_id", "kind", "status", "stages", "request_ids", "round", "created_at")
SELECT r."id", 'auto', 'applied',
  CASE WHEN jsonb_typeof(a."v"->'stages') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(a."v"->'stages')) ELSE '{}'::text[] END,
  CASE WHEN jsonb_typeof(a."v"->'request_ids') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(a."v"->'request_ids')) ELSE '{}'::text[] END,
  CASE WHEN jsonb_typeof(a."v"->'round') = 'number' THEN (a."v"->>'round')::integer END,
  CASE WHEN a."v"->>'at' ~ '^\d{4}-\d{2}-\d{2}T' THEN (a."v"->>'at')::timestamptz ELSE r."updated_at" END
FROM "research_runs" r
CROSS JOIN LATERAL (SELECT r."metadata_json"->'request_auto_reset' AS "v") a
WHERE jsonb_typeof(r."metadata_json") = 'object' AND jsonb_typeof(a."v") = 'object'
  AND NOT EXISTS (SELECT 1 FROM "research_run_resets" x WHERE x."research_run_id" = r."id" AND x."kind" = 'auto');
--> statement-breakpoint
-- Backfill: the last reviewer decision (metadata_json.request_reset_decision), identified by its decided_at.
INSERT INTO "research_run_resets" ("research_run_id", "kind", "status", "stages", "request_ids", "decided_by", "decided_at", "created_at")
SELECT r."id", 'approval', CASE WHEN d."v"->>'decision' = 'rerun' THEN 'applied' ELSE 'skipped' END,
  CASE WHEN jsonb_typeof(d."v"->'stages') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(d."v"->'stages')) ELSE '{}'::text[] END,
  CASE WHEN jsonb_typeof(d."v"->'request_ids') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(d."v"->'request_ids')) ELSE '{}'::text[] END,
  d."v"->>'actor', d."at", d."at"
FROM "research_runs" r
CROSS JOIN LATERAL (SELECT r."metadata_json"->'request_reset_decision' AS "v",
  CASE WHEN r."metadata_json"->'request_reset_decision'->>'decided_at' ~ '^\d{4}-\d{2}-\d{2}T'
    THEN (r."metadata_json"->'request_reset_decision'->>'decided_at')::timestamptz ELSE r."updated_at" END AS "at") d
WHERE jsonb_typeof(r."metadata_json") = 'object' AND jsonb_typeof(d."v") = 'object'
  AND d."v"->>'decision' IN ('rerun', 'skip')
  AND NOT EXISTS (SELECT 1 FROM "research_run_resets" x WHERE x."research_run_id" = r."id" AND x."kind" = 'approval' AND x."decided_at" = d."at");
--> statement-breakpoint
-- Backfill: a re-run still waiting for a reviewer (metadata_json.request_reset). Skipped when a row for the same
-- stages and requests exists, other than the backfilled earlier decision: pending, or decided since the backfill.
INSERT INTO "research_run_resets" ("research_run_id", "kind", "status", "stages", "request_ids", "estimated_cost_usd")
SELECT r."id", 'approval', 'pending', p."stages", p."request_ids",
  CASE WHEN jsonb_typeof(r."metadata_json"->'request_reset'->'estimated_cost_usd') = 'number'
    THEN (r."metadata_json"->'request_reset'->>'estimated_cost_usd')::numeric END
FROM "research_runs" r
CROSS JOIN LATERAL (SELECT
  CASE WHEN jsonb_typeof(r."metadata_json"->'request_reset'->'stages') = 'array'
    THEN ARRAY(SELECT jsonb_array_elements_text(r."metadata_json"->'request_reset'->'stages')) ELSE '{}'::text[] END AS "stages",
  CASE WHEN jsonb_typeof(r."metadata_json"->'request_reset'->'request_ids') = 'array'
    THEN ARRAY(SELECT jsonb_array_elements_text(r."metadata_json"->'request_reset'->'request_ids')) ELSE '{}'::text[] END AS "request_ids",
  CASE WHEN r."metadata_json"->'request_reset_decision'->>'decided_at' ~ '^\d{4}-\d{2}-\d{2}T'
    THEN (r."metadata_json"->'request_reset_decision'->>'decided_at')::timestamptz END AS "legacy_decided_at") p
WHERE jsonb_typeof(r."metadata_json") = 'object' AND jsonb_typeof(r."metadata_json"->'request_reset') = 'object'
  AND NOT EXISTS (SELECT 1 FROM "research_run_resets" x WHERE x."research_run_id" = r."id" AND x."status" = 'pending')
  AND NOT EXISTS (SELECT 1 FROM "research_run_resets" x WHERE x."research_run_id" = r."id" AND x."kind" = 'approval'
    AND x."stages" = p."stages" AND x."request_ids" = p."request_ids"
    AND (x."decided_at" IS NULL OR p."legacy_decided_at" IS NULL OR x."decided_at" <> p."legacy_decided_at"));
--> statement-breakpoint
-- Backfill: each plan-feedback note, in array order. A microsecond per position keeps the order of notes saved in
-- the same millisecond without changing their millisecond timestamps.
INSERT INTO "research_plan_feedback" ("research_run_id", "notes", "requested_by", "requested_at")
SELECT f."run_id", f."notes", f."requested_by", f."requested_at"
FROM (
  SELECT r."id" AS "run_id", e."v"->>'notes' AS "notes", COALESCE(e."v"->>'requested_by', 'user') AS "requested_by",
    (CASE WHEN e."v"->>'requested_at' ~ '^\d{4}-\d{2}-\d{2}T' THEN (e."v"->>'requested_at')::timestamptz ELSE r."updated_at" END)
      + (e."n" - 1) * INTERVAL '1 microsecond' AS "requested_at"
  FROM "research_runs" r
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r."metadata_json") = 'object'
    AND jsonb_typeof(r."metadata_json"->'research_plan_feedback') = 'array' THEN r."metadata_json"->'research_plan_feedback'
    ELSE '[]'::jsonb END) WITH ORDINALITY AS e("v", "n")
  WHERE jsonb_typeof(r."metadata_json") = 'object' AND jsonb_typeof(r."metadata_json"->'research_plan_feedback') = 'array'
    AND jsonb_typeof(e."v") = 'object' AND COALESCE(e."v"->>'notes', '') <> ''
) f
WHERE NOT EXISTS (SELECT 1 FROM "research_plan_feedback" x
  WHERE x."research_run_id" = f."run_id" AND x."notes" = f."notes" AND x."requested_at" = f."requested_at");
