# Reasonix Implementation Plan

## Objective

Consolidate Research OS into one supported research pipeline and repair the SOFI
end-to-end failures.

The current supported implementation is the Research OS v3 design. The finished
codebase must not contain separate executable v1, v2, and v3 pipelines. It should
expose one version-neutral pipeline, one stage definition, one orchestrator, and
one set of current artifact contracts.

This is an implementation assignment, not another planning exercise. Complete
the code changes, tests, documentation, and validation described below.

## Mandatory branch setup

Before editing any file:

```bash
git switch codex/local-agent-harness
git pull --ff-only origin codex/local-agent-harness
git switch -c reasonix
```

All work must be committed to `reasonix`. Do not commit directly to
`codex/local-agent-harness` or `main`. Do not merge `reasonix` into another
branch unless the user explicitly asks.

## Known baseline

The starting branch contains the current v3 implementation, but it is not
release-ready.

Confirmed baseline behavior:

- A SOFI mock run reaches the `research_plan` human gate correctly.
- After research-plan approval, analysis stages fail to create their required
  artifacts.
- The pipeline eventually fails because the shared orchestrator requires the
  old v2-only `asset_analysis` stage before `asset_valuation`.
- `export` and `refresh_schedule` are part of the current stage specification
  but have no registered runtime handlers.
- `npx tsc --noEmit` fails in `tests/sofi-v3-e2e.test.ts` because it reads a
  nonexistent `SystemPipelineResult.failure_reason`.
- The unit suite passes, but the database-backed SOFI acceptance flow does not.

Do not treat the existing handover claim that `postgres.js sql.json()` is the
root cause as established fact. The installed package is postgres.js 3.4.9,
several `sql.json()` operations already work, and the current failure is a
model-output/artifact contract failure. Add a focused regression test before
changing JSON persistence.

## Non-negotiable constraints

1. There must be one active research runtime when this work is complete.
2. Do not delete numbered database migrations. Migration history is required to
   create and upgrade databases even when old application runtimes are removed.
3. Do not rewrite or hide failing tests merely to obtain a green result.
4. Do not call paid model providers in automated acceptance tests.
5. Do not make live SEC, Yahoo, or other network calls in deterministic tests.
6. Do not delete or overwrite an existing real SOFI asset during test setup.
7. Do not insert artifacts directly as `accepted` before their contract
   validation succeeds.
8. Do not use raw `sql.unsafe()` interpolation for dynamic JSON.
9. Preserve point-in-time cutoffs and prevent look-ahead data.
10. Preserve the research goals already added: company genesis and founder
    motivation, historical diagnosis, business-process analysis, moat testing,
    operating scenarios, and bear/base/bull annual price targets.

---

# Component 1 — Establish the canonical pipeline and removal map

## Role

Repository/architecture owner.

## Required changes

Inventory every executable pipeline entry point, stage list, version switch,
worker call, script, API route, and test before deleting code.

At minimum inspect:

- `src/lib/research/system-pipeline.ts`
- `src/lib/research/v3-pipeline.ts`
- `src/lib/research/v3-context.ts`
- `src/lib/research/v3/handlers/`
- `src/lib/workflow/orchestrator.ts`
- `src/lib/workflow/stages.ts`
- `src/lib/workflow/validators.ts`
- run-creation scripts and workers
- all `pipeline_version`, `runResearchPipelineV2`, `runResearchPipelineV3`,
  `getStageConfig`, and `asset_analysis` references

Create a temporary removal map in the working notes with these classifications:

- current runtime code to retain and rename
- current code still incorrectly depending on legacy helpers
- legacy runtime code with no current callers
- shared utilities still required by the current runtime
- database migrations/schema needed for compatibility
- old tests that should be rewritten for the current runtime
- genuinely dead tests/files that should be deleted

Use repository evidence. Do not infer that a file is dead merely because its
name contains `v1` or `v2`.

