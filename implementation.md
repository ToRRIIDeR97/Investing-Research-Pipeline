# Research OS Backend–UI Stitching Implementation Plan

## Objective

Connect the existing web interface to the merged Research OS v3 backend so a
user can create, execute, review, and read a complete research run without
using command-line scripts.

The backend is the tested baseline. Do not rebuild the research engine. Pull
request #1 merged Reasonix into `main` at:

```text
b210ba98 Merge Reasonix research pipeline into main (#1)
```

The backend already supports:

- one current 24-stage workflow;
- typed research artifacts;
- company-genesis and founder-motivation research;
- role-driven source intelligence;
- historical, business-process, moat, forecast, and valuation analysis;
- annual bear/base/bull price-target paths;
- 50-combination framework backtesting;
- AI review and explicit human gates;
- export and refresh-schedule handlers.

The remaining problem is integration. The current UI creates a run and polls
it, but it does not reliably start the v3 engine, resume it after either human
gate, or render most canonical v3 artifacts.

This is an implementation assignment. The implementing agent must make the
changes, add tests, run validation, and commit the completed work.

## Required branch setup

```bash
git switch main
git pull --ff-only origin main
git switch -c codex/backend-ui-stitch
```

Do not commit directly to `main`. Do not merge or push unless the user asks.

## End-state user journey

```text
Asset page
  → Create v3 research run
  → Durable background job starts
  → Intake / identity / archetype composition
  → Real research-plan gate
  → User reviews and approves plan
  → Background job resumes
  → Sources / evidence / analysis / valuation / backtest / decision
  → Final human-review gate
  → User records investment decision
  → Background job resumes
  → Export and refresh schedule complete
  → Typed artifact-backed report is available
```

## Confirmed integration gaps

1. `POST /api/assets/:id/research-runs` does not explicitly write
   `pipeline_version = 3`.
2. The schema and database default for `pipeline_version` remain `1`.
3. The run page says “Starting research pipeline” but only creates a run and
   starts polling.
4. `/run-system-pipeline` waits synchronously for a potentially multi-minute
   run.
5. The UI displays a hard-coded 12-step plan rather than the actual 24-stage,
   profile-derived plan.
6. Research-plan approval and final approval do not durably enqueue the runner
   to continue.
7. The report reads compatibility tables but not most `research_artifacts`.
8. Company genesis, moat attacks, driver trees, expected returns, monitoring,
   AI review, and annual price-target paths are not properly presented.
9. The report may select an older completed run instead of the newest run.
10. The existing worker primarily claims isolated backtest tasks rather than
    complete research-run jobs.

## Non-negotiable constraints

1. Preserve all historical v1/v2 run rows and migrations.
2. New UI runs must use the server-owned current version. The browser must not
   choose a pipeline version.
3. Do not execute a long paid pipeline inside an HTTP request.
4. Execution queue state must survive web/worker restarts.
5. Multiple workers must not claim the same active run.
6. Duplicate clicks must be idempotent.
7. Do not automatically approve either human gate.
8. Export must not execute before final human approval.
9. A run must not become `completed` until export and refresh scheduling finish.
10. Never expose provider credentials or database credentials to the client.
11. Preserve source and market-data cutoffs.
12. Automated tests must use the mock provider and no live Yahoo, SEC, search,
    or paid model calls.
13. Typed v3 artifacts are canonical. Compatibility tables are read models, not
    the narrative source of truth.
14. Missing artifacts must produce visible incomplete states, never invented
    prose.

---

# Component 1 — Current-version run creation

## Main role

Workflow version and run-creation owner.

## Required changes

1. Add one exported constant:

   ```ts
   export const CURRENT_PIPELINE_VERSION = 3;
   ```

   Place it in a version-neutral server module and use it from run creation,
   dispatch, scripts, and tests.

2. Change the Drizzle `research_runs.pipeline_version` default to `3`.

3. Add a new forward migration changing the database default to `3`. Do not
   modify prior migrations or existing rows.

4. Update `POST /api/assets/:id/research-runs` to explicitly store
   `CURRENT_PIPELINE_VERSION`.

5. Keep `pipeline_version` out of client-controlled validation. If a caller
   submits it, reject or ignore it.

6. Return the stored version in create/detail/list responses.

