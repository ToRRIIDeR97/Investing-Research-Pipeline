# MELI Deep-Scan Reliability Implementation Plan

## Objective

Make Research OS complete a MercadoLibre (`MELI`) `deep_dive` run reliably while failing closed when a required stage cannot complete. The implementation must address the observed OpenCode timeouts, align the OpenCode SDK and sidecar protocol, prevent valuation from running after failed asset analysis, preserve useful diagnostics, and verify the result with a fresh MELI deep scan.

Do not discard or overwrite the existing uncommitted branch changes. Inspect the current diff before editing and build on it.

## Observed failure and evidence

The diagnostic run was `dbd07086-7119-4310-8f7e-c1469b949a5a`.

- Source reading and metric normalization completed successfully.
- The asset-analysis primary model (`glm-5.2`) and fallback (`qwen3.7-plus`) were each aborted by the application's fixed 240,000 ms deadline.
- These were not idle requests. OpenCode persisted reasoning and partial response text for both sessions. GLM produced about 5,157 response characters and Qwen produced about 26,046 response characters before each response was cut off mid-JSON.
- `OPENCODE_ASSET_ANALYST_REASONING=max`, the comprehensive multi-module prompt, repeated evidence identifiers, and the four-minute deadline combine to make completion unlikely.
- The application uses `@opencode-ai/sdk` 1.17.13, while the running `opencode serve` executable reported 1.17.8. Persisted structured-output sessions can fail to load with `Expected OutputFormatJsonSchema` because `retryCount` appears inside `info.format`.
- After asset-analysis validation failed, the workflow marked the stage failed but started asset valuation anyway. This happened because `asset_analysis` is configured as `skip_and_continue`, and `system-pipeline.ts` proceeds to `ensureStageReady(..., "asset_valuation")` without requiring successful upstream analysis.
- The diagnostic run also accepted an inconsistent FY2025 revenue value of $20.335B alongside quarterly values that should have caused an annual/quarterly reconciliation warning or rejection.
- The OpenCode API key used during diagnosis was exposed in command output. Rotate it before further live testing and update the local environment without committing the credential.

## Required implementation

### 1. Align the OpenCode SDK and sidecar

Use exactly the same OpenCode version for the application SDK and the sidecar executable. The repository currently declares `@opencode-ai/sdk` 1.17.13 while the observed sidecar was 1.17.8.

Preferred approach:

1. Pin `@opencode-ai/sdk` to an exact version rather than a caret range.
2. Upgrade the OpenCode executable to that same version and restart `opencode serve`.
3. Add a startup/preflight compatibility check that queries the sidecar version, compares it with the SDK version, and fails immediately with a clear error if they are incompatible. If the sidecar does not expose a stable version endpoint, provide a checked startup script that validates `opencode --version` before launching the app/worker.
4. Document the required matched version and the sidecar startup command in `.env.example` or an appropriate repository document.
5. Do not attempt to repair historical OpenCode session rows. Verify that newly created sessions can be read through `/session/{id}/message` without the `OutputFormatJsonSchema` HTTP 400.

Acceptance criteria:

- The SDK and `opencode --version` report the same pinned version.
- A new structured-output smoke session completes.
- Its messages can subsequently be fetched through the sidecar API.
- A version mismatch produces a fast, actionable preflight failure rather than a model timeout.

### 2. Fix timeout semantics and diagnostics

Update `src/lib/opencode/runtime.ts`.

1. Support agent-specific timeouts and configure a longer asset-analysis deadline. Use `OPENCODE_ASSET_ANALYST_TIMEOUT_MS`; start with 600,000 ms unless testing demonstrates a smaller reliable value.
2. Document the agent-specific timeout variables in `.env.example`.
3. Reduce asset-analysis reasoning from `max` to a balanced setting supported by the matched OpenCode version. Do not silently depend on an unsupported reasoning name.
4. Treat the timeout as an end-to-end deadline for one model attempt and record the actual elapsed duration across all candidates. The current exhausted-attempt error incorrectly reports only one configured timeout as total latency.
5. Include the session ID, model, provider, elapsed milliseconds, and attempt number in every timeout failure and model-call log.
6. Ensure `OpenCodeTimeoutError` receives and retains the session ID. The current generic deadline wrapper constructs it without the session ID.
7. Continue aborting the sidecar session on timeout, but await or otherwise confirm the abort sufficiently to prevent zombie sessions.
8. Do not accept truncated JSON. A partial streamed response may be retained for diagnostics, but only a complete response passing the structured-output schema may become task output.
9. If the primary attempt times out, the fallback should receive a deliberately reduced recovery prompt or reduced context, not an identical expensive request. Record that fallback compaction occurred.
10. Distinguish provider timeout, structured-output validation failure, sidecar protocol failure, and operator cancellation in task/model-call status and error metadata.

