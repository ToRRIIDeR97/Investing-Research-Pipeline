# Research OS handover - Runtime limits, evidence budgeting, and valuation checkpoints

**Date tag:** 2026-08-25
**Last updated:** 2026-08-25
**Scope:** Research OS V4 agent runtime, evidence extraction, valuation, and stage scheduling
**Status:** current proposed implementation, not yet implemented

## Executive summary

The latest paid SOFI work exposed three related design problems:

1. Agent deadlines are long enough for broken streams to occupy the provider route for tens of minutes.
2. Scoped retrieval fixed missing KPI recall, but it turned 23 source-reader batches into 49 evidence tasks and 88 model calls after revisions.
3. Valuation asks one model response to produce formulas, provenance, scenarios, tables, reverse valuation, annual targets, and expected returns. Fifteen valuation calls consumed about 123 model-minutes without one accepted result.

The solution is not to return to a small global chunk cap. Keep scoped retrieval and the memory-backed index, but put a coverage planner and hard effort budget between retrieval and model execution. Split valuation into linked persisted checkpoints, execute arithmetic locally, and retry only the failed checkpoint. Allow the deterministic backtest branch to run independently of valuation.

All model-backed routes must use the single vision-capable model configured in `.env.local` for both text and image input. Do not add a text-only model, Qwen fallback, or hardcoded provider model.

This document specifies the implementation. No code described below should be considered complete until the verification and acceptance checks pass.

## Current state

- Repository: `/Users/japardinathaniel/Documents/GitHub/Investing Research Pipeline`
- Pipeline version: V4
- Previous handover: `handover files/2026-08-24-research-os-ui-and-sofi-acceptance-handover.md`
- The worktree is already heavily modified and contains unrelated untracked files. Preserve it. Do not reset, delete, or reformat unrelated changes.
- The runner currently gives `source-reader` a 2,700,000 ms total deadline and 600,000 ms inactivity deadline in `src/lib/agent-harness/runner.ts`.
- The shared default allows four model attempts unless environment configuration overrides it.
- `evidence-extraction.ts` creates all retrieval batches, runs up to four workers, adds gap tasks when the evidence count is low, and aborts the worker pool when one worker rejects.
- The latest observed evidence workload contained 23 original batches, 26 revision tasks, 49 evidence tasks, and 88 underlying model calls.
- `asset-valuation.ts` expects one response containing `valuation_scenario_set`, `valuation_method_run`, `reverse_valuation`, and `annual_price_target_path`.
- `decision-synthesis.ts` already derives the expected-return matrix and four-quarter trends deterministically. Preserve that direction and move remaining valuation arithmetic out of model output.
- The pipeline runner currently activates only one stage at a time according to `stage_order`.
- `indicator_design`, `strategy_design`, backtest execution, and backtest review are deterministic, but the current stage ledger places them after valuation.

## Target runtime behavior

### Deadline policy

Use separate inactivity, per-attempt, and checkpoint deadlines. Queue wait must be measured separately from model execution.

| Work type | Inactivity | Per attempt | Attempts | Checkpoint ceiling |
|---|---:|---:|---:|---:|
| Source-reader batch | 120 seconds | 6 minutes | 2 | 12 minutes |
| Valuation method specification | 120 seconds | 8 minutes | 2 | 16 minutes |
| Other structured analyst work | 90 seconds | 6 minutes | 2 | 12 minutes |
| AI repair | 60 seconds | 3 minutes | 1 | 3 minutes |
| Deterministic calculation | 30 seconds | 30 seconds | 1 | 30 seconds |

The checkpoint ceiling includes original calls, retries, repairs, and validation. A provider request waiting behind the endpoint lock must not consume its per-attempt execution deadline.

Keep the environment overrides, but replace the current long defaults. The initial implementation should use fixed values. Add percentile-based adaptive deadlines only after enough reliable production latency data exists.

### Circuit breaker

Add one run-scoped circuit breaker per provider endpoint and configured model:

- Count consecutive transport timeouts, inactivity timeouts, empty responses, and malformed streams.
- Open the circuit after two consecutive qualifying failures.
- Stop scheduling new model calls on that endpoint for the run.
- Preserve successful tasks and artifacts.
- Mark blocked tasks with a distinct `provider_unavailable` or equivalent machine-readable reason.
- Do not route to another model unless that model is explicitly configured. The intended configuration has one vision-capable model for every route, so a model fallback should not exist.
- If automatic probing is implemented, allow no more than one probe after ten minutes. A simpler first version may stop the stage and require resume.