7. Make run creation and stage initialization one service operation. A failure
   must not leave a run without stages.

## Test cases

### C1-T1 — Default UI run

Create a run through the API without a version.

Expected:

- HTTP 201;
- stored `pipeline_version = 3`;
- exactly 24 stages;
- no duplicate stage keys or orders.

### C1-T2 — Client attempts to choose v1

Send `pipeline_version: 1`.

Expected: the stored run is still v3, or the request is rejected with a clear
validation error.

### C1-T3 — Historical data preservation

Apply the migration to a database containing a v2 row.

Expected: the old row remains v2 and a new row defaults to v3.

### C1-T4 — Dispatcher compatibility

Pass the new run to `runSystemResearchPipeline`.

Expected: no unsupported-version error.

---

# Component 2 — Durable research-run execution queue

## Main role

Database job queue and worker owner.

## Required changes

Do not connect the browser directly to the synchronous pipeline endpoint. Add a
durable run-level queue.

1. Add a `research_run_jobs` table through a new migration and Drizzle schema:

   - `id`
   - `research_run_id`
   - `job_type`
   - `status`: `queued`, `running`, `completed`, `failed`
   - `requested_by`
   - `attempt_count`
   - `max_attempts`
   - `lease_owner`
   - `lease_expires_at`
   - `result_json`
   - `failure_reason`
   - `queued_at`
   - `started_at`
   - `completed_at`
   - `created_at`
   - `updated_at`

2. Add a partial unique index permitting at most one active
   (`queued`/`running`) pipeline job per run.

3. Implement:

   ```text
   enqueueResearchRun
   claimNextResearchRun
   renewResearchRunLease
   completeResearchRunJob
   failResearchRunJob
   requeueExpiredResearchRunJobs
   getLatestResearchRunJob
   ```

4. Claim jobs atomically using a transaction and
   `FOR UPDATE SKIP LOCKED`.

5. Add/extend a pipeline worker that:

   - claims one job;
   - calls `runSystemResearchPipeline(runId)`;
   - periodically renews the lease;
   - persists the returned result;
   - records infrastructure exceptions separately from valid pipeline outcomes;
   - recovers expired leases;
   - shuts down gracefully.

6. Treat these as successful worker executions whose workflow state is stored
   on the run:

   - `waiting_for_human`;
   - `needs_more_work`;
   - `completed`.

7. Change `POST /api/research-runs/:id/run-system-pipeline` into an idempotent
   enqueue/resume endpoint returning HTTP 202. It must not await the full
   pipeline.

8. Add `GET /api/research-runs/:id/jobs` or include the latest job in run
   detail.

9. Add documented local scripts for starting both web and worker processes.

10. Add a worker heartbeat/health record or endpoint so the UI can distinguish
    “queued normally” from “queued but no worker is available.”

## Test cases

### C2-T1 — Fast enqueue response

POST the start endpoint.

Expected: HTTP 202 and a queued job ID before any model execution begins.

### C2-T2 — Duplicate start

Submit two start requests for one run.

Expected: one active job.

### C2-T3 — Competing workers

Run two claims concurrently.

Expected: one worker receives the job.

### C2-T4 — Lease recovery

Expire a running job lease and invoke recovery.

Expected: the job becomes claimable once and resumes through pipeline
idempotency.

### C2-T5 — Human gate outcome

Run until a human gate.

Expected: the job completes with a `waiting_for_human` result; it is not marked
as an infrastructure failure.

### C2-T6 — Unsupported legacy run

Enqueue a v2 run.

Expected: HTTP 422 and no job row.

---

# Component 3 — Run-page creation and real research-plan gate

## Main role

Run-page user experience owner.

## Required changes

1. Replace the current hard-coded plan-first flow with:

   - research question;
   - run type;
   - source cutoff;
   - market-data cutoff;
   - optional budget.

2. The first action should create a v3 run and enqueue it.

3. Let the engine complete intake, identity, and archetype composition before
   showing the research-plan gate.

4. Persist a deterministic `research_plan` artifact before the plan gate. It
   must contain:

   - asset and profile;
   - composed archetypes and overlays;
   - required source roles;
   - required historical metrics;
   - required analysis modules;
   - applicable and forbidden valuation methods;
   - backtest requirement;
   - applicable stage list;
   - cutoffs and budget.

