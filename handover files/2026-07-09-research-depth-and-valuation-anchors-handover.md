# Research Pipeline Handover - Depth Gates And Valuation Anchors

**Date tag:** 2026-07-09
**Last updated:** 2026-07-09
**Scope:** Investing Research Pipeline research workflow, system pipeline, quality gates, export/UI surface
**Status:** current

## Executive Summary

This session implemented deterministic research quality gates, expanded MSFT/source gathering from one SEC context blob to a multi-source corpus, and added deterministic SEC financial/market-data extraction before valuation. The pipeline now stores annual and quarterly SEC filings as individual source documents, records market/context sources, persists structured financial metrics such as capex/free cash flow/EPS/shares, and can add caveated numeric scenario anchors when valuation agents leave anchors blank.

The system correctly distinguishes source breadth from action readiness. Source depth is now materially improved, but full action-ready completion still depends on extracting enough evidence and getting stable OpenCode agent calls through analysis/review.

## Current State

- Dev server was started on `http://localhost:3001` because port `3000` was already in use.
- MSFT asset exists as `2b731da6-dd67-4300-9938-933c04f63a71`.
- Earlier fresh MSFT run `a5a6af62-fcd6-452b-8219-b423718d01b7` completed as `needs_more_work` with:
  - 25 sources
  - 12 evidence claims
  - 6 metrics
  - 10 valuation signals
  - 4 scenarios
  - 0 numeric anchors
  - 2 exports
- Verification run `1299bfe9-3a8f-4f94-a310-3629f47ad5d8` proved deterministic SEC financial extraction works, then hit an OpenCode transport failure during asset analysis. It was marked `needs_more_work` with a metadata note.

## What Changed

- Added shared quality gate module:
  - `src/lib/workflow/quality-gates.ts`
- Added `/api/research-runs/[id]/quality`.
- Added real validators for:
  - source depth
  - analysis coverage
  - valuation depth
  - AI/human review outcome
- Wired validators into stages and made unknown validation rules fail visibly.
- Added a Quality Gates panel to `src/app/assets/[id]/run/page.tsx`.
- Updated export package generation to include `quality_gates.json` and reuse the shared quality result.
- Populated seeded profile completion criteria in `src/db/seed.ts`.
- Updated `src/lib/research/system-pipeline.ts` so public-company source discovery now stores:
  - SEC companyfacts/submissions context
  - 5 years of `10-K` and `10-Q` filing primary documents where available
  - investor relations source candidate
  - industry/peer context candidate
  - macro/FRED context candidate
  - Yahoo Finance chart market-data snapshot
- Added deterministic metric extraction from SEC companyfacts:
  - revenue
  - gross profit
  - operating income
  - net income
  - operating cash flow
  - capex
  - free cash flow
  - cash/debt where available
  - diluted EPS
  - diluted shares
  - shares outstanding
- Added deterministic market metrics from Yahoo chart data:
  - market price
  - 52-week high/low
  - market volume
  - computed market cap when share count is available
- Increased metric persistence cap from 12 to 60 observations so deterministic market rows are not dropped.
- Added caveated deterministic scenario anchors when valuation agents return scenarios with null `value_anchor`.

## Verification

Commands run:

```bash
npx tsc --noEmit
npm run build
```

Final results:

- `npx tsc --noEmit` passed.
- `npm run build` passed.

Note: one parallel `tsc` run failed while `next build` was regenerating `.next/types`; rerunning `tsc` by itself passed.

## Important Outputs

Source-depth MSFT run:

```text
Run ID: a5a6af62-fcd6-452b-8219-b423718d01b7
Status: needs_more_work
Sources: 25
SEC 10-K sources: 5
SEC 10-Q sources: 15
Evidence: 12
Metrics: 6
Valuation signals: 10
Scenarios: 4
Numeric anchors: 0
```

Deterministic extraction verification run:

```text
Run ID: 1299bfe9-3a8f-4f94-a310-3629f47ad5d8
Status: needs_more_work
Verified metrics before OpenCode failure:
- capex: 28.107B USD
- diluted EPS: 9.68 USD/share
- diluted shares: 7.472B
- free cash flow: 59.475B USD
- revenue facts present
- shares outstanding facts present
```

## Known Issues

- OpenCode transport failed during one verification run at `asset-analyst:full-analysis` with `fetch failed`.
- Yahoo market snapshot fetched successfully, but the verification run started before the metric persistence cap fix; future runs should persist market metrics because the cap was raised from 12 to 60.
- `research_runs.metadata_json` has some array-shaped values from prior JSONB concatenation behavior. This was observed but not fixed in this session.
- Source-reader still extracts only 12 evidence claims because `persistEvidence` slices evidence to 12. This is likely too low for deep-dive quality thresholds.
- Deterministic scenario anchors are intentionally caveated. They are useful workflow anchors, not a substitute for human-reviewed intrinsic valuation.

## Next Steps

1. Run a fresh MSFT pipeline after the metric cap fix to confirm `market_price` and `market_cap` persist.
2. Raise or make configurable the evidence persistence cap in `persistEvidence`.
3. Add deterministic filing table extraction from SEC HTML/XBRL facts into module-level coverage, not only generic metrics.
4. Add true peer multiple/industry data fetchers instead of storing peer/industry search candidates.
5. Fix metadata JSONB merge behavior so `metadata_json` remains an object, not an array.
6. Add tests for deterministic metric extraction and scenario-anchor fallback.

## Practical Caveats

- Do not treat `needs_more_work` runs as broken. That is the intended state when the output is useful but not action-ready.
- Do not loosen the quality gate to force `completed`; instead, improve extracted metrics, evidence, and numeric anchors.
- The deterministic anchor fallback should remain explicitly labeled in assumptions so reviewers know when it is a workflow anchor versus an intrinsic valuation.

## Files To Start With

- `src/lib/research/system-pipeline.ts`
- `src/lib/workflow/quality-gates.ts`
- `src/lib/workflow/validators.ts`
- `src/lib/workflow/orchestrator.ts`
- `src/lib/workflow/stages.ts`
- `src/lib/export/research-package-generator.ts`
- `src/app/api/research-runs/[id]/quality/route.ts`
- `src/app/assets/[id]/run/page.tsx`
- `src/db/seed.ts`
