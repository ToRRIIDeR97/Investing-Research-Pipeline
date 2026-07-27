# Research Pipeline Follow-up Implementation Plan

## Purpose

Finish the reliability and automation work left after the SOFI v3 mock end-to-end acceptance effort. This plan is based on the three newest handovers:

- `handover files/2026-07-19-sofi-v3-e2e-acceptance-complete-handover.md`
- `handover files/2026-07-18-sofi-v3-sql-json-bug-handover.md`
- `handover files/2026-07-18-sofi-v3-mock-e2e-acceptance-handover.md`

The July 19 handover supersedes the in-progress states in the July 18 files. Treat the earlier files as failure history and test-design context, not as the current architecture.

## Current Baseline

Confirm these facts before editing:

- The runtime is version-neutral: `runResearchPipeline(runId)` in `pipeline-runner.ts` is the canonical pipeline entry point.
- Canonical stage handlers live in `src/lib/research/handlers/`.
- Stage output contracts live in `src/lib/research/stage-contracts.ts`.
- Report generation lives in `src/lib/export/report-generator.ts`.
- `scripts/test-acceptance.ts` is the latest full SOFI mock acceptance harness.
- `tests/sofi-research-e2e.test.ts` is the isolated database-backed acceptance suite invoked by `npm run test:sofi-v3`.
- Legacy `v3-pipeline.ts`, `v3-context.ts`, `v3-stage-registry.ts`, `v3-contracts.ts`, `src/lib/research/v3/handlers/`, and `src/lib/export/v3-report-generator.ts` no longer exist.
- Mock acceptance currently depends on `SKIP_V3_CONTENT_VALIDATORS=true` to bypass content and quality checks that synthetic fixtures cannot satisfy.
- Dynamic JSONB concatenation in `run-context.ts` still uses an escaped `sql.unsafe()` literal.

Do not recreate deleted v3-prefixed modules or introduce a second pipeline path.

## Goal

Provide one deterministic, isolated, repeatable SOFI mock acceptance workflow that:

1. exercises the canonical pipeline through both human gates and final completion;
2. validates every applicable stage and required artifact;
3. verifies backtest and export behavior;
4. does not mutate or depend on a pre-existing real SOFI asset;
5. cleans up all test-created rows in foreign-key-safe order;
6. has an explicit package script suitable for local use and CI;
7. keeps production validation enabled by default and scopes any mock-only bypass to the acceptance harness;
8. leaves a clearly documented boundary between mock acceptance and a future paid real-provider smoke run.

## Non-goals

- Do not run a paid or live-provider research job.
- Do not change the research stage graph, artifact schema, or report format unless a failing acceptance assertion proves the current implementation is incorrect.
- Do not replace PostgreSQL or redesign the persistence layer.
- Do not add asset-slug branches to production pipeline code.
- Do not perform a broad rename of historical “v3” test labels unless required for correctness.

## Implementation Sequence

### 1. Establish the baseline

Run:

```bash
npx tsc --noEmit
npm run test:unit
```

Then, with the test PostgreSQL instance available:

```bash
npm run test:sofi-v3
```

Record failures exactly. Distinguish product failures from missing database/service prerequisites. Do not weaken assertions merely to make the suite green.

### 2. Consolidate the acceptance entry point

Use `tests/sofi-research-e2e.test.ts` as the canonical automated acceptance suite. Compare its coverage with `scripts/test-acceptance.ts` and port any unique, still-relevant assertions into the test suite:

- every applicable stage completes;
- both `research_plan` and `human_review` gates pause and resume correctly;
- no non-human task remains `running` at either gate;
- required artifacts are derived from the contracts in `stage-contracts.ts`, not duplicated as a stale static list;
- `synthetic_report` includes an `exportId`;
- `refresh_schedule` completes after export;
- 50 backtest combinations complete;
- all 50 backtests contain in-sample, out-of-sample, excess-return, and parameter-stability evidence;
- the final run status is `completed`;
- rerunning an idempotent operation does not create duplicate logical artifacts.

After parity is achieved, either:

- reduce `scripts/test-acceptance.ts` to a thin documented wrapper around the canonical test command; or
- delete it if it has no remaining distinct operational use.

Prefer one source of acceptance assertions.

### 3. Make fixture setup and cleanup self-contained

Keep all test data isolated under generated IDs and a generated slug. Never select the production `sofi` row as the subject of the test.

Extract the large foreign-key-aware cleanup routine from `tests/sofi-research-e2e.test.ts` into a test support module if another database-backed suite needs the same behavior. The helper must:

- accept the exact test asset/run identifiers;
- delete only rows reachable from those identifiers;
- delete child rows before parents;
- run during both setup recovery and teardown;
- preserve any pre-existing SOFI asset and assert that it was not mutated.