Do not count deterministic schema rejection as provider failure. That is a contract or prompt problem, not endpoint health.

## Evidence extraction redesign

### Keep scoped retrieval

Do not restore the old global selection of at most 32 chunks. It can omit decision-critical data such as members, total products, and segment contribution margins.

The memory-backed retrieval layer should return candidates for named coverage slots. It must not create one model task per search result or retrieval scope.

### Coverage slots

Build the required coverage list from the composed research profile. The SoFi profile must include at least:

- members by reporting period
- total products by reporting period
- cross-buy or products-per-member measures
- Lending contribution profit, loss, and margin
- Technology Platform contribution profit, loss, and margin
- Financial Services contribution profit, loss, and margin
- consolidated revenue, adjusted EBITDA, net income, deposits, loans, and capital
- funding cost and credit performance
- management guidance and assumptions
- founder and company history

Each slot needs:

```ts
type EvidenceCoverageSlot = {
  key: string;
  priority: "mandatory" | "important" | "optional";
  retrievalQueries: string[];
  preferredSourceRoles: string[];
  preferredSourceTypes: string[];
  minimumAcceptedClaims: number;
  periodCoverage?: { minimumPeriods: number; periodicity?: "quarterly" | "annual" };
};
```

Use the existing archetype and profile configuration as the source of slot requirements. Do not introduce a second unrelated profile system.

### Effort budget

Apply these initial limits per full research run:

| Limit | Value |
|---|---:|
| Primary batches | 8 |
| Targeted gap batches | 2 |
| Logical batch maximum | 10 |
| Attempts per batch | 2 |
| Underlying model-call maximum | 20 |
| Preferred successful calls | 8 to 12 |
| Total selected text | 60,000 to 80,000 characters |
| Revisions per logical batch | 1 |
| Concurrent model calls | 3 |

The batch planner should rank candidates by marginal coverage gained per estimated input byte. Mandatory uncovered slots rank first. Duplicate chunks and overlapping source excerpts should not consume the budget twice.

Stop evidence generation when all of these are true:

```text
mandatory coverage slots satisfied
AND run-type minimum accepted claim count reached
AND required source roles satisfied
```

If the effort budget ends first, persist successful evidence and a structured gap report. A missing mandatory slot should fail or pause according to the existing profile gate. An optional gap should not discard valid evidence.

### Deterministic extraction before AI

Extract these without a model when the source structure permits it:

- XBRL facts
- HTML table rows
- earnings-release KPI tables
- member and product rows
- segment contribution-profit tables
- previously accepted metric observations from memory

The model should handle ambiguous labels, narrative disclosures, table interpretation, and qualitative claims. It should not retype clean numeric tables merely to satisfy the evidence contract.

### Failure isolation

Replace the current pool-wide abort behavior:

- Persist each successful batch immediately.
- Record coverage supplied by each batch.
- If one batch fails, allow unrelated workers to finish.
- Retry the failed batch only when it owns an unsatisfied mandatory slot.
- Never rerun a successful logical batch during a stage retry.
- Merge persisted task outputs by stable batch fingerprint.

A stage-level retry must resume from missing coverage, not recreate the original fan-out.

### Suggested files

- `src/lib/research/handlers/evidence-extraction.ts`
- `src/lib/research/source-reader-batching.ts`
- `src/lib/research/system-pipeline.ts`
- `src/lib/research/run-context.ts`
- `src/lib/research/archetypes/`
- `src/lib/agent-harness/runner.ts`
- `tests/source-reader-batching.test.ts`
- `tests/agent-harness.test.ts`
- Add one focused coverage-planner test file only if the planner does not fit an existing test module.

## Valuation checkpoint redesign

### Required checkpoint graph

```text
accepted operating scenarios and metrics
  -> locked valuation input manifest
  -> one AI method specification per required method
  -> deterministic formula execution per method
  -> deterministic method and scenario reconciliation
  -> reverse valuation
  -> deterministic annual target path
  -> deterministic expected-return matrix
  -> AI valuation explanation
```

### Checkpoint 1: valuation input manifest

Build this deterministically from accepted artifacts and metric observations. It should include:

- current market price and retrieval time
- scenario probabilities and scenario-set ID
- share count and dilution basis
- cash, debt, book value, tangible book value when applicable
- accepted historical and forecast metrics used by each valuation lens
- units, currency, period, source metric ID, and evidence claim ID
- required valuation methods from the research profile
- a canonical SHA-256 input manifest hash

Reject duplicate metric keys with incompatible units. Do not let the model select between silent duplicates.

### Checkpoint 2: method specification

Ask the configured model for one method at a time. Each response should contain only:

- method key and version
- method rationale
- declared inputs referencing exact manifest metric keys
- assumptions not present in accepted metrics
- ordered formula graph
- required output references
- bear, base, and bull overrides
- optional reproducible table specification using value references

Do not ask this response for price paths, expected returns, reverse valuation, or narrative report prose.

Required valuation methods can run independently after the input manifest is locked. For a bank or financial-services profile, the primary method may be residual income or tangible-book-based valuation, with a second method as a cross-check. The configured profile decides the methods.

### Checkpoint 3: deterministic method execution

Reuse `src/lib/valuation/method-protocol.ts`. Extend it only where the existing operation set cannot represent a required formula. The application must:

- resolve formula references in order
- enforce dimensional and unit compatibility
- reject undefined references
- calculate bear, base, and bull outputs
- produce numeric table cells from references
- persist calculation traces and validation errors

The model must never supply formatted numeric table values.

### Checkpoint 4: reconciliation gate

The integration gate should verify:

- all required methods completed
- probabilities sum to one
- the primary method's executed values equal the valuation scenario anchors
- per-share outputs use compatible units
- table columns and referenced values exist
- the input manifest hash and scenario-set version match across methods

Retry only the method specification that failed. Do not regenerate accepted methods.

### Checkpoint 5: reverse valuation

Compute the reverse-valuation arithmetic locally from current price and the accepted method graph. The model may explain the implied assumptions and plausibility, but it must not replace the calculated values.

For financial institutions, preserve the existing return-on-equity versus cost-of-equity spread validation.

### Checkpoint 6: annual price-target path

Derive each annual bear, base, and bull target locally from accepted scenario anchors and an explicit interpolation or compounding rule. Persist that rule with the artifact.

Do not ask the model to independently reproduce every annual target.

### Checkpoint 7: expected-return matrix

Use the existing deterministic derivation in `src/lib/research/decision/validation.ts` as the canonical implementation. The matrix must use:

- the same current market price as the input manifest
- accepted scenario probabilities
- accepted annual price targets
- explicit dividend assumptions, if any

Decision synthesis should receive the completed matrix as immutable input. It may explain the result but must not recalculate it.

### Checkpoint 8: valuation explanation

After all calculations pass, ask the configured model to explain:

- method selection
- important inputs and provenance
- bear, base, and bull differences
- cross-check results
- reverse-valuation implications
- known limitations

This output is report prose. It must reference persisted calculation artifacts and cannot introduce new numeric assumptions.

### Linking and stale-artifact rules

Every valuation checkpoint must persist:

```text
run_id
input_manifest_hash
operating_scenario_set_id
operating_scenario_set_version
valuation_method_key
valuation_method_protocol_version
upstream_artifact_ids
```

When an upstream version or hash changes, mark dependent artifacts stale. Do not silently combine artifacts from different scenario or manifest versions.

Use the existing `research_artifact_dependencies` repository support instead of building a second dependency store.

### Suggested files

- Split responsibilities currently concentrated in `src/lib/research/handlers/asset-valuation.ts`.
- Keep a thin `asset-valuation.ts` stage coordinator if that avoids changing the stage registry.
- Reuse `src/lib/valuation/method-protocol.ts`.
- Reuse and narrow `src/lib/research/valuation/contracts.ts`.
- Reuse `src/lib/research/valuation/validation.ts`.
- Reuse `src/lib/research/decision/validation.ts` for expected returns.
- Reuse `src/lib/research/artifacts/repository.ts` for dependencies.
- Update `tests/valuation-method-protocol.test.ts` and `tests/valuation-artifacts.test.ts`.
- Update decision tests only where the persisted valuation artifact shape changes.

Avoid creating one framework class per checkpoint. Plain functions plus persisted artifacts are sufficient.

## Independent stage execution

### Target dependency graph

