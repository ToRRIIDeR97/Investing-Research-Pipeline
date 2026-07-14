# Research OS Handover - Local Harness Transition

**Date tag:** 2026-07-14
**Last updated:** 2026-07-14
**Scope:** Research v2 pipeline reliability work and transition from the OpenCode service runtime to an embedded local agent harness
**Status:** current

## Executive Summary

The `research-os-v2-test` branch now contains the Research v2 reliability changes developed while diagnosing MELI deep-dive runs. The branch improves chunk-level retrieval, annual SEC fact selection, metric conflict reconciliation, source-gap lifecycle management, required-module validation, valuation preflight, backtest review context, human-review integrity, workflow failure handling, OpenCode timeout diagnostics, and database connection lifetime management.

The architectural direction has now changed. The intended design is not to operate Research OS through the OpenCode SDK, local `opencode serve` process, and hosted `opencode-go` gateway. The next branch should adapt only the useful harness concepts from the open-source OpenCode CLI into a Research OS-owned local harness. Model inference may remain remote through direct provider APIs or may use a local inference adapter, but OpenCode must no longer be an operational gateway or session authority.

## Current State

- Source branch: `research-os-v2-test`.
- The current reliability changes are intended to be committed and pushed before branching.
- Target migration branch: `codex/local-agent-harness`.
- The migration implementation plan is maintained in the repository-root `implementation.md` on the target branch.
- Local OpenCode sidecar and SDK are currently aligned on version `1.17.13`, but this is an interim state.
- A local Next.js development server and OpenCode sidecar were running at the time of this handover; they are not required to remain running for the next agent.

Latest MELI run checked:

- Run ID: `76355c02-b88f-4b44-b65a-9af20896392d`
- Status: `needs_more_work`
- Cost: `$0.04538438`
- Completed through `metric_normalization`.
- `asset_analysis` failed because required v2 modules were not completed.
- `asset_valuation` and every later stage were correctly cancelled rather than executed.
- Failure reason: retries exhausted after GLM 5.2 timeouts and an unsuccessful Qwen 3.7 Plus fallback path.

## What Changed on `research-os-v2-test`

Important production changes include:

- `src/lib/research/system-pipeline.ts`
  - Retrieves relevant chunks from the latest completed parse rather than relying on document openings.
  - Persists source-linked evidence locators.
  - Filters annual SEC facts by duration/context.
  - Reconciles deterministic and model-normalized metrics.
  - Manages source-gap ownership and resolution.
  - Requires module-specific evidence provenance.
  - Adds deterministic valuation preflight and reviewer backtest packets.
  - Stops automation at real human review.
  - Awaits final pipeline-result queries before closing the PostgreSQL client.
- `src/lib/research/pipeline-helpers.ts`
  - Contains testable helpers for retrieval, fact selection, metric reconciliation, source gaps, canonical metric plans, and module completion.
- `src/lib/workflow/orchestrator.ts`, `stages.ts`, `validators.ts`, and `quality-gates.ts`
  - Fail critical deep-dive analysis closed.
  - Prevent valuation after failed analysis.
  - Transactionally close downstream stages when a run fails.
  - Separate AI review from persisted human approval.
- `src/lib/opencode/runtime.ts`
  - Adds interim version checks, agent-specific timeouts, awaited session aborts, attempt metadata, aggregate latency, and fallback compaction.
  - This file is the primary replacement target for the local-harness migration; do not extend its OpenCode-specific design further unless needed temporarily for compatibility.
- `scripts/check-opencode.js`
  - Interim sidecar/SDK compatibility preflight. It should be removed when the OpenCode runtime dependency is removed.
- `tests/pipeline-helpers.test.ts` and `tests/research-v2-contracts.test.ts`
  - Cover retrieval, annual fact selection, conflicts, source gaps, module provenance, human review, valuation anchors, MELI profile aliases, and filing selection.

## Endpoint Investigation

Both models were tested through the local OpenCode sidecar after aligning the CLI and SDK to `1.17.13`.