Do not use `TRUNCATE`, broad slug deletes, or global fixture cleanup.

### 4. Scope mock-mode validation behavior explicitly

Audit these current bypass points:

- `src/lib/workflow/orchestrator.ts`
- `src/lib/research/handlers/human-review.ts`

Replace direct, scattered reads of `SKIP_V3_CONTENT_VALIDATORS` with one named acceptance-mode predicate or run-scoped policy. The policy must require explicit mock/test context and must default to validators enabled.

Acceptance criteria:

- production and real-provider paths cannot accidentally inherit the bypass from an unrelated environment;
- tests cover enabled-by-default behavior;
- tests cover the exact mock acceptance condition that permits the bypass;
- comments explain which synthetic-data limitations require the bypass;
- the old environment variable may remain temporarily for compatibility, but its use must be centralized.

Do not loosen the actual source, evidence, stage, or quality validators.

### 5. Encapsulate JSONB persistence

Audit JSONB writes in:

- `src/lib/research/run-context.ts`
- `src/lib/research/artifacts/repository.ts`
- the canonical handlers under `src/lib/research/handlers/`
- workflow failure and validation persistence

The handovers document a postgres.js 3.4.5 failure in some `sql.json()` query shapes and the current `sql.unsafe()` workaround for JSONB concatenation. Create one narrowly scoped helper for the query shapes that cannot safely use parameterized `sql.json()`.

The helper must:

- serialize exactly once;
- reject or handle non-serializable values deterministically;
- escape SQL string delimiters correctly;
- return only a JSONB SQL fragment;
- include focused tests for apostrophes, nested objects, arrays, Unicode, `null`, and JSON serialization failures.

Continue using parameterized `sql.json()` where it is known to work. Do not mechanically replace every JSON write with raw SQL. If upgrading `postgres` removes the bug, prove it with integration tests before removing the workaround.

### 6. Add stable commands and CI wiring

Add a clear package script such as:

```json
"test:acceptance:sofi": "..."
```

Keep the existing `test:sofi-v3` as an alias during migration if external workflows may call it.

The command must set only deterministic mock-provider flags. Database connection configuration should be overridable rather than hard-coded for all environments.

Add the acceptance command to CI only if CI provisions and seeds PostgreSQL. The job should:

1. install dependencies from the lockfile;
2. start/provision PostgreSQL;
3. apply migrations and required seed data;
4. run type checking and unit tests;
5. run the SOFI mock acceptance suite;
6. always execute teardown/log collection.

Do not add a CI step that silently skips when the database is absent.

### 7. Update documentation

Document:

- prerequisites and the exact local command;
- required environment variables;
- how the two human gates are auto-approved in test mode;
- why content validators are scoped out for synthetic fixtures;
- the difference between mock acceptance and real-provider smoke coverage;
- how to diagnose a failed stage using `research_stages.failure_reason` and run metadata.

Use version-neutral terminology for the runtime. Historical test names may retain “v3” only where compatibility requires it.

## Validation Matrix

| Check | Command or assertion | Required result |
|---|---|---|
| Type safety | `npx tsc --noEmit` | Exit 0 |
| Unit/regression suite | `npm run test:unit` | Exit 0; skipped DB tests identified |
| Mock E2E | `npm run test:acceptance:sofi` | Exit 0 |
| Stage completion | Database assertions | All applicable stages completed |
| Human gates | Test assertions | Both gates pause, approve, and resume |
| Artifact coverage | Contract-derived assertions | All required artifacts present once |
| Backtest coverage | Database assertions | 50 completed and 50 robust records |
| Export | Artifact assertion | `synthetic_report.content_json.exportId` present |
| Final status | Run assertion | `completed` |
| Isolation | Before/after assertions | Pre-existing SOFI unchanged |
| Cleanup | Post-test queries | No rows remain for generated asset/run IDs |
| Validator safety | Unit tests | Bypass off by default and limited to mock acceptance |
| JSONB safety | Unit + DB integration tests | Complex payloads round-trip unchanged |

## Completion Criteria

The work is complete only when:

- there is one canonical automated SOFI mock acceptance suite;
- the package script and documentation agree;
- the suite passes twice consecutively against a clean, seeded test database;
- type checking and relevant unit tests pass;
- test-created database state is removed after both success and failure;
- the validator bypass is centralized, explicit, and tested;
- JSONB workaround usage is centralized and covered by round-trip tests;
- no paid-provider call is made;
- any environmental or pre-existing failure is reported rather than described as successful validation.

## Handoff Notes for the Implementing Agent

Before changing code, inspect the current branch and preserve unrelated user changes. Use repository evidence over filenames mentioned in old handovers because several referenced v3-prefixed files were intentionally deleted during consolidation. Keep production-file ownership narrow, and report the exact commands run plus any checks that could not run.