After evidence extraction, the following work can proceed independently:

```text
evidence extraction
  |-> historical record -> historical diagnosis -----------|
  |-> company genesis --------------------------------------|-> operating model
  |-> business process analysis -> moat analysis -----------|

historical record -> indicator design -> strategy design -> backtest execution -> backtest review

operating model -> operating scenarios -> valuation checkpoints

valuation checkpoints + moat analysis + optional backtest review -> decision synthesis
```

### Dependency corrections

- `historical_record`, `company_genesis`, and `business_process_analysis` can start after accepted evidence exists.
- `historical_diagnosis` waits for the historical record.
- `moat_analysis` waits for business-process artifacts and should consume historical diagnosis when available.
- `operating_model` waits for historical diagnosis and moat analysis.
- `operating_scenarios` waits for the operating model.
- Valuation waits for accepted operating scenarios.
- `indicator_design` does not read valuation artifacts. Remove its `valuation_signals_exist` entry criterion.
- The deterministic indicator, strategy, and backtest chain can run alongside moat, forecasting, and valuation.
- `decision_synthesis` waits for accepted valuation and for backtest review only when the profile requires backtesting.
- `ai_reviewer`, human review, and export remain final serial gates.

### Scheduler scope

Do not build a general distributed workflow engine. Extend the current runner only enough to activate dependency-ready stages and support these two branches:

1. Fundamental research, operating model, and valuation.
2. Deterministic indicator, strategy, and backtest work.

Use a global semaphore of three for model-backed work. Use a separate local limit for deterministic tasks. Provider endpoint serialization may reduce actual model parallelism, so record queue and execution timing separately.

The database stage ledger remains authoritative. Resume must inspect completed artifacts and dependency readiness rather than relying only on stage order.

### Suggested files

- `src/lib/workflow/stages.ts`
- `src/lib/workflow/orchestrator.ts`
- `src/lib/research/pipeline-runner.ts`
- `src/lib/research/run-service.ts`
- `tests/workflow-orchestration.test.ts`
- `tests/persistence-integration.test.ts`

## Model routing requirement

All text and image requests must resolve from `.env.local` to the same vision-capable model.

Required behavior:

- No hardcoded model identifier in research runtime selection.
- No Qwen fallback.
- No separate text-model default.
- Missing model configuration fails closed before a paid request.
- Task records and provider-call logs persist the resolved model.
- Retries and revisions use the same configured vision model unless the environment changes before a separately initiated resume.

Do not change provider compatibility metadata merely because a provider is inactive. The requirement applies to runtime routing, not static pricing or compatibility catalogs.

## Implementation order

### Phase 1: stop excessive waits

1. Add per-attempt deadline support to the shared runner.
2. Apply the new fixed timeout defaults.
3. Reduce paid model attempts to two.
4. Add the run-scoped provider circuit breaker.
5. Record queue wait, execution time, timeout type, and circuit state.

Acceptance condition: two broken calls stop further fan-out within roughly twelve minutes, and a successful task remains reusable after resume.

### Phase 2: bound evidence work

1. Add profile-derived coverage slots.
2. Add marginal-coverage batch selection and the hard effort budget.
3. Isolate failed batches instead of aborting successful workers.
4. Persist coverage and structured gaps.
5. Add deterministic extraction for the highest-value KPI and segment tables.

Acceptance condition: the SOFI snapshot finds members, total products, and segment contribution metrics while staying at or below ten logical batches and twenty underlying calls.

### Phase 3: split valuation

1. Persist the valuation input manifest.
2. Generate one method specification per required lens.
3. Execute and validate formulas locally.
4. Add the reconciliation gate.
5. Calculate reverse valuation, annual targets, and expected returns from persisted values.
6. Generate narrative explanation last.

Acceptance condition: a formatting or table-reference failure retries only one checkpoint, and all report tables reproduce from persisted inputs without another model call.

### Phase 4: run independent branches

1. Remove the false valuation dependency from indicator design.
2. Add dependency-ready stage selection.
3. Run the deterministic backtest branch alongside the fundamental branch.
4. Keep decision, AI review, human review, and export as integration gates.

Acceptance condition: valuation delays do not prevent deterministic indicator generation or backtest completion.

### Phase 5: paid SOFI acceptance

Run unit and integration checks before another paid run. Then run one paid SOFI acceptance using the configured vision model. Do not reuse the previous 45-minute or 30-minute manual timeout overrides.

