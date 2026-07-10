# Research Pipeline Handover - MELI Pipeline Fixes And Validated Rerun

**Date tag:** 2026-07-10
**Last updated:** 2026-07-10
**Scope:** Research OS system pipeline, SEC filing ingestion, agent-output recovery, workflow state handling, MELI validation run
**Status:** current

## Executive Summary

The MELI pipeline defects documented earlier on 2026-07-10 were diagnosed and fixed, then verified with a new end-to-end `deep_dive` run.

The most important factual correction is that MercadoLibre currently files as a US domestic issuer using `10-K`, `10-Q`, and earnings `8-K` forms. It is not currently a `20-F`/`6-K` filer. The actual zero-filing bug was date-window logic: when a run had no cutoff, the code used `9999-12-31` as the cutoff and then subtracted five years, producing an earliest date in 9994 and filtering out every real filing.

The corrected run stored substantive filings and macro/market context, produced 30 evidence claims, normalized metrics, completed analysis, valuation, backtesting, review, export, and refresh scheduling, and terminated honestly as `needs_more_work / research_scaffold`. The remaining blockers are the AI reviewer's `needs_more_work` conclusion and the absence of a genuine human review decision. They are not missing-source, evidence-depth, metric, or valuation-anchor failures.

## Current State

Validated MELI run:

```text
run_id: 97894eeb-b7d8-46c1-9a05-73ce08d58e5c
asset_id: 326e7eec-50ae-40dc-b334-b9b74e1b965e
profile_id: 917d1675-67d1-4dc3-bae6-69e9681c437c
run_type: deep_dive
status: needs_more_work
quality status: needs_more_work
action readiness: research_scaffold
failure_reason: null
actual model cost: USD 0.20716036
```

Final persisted counts:

```text
sources: 25
evidence claims: 30
metric observations: 65
valuation signals: 12
scenarios: 4
scenarios with numeric anchors: 4
open source gaps: 0
human review decisions: 0
```

All stages completed except `ai_reviewer`, which is deliberately marked failed because the reviewer outcome was `needs_more_work` and the quality evaluator also observed that a real human review decision was absent. `human_review`, `export`, and `refresh_schedule` completed under temporary system-test auto-approval.

The dev server was restored without the temporary auto-approval environment override and is running at:

```text
http://localhost:3000
```

## What Changed

### SEC filing discovery and ingestion

- Fixed the no-cutoff five-year-window defect by using the current date as the effective cutoff instead of year 9999.
- Added issuer-family-aware filing selection:
  - domestic issuers: `10-K`, `10-Q`, and earnings-related `8-K` filings;
  - foreign private issuers: `20-F` and selected results/update `6-K` filings;
  - Canadian MJDS issuers: `40-F` and selected `6-K` updates.
- Preserved filing family and semantic role in filing metadata.
- Limited the corpus to useful annual, quarterly/interim, and earnings documents rather than downloading every current report.
- Persisted failed filing downloads as explicit low-quality failure records, then excluded them from substantive quality counts.
- Added real FRED DGS10 macro data instead of counting a URL/search plan as a source.
- Kept source-plan candidates available to agents as context without persisting them as substantive `source_documents`.

### Evidence and structured output

- Raised the evidence persistence cap from 12 to a configurable default of 40, with a minimum of 25.
- Added a detailed source-reader JSON schema with required claim fields and minimum text length.
- Added semantic claim validation so schema examples such as `"string"` are rejected.
- Added one evidence repair call when a deep-dive response has fewer than 25 usable claims.
- Sanitized agent-provided dates at the persistence boundary; malformed dates now become null rather than throwing `Invalid time value`.
- Added general structured-output repair inside the OpenCode runtime when required top-level keys are missing.
- Preserved raw response excerpts in failed structured-output metadata for debugging.

### Agent reliability and auditability

- Added up to three attempts for transient errors such as `fetch failed`, timeouts, resets, and network/socket failures.
- Recorded every failed transport/runtime attempt in `model_call_logs`, even when usage metadata was unavailable.
- Retained `retry_count` for audit while clearing a temporary `failure_reason` after a successful retry.
- The valuation agent failed twice at the five-minute transport boundary and succeeded on attempt three, proving the retry path works.

### Workflow and metadata correctness

- Added atomic propagation of an uncaught pipeline error to the running task, stage, and run.
- Failed partial runs now terminate as `needs_more_work` with a durable failure reason rather than remaining `running`.
- Fixed `research_runs.metadata_json` merges to use real JSON values and to repair legacy array/string shapes before merging.
- The validated run retained object-shaped metadata throughout.
- Removed a redundant final `advanceStage` after `refresh_schedule`; the extra call previously produced a trailing API 500 after all stages and exports had already finished.

### Metric recency and point-in-time behavior

- Combined all configured SEC concept fallbacks before selecting the best fact instead of stopping on the first concept with any history.
- Sorted facts by reporting-period end before filing date so a newly filed comparative fact cannot outrank the newer reporting period.
- Treated `10-K`, `20-F`, and `40-F` as annual forms.
- For runs with a historical market cutoff, selected the latest Yahoo close at or before the cutoff and omitted current-only 52-week/volume metadata.

## Verification