- GLM 5.2 plain inference: HTTP 200, about 2 seconds, returned `ENDPOINT_OK`.
- Qwen 3.7 Plus plain inference: HTTP 200, about 2 seconds, returned `ENDPOINT_OK`.
- GLM native structured output: HTTP 200 followed by `StructuredOutputError`; model returned JSON-like text but `info.structured` was null.
- Qwen native structured output: same failure mode.
- Fetching either structured session's history returned HTTP 400 due `retryCount` being persisted inside `info.format`.

This proves model connectivity is currently healthy and the remaining defect is OpenCode's structured-output/session-history layer. Matching the CLI and SDK versions did not eliminate it. This finding is one reason to move validation, retries, streaming, traces, and persistence into the Research OS-owned harness.

## Verification

Commands executed immediately before the branch handover:

```bash
npm run test:unit
npx tsc --noEmit
npm run build
git diff --check
```

Results:

- Node unit tests: 16 passed, 0 failed.
- TypeScript: passed after removing an unused invalid import from `scripts/check-timeout.ts`.
- Next.js production build: passed; 9 static pages generated.
- OpenCode prebuild compatibility check: passed at version `1.17.13`.
- Diff whitespace check: passed.

## Important Outputs

- Migration plan: `implementation.md` on `codex/local-agent-harness`.
- Previous detailed reliability handover: `handover files/2026-07-14-meli-deep-dive-reliability-handover.md`.
- Database backup created earlier in the reliability work: `/tmp/research_os_post_v2_20260714_103829.dump`.
- Diagnostic MELI runs are retained in PostgreSQL for comparison; do not reuse them as final acceptance runs.

## Known Issues

1. OpenCode native structured output remains unreliable even with CLI and SDK both on `1.17.13`.
2. OpenCode structured session history can be unreadable because of invalid persisted `info.format` metadata.
3. Long monolithic asset-analysis responses can exceed fixed deadlines and be aborted mid-JSON.
4. The Research OS runtime still depends on `@opencode-ai/sdk`, `opencode serve`, and the `opencode-go` hosted gateway until the migration plan is implemented.
5. The previously exposed OpenCode API key must be rotated. Never commit `.env.local` or reproduce the key in logs or documentation.
6. The last MELI run did not produce acceptable research modules, so the research-quality objective is not yet complete.
7. `scripts/monitor.ts`, `scripts/check-progress.ts`, and `scripts/check-timeout.ts` are diagnostic utilities. Reassess whether they should survive the harness migration.

## Next Steps

1. Work only on `codex/local-agent-harness` after confirming the current reliability branch was pushed.
2. Follow `implementation.md` as the acceptance contract.
3. Verify the license of the exact open-source OpenCode CLI source version before copying code. Preserve all required notices and keep provenance for adapted files.
4. Introduce Research OS-owned provider, streaming, execution-policy, validation, trace, and cancellation interfaces.
5. Implement a direct provider adapter and a deterministic mock adapter before removing the compatibility adapter.
6. Move JSON extraction/schema validation, repair, fallback, timeouts, usage accounting, and trace persistence into the local harness.
7. Remove the SDK, sidecar preflight, `opencode-go` key flow, and OpenCode session dependency only after parity tests pass.
8. Run a fresh MELI `deep_dive` acceptance run; do not fabricate human review.

## Practical Caveats

- Preserve the existing uncommitted/committed reliability work; the local harness migration should replace only the execution boundary, not regress evidence, metric, valuation, workflow, or review controls.
- Do not copy tightly coupled CLI UI, terminal, workspace, patching, or general coding-agent machinery into Research OS.
- Do not make provider-specific response objects part of workflow/domain contracts.
- Do not claim inference is local unless a provider adapter actually targets a local server such as Ollama, llama.cpp, MLX, or vLLM. Direct vendor APIs are still remote inference, merely without OpenCode as a gateway.
- Keep secrets out of provider configuration records, model-call logs, test snapshots, and handover documents.

## Files To Start With

- `implementation.md`
- `src/lib/opencode/runtime.ts`
- `src/lib/opencode/agent-registry.ts`
- `src/lib/agents/model-calls.ts`
- `src/lib/research/system-pipeline.ts`
- `src/lib/workflow/orchestrator.ts`
- `src/db/schema/agents.ts`
- `tests/pipeline-helpers.test.ts`
- `handover files/2026-07-14-meli-deep-dive-reliability-handover.md`