The target architecture is:

```text
runResearchPipeline
  -> current stage registry
  -> current stage handler
  -> stage-specific output validation
  -> artifact validation and acceptance
  -> current dependency-based transition
```

There must be no runtime dispatcher choosing among pipeline versions.

## Test cases

### C1-T1 — One executable pipeline

Search production code for legacy dispatch:

```bash
rg -n "runResearchPipelineV1|runResearchPipelineV2|runResearchPipelineV3|pipelineVersion ===|pipeline_version.*[<>=].*[123]" src scripts
```

Expected: no executable version-selection path. A schema field or explicit
legacy-data rejection may remain, but it must not select an old implementation.

### C1-T2 — No legacy stage set

```bash
rg -n "asset_analysis|V1_STAGES|V2_STAGES|V3_STAGES|getStageConfig\\([^)]*,\\s*[123]" src
```

Expected: no old `asset_analysis` dependency and no multiple active stage
arrays. If a compatibility reference remains, document why it cannot execute.

### C1-T3 — Migration history preserved

Run migrations against an empty disposable database.

Expected: all numbered migrations apply successfully and produce the current
schema. Old migration filenames must remain even though old runtime code is
removed.

---

# Component 2 — Rename v3 into the version-neutral current runtime

## Role

Pipeline consolidation owner.

## Required changes

After the removal map is complete:

1. Promote the current v3 implementation to version-neutral names.
2. Rename public symbols such as `runResearchPipelineV3`, `V3RunContext`, and
   `V3StageHandler` to current equivalents.
3. Move `src/lib/research/v3/handlers/` to a version-neutral location such as
   `src/lib/research/handlers/`.
4. Rename `v3-context.ts`, `v3-pipeline.ts`, `v3-stage-registry.ts`, and
   `v3-contracts.ts` where doing so improves clarity.
5. Rename the v3 report generator to the current report generator.
6. Update imports, scripts, tests, and documentation.
7. Remove the old monolithic pipeline only after all required source ingestion
   and shared behavior has been moved into current modules.
8. Make new runs use the current pipeline without an environment variable that
   selects a version.

The database may keep `pipeline_version` temporarily for historical metadata,
but application code must either:

- create current runs with one constant current value; and
- reject unsupported historical runs with a clear error;

or migrate the field away in a forward migration. It must not dispatch to an
old runtime.

Do not rename schema versions embedded in already-created artifacts or
migrations. Runtime consolidation and historical schema identity are different
concerns.

## Test cases

### C2-T1 — Current entry point

A test imports only `runResearchPipeline` and starts a new run without
`RESEARCH_PIPELINE_VERSION`.

Expected: the current pipeline starts.

### C2-T2 — Legacy run handling

Create a run row marked with an unsupported historical pipeline version.

Expected: one explicit unsupported-version error. The system must not silently
execute current stages against incompatible historical state.

### C2-T3 — No version-specific production paths

```bash
rg -n "/v3/|v3-pipeline|v3-context|V3RunContext|V3StageHandler" src scripts
```

Expected: no version-specific runtime names, except deliberately preserved
historical metadata or migration commentary.

---

# Component 3 — Repair stage-specific model-output contracts

## Role

Agent harness and contract owner.

## Root cause

Current analysis handlers prompt for the generic asset-analyst keys:

- `analysis_sections`
- `key_drivers`
- `metric_interpretation`
- `contradictions_or_tensions`
- `missing_modules`
- `source_gaps`
- `analyst_questions`
- `confidence`

Those handlers then try to persist different top-level keys such as
`company_genesis`, `founder_profile`, `driver_tree`, or `moat_assessment`.

The shared agent registry enforces the generic output schema. A correct
specialized response is therefore rejected and sent through repair. The repair
request does not preserve enough of the original task contract, and the mock
provider returns the generic analyst response. No specialized artifacts are
persisted.

## Required changes

