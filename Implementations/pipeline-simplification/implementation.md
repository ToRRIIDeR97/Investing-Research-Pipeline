# Pipeline simplification, scope A: advisory review, one question round, no rerun loops

Branch base: `lean-combined` (a8947f3 lean report, f7107ee analysis prompt cap, 26d6911 bank valuation, merged at da8b9e0).
Stage map and measurements: [stage-map.md](stage-map.md). The user chose scope A on 2026-11-26 (options B and C, merging stages, are out of scope).

## Problem

The pipeline's coordination machinery, not its analysis, is what fails runs and wastes money:

- **The review fails the run.** `ai_reviewer` reviews the draft. When the verdict isn't passing, it runs a post-review question round (which can rerun analysis stages and pause for approval), rewrites chapters in a repair round, reviews again, and then fails the stage when the verdict is still `needs_more_work`. Both measured SoFi runs (0c9a, 7c70) ended there, so neither reached the human gate. 0c9a spent $5.31 in the review and repair rounds; 7c70 spent $0.33 there.
- **Question rounds loop.** Before drafting, up to two specialist question rounds run. An owner's answer may set `requires_rerun`, which reopens its stage. On 7c70 that produced four valuation passes (about $3) and five approval prompts.

**Before (7c70):** valuation check flags → valuation rerun → owner asks for a rerun → approval prompt (×4) → report written → review `needs_more_work` → post-review rework request → approval prompt → repair → review 2 `needs_more_work` → run fails at `ai_reviewer`, $4.83, never at the human gate.

**After:** valuation check flags → valuation rerun once (automatic) → one question round; answers never rerun anything → report written once → one review, saved as advisory findings → run waits at `human_review` with the verdict and findings for the user.

## Scope

**In scope**
- `src/lib/workflow/validators.ts` (`validateReviewOutcome`) and `src/lib/workflow/quality-gates.ts` (`addAiReviewCoverage`): the review verdict becomes a warning, not a stage or completion blocker.
- `src/lib/research/reporting/compose.ts` (`reviewDraftedReport`, `composeReviewedReport`): one review, no repair round, no rework call.
- `src/lib/research/reporting/runtime.ts`: the review action set without `rework`; `draftReport` and the outline plan without a second pre-draft round.
- `src/lib/research/team.ts`: one pre-draft round, no `post_review` phase, owner answers never rerun, reset plans never pause for approval.
- The tests that encode the removed behaviour, updated to the new contract with a comment naming this plan.
- Docs: `docs/system.md` (request flow, report review, valuation check sections) and `docs/architecture.md` (the affected sequence and state views, coverage index). Owners: `python tools/docs_sync.py owners <paths>`.

**Kept (invariants)**
- Both human gates (`research_plan`, `human_review`) pause exactly as now. Nothing here may complete a run without the human decision, export and refresh scheduling.
- The position guard at the final review (`src/app/api/research-runs/[id]/review/route.ts`): blocking review findings and a withheld conclusion still prevent `approved_for_position`, and `approved_for_tracking` is still allowed.
- The code-built valuation check (`valuationRework` in `runtime.ts`): a flagged check sends `asset_valuation` back once per run, automatically.
- A missing AI review is still a blocker (`ai_review_missing`): the review must run; only its verdict becomes advisory.
- Runs execute only through `research_run_jobs` and the per-run advisory lock; stage order, retries and failure policy stay in `stages.ts`.
- Legacy rows: a run that already holds a pending `approval` row in `research_run_resets` can still be decided through `POST /api/research-runs/:id/request-reset`. No new such rows are created.
- No schema change and no migration (the `research_run_resets` table and its `kind` values stay).

**Out of scope:** merging or renaming stages, the pipeline version, the UI beyond what the removed paths require, analysis prompts, model choices.

## Diagrams