Record:

- wall-clock duration
- queue wait versus provider execution time
- model calls by stage and checkpoint
- retries, revisions, and repairs
- evidence coverage slots and gaps
- total selected evidence bytes
- valuation checkpoint durations
- total cost
- resolved model for every provider call

## Verification

No verification has been run for this proposed implementation because the implementation does not yet exist.

Minimum checks after each phase:

```bash
npx tsc --noEmit
node --import tsx --test tests/agent-harness.test.ts
node --import tsx --test tests/source-reader-batching.test.ts
node --import tsx --test tests/valuation-method-protocol.test.ts tests/valuation-artifacts.test.ts
node --import tsx --test tests/workflow-orchestration.test.ts
git diff --check
```

Run the broader unit suite once after the phases integrate. Do not repeatedly run the entire suite after each small edit.

### Required regression cases

- A stream that emits nothing for 120 seconds times out.
- Queue wait does not consume the per-attempt timeout.
- Two consecutive provider failures open the circuit.
- The circuit never changes the configured model.
- One failed evidence batch does not cancel or erase successful batches.
- Mandatory KPI coverage outranks optional narrative chunks.
- Evidence work cannot exceed the configured effort budget.
- A successful logical batch is reused after stage resume.
- Two valuation methods can complete independently.
- An invalid method retries only that method checkpoint.
- Undefined formula references fail before persistence as accepted output.
- Expected-return values reproduce from current price, scenario probabilities, and price targets.
- Indicator and backtest stages can complete while valuation remains running.
- Decision synthesis waits for the required upstream branches.

## Important outputs

The completed implementation should make these diagnostics visible in the run console or persisted run metadata:

- evidence coverage table with slot, priority, status, source, and accepted claim count
- effort budget used and remaining
- provider circuit state
- task queue wait and execution duration
- valuation checkpoint status and dependency versions
- exact source of every expected-return cell

These diagnostics should read persisted state. Do not calculate a second view of pipeline truth only for the UI.

## Known risks

1. Shorter timeouts can reject a genuinely slow but valid response. Small checkpoint prompts and immediate persistence reduce this risk.
2. A batch cap can reintroduce missing evidence if coverage is defined poorly. Mandatory profile-derived slots are the protection.
3. Parallel stage execution can expose hidden order dependencies. Start with the two documented branches and add dependency tests before widening it.
4. Valuation artifact changes may affect the report read model and old run compatibility. Preserve read support for existing V4 artifacts or add an explicit schema-version branch.
5. Deterministic extraction from tables needs exact provenance offsets. Do not weaken citation and source-bound validation to make it easier.
6. The worktree contains many existing edits. Changes must be reviewed file by file and must not revert unrelated UI or runtime work.

## Practical caveats

- Do not solve fan-out by shrinking retrieval to one generic context window.
- Do not make timeout errors eligible for unlimited stage revisions.
- Do not let the model generate arithmetic that the application can calculate.
- Do not weaken valuation contracts merely to accept inconsistent outputs.
- Do not add a new workflow framework or dependency unless the existing stage ledger cannot support the two required branches.
- Do not launch another paid acceptance run until model routing, deadlines, and effort budgets are verified locally.
- Do not auto-approve the human-review gate.

## Files to start with

- `src/lib/agent-harness/runner.ts`
- `src/lib/agent-harness/session-store.ts`
- `src/lib/research/handlers/evidence-extraction.ts`
- `src/lib/research/source-reader-batching.ts`
- `src/lib/research/handlers/asset-valuation.ts`
- `src/lib/valuation/method-protocol.ts`
- `src/lib/research/valuation/contracts.ts`
- `src/lib/research/valuation/validation.ts`
- `src/lib/research/decision/validation.ts`
- `src/lib/research/artifacts/repository.ts`
- `src/lib/workflow/stages.ts`
- `src/lib/workflow/orchestrator.ts`
- `src/lib/research/pipeline-runner.ts`
- `tests/agent-harness.test.ts`
- `tests/source-reader-batching.test.ts`
- `tests/valuation-method-protocol.test.ts`
- `tests/valuation-artifacts.test.ts`
- `tests/workflow-orchestration.test.ts`
- `handover files/2026-08-24-research-os-ui-and-sofi-acceptance-handover.md`