Strongly recommended prompt change:

- Split asset analysis into bounded module groups or individual module calls rather than requesting every contract-required module in one monolithic response.
- Keep shared evidence and metrics in a compact common packet.
- Ask each call only for the sections it owns and merge the validated module outputs deterministically.
- Avoid repeating long evidence-ID arrays and full metric objects in every section.
- Preserve the existing requirement that module evidence IDs resolve to persisted claims.

Acceptance criteria:

- Unit tests can use a short injected timeout without waiting minutes.
- A timed-out request is aborted, recorded once, and leaves no `running` task or stage.
- Failure metadata identifies the exact session and attempt.
- A slow but valid response that finishes within the asset-specific deadline succeeds.
- A truncated response is never persisted as completed output.

### 3. Make required deep-dive stages fail closed

Update `src/lib/workflow/stages.ts`, `src/lib/workflow/orchestrator.ts`, and `src/lib/research/system-pipeline.ts`.

1. `asset_analysis` must not use `skip_and_continue` for v2 `deep_dive` or `full_initiation_report` runs. Use `fail_run` or a resumable `pause_for_human`/`needs_more_work` state, consistent with the existing state machine.
2. `asset_valuation` must require completed asset analysis and completed required analysis modules for deep-dive equity profiles. Metrics alone are not sufficient entry criteria.
3. After `ensureStageReady`, check the returned status. Do not execute an agent unless its stage is actually `running` or is in the explicitly supported resumable state.
4. Immediately return a terminal pipeline result when a required upstream stage fails, pauses, or needs more work. Do not call later-stage agents.
5. Reserve `skip_and_continue` for stages that are genuinely optional for the current run type/profile. Encode this in configuration instead of relying on call-site assumptions.
6. When a required stage terminates, transactionally close any running task/stage and update the research run so it never remains falsely `running`.
7. Preserve resumability: retrying a corrected run must not duplicate completed claims, metrics, modules, or model-call accounting.

Acceptance criteria:

- Exhausting asset-analysis retries on a deep dive results in a terminal `needs_more_work` or failed run.
- `asset_valuation` remains `pending` and no valuation agent task/model call is created.
- Optional stages can still skip and continue for run types that explicitly allow it, such as `backtest_only`.
- No terminal run has any task or stage left in `running`.

### 4. Reconcile conflicting financial periods

Review deterministic SEC extraction and metric reconciliation in `src/lib/research/system-pipeline.ts` and the related helper/contract files.

1. Confirm annual facts use the correct SEC duration/context and are not confused with YTD or quarterly contexts.
2. Compare an accepted annual value with the accepted quarters that compose the same fiscal year when coverage is sufficient.
3. Apply a documented tolerance for rounding, currency translation, and taxonomy differences.
4. If an annual value is materially inconsistent, reject/demote it or create an explicit unresolved conflict/source gap. Do not leave both observations silently accepted as canonical.
5. Keep raw observations and provenance for auditability.

MELI-specific regression fixture:

- Reproduce the FY2025 revenue conflict seen in the diagnostic run: accepted annual revenue was $20.335B while the quarterly sequence was inconsistent with that figure.
- The test should prove that the incorrect annual context cannot silently become canonical.

## Required automated tests

Add focused tests rather than relying only on the live MELI run. Existing unit tests run with `npm run test:unit` and currently live under `tests/*.test.ts`.

### OpenCode runtime tests

Refactor only as much as needed to inject or mock the OpenCode client and clock/timer.

Test at least:

1. Agent-specific timeout overrides the global timeout.
2. Invalid or too-small timeout values fall back safely.
3. A response completing before the deadline returns validated structured output.
4. A hanging prompt is aborted at the deadline and returns a timeout containing its session ID.
5. Primary timeout invokes the configured fallback exactly once.
6. Both attempts timing out produce accurate aggregate latency and per-attempt metadata.
7. A truncated JSON response is rejected and is not marked completed.
8. A structured-output protocol/schema error is classified separately from timeout.
9. Sidecar/SDK version mismatch fails preflight before any session is created.
10. A matched version permits a structured-output request and later session-message retrieval.

### Workflow/orchestrator tests

Test at least:

1. Failed required `asset_analysis` in a v2 deep dive does not start `asset_valuation`.
2. Exhausted retries leave the run terminal and close running records.
3. Successful asset analysis starts valuation normally.
4. An optional stage configured for `skip_and_continue` still advances.
5. `backtest_only` retains its intended skip behavior.
6. Resuming a stopped run is idempotent and does not duplicate task outputs.