5. Render the persisted plan instead of `generateResearchPlan()`.

6. Add explicit controls:

   - Approve Plan;
   - Request Changes.

7. Approve Plan must:

   - call `/approve-plan`;
   - persist approver/time;
   - enqueue exactly one resume job;
   - return immediately.

8. Request Changes must persist notes and leave the workflow in a documented
   actionable state.

9. Reloading the page must reconstruct the plan/gate from the database.

## Test cases

### C3-T1 — Persisted plan

Create a mock equity run.

Expected: the UI renders profile, sources, modules, methods, stages, cutoffs,
and budget from persisted backend state.

### C3-T2 — No automatic approval

Do not click Approve.

Expected: `research_plan` stays `waiting_for_human` and source discovery does
not start.

### C3-T3 — Approval resumes

Approve once.

Expected: plan stage completes and exactly one resume job is queued.

### C3-T4 — Double-click safety

Submit approval twice rapidly.

Expected: one effective approval and one active job.

### C3-T5 — Reload

Reload at the gate.

Expected: the same plan and actions reappear.

---

# Component 4 — Live 24-stage progress and failure UX

## Main role

Pipeline theater and operational-state owner.

## Required changes

1. Run detail must expose:

   - version;
   - run status;
   - latest job status;
   - all stages;
   - active/recent tasks;
   - cost and budget;
   - sources and role coverage;
   - model calls;
   - backtest combination progress;
   - run, stage, task, and job failures.

2. Render the 24 database stages in `stage_order`. Do not maintain a separate
   client stage list.

3. Distinguish:

   - queued;
   - running;
   - waiting for plan approval;
   - waiting for final review;
   - needs more work;
   - worker unavailable;
   - worker failure;
   - completed.

4. Poll while queued/running. Slow or stop polling at stable gates and terminal
   states; resume after user action.

5. Display the most actionable failure with stage/task context.

6. Add Retry/Resume only when the backend reports that the action is valid.

7. Show source-role coverage as distinct roles, not the raw number of
   role-by-artifact rows.

## Test cases

### C4-T1 — Stage list

Expected: exactly 24 stages in backend order.

### C4-T2 — Gate-specific actions

Expected: plan controls only at `research_plan`; investment-review controls
only at `human_review`.

### C4-T3 — Handler failure

Force a mock handler failure.

Expected: persisted reason is visible and polling does not spin forever.

### C4-T4 — Worker unavailable

Queue a run without a healthy worker heartbeat.

Expected: a clear “waiting for worker” warning.

### C4-T5 — Poll lifecycle

Expected: active polling during execution and reduced/stopped polling at human
gates.

---

# Component 5 — Canonical typed-artifact and report APIs

## Main role

Backend read-model/API owner.

## Required changes

1. Add:

   ```text
   GET /api/research-runs/:id/artifacts
   GET /api/research-runs/:id/artifacts/:artifactType
   GET /api/research-runs/:id/report
   ```

2. Artifact responses must include:

   - ID;
   - type;
   - scope;
   - status;
   - content object;
   - schema/prompt/validator versions;
   - validation result;
   - timestamps.

3. By default return the newest non-superseded artifact for each type/scope.

4. Return JSONB objects as objects, including backward-compatible parsing for
   legacy string-valued rows.

5. The report endpoint should aggregate canonical typed artifacts plus tabular
   read models:

   - evidence;
   - metrics;
   - valuation signals;
   - scenarios;
   - backtests;
   - sources and source-role coverage;
   - model calls;
   - export and refresh metadata.

6. Preserve existing compatibility endpoints for specialized tables.

7. Apply consistent authorization/run isolation.

## Test cases

### C5-T1 — Typed object output

Seed genesis, moat, valuation, decision, and review artifacts.

Expected: `content_json` is an object, not a JSON string.

### C5-T2 — Supersession

Seed two versions and supersede the first.

Expected: only the current artifact appears by default.

### C5-T3 — Cross-run isolation

Expected: run A never receives run B artifacts.

### C5-T4 — Unknown run/type

Expected: consistent 404 response.

### C5-T5 — Incomplete run

Expected: report response marks required missing sections instead of inventing
content.

