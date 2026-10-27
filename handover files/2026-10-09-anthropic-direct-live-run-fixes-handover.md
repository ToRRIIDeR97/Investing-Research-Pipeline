# Anthropic Direct Provider and Live-Run Fixes Handover

**Date:** 2026-10-09
**Status:** Merged to `main`
**PR:** [ToRRIIDeR97/Investing-Research-Pipeline#29](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/29)
**Merge commit:** `37534f81` (12 branch commits, `ab647c07` to `32cb2c46`)

## What changed

A live META run was taken through the pipeline on free OpenCode models, then on Claude Haiku 5.5 through a new `anthropic-direct` provider. Every failure was fixed at its cause and the run was resumed. The last run reached the human review gate.

| Commit | Problem found live | Fix | Files |
|---|---|---|---|
| `ab647c07` | `\u0000` in model output failed the jsonb insert (`unsupported Unicode escape sequence`) | Strip NUL from streamed text and from parsed JSON strings | `agent-harness/output-parser.ts`, `runner.ts` |
| `3feeb5ac` | There was no way to call Claude directly | `RESEARCH_MODEL_PROVIDER=anthropic-direct`. Claude models get no `temperature` (non-default sampling returns a 400), plus a `/models` health check, Haiku 5.5 pricing and `ANTHROPIC_API_KEY` redaction | `providers/provider.ts`, `providers/anthropic-compatible.ts`, `telemetry.ts` |
| `a1043d8b` | A source-reader batch holding only 1962 FRED data failed the 5-claim minimum | No per-batch minimum (the stage still enforces the run target); FRED DGS10 keeps the last 260 rows up to the cutoff | `agent-harness/registry.ts`, `research/sources/corpus.ts` |
| `8efc6dea` | Undisclosed segment revenue became placeholder zeros and failed reconciliation | `forecast_revenue` is nullable; reconciliation runs only when every segment has revenue, otherwise a warning | `research/forecast/contracts.ts`, `validation.ts` |
| `8547b468` | The diluted-share lookup took the first chunk containing the value (a different SEC concept) | The chunk must also contain the start date, end date and accession number | `research/handlers/asset-valuation.ts` |
| `7e5e2e75` | The report agent put `regulatory_filing` (a `source_role`) into `role` | The prompt lists the four roles | `research/team.ts` |
| `1eb27d6d` | Pings and hidden adaptive thinking produced no events, so the 90 s inactivity timer aborted live Haiku streams | Content-free Anthropic stream events yield a `heartbeat` | `agent-harness/types.ts`, `providers/anthropic-compatible.ts` |
| `3d4b4203` | The outline validator stopped at its first rule and named no sections | Report all violations with section titles | `research/reporting/contracts.ts` |
| `164c9658` | Web-fetched SEC filings had no `published_at`, so 87 claims could not be cited | Date `sec.gov/Archives/edgar/data/...` documents from their EDGAR filing index; the report drops unusable citations and records them in section `gaps` | `research/sources/role-discovery.ts`, `research/reporting/runtime.ts` |
| `556e5f59` | Backtest material had no coverage key | Place it under `monitoring` | `research/reporting/runtime.ts` |
| `bed08a80` | The doctrine said "financial tables live in Financials", which led to a Financials chapter that the outline rules rejected | Financials is a separate tab; the opening summary is conclusion-only | `research/reporting/contracts.ts`, `runtime.ts` |
| `32cb2c46` | Docs | `system.md`, `local-agent-harness.md` (also `architecture.md`, `security.md` and `.env.example` in earlier commits) | `docs/` |

## Verification

- `npx tsc --noEmit` and `npm run build` pass on a clean copy of the tracked files. The untracked `Temp Download/` folder in the main checkout breaks both, because it has no `remotion`, `bun`, `@playwright/test` or `sst` dependencies.
- `npm run test:unit`: 248 passed, 8 skipped, 0 failed.
- `test:sofi-v3` (mock e2e): 6/6, run against a new local database `research_os_test` on 5432. Port 5433 was not running.
- `npm run test:db` against `research_os_test`: 383 passed, 19 failed. `main` fails the same 19: `Implementations/research-memory` acceptance and verification tests, AC-13 to AC-16 (corpus rounds, founder escalation, PDF/OCR).
- Live: the provider smoke on `claude-haiku-5-5` passed. META run `02c8d48b-cd29-4dfa-814f-f38c9f5568a3` reached `human_review` after 174 calls, at $2.61 on the Anthropic account.

## Live run record (META)

| Run | Model | Result |
|---|---|---|
| `11965a65` | `space-bunny-free` via OpenCode Go | Go endpoint returned "Model is unavailable" |
| `15158c84` | `space-bunny-free` via OpenCode Zen | NUL persistence bug |
| `52fc33ee` | `longcat-2.5-preview-free` via Go | Valuation output truncated at 32,768 tokens |
| `66637bdb` | `claude-haiku-5-5` | 5-claim minimum and FRED 1962 data |
| `02c8d48b` | `claude-haiku-5-5` | Reached human review after the fixes above; three AI-reviewer passes |

Run `02c8d48b`'s decision record is `pending`. Expected returns at the unverified $719.87 reference are bear -42.6%, base -21.7% and bull -6.6%. The AI reviewer raised 30 findings on the report, 1 critical. The report is a research draft and is not reliable.

## Known issues and limits

- Run `02c8d48b` is waiting at `human_review`. It has not been approved or rejected.
- 6 sec.gov sources in run `02c8d48b` were dated by a one-off backfill. New runs date them during discovery.
- About 70 claims from undated non-SEC web pages remain usable for analysis but cannot be cited in the report. That is the point-in-time rule.
- Haiku 5.5 sometimes produces very long answers that aren't valid JSON. Retries absorbed it, but it costs a repair cycle.
- The META asset (`meta-platforms`, NASDAQ: META) was added directly to the dev database, using the MSFT asset's profile.
- The free OpenCode Zen models refuse outside clients ("free tier can only be used from within OpenCode"). The only free model on the Go endpoint is `longcat-2.5-preview-free`.

## Next steps

1. Done: segment-revenue sourcing merged as [#30](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/30) (`2a020dfe`). Segment revenue and operating income now reach the asset analyst as `reported_segment_history`.
2. Done: the Anthropic prompt-cache module merged as [#31](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/31) (`0c1633f7`). The packet breakpoint is **on** by default, and it roughly breaks even. Set `RESEARCH_ANTHROPIC_CACHE_PROMPT=0` to keep only the system breakpoint. Its paid test ran before the rebase onto the heartbeat change; the next live Anthropic run serves as the post-rebase check.
3. Look into the 19 `Implementations/research-memory` test failures on `main`.
4. Decide on run `02c8d48b`'s human review, or rerun META for a report with segment revenue and the cache module.

## Local state at handover

- Local `main` is at `0c1633f7` (#29, #30 and #31 merged). The PR branch and its stacked local branches (`fix/strip-nul-model-output`, `feat/anthropic-direct-provider`, `fix/operating-model-missing-segment-revenue`) were deleted locally and on origin.
- `research_os_test` (local Postgres on 5432) is migrated and seeded for database tests.
- `.env.local` gained `ANTHROPIC_API_KEY`; its default provider is still OpenCode Go. The per-run Anthropic settings are in the PR body and in `docs/local-agent-harness.md`.
- `node_modules` gained `cheerio`, which was declared but not installed.
- This handover file is not committed.
