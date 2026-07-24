# SOFI V3 Mock E2E Acceptance — Handover

**Date:** 2026-07-18
**Scope:** WP12 — SOFI Mock End-to-End Acceptance (Component WP12)
**Branch:** `codex/local-agent-harness`
**Status:** In progress — pipeline now traverses mock sources; teardown cascade fully defined; test not yet passing (blocked on DB teardown + pipeline validation)
**Next owner:** Same session or delegated developer

---

## Executive Summary

This session continued from the previous handover. The focus was on getting the SOFI V3 pipeline to complete a full E2E mock run (without paid inference) and making the `test:sofi-v3` acceptance suite runnable. Several infrastructure bugs were discovered and fixed:

1. The pipeline was failing at `source_discovery` because required source roles (`company_investor_relations`, `earnings_release`, `founder_and_company_history`, `industry_primary`) were not populated in mock/test mode — fixed by injecting a mock response into `fetchSecContext`.
2. The duplicate stage handler registration was crashing the test harness — fixed by demoting the error to a `console.warn`.
3. Test teardown was failing due to an undiscovered cascade of foreign key constraints — the full correct deletion order has now been identified and implemented in `sofi-v3-e2e.test.ts`.

---

## What Was Completed This Session

### 1. Mock Bypass in `fetchSecContext`

**File:** [`src/lib/research/system-pipeline.ts`](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/src/lib/research/system-pipeline.ts)

When `RESEARCH_ACCEPTANCE_PROVIDER=mock` or `RESEARCH_TEST_MODE=1`, `fetchSecContext` now returns a fully-structured mock object including:
- Mock CIK, `entityName`, `recentFilings` (one 10-K)
- `supplementalSources` covering all required roles: `investor_relations`, `founder_history`, `industry_report`, `earnings_release`

This prevents the live SEC API call entirely during acceptance testing.

### 2. Mock Bypass in `fetchSecFilingPayloads`

**File:** [`src/lib/research/system-pipeline.ts`](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/src/lib/research/system-pipeline.ts)

`fetchSecFilingPayloads` now short-circuits to use `"Mock SEC filing content"` instead of making live `fetch()` calls to SEC EDGAR when in mock/test mode.

### 3. Duplicate Stage Handler Registration — Demoted to Warning

**File:** [`src/lib/research/v3-stage-registry.ts`](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/src/lib/research/v3-stage-registry.ts)

Changed from `throw new Error(...)` to `console.warn(...)` + early return when a handler for a stage key is already registered. This prevents the test harness from crashing when `runResearchPipelineV3` is called multiple times in the same Node.js process.

> **Note:** The `registerCoreV3Handlers()` function already guards against this with `if (hasV3StageHandler("intake")) return;`. The registry throw was a safety net that became a hazard in multi-run test contexts.

### 4. Pipeline Failure Logging

**File:** [`src/lib/research/v3-pipeline.ts`](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/src/lib/research/v3-pipeline.ts)

Added `console.error("V3 Pipeline failure error stack:", error)` to `markV3PipelineFailure` so the full stack trace is visible in test output instead of being silently truncated to the DB.

### 5. Full Teardown Cascade in `sofi-v3-e2e.test.ts`

**File:** [`tests/sofi-v3-e2e.test.ts`](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/tests/sofi-v3-e2e.test.ts)

Replaced the simple `after()` hook with a full cascade delete in the correct FK-respecting order. Also added a **pre-cleanup `before()` block** that checks for a stale `sofi` asset slug and deletes everything associated with it before seeding.

The correct deletion order, fully determined this session, is:

```
1. model_call_logs        (FK → research_stages)
2. model_budget_ledger    (FK → research_stages)
3. research_tasks         (FK → research_stages)
4. research_stages
5. research_artifacts
6. theses / risks / catalysts / valuation_signals / scenarios  (FK → research_runs)
7. source_gaps            (FK → research_runs)
8. source_role_coverage   (FK → research_runs)
9. source_role_assignments (FK → source_documents)
10. source_document_relations (FK → source_documents)
11. document_chunks       (FK → source_documents)
12. source_documents
13. asset_profile_assignments (FK → assets)
14. research_runs
15. listings              (FK → instruments)
16. instruments           (FK → assets)
17. assets
```

### 6. Cleanup in `research-run-harness.test.ts`

**File:** [`tests/research-run-harness.test.ts`](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/tests/research-run-harness.test.ts)