![Current versus proposed report flow: the current flow loops through post-review questions, reruns, approval prompts, a repair rewrite and a second review before failing; the proposed flow runs one question round, the valuation check's one automatic rework, one advisory review, then the human gate](diagrams/current-vs-proposed.svg)

![Implementation detail: which function changes for each acceptance criterion](diagrams/detail.svg)

| Change | Where | Criterion |
|---|---|---|
| Verdict is a warning at the stage | `validateReviewOutcome` (validators.ts) | AC-1 |
| Verdict is a warning at completion | `addAiReviewCoverage` (quality-gates.ts), `ai_review_outcome` not `requiredForCompletion` | AC-8 |
| One review, no repair, no rework | `reviewDraftedReport` (compose.ts) | AC-2, AC-3 |
| No post-review round | runtime.ts review actions, team.ts `RequestPhase`, `roundAvailable` | AC-3 |
| One pre-draft round | team.ts `MAX_PRE_DRAFT_ROUNDS`, runtime.ts outline plan | AC-4 |
| Answers never rerun | team.ts `ownerAnswer`, `processResearchRequests` | AC-5 |
| Valuation rework kept | team.ts `requestResetPlan`, runtime.ts `valuationRework` | AC-6 |
| No approval pauses | team.ts `processResearchRequests`, `requestResetPlan` | AC-7 |

## Acceptance criteria

- **AC-1 Advisory review stage.** When the latest completed `ai_review` task's verdict is `needs_more_work`, `fail` or `failed`, `validateReviewOutcome(runId)` returns `valid: true`, and the verdict appears in `warnings` (text containing the verdict). A run whose review is `needs_more_work` reaches `human_review` (`waiting_for_human`) instead of failing at `ai_reviewer`. A missing review task still returns `valid: false`.
- **AC-2 One review, no rewrite.** `reviewDraftedReport(input, actions, draft)` calls `actions.review` exactly once and `actions.write` never, for every verdict, including a failing verdict with severe findings and substance-check leaks. It returns the draft's `document` (same `content_hash`) and a review whose findings include the substance-check findings. It saves one `report_review` with `round: 0`.
- **AC-3 No post-review round.** `reviewDraftedReport` never calls `actions.rework`, even with `analysis_rework` and `research_gap` findings and failing depth checks. The review stage writes no `team_requests` round, no `research_run_resets` row, and reopens no stage. `nextRequestBatch(previous, proposed, phase)` never creates a post-review round, whatever `phase` is passed.
- **AC-4 One pre-draft question round.** After one pre-draft round exists (`round: 1`), `nextRequestBatch` returns `null` for any further pre-draft proposal. Blocked outline questions remain open report questions and start no round. A run makes at most one `team:requests` planner call.
- **AC-5 Answers never rerun a stage.** An owner answer that sets `requires_rerun: true` reopens no stage and creates no `research_run_resets` row: its status and text are kept and `requires_rerun` is dropped from the stored response. The owner prompt no longer offers `requires_rerun`. `requestResetPlan` gives `mode: "none"` for requests whose only rerun signal is an owner answer.
- **AC-6 The valuation check's rework is kept.** A batch holding the code's `asset_valuation` rework request (from `valuationRework`) gives `requestResetPlan(...).mode === "auto"` when the run's automatic rerun is unused. After it is used, the same plan gives `"none"`, never `"approval"`.
- **AC-7 No approval pauses.** `requestResetPlan` never returns `mode: "approval"`. `processResearchRequests` never sets the run or a report stage to `waiting_for_human` and never inserts an `approval` row. An existing pending `approval` row can still be decided with `approveRequestReset` (legacy runs).
- **AC-8 Completion isn't blocked by the review verdict.** `evaluateQualityGates` with a completed `ai_review` task whose verdict is `needs_more_work` reports the `ai_review_outcome` item with `requiredForCompletion: false`, and the verdict as a warning. With no review task, `ai_review_missing` stays `requiredForCompletion: true`.
- **AC-9 Docs.** `docs/system.md` and `docs/architecture.md` describe the new flow, stale text about repair rounds, post-review rounds, owner reruns and approval pauses is removed or marked legacy, and `python tools/docs_sync.py check` passes.

Which test set checks each criterion:

| Criterion | Acceptance | Verification | Manual |
|---|---|---|---|
| AC-1 | `stage-flow.db.test.ts` | `restart-and-legacy.db.test.ts` | paid run reaches `human_review` |
| AC-2 | `advisory-review.test.ts` | `review-variants.test.ts` | |
| AC-3 | `advisory-review.test.ts`, `request-rounds.test.ts` | `review-variants.test.ts` | |
| AC-4 | `request-rounds.test.ts` | `restart-and-legacy.db.test.ts` | |
| AC-5 | `stage-flow.db.test.ts` | `restart-and-legacy.db.test.ts` | |
| AC-6 | `request-rounds.test.ts` | `restart-and-legacy.db.test.ts` | |
| AC-7 | `request-rounds.test.ts`, `stage-flow.db.test.ts` | `restart-and-legacy.db.test.ts` | |
| AC-8 | `advisory-review.test.ts` | `review-variants.test.ts` | |
| AC-9 | | | docs read against the diff, `docs_sync.py check` |

## Phases (TOR-2: one implementor, one verifier, in order)

| Phase | Outcome | Criteria | Edit scope | Depends on | Tests |
|---|---|---|---|---|---|
| **P1 Advisory review** | A failing review is saved as findings and the run reaches the human gate; no repair round, no post-review round | AC-1, AC-2, AC-3, AC-8, AC-9 (review parts) | `validators.ts`, `quality-gates.ts`, `compose.ts`, `runtime.ts` (review actions), `team.ts` (post-review phase only), affected tests, `docs/system.md` report-review section, `docs/architecture.md` | none | acceptance `advisory-review.test.ts`, `stage-flow.db.test.ts` (AC-1 cases); verification `review-variants.test.ts` |
| **P2 One question round, no reruns from answers** | One pre-draft round; owner answers never rerun; the only automatic rerun is the valuation check's; no approval pauses | AC-4, AC-5, AC-6, AC-7, AC-9 (request parts) | `team.ts`, `runtime.ts` (draft and outline rounds), affected tests, `docs/system.md` request-flow section, `docs/architecture.md` | P1 (shares `runtime.ts`, `team.ts`) | acceptance `request-rounds.test.ts`, `stage-flow.db.test.ts`; verification `restart-and-legacy.db.test.ts` |
| **P3 Paid SoFi test** | One paid SoFi run on the final commit reaches `human_review`, with cost and score recorded | AC-1, AC-4..AC-7 in a live run | none (run only) | P2, and **the user's explicit approval** | `npm run eval:score -- <run id>` |

Each phase also passes the five required checks and `npm run test:sofi-v3` / `npm run test:db` on the test database (`research_os_lean_test`), since the pipeline and orchestration change.

## Verification

All commands run from the repository root.

```bash
# acceptance (worker-visible)
npx tsx --test Implementations/pipeline-simplification/acceptance/advisory-review.test.ts Implementations/pipeline-simplification/acceptance/request-rounds.test.ts
RUN_DB_INTEGRATION=1 RESEARCH_MODEL_PROVIDER=mock RESEARCH_ACCEPTANCE_PROVIDER=mock DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/research_os_lean_test \
  npx tsx --test --test-concurrency=1 Implementations/pipeline-simplification/acceptance/stage-flow.db.test.ts

# verification (plan-author-owned; kept outside the implementor's worktree)
npx tsx --test <verification-dir>/review-variants.test.ts
RUN_DB_INTEGRATION=1 RESEARCH_MODEL_PROVIDER=mock RESEARCH_ACCEPTANCE_PROVIDER=mock DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/research_os_lean_test \
  npx tsx --test --test-concurrency=1 <verification-dir>/restart-and-legacy.db.test.ts

# required checks
npm run lint && npx tsc --noEmit && npm run test:unit && npm run build && python tools/docs_sync.py check
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/research_os_lean_test npm run test:sofi-v3
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/research_os_lean_test npm run test:db
```

Setup: the local PostgreSQL on port 5433 (user `postgres`), and the test database `research_os_lean_test` with migrations applied and `npm run db:seed` run. Don't point the DB suites at `research_os`, which a paid run may be using.

**Baseline on `lean-combined` (da8b9e0):** `npm run test:unit` 876/876; `npm run test:db` 1,567/1,571. The four failures are also on `main`: three design-token tests (`globals.css` Slate/navy tokens, no serif face, navy brand mark) and one storage-cleanup test. Treat them as known, not regressions.

**This package's tests on the baseline (da8b9e0), run 2026-11-26.** Every failure below is on the criterion's own assertion, not on setup or imports.

| Set | Result | Failing on the intended assertion |
|---|---|---|
| acceptance `advisory-review` + `request-rounds` | 3 pass / 10 fail | two reviews instead of one; `requiredForCompletion` true; a second pre-draft round created; `post_review_round` set; an owner `requires_rerun` gives `auto`; `approval` instead of `none` |
| acceptance `stage-flow.db` | 1 pass / 5 fail | stage invalid on `needs_more_work`; `asset_valuation` reopened; owner prompt mentions `requires_rerun`; run `waiting_for_human`; a second planner call |
| verification `review-variants` | 2 pass / 4 fail | the repair round rewrites (6 writes); `requiredForCompletion` true |
| verification `restart-and-legacy.db` | 2 pass / 3 fail | a reset from a stored `requires_rerun`; stage invalid on `fail`; a second planner call |

The passes are the kept behaviours: a missing review still blocks, review errors propagate, the valuation rework reruns automatically, and a legacy approval row can be skipped.

Real-run evidence for the same problem: e79c411c (lean-combined, $0.95) is paused at `ai_reviewer` on a post-review `approval` row (estimated $0.54), the path P1 removes.

**Expected test updates:** these suites assert the removed behaviour and must be updated to the new contract, each change commented with `pipeline-simplification`:
- `tests/review-rework-db.test.ts`, `tests/depth-review.test.ts`, `tests/report-draft-split.test.ts`;
- `Implementations/report-review-resilience/*`, `Implementations/research-request-routing/*` (the AC-6/AC-7 sequences), `Implementations/adaptive-research/verification/reinvestigation.test.ts`, `Implementations/architecture-9/*/p3-run-control.test.ts`.

Weakening or deleting assertions unrelated to these mechanisms is a defect.

**Manual:** read the full diff; reconcile the diagrams; read the stamped docs against the diff; the paid SoFi run (P3), only after the user approves it.

## Completion evidence

To be filled in at close-out. Keep implementor reports apart from verifier results.

| Phase | Verified SHA | Correction rounds | Verifier result |
|---|---|---|---|
| P1 | | | |
| P2 | | | |
| P3 | | | |