---

# Component 6 — Artifact-backed research report

## Main role

Research report UI owner.

## Required changes

Use typed artifacts as the primary report source.

The report must include:

1. Executive decision and workflow status.
2. Company genesis:
   - why the company started;
   - founder identity and motivation;
   - original problem;
   - early constraints/funding;
   - pivots;
   - current strategic implication.
3. Historical record and diagnosis.
4. Customer and business process:
   - segment model;
   - customer decision map;
   - process map;
   - bottleneck register;
   - competitive-response matrix.
5. Moat assessment, attack matrix, and no-moat counterfactual.
6. Driver tree and operating model.
7. Bear/base/bull operating scenarios.
8. Valuation:
   - market price;
   - methods/lenses;
   - reverse valuation;
   - annual price-target table.
9. Decision:
   - thesis;
   - risks;
   - catalysts;
   - expected-return matrix;
   - thesis breakers;
   - monitoring dashboard;
   - confidence assessment.
10. Backtesting:
    - combination count;
    - top 10;
    - reviewed failures;
    - IS/OOS results;
    - benchmark;
    - costs;
    - one-bar shift/no-lookahead rule;
    - proxy-data limitations.
11. AI review and human decision.
12. Sources, role coverage, evidence, citations, and gaps.

Additional requirements:

1. Add a run selector.
2. Default to the newest run, not an arbitrary older completed run.
3. Allow reports for `waiting_for_human` and `needs_more_work`.
4. Display pipeline version.
5. Preserve stored numbers; do not recalculate valuation in React.
6. Render the annual price path as a real table:

   | Fiscal year | Bear | Base | Bull |

7. Do not hide missing sections. Render a visible incomplete state.
8. Make evidence/source links navigable.
9. Keep large JSON previews as a secondary diagnostic view, not the primary
   presentation.

## Test cases

### C6-T1 — Genesis narrative

Expected: founder motivation and company origin are visible with citations.

### C6-T2 — Price-target table

Load five years and three scenarios.

Expected: five rows with bear/base/bull columns and terminal values matching
the stored anchors.

### C6-T3 — Non-monotonic targets

Expected: a falling-then-recovering bear path is rendered unchanged.

### C6-T4 — Missing moat

Expected: visible incomplete moat section, not a missing panel or filler.

### C6-T5 — Run selection

Seed an old completed run and newer human-review run.

Expected: newer run is selected and both remain selectable.

### C6-T6 — Backtest disclosures

Expected: counts, IS/OOS, costs, no-lookahead, benchmark, and limitations are
visible.

---

# Component 7 — Final human review and resume

## Main role

Review workflow owner.

## Required changes

1. Review queue should contain legitimate final-review candidates only.

2. Final review must display:

   - investment thesis;
   - scenario price targets;
   - expected-return matrix;
   - principal risks and catalysts;
   - thesis breakers;
   - monitoring thresholds;
   - backtest conclusion and limitations;
   - AI-review findings.

3. Persist the decision before completing the stage.

4. Approved decisions must:

   - call `approveHumanReview`;
   - enqueue one resume job;
   - let the worker execute export and refresh scheduling.

5. The review route must not directly mark the run completed.

6. `needs_more_work` must preserve reviewer notes and must not enqueue export.

7. Make review submission idempotent.

8. After approval, navigate to progress/report and show export completion.

## Test cases

### C7-T1 — Approval resumes export

Expected: review completes, one job is queued, export/refresh finish, then run
becomes completed.

### C7-T2 — No approval

Expected: export remains pending.

### C7-T3 — Needs more work

Expected: notes persist, approval metadata is absent, no export job exists.

### C7-T4 — Duplicate approval

Expected: one decision transition and one active job.

### C7-T5 — Invalid status

Expected: HTTP 400/422 and no partial decision/stage update.

---

# Component 8 — Export, refresh, and operations

## Main role

Export and deployment owner.

## Required changes

1. Expose generated export metadata and a usable view/download link.

2. Display refresh schedule:

   - next refresh date;
   - reason/trigger;
   - cadence;
   - status.

3. Document local startup:

   ```text
   database
   migrations
   web process
   pipeline worker
   mock acceptance mode
   ```

4. Ensure production/development setup starts at least one run worker.

