# Research OS Handover - V4 Harness Timeout Remediation and SOFI Live Run

**Date tag:** 2026-08-10  
**Last updated:** 2026-08-10  
**Scope:** Research OS V4 agent harness, provider scheduling, source extraction, and live SOFI acceptance run  
**Status:** current

## Executive Summary

The V4 timeout/concurrency remediation is implemented and verified. Provider requests are serialized through the existing endpoint lock; queue wait no longer consumes a model-call deadline. Source-reader and valuation now have agent-specific deadlines, source packets are bounded, and same-model source retries compact the request.

The latest paid SOFI run proved the timeout fix: valuation completed in 248.5 seconds instead of failing at the former 240-second global deadline. The run did not reach human review because the strict operating-model validator rejected a model-generated driver tree twice. This is a model-output/content issue, not a provider timeout or concurrency failure. Do not weaken the validator to make the run pass.

## Current State

- Repository: `/Users/japardinathaniel/Documents/GitHub/Investing Research Pipeline`
- Pipeline version: V4
- Provider: `opencode-go-direct`
- Model used in the live run: `deepseek-v4-flash`
- Endpoint requests: serialized by `request-lock.ts`; harness concurrency remains `RESEARCH_AGENT_CONCURRENCY=3`
- Worktree is intentionally dirty with prior user changes, benchmark files, migrations, UI changes, and harness changes. Do not reset or discard unrelated edits.
- No commit was created for this handover or the remediation work.

## What Changed

### Deadline and provider scheduling

- `src/lib/agent-harness/deadlines.ts` adds `pauseTotal()` and `resumeTotal()` so time spent waiting for the provider lock is excluded from the request deadline.
- `src/lib/agent-harness/runner.ts` pauses total and inactivity timers while acquiring the provider lock and always releases the lock after the pass.
- Source-reader defaults are 20 minutes total and 10 minutes inactivity.
- Asset analysis, metric normalization, and valuation default to 10 minutes total; valuation also has a 5-minute inactivity limit in `.env.local` and `.env.example`.
- OpenAI-compatible requests omit `max_tokens` unless explicitly configured. `maxResponseBytes` remains the hard response bound because reasoning tokens can consume a provider `max_tokens` budget before final JSON is emitted.

### Source-reader reliability

- `src/lib/research/source-reader-batching.ts` defaults to four chunks and 16,000 bytes per batch.
- Evidence-extraction handler fallbacks use the same bounds.
- A same-model source-reader retry now compacts the packet instead of replaying the identical long prompt. The compacted retry is recorded in attempt metadata.

### Environment settings

Relevant values are in `.env.local` and mirrored in `.env.example`:

```text
RESEARCH_AGENT_CONCURRENCY=3
RESEARCH_DEFAULT_MODEL=deepseek-v4-flash
RESEARCH_SOURCE_READER_TIMEOUT_MS=1200000
RESEARCH_SOURCE_READER_INACTIVITY_TIMEOUT_MS=600000
RESEARCH_SOURCE_READER_BATCH_MAX_CHUNKS=4
RESEARCH_SOURCE_READER_BATCH_MAX_BYTES=16000
RESEARCH_VALUATION_ANALYST_TIMEOUT_MS=600000
RESEARCH_VALUATION_ANALYST_INACTIVITY_TIMEOUT_MS=300000
```

## Latest Paid SOFI Run

Run ID: `569bcce4-b32b-4b13-9f4c-73763de0f310`

Command used:

```bash
RUN_PAID_RESEARCH=1 \
RESEARCH_ACCEPTANCE_PROVIDER=opencode-go-direct \
RESEARCH_ACCEPTANCE_BUDGET_USD=10.00 \
RESEARCH_ASSET=SOFI \
RESEARCH_AGENT_CONCURRENCY=3 \
npx tsx scripts/new-equity-run.ts
```

Recorded result:

