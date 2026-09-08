# Research OS Handover - Paid Evidence-Reader Canary Failure

**Date tag:** 2026-09-04
**Last updated:** 2026-09-04
**Scope:** Research OS paid source-reader acceptance test
**Status:** corrected canary implemented; paid execution still required

## Executive summary

One paid source-reader request ran against the configured provider and failed local structured-output validation. The response had four claim objects, but all four omitted the required `claim_text` and `confidence` fields. The runtime rejected the output and made no retry or repair call.

This is not a valid production-prompt acceptance result. The temporary canary prompt did not enumerate `claim_text` and `confidence` as clearly as the production evidence prompt. The canary also used the in-memory runner instead of `callResearchAgent`, so the failed response, request ID, token use and cost were not persisted.

Do not treat this as proof of a citation-offset defect. Missing `claim_text` causes the shared normalizer to reject the entire claim before it can establish whether the quote and offsets are correct.

## Implementation update

The corrected canary is implemented in `scripts/source-reader-smoke.ts` but has not been run against the paid provider. It now:

- creates a dedicated research run and evidence-extraction stage;
- reads the saved SOFI filing through the production source-packet path;
- reuses the production source-reader prompt;
- allows one model attempt, no repair, and one provider request at a time;
- persists the task, model-call telemetry, sanitized rejected output, validation errors, and compact attempt telemetry;
- checks required fields before source ID, chunk ID, exact quote, and absolute offsets;
- rejects locally repaired offsets for canary acceptance; and
- sends the durable session ID to OpenCode and retains request IDs from headers or SSE payloads.

Malformed claims and proven citation failures now have separate rejection buckets. No paid request was made during this implementation pass.

## Current state

- Provider: `opencode-go-direct`
- Model: `deepseek-v4-flash-vision-exp`
- Provider concurrency: `1`
- Paid provider requests: `1`
- Model attempts: `1`
- Repair calls: `0`
- Retries: `0`
- Observed wall time: about 126 seconds
- Outcome: rejected, no evidence accepted
- Exact cost and token use: unavailable because the temporary wrapper did not persist telemetry
- Temporary wrapper: deleted after the run
- Full paid analysis and report review: not started

The implementation remains at the state recorded in `handover files/2026-09-03-focused-tasks-and-report-composition-handover.md`.

## Test input

The canary read the saved SOFI quarterly filing at:

```text
storage/sources/621d87c594d6ed57cdec9220a2aadd05b069e97bd438f2fa05fb69632e221336.html
```

It sent one focused excerpt containing the member and product table. The requested facts were:

| Claim type | Period | Expected value |
| --- | --- | ---: |
| `members` | 2026-03-31 | 14,706,040 |
| `members` | 2025-03-31 | 10,915,811 |
| `total_products` | 2026-03-31 | 22,159,146 |
| `total_products` | 2025-03-31 | 15,915,425 |

The local deterministic extractor had already recovered these four facts and verified their exact saved-text offsets before the paid call.

## Confirmed failure

The terminal reported these validation failures for `evidence_claims[0]` through `evidence_claims[3]`:

```text
claim_text: Required property is missing
confidence: Required property is missing
```

The canary's custom checks then reported all four requested type and period pairs as missing. It also reported that one or more citations did not match the excerpt.

The missing-pair errors follow directly from the absent `claim_text` fields. The citation message is less precise than it sounds. `normalizedClaim` in `src/lib/research/source-reader-batching.ts` rejects a claim when `claim_text` is shorter than twenty characters. Such a rejected claim enters `rejected_invalid_citations`, even if quote comparison was never decisive. The failed wrapper printed only the final error message, so the original four objects are no longer available for separate quote inspection.

## Root cause assessment

Two facts are established:

1. The model response did not satisfy the claim schema.
2. The runtime blocked the invalid response after one attempt.

The test setup prevents a stronger conclusion. The temporary prompt asked for four claims and named `claim_type`, `claim_category`, `period_end`, source identifiers, quotes and offsets. It did not explicitly say that every claim must include `claim_text` and `confidence`. The production prompt in `src/lib/research/handlers/evidence-extraction.ts` does include that complete field list.

Because this was a weaker prompt than production and the failed payload was not saved, do not classify the incident as a provider schema bug, a pipeline prompt bug or a citation bug yet.

## What worked

- The paid-call authorization was explicit.
- Concurrency stayed at one.
- The runner made one provider request only.
- Schema and domain validation failed closed.
- No malformed evidence reached persistence or later research stages.
- No automatic retry increased cost.

## Resolved setup issues

1. The canary now reuses the production `exactJsonPrompt` construction.
2. It calls `callResearchAgent` with a real run and stage.
3. Rejected output staging reads the nested harness response metadata and retains compact attempt telemetry.
4. `rejected_invalid_claims` is separate from `rejected_invalid_citations`.

## Next steps

1. Get explicit approval for one new paid request.
2. Run `RUN_SOURCE_READER_SMOKE=1 npm run test:source-reader-smoke` and retain the printed run ID.
3. If the corrected request still omits required fields, inspect whether `opencode-go-direct` receives or honors the configured response schema. Do not start the full paid pipeline first.

## Verification

The pre-canary implementation passed:

- TypeScript check.
- 74 targeted harness, provider, prompt, extraction, and citation tests.
- ESLint on the changed files, with no errors.
- Diff whitespace check.
- Read-only database confirmation that the saved SOFI source, asset link, and target table chunk are present.

The paid canary was deliberately not run.

## Files to start with

- `src/lib/research/handlers/evidence-extraction.ts`
- `src/lib/research/source-reader-batching.ts`
- `src/lib/research/run-context.ts`
- `src/lib/agent-harness/runner.ts`
- `src/lib/agent-harness/providers/opencode-go.ts`
- `src/lib/agents/model-calls.ts`
- `handover files/2026-09-03-focused-tasks-and-report-composition-handover.md`