Successful checks:

```bash
npx tsc --noEmit
npm run build
```

Focused runtime checks also passed for:

- domestic `10-K`/`10-Q`/earnings `8-K` selection;
- foreign-private-issuer `20-F`/`6-K` selection;
- Canadian `40-F`/`6-K` selection;
- structured JSON extraction and missing-key rejection;
- source-reader schema shape;
- real FRED DGS10 CSV retrieval;
- JSONB object serialization using `postgres.js` `sql.json(...)`.

Live MELI evidence:

```text
SEC 10-K sources: 5
SEC 10-Q sources: 12
earnings 8-K sources: 4
macro context: FRED DGS10
market snapshot: present
evidence claims: 30/25 required
valuation lenses/signals: 12
numeric scenario anchors: 4
backtest: completed
AI review: completed, outcome needs_more_work
exports: completed
```

The quality endpoint returns only these blocking items:

```text
AI review outcome is needs_more_work.
Human review decision is required before completion.
```

## Important Outputs

Validated research package:

```text
storage/exports/mercado_libre_deep_dive_1783651268271_research_package
```

Validated memo:

```text
storage/exports/mercado-libre_deep_dive_1783651268201.md
```

Useful endpoints:

```text
http://localhost:3000/api/research-runs/97894eeb-b7d8-46c1-9a05-73ce08d58e5c
http://localhost:3000/api/research-runs/97894eeb-b7d8-46c1-9a05-73ce08d58e5c/quality
http://localhost:3000/api/research-runs/97894eeb-b7d8-46c1-9a05-73ce08d58e5c/sources
http://localhost:3000/api/research-runs/97894eeb-b7d8-46c1-9a05-73ce08d58e5c/evidence
http://localhost:3000/api/research-runs/97894eeb-b7d8-46c1-9a05-73ce08d58e5c/metrics
http://localhost:3000/api/research-runs/97894eeb-b7d8-46c1-9a05-73ce08d58e5c/model-calls
```

## Known Issues

1. The final run is not investment-ready. The AI reviewer explicitly returned `needs_more_work`, and no genuine analyst review decision exists.
2. Temporary system auto-approval completed the human-review workflow stage for testing, but it does not create a `review_decisions` row and must not be represented as substantive human approval.
3. The AI reviewer stage validator currently includes the not-yet-created human review decision in its failure message. This makes the stage failure reason include both AI-review and human-review issues even though human review is a later stage.
4. A resumed run re-fetches and re-persists deterministic sources/metrics. This produced 25 sources and 65 metric rows in the validated run; resume idempotency should be tightened to prevent duplicate dynamic snapshots and deterministic observations.
5. `source_documents` uses a globally unique file hash and reassigns the document's `research_run_id` on conflict. That design can move a shared unchanged filing between runs instead of modeling a many-to-many run/source relationship.
6. Specialist models can exceed the OpenCode transport window. Bounded retries work, but a model-aware faster fallback would be more efficient than retrying the same slow model three times.
7. Numerous JSONB inserts elsewhere in the repository still use `JSON.stringify(value)::jsonb`. The critical research-run metadata merges were fixed, but broader JSON shape normalization should be audited.
8. The working tree was already dirty before this session. Several modified and untracked files contain earlier user/session work; do not discard or overwrite them.

## Next Steps

1. Inspect the AI review findings and generated review packet, then decide whether to:
   - add missing analytical work and rerun the reviewer; or
   - record a real analyst `needs_more_work` decision with concrete follow-up questions.
2. Separate AI-review-stage validation from human-review validation so the reviewer stage reports only its own outcome.
3. Make source and deterministic metric persistence idempotent on pipeline resume.
4. Replace the global source-document/run ownership pattern with a run-to-source association if the schema permits.
5. Add model fallback routing after repeat transport timeouts, especially for `valuation-analyst`.
6. Add permanent automated tests for filing-family selection, date sanitization, semantic evidence validation, transient retries, JSONB metadata shape, and failure propagation.
7. Consider normalizing legacy array/string-shaped `research_runs.metadata_json` values with a one-time migration.

## Practical Caveats

- Do not revert to the earlier assumption that MELI is a foreign private issuer. Live SEC submissions show current `10-K`, `10-Q`, and `8-K` filing behavior.
- Do not loosen the AI or human-review gates to call this run complete. The pipeline now has sufficient source/evidence/valuation depth; the remaining work is analytical review.
- `needs_more_work` is the correct final state for this run and is evidence that the quality system is operating honestly.
- The validated run was resumed once at `asset_analysis` after a transport failure. Its completed stages and audit logs should be retained.
- A production build invalidates a running Next dev server's `.next` cache. Restart `npm run dev` after `npm run build` before API testing.

## Files To Start With

```text
src/lib/research/system-pipeline.ts
src/lib/opencode/runtime.ts
src/lib/opencode/agent-registry.ts
src/lib/workflow/orchestrator.ts
src/lib/workflow/quality-gates.ts
src/lib/workflow/validators.ts
src/lib/workflow/stages.ts
src/app/api/research-runs/[id]/review/route.ts
src/app/api/research-runs/[id]/quality/route.ts
src/lib/export/research-package-generator.ts
```