5. Add queue/worker health to an operations response or UI.

6. Remove production dependence on manually invoking
   `scripts/resume-research-run.ts`.

## Test cases

### C8-T1 — Export availability

Expected: completed export is reachable from the report.

### C8-T2 — Refresh visibility

Expected: persisted schedule details render correctly.

### C8-T3 — Worker health

Expected: heartbeat is healthy while worker runs and stale after its timeout.

### C8-T4 — Restart

Restart the web process while a worker is executing.

Expected: job and run continue without losing state.

---

# Component 9 — End-to-end acceptance

## Main role

Independent test owner.

## Required mock-provider flow

Create a database-backed acceptance test using the same services/routes as the
UI:

1. Create an asset/run.
2. Verify `pipeline_version = 3`.
3. Verify 24 stages.
4. Verify an execution job was queued.
5. Claim and run to research-plan approval.
6. Verify persisted plan.
7. Approve the plan.
8. Queue and resume.
9. Verify sources, evidence, typed analysis, scenarios, valuation path, and 50
   backtests.
10. Stop at final human review.
11. Submit an approved review decision.
12. Queue and resume.
13. Verify export, refresh schedule, and completed run.
14. Fetch report data.
15. Verify founder story and annual bear/base/bull target table.

Use:

```text
RESEARCH_MODEL_PROVIDER=mock
RESEARCH_ACCEPTANCE_PROVIDER=mock
no live network
no paid API
```

Do not globally skip content validators unless the fixture explicitly cannot
represent the required data. Prefer valid fixtures.

## Required commands

```bash
npx tsc --noEmit
npm run test:unit
npm run build
npm run test:sofi-v3
```

If browser testing is introduced, include:

```text
create → plan gate → approve → progress → final review → approve → report
```

## Acceptance matrix

| Requirement | Expected result |
|---|---|
| UI-created pipeline version | 3 |
| Stage count | 24 |
| Start operation | Durable HTTP 202 queue operation |
| Research plan | Persisted and explicitly approved |
| Automated stages before final gate | 21 completed |
| Backtesting | 50/50 combinations |
| Final decision | Explicit human record |
| Export and refresh | Complete after approval |
| Genesis story | Visible with evidence |
| Annual price targets | Bear/base/bull for every year |
| Missing artifacts | Visible incomplete state |
| Duplicate actions | Idempotent |
| TypeScript | Pass |
| Unit suite | Pass |
| Production build | Pass |
| Paid/live calls in tests | Zero |

## Suggested ownership boundaries

If the implementing agent delegates work:

- Backend queue owner: Components 1–2.
- Run-page owner: Components 3–4.
- Read-model/report owner: Components 5–6.
- Review/export owner: Components 7–8.
- Tester: Component 9 and regression tests.
- Reviewer: final read-only review after all validation passes.

Only one agent should own each of these shared files at a time:

```text
package.json
src/db/index.ts
src/db/schema/workflow.ts
src/app/assets/[id]/run/page.tsx
src/app/assets/[id]/view/page.tsx
src/app/review/page.tsx
```

## Files to inspect first

```text
src/app/api/assets/[id]/research-runs/route.ts
src/app/api/research-runs/[id]/run-system-pipeline/route.ts
src/app/api/research-runs/[id]/approve-plan/route.ts
src/app/api/research-runs/[id]/review/route.ts
src/app/api/review/queue/route.ts
src/app/assets/[id]/run/page.tsx
src/app/assets/[id]/view/page.tsx
src/app/review/page.tsx
src/workers/research-worker.ts
src/lib/research/pipeline-runner.ts
src/lib/research/system-pipeline.ts
src/lib/research/stage-contracts.ts
src/lib/research/artifacts/repository.ts
src/lib/workflow/orchestrator.ts
src/lib/workflow/stages.ts
src/lib/workflow/validators.ts
src/db/schema/workflow.ts
src/db/schema/research-artifacts.ts
src/lib/export/report-generator.ts
tests/sofi-research-e2e.test.ts
```

## Completion rule

Do not call the UI “connected” merely because it can create a row, display
stages, or call the pipeline endpoint. Completion requires one new run to
traverse the full UI-controlled lifecycle through both human gates, export,
refresh scheduling, and an artifact-backed report.
