# Provider Prompt Caching Handover

**Date:** 2026-10-02
**Status:** Merged to `main`
**PR:** [ToRRIIDeR97/Investing-Research-Pipeline#4](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/4)
**Merge commit:** `f2b6dc44` (branch commits `99d67b71`, `baea08fc`)

## What changed

The cache layer of the [Codetonomy foundation harness](https://github.com/ToRRIIDeR97/codetonomy-foundation-harness) (`packages/runtime/src/cache-shape.ts`) was ported into `src/lib/agent-harness`. The harness runtime itself was not adopted. It is a coding-agent loop with a sandbox and workspace tools, and research calls are single-shot JSON requests.

| Area | Change | Files |
|---|---|---|
| Prompt layout | Instructions before `Task packet:` become the system message; the packet is the user message. Run-wide packet keys (`asset`, `research_question`, `source_cutoff`, `profile`, `coverage_requirements`, `evidence_claims`) come first. Full-task repairs repeat the generation request and append the repair. | `agent-harness/cache.ts` (`promptMessages`), `agent-harness/runner.ts`, `research/run-context.ts` (`runContextFirst`) |
| Affinity | HMAC of run ID over provider, model and instruction hash, sent to OpenCode Go as `x-opencode-session`. The run ID is never sent. | `cache.ts`, `providers/opencode-go.ts` |
| Anthropic protocol | `cache_control` on the system block; `RESEARCH_ANTHROPIC_CACHE_CONTROL=0` disables it | `providers/anthropic-compatible.ts` |
| Usage and cost | Parses `cached_tokens`, `prompt_cache_hit_tokens` and the Anthropic `cache_*_input_tokens` fields. Cache reads are priced at 10% and writes at 125% of input. Recorded as `cache_read_tokens` and `cache_write_tokens` in `model_call_logs.response_metadata_json`. | `providers/openai-compatible.ts`, `telemetry.ts`, `types.ts`, `run-context.ts`, `backtesting/executor.ts` |
| Diagnosis | Content-free hashes, the bytes shared with the previous request in the same affinity group, and a miss reason, stored per request under `response_metadata_json.provider_requests[].cache` | `cache.ts` (`WireRequestTracker`, `classifyCacheMiss`), `runner.ts` |
| Smoke test | `RUN_PAID_RESEARCH=1 npm run test:provider-cache-smoke` sends six small requests and prints cache reads | `scripts/provider-cache-smoke.ts` |

`PROMPT_VERSION` is now `v3-runtime-v2`, which changes task keys.

## Verification

- `npx tsc --noEmit`: clean.
- `npm run test:unit`: 222 passed, 0 failed, 5 skipped (gated on the database).
- Mock pipeline (`tests/sofi-research-e2e.test.ts` with the mock provider): 5/5 passed against the dev database on 5432. Port 5433 was not running. The suite creates and deletes an isolated test asset.
- Before merging, this branch was combined with the uncommitted work on local `main` in a dry run: no conflicts, tsc clean, 229 unit tests passed, mock pipeline 6/6.
- `npm run lint` was not run: ESLint is not configured, and `next lint` opens its setup prompt.

Live results, DeepSeek V4.1 Flash via OpenCode Go, from two runs of the smoke test:

| Request | Run 1: cached / prompt | Run 2: cached / prompt |
|---|---|---|
| Same run, second call with shared evidence | 6,144 / 8,064 | 8,064 / 8,125 |
| Repair after its generation pass | 8,064 / 8,404 | 8,064 / 8,369 |
| Same prompt, different session | 8,064 / 8,127 | 8,192 / 8,249 |

OpenCode Go reports cache reads as `prompt_tokens_details.cached_tokens`. Its DeepSeek cache is shared across sessions, so the savings come from the prompt layout, not the session header. The 12 requests cost about $0.026 at the estimated cache rate, against $0.038 without caching.

The live run exposed one bug, fixed in `baea08fc`: a cache hit from another affinity group was labelled `first-request`. Any reported cache read now counts as `none`.

## Known issues and limits

- No full research run has used the new layout yet. The model now sees its instructions as a system message, and the packet key order has changed.
- Runs that were in progress before the merge will re-run model tasks in reopened stages, because task keys changed.
- `cache_control` on qwen/minimax has not been tested against OpenCode's `/messages` endpoint. If those calls start returning HTTP 400, set `RESEARCH_ANTHROPIC_CACHE_CONTROL=0`.
- Cache prices are estimates, like the rest of `telemetry.ts`. OpenCode's actual billing for cached tokens is not confirmed.
- The old code never recorded cache counts, so the baseline hit rate is unknown.

## Next steps

1. Run one full live research run, then check cache reads per agent:
   ```sql
   SELECT agent_name, count(*), sum(input_tokens) AS input,
          sum((response_metadata_json->>'cache_read_tokens')::int) AS cached
   FROM model_call_logs WHERE research_run_id = '<run id>' GROUP BY 1 ORDER BY 3 DESC;
   ```
2. Use `provider_requests[].cache.cacheMissReason` to find calls that missed. `previous-in-flight` points to parallel siblings, which is the case for sibling warm-up (harness `module-orchestration`).
3. Consider putting shared run context before agent-specific instructions, so different agents (outline, sections, reviewer) can share the large evidence prefix.
4. Configure ESLint so `npm run lint` can run.

## Local state at handover

- Your uncommitted work on local `main` was left untouched, and local `main` is behind `origin/main`. Commit that work before pulling: the merge also changed `src/lib/research/run-context.ts` and `docs/system.md`.
- The `feat/provider-prompt-caching` branch still exists locally and on origin; it was not deleted. A checkout of it remains at `.claude/worktrees/provider-prompt-caching`, with `node_modules` and `.env.local` symlinked from the main checkout.
- `.claude/worktrees/` and `node_modules` were added to the local `.git/info/exclude`, which is never committed.
- This handover file is not committed.