- Start: 2026-08-08 21:51:45 +08
- End: 2026-08-08 23:09:30 +08 (about 78 minutes wall time)
- Status: `needs_more_work`
- Actual cost: US$0.102941 of the US$10 cap
- 20 of 24 stages completed
- AI review completed
- Human review remained pending, correctly blocked by the failed operating-model stage
- 37 persisted artifacts were validated; no invalid artifact was exposed downstream

Stage failure:

```text
Failed after 2 retries: Driver tree: Driver 'financial_services_revenue_growth'
enters revenue CAGR without operational driver decomposition.
```

The stage-level validation result is stored in `research_stages.validation_result_json` for `stage_key = 'operating_model'`. The task-level forecast output itself is contract-valid, but the composed driver tree fails the semantic validator. Inspect that stage row before changing prompts or retry behavior.

Source and valuation evidence:

- Evidence extraction completed after 8 serialized source batches in 40.8 minutes.
- One malformed source stream was recovered by the compact same-model retry.
- Valuation succeeded in 248.5 seconds under the new valuation deadline.
- There were no valuation timeout failures in this run.

## Verification

All of the following passed after the latest edits:

- `npx tsc --noEmit`
- `npm run build`
- `npm run test:unit` — 212 tests, 209 passed, 3 skipped, 0 failed
- `git diff --check`
- Loopback provider deadline test with escalated local binding permission
- `RUN_PROVIDER_SMOKE=1 npx tsx scripts/provider-smoke.ts` — configured provider/model returned valid output

The sandbox-only run of the loopback test initially failed with `listen EPERM`; rerunning with local binding permission passed. The same sandbox restriction affected the first unprivileged `npm run test:unit` invocation; the escalated full suite passed.

## Known Issues

1. **Operating-model semantic rejection:** DeepSeek produced `financial_services_revenue_growth` as a direct revenue CAGR without an operational decomposition. The validator is intentionally correct and should remain fail-closed. The next fix should improve the operating-model prompt/retry context or task decomposition, then rerun a paid acceptance run.
2. **Runtime SLO is not met under strict serialization:** Source extraction alone took 40.8 minutes, and the full run took about 78 minutes. This is the expected throughput cost of the no-concurrent-provider-call requirement, not a deadline bug. Do not re-enable concurrent calls without an explicit provider-rate-limit decision.
3. **Human review was not auto-approved:** The final decision gate remains intentionally human-controlled.

## Next Steps

1. Inspect `src/lib/research/handlers/operating-model.ts`, its prompt construction, and the operating-model semantic validator. Add the smallest prompt/context change that explicitly requires an operational decomposition for lender/financial-services revenue growth.
2. Add a focused regression fixture proving that a `financial_services_revenue_growth` node with operational drivers passes while a direct CAGR node remains rejected.
3. Run the operating-model unit tests and a mocked SOFI E2E before spending another live-run budget.
4. Repeat the capped paid SOFI run only after the model-output fix; acceptance still requires all automated stages to reach `waiting_for_human`, canonical AI `pass`, evidence/accounting gates, and no invalid artifacts.

## Practical Caveats

- Preserve V3 historical data as read-only; new runs are V4.
- Keep provider/model values env-driven. The current live smoke test confirms `opencode-go-direct` and `deepseek-v4-flash`; do not introduce caller-supplied model tiers.
- Use the local PostgreSQL database for run inspection. Useful queries filter `research_runs`, `research_stages`, `research_tasks`, `model_call_logs`, and `research_artifacts` by the run ID above.
- Do not auto-approve `human_review` just to demonstrate completion.

## Files To Start With

- `src/lib/agent-harness/runner.ts`
- `src/lib/agent-harness/deadlines.ts`
- `src/lib/agent-harness/providers/request-lock.ts`
- `src/lib/research/source-reader-batching.ts`
- `src/lib/research/handlers/evidence-extraction.ts`
- `src/lib/research/handlers/operating-model.ts`
- `src/lib/research/stage-contracts.ts`
- `src/lib/workflow/validators.ts`
- `src/lib/workflow/orchestrator.ts`
- `tests/agent-harness.test.ts`
- `tests/valuation-artifacts.test.ts`
- `tests/workflow-orchestration.test.ts`
- `.env.local` / `.env.example`