1. Allow an agent request to supply a stage-specific structured-output schema.
   Do not force every request made by `asset-analyst` through one generic schema.
2. Define one explicit response contract for each artifact-producing stage:
   - company genesis
   - historical diagnosis
   - business-process analysis
   - moat analysis
   - operating model
   - operating scenarios
   - valuation
   - decision synthesis
   - AI review
3. The prompt’s required keys, parser required keys, schema validator, handler
   output type, and persisted artifact keys must all come from the same
   contract.
4. Include a stable stage or artifact-family discriminator in the task packet.
5. Structured-output repair must retain:
   - the original stage discriminator
   - required keys/schema
   - the original bounded task packet or a safe compacted form
   - the validation errors
   - the previous response
6. Update the mock provider to route on the explicit discriminator, not on
   brittle inference from a generic prompt.
7. Remove debug `console.log` statements from production handlers.
8. Use concrete TypeScript output types instead of `unknown` and `any` for
   handler results.

## Test cases

### C3-T1 — Company-genesis contract

Send a company-genesis request through the complete agent runner using the mock
provider.

Expected top-level keys:

- `company_genesis`
- `founder_profile`
- `strategic_history_timeline`
- `strategic_dna`

The output must pass the same schema used by the handler.

### C3-T2 — All specialized contracts

Create a table-driven test covering every artifact-producing handler.

Expected: each mock response passes without structured-output repair and
contains exactly the artifact family required by that stage.

### C3-T3 — Repair retains the contract

Make the first mock response malformed and the repair response valid.

Expected: the repair request still identifies the original stage and produces
the specialized response, not generic `analysis_sections`.

### C3-T4 — Wrong family rejected

Return a moat response to the company-genesis handler.

Expected: schema validation fails and no artifacts are inserted.

---

# Component 4 — Make artifact persistence validation-first

## Role

Artifact repository and validation owner.

## Required changes

1. Handlers must create artifacts as `draft` or `validated`.
2. Run the artifact-specific validator before acceptance.
3. Call the repository acceptance method only after validation succeeds.
4. Store validation metadata and validator version.
5. Link supporting `evidence_claim_ids` through
   `research_artifact_claim_links`.
6. Add required artifact dependencies through
   `research_artifact_dependencies`.
7. Make handler `validate()` check required persisted artifacts, their status,
   and their validation result—not merely the existence of a completed task.
8. Correct repository idempotency:
   - use the declared idempotency key or a documented unique logical key;
   - retrying the same stage in the same run must not duplicate artifacts;
   - changed content must not be silently discarded;
   - artifacts from different runs remain independent.
9. Parse legacy string JSON only at a clearly bounded compatibility boundary.
   Current JSONB reads should return typed objects.

## Test cases

### C4-T1 — Missing artifact fails locally

Complete a task without inserting its required artifact.

Expected: that handler’s validation fails immediately with the missing artifact
types. The error must not be deferred to a later global validator.

### C4-T2 — Invalid artifact is not accepted

Generate a company genesis artifact with an unsupported assertion about founder
financial motivation.

Expected: the artifact remains non-accepted and the stage reports the contract
error.

### C4-T3 — Evidence links

Accept a valid artifact with two real evidence claim IDs.

Expected: two valid claim-link rows exist and no fabricated UUID is accepted.

### C4-T4 — Same-run idempotency

Execute the same handler twice for the same run and task key.

Expected: one current logical artifact per type/scope, with deterministic
content/version behavior.

### C4-T5 — Cross-run independence

Execute two separate research runs for the same asset.

Expected: each run owns its own artifact set. The second run is not incorrectly
deduplicated against the first.

---

# Component 5 — Replace legacy orchestration with current dependencies

## Role

Workflow orchestration owner.

## Required changes

