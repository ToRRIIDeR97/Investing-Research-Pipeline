# Research OS local harness migration implementation handover

Date: 2026-07-14

Branch: `codex/local-agent-harness`

Starting HEAD: `bcc11c3a`
Working tree: intentionally uncommitted; the pre-existing partial migration was preserved before editing at `/tmp/local-agent-harness-partial-20260714.patch` and `/tmp/local-agent-harness-partial-20260714.status`.

## Outcome

The Research OS-owned execution harness now runs in-process and uses provider-neutral contracts. Active runtime code no longer imports the OpenCode SDK, starts an OpenCode service, reads OpenCode credentials, or uses OpenCode session/history APIs.

Implemented behavior includes:

- Direct HTTPS and local/private OpenAI-compatible provider modes with URL validation, direct-host allowlisting, redirect refusal, optional local authentication, `/models` health checks, request IDs, usage, normalized errors, and fragmented SSE parsing.
- Caller cancellation plus distinct total and inactivity deadlines that abort the provider request.
- Plain-text responses with local direct/fenced JSON parsing, ambiguity/truncation rejection, local schema validation, one bounded repair, bounded partial-response capture, response/token ceilings, retry classification, fallback compaction, and attempt aggregation.
- Deny-by-default schema-validated tool dispatch with four-turn/eight-call defaults and redacted summaries.
- Per-attempt model-call records with provider/model/request ID, timing, tokens/cost, retry/fallback/compaction/repair state, error/timeout category, validation errors, bounded response excerpt, and tool summaries.
- Run/stage/task budget preflight before each model attempt and exact-once attempt cost persistence.
- Native JSONB object persistence via `sql.json(...)`, plus legacy string normalization for task-output reads and grouped output merging.
- A deterministic mock source-reader and analyst that use only evidence/source IDs supplied in their task packets.
- Gated direct-provider and paid MELI launchers, documented direct/local endpoint setup, and audited OpenCode provenance.

## Final mock MELI acceptance

Command: `npm run test:meli-mock`

Run ID: `30a149e5-d219-4ecd-8946-1e7cca25f541`

Pipeline: v2 `deep_dive`

Provider: `mock`

Hard budget: USD 10.00

Actual model cost: USD 0
UTC source and market cutoffs: `2026-07-14T08:57:10.321Z`

The run stopped at the genuine human-review gate. The script approved only the research-plan gate and did not create or approve a human review decision.

Stage results:

- Completed: intake, asset identity, research plan, source discovery, source ingestion, evidence extraction, metric normalization, asset analysis, thesis/risks, indicator design, 50-combination backtest execution, and AI review.
- Failed closed: asset valuation. Three numeric mock scenarios were persisted with anchors from 3,500 to 5,000, but the reproducible `fintech_platform_sotp` engine remained blocked because required canonical metrics were absent. Valuation did not receive a false reproducibility pass.
- Waiting: human review.
- Pending: export and refresh scheduling.
- Running tasks/stages left behind: zero tasks; the only active stage is the intentional `waiting_for_human` gate.

Selected completed-stage durations were 8.809s intake, 8.641s source discovery, 0.238s evidence extraction, 0.464s grouped asset analysis, 0.259s valuation preflight, 1.967s backtests, and 0.484s AI review.

Research/telemetry results:

- Evidence: 30 claims; all 30 have source links to non-null document chunks.
- Required analysis: all 22 contract-required sections completed. Eight additional narrative sections remain `needs_more_work`: `business_or_asset_profile`, `credit_losses`, `financial_history`, `industry_or_context`, `investment_thesis`, `risk_reward`, `source_completeness`, and `valuation_inputs`.
- Attempts: ten successful mock attempts; every row has attempt metadata and a provider request ID.
- Usage: 66,301 input tokens and 10,981 output tokens across the mock attempts; cost remained zero because the mock provider explicitly reported zero cost.
- Metric conflicts: zero unresolved observation review states.
- Open source gap: `valuation_fintech_platform_sotp_blocked` (high), listing missing GMV, TPV, loan-book, provision, customer-funds, funding-liability, commerce operating-income, and fintech operating-income metrics.
- Run-level `needs_more_work` reason: none. Run status is `waiting_for_human`; the valuation artifact is explicitly blocked rather than represented as complete.

## Verification performed

- `npm run test:unit`: passed. The latest suite covers parser ambiguity/truncation, schema validation, total/inactivity/caller cancellation, partial-response retention, repair, retry/fallback compaction, budget refusal, response limits, zero-cost telemetry, tools, fragmented/malformed/incomplete SSE, rate limits, server errors, real HTTP inactivity abort, URL controls, and existing Research v2 safeguards.
- `npm run test:integration`: passed 3/3 against PostgreSQL. It covers object and legacy-string JSONB merge, actual model-call attempt metadata, idempotent task resume, terminal cleanup, and failed analysis cancelling valuation.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed with Next.js production compilation and type validation.
- `git diff --check`: passed.
- Active-code search for `@opencode-ai/sdk`, `OPENCODE_*`, `opencode serve`, OpenCode session IDs, and OpenCode model providers: no matches in `src`, `scripts`, package manifests, `.env.example`, docs, or README.

## Direct-provider acceptance remains gated

No new direct-provider configuration is present in this workspace: `RESEARCH_MODEL_BASE_URL`, `RESEARCH_MODEL_API_KEY`, `RESEARCH_MODEL_ALLOWED_HOSTS`, and authorized direct model IDs are missing. Therefore no paid smoke prompt or paid MELI run was attempted.

After authorized values are supplied locally:

1. Run `RUN_PROVIDER_SMOKE=1 npm run test:provider-smoke`.
2. Set an explicit `RESEARCH_ACCEPTANCE_CUTOFF_AT` and `RESEARCH_ACCEPTANCE_BUDGET_USD` if the defaults are not desired.
3. Run `RUN_PAID_MELI=1 npm run run:meli-direct`.
4. Audit the new run with the same evidence/module/valuation/attempt/cleanup queries and create a new dated handover. Do not approve human review automatically.

## Remaining product gap

The local harness migration itself is implemented and mock-accepted. Investment-ready MELI valuation still requires either the missing canonical fintech metrics plus a versioned reproducible `fintech_platform_sotp` engine, or an explicit decision to support a different executable valuation model. A model-generated numeric scenario alone must not clear that gate.