### Metric reconciliation tests

Test at least:

1. Matching annual and quarterly observations remain accepted.
2. Materially inconsistent annual and quarterly observations create a conflict and select the correct canonical observation.
3. Missing quarters do not create a false conflict.
4. Currency/unit mismatches are normalized before comparison or explicitly excluded.
5. The MELI FY2025 fixture rejects or flags the $20.335B annual observation.

### Full local verification commands

Run and report the exact results of:

```bash
npm run test:unit
npx tsc --noEmit
npm run build
git diff --check
```

If lint is functional in this Next.js version, also run `npm run lint`; otherwise report the exact tooling incompatibility rather than calling it a pass.

## Required OpenCode smoke tests

Before spending budget on another full run:

1. Rotate the exposed API key and load the replacement into `.env.local` without committing it.
2. Restart the matched-version sidecar.
3. Run a minimal structured-output request through the same SDK path used by Research OS.
4. Run a representative asset-analyst request with a bounded MELI fixture large enough to exercise structured output.
5. Fetch both sessions afterward through `/session/{id}/message`.
6. Confirm there is no `Expected OutputFormatJsonSchema` error, no orphaned busy session, and complete token/cost/latency metadata.

## Final acceptance run: fresh MELI deep scan

After all automated and smoke tests pass, run a fresh round of research for MELI using `run_type: "deep_dive"`. Do not reuse the stopped diagnostic run. Use a fresh run ID so the results are auditable.

Research question:

> Separate MercadoLibre's commerce and fintech economics; evaluate revenue and margin drivers, credit growth and loss quality, working-capital and funding needs, country/currency risk, competitive position, and valuation under base, bull, and bear scenarios.

Use explicit UTC `Z` timestamps for source and market-data cutoffs because offset timestamps previously exposed an API validation/500 defect. Set a sufficient budget for the complete deep scan and record the chosen limit.

Execution sequence:

1. Confirm the MELI asset/profile and create a new `deep_dive` research run through `POST /api/assets/{assetId}/research-runs`.
2. Start the pipeline through `POST /api/research-runs/{runId}/run-system-pipeline`.
3. Review and explicitly approve the research plan through `POST /api/research-runs/{runId}/approve-plan`; do not fabricate human approval for the final review.
4. Resume the pipeline and monitor both HTTP behavior and persisted database state.
5. Follow the run until it reaches the legitimate human-review checkpoint or a correctly reported terminal failure.

The MELI run passes only if all of the following are true:

- The run uses `pipeline_version = 2`.
- Source ingestion uses the latest completed parse and citations include meaningful non-zero chunk indices, demonstrating multi-chunk retrieval.
- Evidence claims have valid persisted source links; report claim count, linked-claim count, distinct cited chunks, and source gaps.
- Asset analysis completes without timeout and all MELI contract-required modules are completed with substantive evidence provenance.
- No required module is marked completed solely from generic fallback text.
- Asset valuation starts only after asset analysis passes.
- Valuation either produces valid, source-supported scenarios/signals or fails closed with an explicit unsupported-engine/source-gap reason.
- The FY2025 revenue inconsistency is resolved or explicitly flagged; it is not silently accepted.
- Backtest and reviewer outputs, if reached, contain their required artifacts and validation results.
- The pipeline stops at real human review; do not auto-approve it.
- No task or stage is left `running` after the request returns or terminates.
- Model-call logs contain model/provider, session ID, actual latency, tokens, cost, and precise status for every attempt.
- The run stays within its declared budget.

Report the final run ID, stage-by-stage statuses, model attempts and durations, total cost, evidence/citation counts, normalized metric conflicts, completed modules, valuation/scenario status, source gaps, and any remaining `needs_more_work` reasons.

## Handoff completion checklist

- [ ] Existing branch changes were preserved.
- [ ] OpenCode SDK and sidecar versions are pinned and matched.
- [ ] The exposed API key was rotated.
- [ ] Structured-output session history is readable for new sessions.
- [ ] Timeout behavior and diagnostics were corrected.
- [ ] Asset-analysis workload was reduced or split sufficiently to finish reliably.
- [ ] Required deep-dive stages fail closed.
- [ ] MELI annual/quarterly metric conflict is covered by a regression test.
- [ ] Unit tests, TypeScript, production build, and diff checks pass.
- [ ] OpenCode smoke tests pass.
- [ ] A fresh MELI deep scan was run and fully reported.
- [ ] No human-review decision was fabricated.