1. Remove the hard-coded `asset_analysis` prerequisite for `asset_valuation`.
2. Define stage dependencies once in the current stage configuration.
3. Use those dependencies consistently for:
   - entry criteria
   - retries
   - skip behavior
   - human gates
   - failure propagation
   - resume
4. Required analysis stages must finish with their required accepted artifacts
   before valuation starts.
5. `optional_backtest` without an approved timing hypothesis must be
   `not_applicable`/skipped, not treated as a pipeline failure.
6. Human review must not start if required current stages failed.
7. A failed required stage must not leave later stages or tasks running.
8. Remove duplicated transition logic between the pipeline runner and shared
   orchestrator.
9. Preserve two human gates:
   - research-plan approval before research execution
   - final human review before export/final completion

## Test cases

### C5-T1 — Valuation dependency chain

Complete all current required analysis stages and artifacts without creating an
`asset_analysis` stage.

Expected: `asset_valuation` starts.

### C5-T2 — Missing moat blocks valuation

Leave the required moat artifact incomplete.

Expected: valuation does not start and the failure identifies the missing
current dependency.

### C5-T3 — Human-gate sequence

Run a fresh mock pipeline.

Expected sequence:

1. stops at `research_plan`;
2. resumes only after plan approval;
3. stops at `human_review`;
4. resumes only after final human approval.

### C5-T4 — Optional backtest

Run without a timing hypothesis.

Expected: optional backtest is explicitly skipped/not applicable and does not
block human review.

### C5-T5 — Terminal cleanup

Force a required stage failure.

Expected: zero non-human stages and zero tasks remain in `running`.

---

# Component 6 — Implement the missing terminal stages

## Role

Export and lifecycle owner.

## Required changes

Implement and register current handlers for:

- `export`
- `refresh_schedule`

The export handler must consume accepted current artifacts and use the existing
25-section report structure. Missing required sections must remain visibly
incomplete; do not generate filler.

The refresh-schedule handler must persist a deterministic refresh decision or
explicitly record that no automatic refresh was requested. It must be
idempotent.

After final human approval:

1. export runs;
2. refresh scheduling runs;
3. the research run reaches its documented successful terminal status.

## Test cases

### C6-T1 — Registry completeness

Compare every executable current stage key with the registered handler keys.

Expected: exact set equality.

### C6-T2 — Export after approval

Before final human approval, assert no final export exists. Approve the final
review and resume.

Expected: one watermarked synthetic report is created with all 25 canonical
section headings.

### C6-T3 — Refresh idempotency

Resume the completed run twice.

Expected: no duplicate refresh schedule or export.

---

# Component 7 — Correct JSON persistence and test-provider injection

## Role

Persistence and integration-boundary owner.

## Required changes

1. Add a minimal postgres.js 3.4.9 integration test for:
   - `INSERT ... VALUES` JSONB
   - `UPDATE` JSONB
   - JSONB concatenation
   - task output round-trip
2. Verify whether `sql.json(value)` or a parameterized
   `JSON.stringify(value)::jsonb` implementation produces an object.
3. Replace dynamic `sql.unsafe()` JSON literals with one tested parameterized
   helper.
4. Preserve apostrophes, Unicode, nested arrays, null, and large bounded model
   outputs.
5. Remove test-mode SEC branches from production fetch functions.
6. Introduce an injectable source provider/retriever interface. Tests should
   inject mock SEC and supplemental sources through that interface.
7. Production source retrieval must never change merely because
   `RESEARCH_TEST_MODE` is set globally.

## Test cases

### C7-T1 — JSON object round trip

Persist and reload:

```json
{
  "founder": "O'Brien",
  "motivation": ["mission", "commercial"],
  "unicode": "金融",
  "nested": {"confidence": 0.8},
  "nullable": null
}
```

Expected: deep equality and PostgreSQL `jsonb_typeof(...) = 'object'`.

### C7-T2 — Injection safety

Persist strings containing quotes and SQL-looking text.

Expected: the content round-trips and no unintended statement executes.

