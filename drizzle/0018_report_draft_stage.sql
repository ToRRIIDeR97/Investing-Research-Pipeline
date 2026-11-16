-- The report is drafted in its own stage (architecture-9 P4): report_draft at order 21, ai_reviewer and the tail
-- at 22-25. Only runs with the 24-stage tail (ai_reviewer 21, human_review 22, export 23, refresh_schedule 24) and
-- no report_draft row change; every other stage keeps its status. Re-runnable: a converted run has a report_draft
-- row and is skipped. The tail moves one stage at a time, last first, so UNIQUE (research_run_id, stage_order)
-- never sees two rows at one order.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT ai."research_run_id", ai."status", ai."started_at", ai."completed_at", ai."failure_reason"
    FROM "research_stages" ai
    WHERE ai."stage_key" = 'ai_reviewer' AND ai."stage_order" = 21
      AND NOT EXISTS (SELECT 1 FROM "research_stages" x WHERE x."research_run_id" = ai."research_run_id"
        AND (x."stage_key" = 'report_draft' OR x."stage_order" = 25))
      AND EXISTS (SELECT 1 FROM "research_stages" x WHERE x."research_run_id" = ai."research_run_id" AND x."stage_key" = 'human_review' AND x."stage_order" = 22)
      AND EXISTS (SELECT 1 FROM "research_stages" x WHERE x."research_run_id" = ai."research_run_id" AND x."stage_key" = 'export' AND x."stage_order" = 23)
      AND EXISTS (SELECT 1 FROM "research_stages" x WHERE x."research_run_id" = ai."research_run_id" AND x."stage_key" = 'refresh_schedule' AND x."stage_order" = 24)
  LOOP
    UPDATE "research_stages" SET "stage_order" = 25 WHERE "research_run_id" = r."research_run_id" AND "stage_key" = 'refresh_schedule';
    UPDATE "research_stages" SET "stage_order" = 24 WHERE "research_run_id" = r."research_run_id" AND "stage_key" = 'export';
    UPDATE "research_stages" SET "stage_order" = 23 WHERE "research_run_id" = r."research_run_id" AND "stage_key" = 'human_review';
    UPDATE "research_stages" SET "stage_order" = 22 WHERE "research_run_id" = r."research_run_id" AND "stage_key" = 'ai_reviewer';
    -- Done with the review means the draft was done; a skipped review means a skipped draft; anything else redrafts.
    INSERT INTO "research_stages" ("research_run_id", "stage_key", "stage_order", "status", "allowed_model_tiers", "max_retries",
      "budget_limit_usd", "completion_criteria_json", "validator_config_json", "started_at", "completed_at", "failure_reason")
    VALUES (r."research_run_id", 'report_draft', 21,
      CASE WHEN r."status" = 'completed' THEN 'completed' WHEN r."status" = 'skipped' THEN 'skipped' ELSE 'pending' END,
      ARRAY['mid', 'cheap']::text[], 2,
      CASE WHEN r."status" = 'skipped' THEN NULL ELSE 5.00 END,
      CASE WHEN r."status" = 'skipped'
        THEN jsonb_build_object('requiredOutputs', '[]'::jsonb, 'skipReason', COALESCE(r."failure_reason", 'Skipped for run type'))
        ELSE jsonb_build_object('requiredOutputs', '[]'::jsonb, 'requiresHumanApproval', false,
          'entryCriteria', '["decision_synthesis_completed"]'::jsonb, 'validationRules', '[]'::jsonb, 'failureState', 'fail_run') END,
      '{}'::jsonb,
      CASE WHEN r."status" = 'completed' THEN r."started_at" END,
      CASE WHEN r."status" = 'completed' THEN r."completed_at" END,
      CASE WHEN r."status" = 'skipped' THEN r."failure_reason" END);
  END LOOP;
END $$;