Both inline cleanup blocks (after WP0-T5 and WP0-T7/T8) now include `DELETE FROM research_tasks` before `DELETE FROM research_stages`.

---

## Current Test State

Running:
```bash
RESEARCH_TEST_MODE=1 RESEARCH_ASSET=SOFI RESEARCH_PIPELINE_VERSION=3 RESEARCH_ACCEPTANCE_PROVIDER=mock npm run test:sofi-v3
```

**Last observed error:** `update or delete on table "source_documents" violates foreign key constraint "document_chunks_source_document_id_source_documents_id_fk"`

This has since been fixed by adding `document_chunks`, `source_role_assignments`, `source_document_relations`, `source_role_coverage`, and `source_gaps` to the teardown before `source_documents`. The fix is in the file but the test has **not been re-run** after the last teardown correction — the next agent should re-run it immediately.

---

## Immediate Next Steps

### Step 1: Re-run the acceptance test

```bash
RESEARCH_TEST_MODE=1 RESEARCH_ASSET=SOFI RESEARCH_PIPELINE_VERSION=3 RESEARCH_ACCEPTANCE_PROVIDER=mock npm run test:sofi-v3
```

Expected: the test harness runs without teardown errors. The pipeline should now traverse past `source_discovery` (mock sources cover all required roles) and into the analysis stages.

### Step 2: If pipeline fails mid-run

Check the DB for the failure reason:
```bash
NODE_PATH="$(pwd)/node_modules" npx tsx /Users/japardinathaniel/.gemini/antigravity-cli/brain/d293ee5d-4c12-4edf-8753-2864a60fcb4f/scratch/check-stages.ts
```

The `v3_pipeline_failure` field in `metadata_json` of `research_runs` will contain the error. The `console.error` added to `markV3PipelineFailure` will also print the full stack in the test output.

### Step 3: Validate stage assertions

The test asserts:
- Final run status is `waiting_for_human` (not `needs_more_work`)
- Each stage completes with `status = 'completed'`
- Artifacts exist in `research_artifacts` for each handler
- Report quality is `review_ready` (not `investment_ready` — blocked by mock/synthetic detection in quality gates)

### Step 4 (Optional): WP13 — Real-Provider Run

Once WP12 passes with mock provider, the next milestone is running a bounded SOFI initiation using a real OpenAI-compatible provider:
```bash
RESEARCH_ASSET=SOFI RESEARCH_PIPELINE_VERSION=3 npm run test:sofi-v3
```

Requires a real `OPENAI_API_KEY` or compatible endpoint configured in `.env.local`.

---

## Key Design Decisions Made This Session

| Decision | Rationale |
|---|---|
| Mock bypass inside `fetchSecContext` (not a separate test double) | Keeps the production code path intact; no need to inject mocks externally |
| Duplicate handler → warn not throw | `registerCoreV3Handlers()` already idempotency-guards; throwing breaks multi-run test harnesses |
| Pre-cleanup in `before()` hook | Prevents `assets_slug_unique` violation when a previous test run didn't clean up due to crash |
| Full cascade delete order enumerated | FK constraints are not ON DELETE CASCADE — every test hook must manually delete in child-first order |

---

## Files Edited This Session

| File | Change |
|---|---|
| [`src/lib/research/system-pipeline.ts`](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/src/lib/research/system-pipeline.ts) | Added mock bypass in `fetchSecContext` + `fetchSecFilingPayloads` |
| [`src/lib/research/v3-stage-registry.ts`](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/src/lib/research/v3-stage-registry.ts) | Duplicate registration demoted from throw to warn |
| [`src/lib/research/v3-pipeline.ts`](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/src/lib/research/v3-pipeline.ts) | Added stack logging in `markV3PipelineFailure` |
| [`tests/sofi-v3-e2e.test.ts`](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/tests/sofi-v3-e2e.test.ts) | Full cascade delete in `before()` + `after()` hooks |
| [`tests/research-run-harness.test.ts`](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/tests/research-run-harness.test.ts) | Added `research_tasks` deletion before `research_stages` in cleanup |

---

## DB Connection

```
DATABASE_URL=postgresql://research_os:research_os_dev@localhost:5433/research_os
```

The PostgreSQL container should still be running (`research-os-postgres-temp` on port `5433`). If not:
```bash
docker start research-os-postgres-temp
```