### C7-T3 — Mock source injection

Run source discovery and ingestion with the injected mock provider.

Expected: zero network calls and complete required mock source-role coverage.

### C7-T4 — Production boundary

Run the production provider in a test with `fetch` stubbed.

Expected: it uses the provider interface; no hidden acceptance-mode branch
returns hard-coded SOFI data.

---

# Component 8 — Repair the deterministic SOFI fixture

## Role

Acceptance fixture owner.

## Required changes

The fixture must be internally coherent enough to pass the same contracts as a
real provider response.

Fix at least:

- remove remaining MELI/MercadoLibre labels from SOFI responses;
- use evidence claim IDs actually inserted for that run;
- remove duplicate object keys such as `seller_segment`;
- make segment totals reconcile to consolidated totals;
- make scenario probabilities sum to one;
- make valuation values reconcile to operating scenarios;
- include bear/base/bull price targets for every forecast year through the
  terminal year;
- keep all fixture publication/as-of dates at or before a fixed historical
  cutoff;
- ensure synthetic data can never become `investment_ready`.

Do not weaken validators to accommodate an inconsistent fixture.

## Test cases

### C8-T1 — Fixture self-validation

Run every artifact validator directly against the SOFI fixture.

Expected: all intended accepted artifacts pass.

### C8-T2 — Reconciliation

Expected:

- segment revenue equals consolidated revenue;
- scenario probabilities equal 1.0 within the documented tolerance;
- final-year price targets equal their terminal valuation anchors;
- every evidence link points to a claim from the same run.

### C8-T3 — Synthetic readiness

Evaluate quality gates for the complete fixture.

Expected: it may become structurally/review ready, but never
`investment_ready`.

---

# Component 9 — Rebuild the SOFI end-to-end acceptance test

## Role

End-to-end test owner.

## Required changes

Repair `tests/sofi-v3-e2e.test.ts` and rename it after runtime consolidation.

Required corrections:

1. Stop accessing a nonexistent `SystemPipelineResult.failure_reason`, or add a
   properly typed result field if it is part of the intended public contract.
2. Query `ai_reviewer`, not `ai_review`.
3. Use a unique test-only asset slug and symbol suffix. Never delete the
   database’s existing `sofi` asset.
4. Use transaction rollback, a dedicated disposable database, or one reusable
   FK-safe fixture cleanup helper.
5. Delete tasks before stages.
6. Use a fixed cutoff and fixture observations that predate it. Do not set the
   cutoff one year into the future.
7. Test idempotency by rerunning the same logical task/run and querying actual
   duplicate counts.
8. Treat two distinct research runs as independent.
9. Exercise all three pipeline invocations:
   - reach research-plan gate;
   - approve and reach final human gate;
   - approve and complete export/refresh.
10. Assert exact required artifact types and accepted status.
11. Assert zero running non-human work at every pause and terminal state.

## Annual price-target acceptance table

Derive the expected year range from the valuation artifact. For every year from
the first forecast year through the terminal year, assert exactly one target
for each scenario:

| Fiscal year | Bear | Base | Bull |
|---|---:|---:|---:|
| First forecast year | required | required | required |
| Every intermediate year | required | required | required |
| Terminal year | required | required | required |

Also assert:

- no duplicate `(fiscal_year, scenario_type)` pairs;
- no missing intermediate years;
- finite positive price targets;
- correct currency;
- the final-year value reconciles to the scenario terminal anchor;
- values are derived from scenario assumptions, not simple interpolation;
- non-monotonic paths are permitted when supported by scenario economics.

## Test cases

### C9-T1 — Complete mock flow

```bash
RUN_DB_INTEGRATION=1 \
DATABASE_URL=postgresql://research_os:research_os_dev@localhost:5433/research_os \
RESEARCH_MODEL_PROVIDER=mock \
npx tsx --test --test-timeout=600000 tests/sofi-research-e2e.test.ts
```

Expected: all gates and terminal stages pass with no network or paid inference.

### C9-T2 — Existing SOFI safety

Seed a pre-existing SOFI asset before the test.

Expected: the test completes without updating or deleting that row.

### C9-T3 — Failure cleanup

Force one required mock artifact to fail validation.

Expected: deterministic failure, no export, and no running tasks/stages.

---

# Component 10 — Remove obsolete code and align documentation

## Role

Final consolidation owner.

## Required changes

Only after the current pipeline and acceptance tests pass:

1. Delete the old pipeline implementation and version dispatcher.
2. Delete old stage definitions and validators that have no current callers.
3. Delete obsolete provider adapters only if no current script or configured
   provider uses them.
4. Remove environment variables that select v1/v2/v3.
5. Remove obsolete scripts and tests tied exclusively to removed runtimes.
6. Update current scripts, `.env.example`, README/docs, and handover guidance to
   describe one pipeline.
7. Mark historical handover files as historical if retained. Do not treat them
   as current operating instructions.
8. Keep reusable domain validators, source ingestion, artifact contracts,
   migrations, and other code proven to be used by the current runtime.
9. Run a final dead-code and import check.

Avoid a cosmetic rename that leaves duplicate orchestration underneath. The
goal is one behavior, not merely one public function name.

## Test cases

### C10-T1 — No legacy runtime symbols

```bash
rg -n "runResearchPipelineV1|runResearchPipelineV2|runResearchPipelineV3|RESEARCH_PIPELINE_VERSION|asset_analysis" \
  src scripts tests package.json .env.example
```

Expected: no active legacy runtime reference.

### C10-T2 — No broken imports

```bash
npx tsc --noEmit
```

Expected: exit code 0.

### C10-T3 — Build

```bash
npm run build
```

Expected: exit code 0.

---

# Required execution sequence

Implement in this order:

1. Create the `reasonix` branch.
2. Build the evidence-based removal map.
3. Establish version-neutral current runtime names and entry point.
4. Implement stage-specific model-output contracts.
5. Make artifact persistence validation-first.
6. Replace legacy orchestration dependencies.
7. Implement export and refresh scheduling.
8. Correct JSON persistence and provider injection.
9. Repair the SOFI fixture.
10. Rebuild and pass the complete SOFI acceptance test.
11. Delete proven-dead legacy runtime code.
12. Update documentation and run final validation.

Do not begin broad deletion before the current source retrieval and stage
dependencies are mapped. Some code currently located in the monolithic legacy
file is still used by the new dispatcher and must first be moved or replaced.

# Final validation matrix

The work is complete only when all of the following are true:

| Validation | Required result |
|---|---|
| `git diff --check` | pass |
| `npx tsc --noEmit` | pass |
| `npm run test:unit` | pass |
| focused agent-contract tests | pass |
| focused artifact/repository tests | pass |
| focused orchestration tests | pass |
| JSONB database regression tests | pass |
| complete SOFI mock E2E | pass |
| `npm run build` | pass |
| legacy runtime search | no active v1/v2/v3 dispatcher |
| handler/stage registry comparison | exact set equality |
| running work after gates/completion | zero unintended rows |
| network calls during mock acceptance | zero |
| paid inference during mock acceptance | zero |

# Final handoff requirements

At completion, the implementing agent must report:

- the `reasonix` commit hash;
- files and legacy runtime components deleted;
- files renamed or promoted to the current runtime;
- the final current stage sequence;
- how stage-specific output contracts are selected;
- how artifact validation and acceptance work;
- how JSONB parameters are persisted safely;
- exact commands run and their results;
- the SOFI gate-by-gate outcome;
- any remaining compatibility limitation;
- confirmation that `reasonix` was pushed without merging it.

Do not claim completion if TypeScript, build, or the full SOFI mock acceptance
test is failing.
