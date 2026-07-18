# Research OS Handover - Local Harness and MELI Resolution Work

**Date tag:** 2026-07-17
**Last updated:** 2026-07-17
**Scope:** Research OS local agent harness, direct model providers, MELI deep-dive pipeline, valuation, review, and backtesting
**Status:** current

## Executive Summary

The OpenCode-dependent research runtime has been migrated substantially toward a Research OS-owned local harness on branch `codex/local-agent-harness`. Direct published model endpoints are working without mock data. A fresh paid MELI deep dive was run end to end through evidence, grouped analysis, executable valuation, deterministic backtests, and AI review.

The current MELI run is deliberately `needs_more_work`, not stuck. Its final reviewer failure is now primarily substantive:

- Quarterly 84M unique buyers and broader FY2025 reach of 121M are correctly recognized as different measurement windows, not contradictory.
- Cash-flow valuation still uses unadjusted CFO-minus-capex while MELI's fintech-adjusted FCF is materially lower.
- Revenue-based valuation mixes GAAP revenue with MELI's “net revenues and financial income” reporting basis.
- Commerce/Fintech profitability estimates need labeled ranges and reconciliation to consolidated operating income.
- The moving-average strategies genuinely failed out-of-sample benchmark testing.

Do not force this run into human review. Fix the remaining normalization and analytical artifacts, then resume the same run or create a fresh acceptance run.

## Current State

- Branch: `codex/local-agent-harness`
- Worktree: intentionally dirty with substantial uncommitted migration work; preserve all existing changes.
- Active MELI run ID: `200d3d5a-ee95-4108-8024-f6917dafe277`
- Pipeline version: 2
- Provider: `opencode-go-direct` (direct published inference API; not OpenCode SDK/session/sidecar)
- Run type: `deep_dive`
- Run status: `needs_more_work`
- Total recorded model cost: `$0.217917`
- Sources: 29
- Source-linked evidence claims before the latest supplemental pass: 39; the latest pass adds deterministic buyer-definition and adjusted-FCF evidence.
- Backtests: exactly 50 current rows, all with robustness fields.
- Running tasks: 0
- Running stages: 0
- Stage summary after cleanup: 12 completed, AI reviewer failed, human review cancelled fail-closed, export and refresh pending.

The database was cleared of all prior research before this run. Reference assets, profiles, registries, and the MELI asset remained.

## What Changed

### Local harness and provider reliability

- Added provider-neutral local execution, retry, repair, deadline, cancellation, telemetry, and tool contracts.
- Added direct OpenAI-compatible and OpenCode Go direct adapters, including the Anthropic-compatible route needed by Qwen.
- Preserved bounded local JSON parsing and schema validation rather than relying on provider-native structured output.
- Added recovery and telemetry for timeout-boundary partial responses.
- Added valuation-specific schema coercions for safe aliases:
  - `ordered_formulas` to protocol `formulas`
  - protocol version `1.0`
  - `valuation_analyst` origin to `proposed`
  - scalar limitations to string arrays
- Arbitrary generated expression/code strings remain rejected.

### Evidence and analysis

- Fixed JSONB task-output normalization and grouped-output merging.
- Fixed required analysis modules being marked incomplete when a model used a generic section name despite having accepted module-specific evidence.
- Added deterministic primary-source claims for:
  - quarterly fintech MAU and unique active buyers
  - annual active-buyer reach context
  - customer-fund cash movements
  - fintech funding flows
  - signed adjusted-FCF bridge inputs
- Analysis and review prompts now receive an explicit analytical-resolution protocol covering disclosure conflicts, fintech-adjusted FCF, segment profitability, and backtest robustness.
- AI review now receives up to 120 accepted evidence claims instead of the first 24 claims from compacted context.

### Valuation

- The original 240-second generic valuation deadline caused four failed attempts.
- A 10-minute valuation-specific deadline allowed Qwen 3.7 Plus to complete.
- Local coercion accepted the semantically valid response, and one bounded semantic repair produced an executable method.
- Reproducible model: `fintech_platform_sotp`
- Current executed SOTP values:
  - Bull: `$1,518.05/share`
  - Base: `$953.69/share`
  - Bear: `$324.35/share`
- The model is reproducible, but its segment assumptions still require better source labeling, ranges, and reconciliation.

### Backtesting

- `python/backtesting/run_backtest_grid.py` now creates:
  - chronological 70/30 in-sample/out-of-sample split
  - untouched out-of-sample metrics
  - benchmark excess return
  - nearby-parameter stability
  - in-sample ranking and explicit selection rule
- The v2 quality gate now requires all completed combinations to contain these robustness fields.
- Resume-generated duplicate backtests were removed; the run has exactly 50 robust combinations.

## Important MELI Findings

### Buyer-count reconciliation

The apparent conflict is resolved:

| Disclosure | Meaning | Correct use |
|---|---|---|
| 84M | Unique active buyers for the three months ended Q1 2026 | Quarterly operating KPI |
| 121M | Broader buyer reach described in FY2025 results | Annual ecosystem reach |

These values should not be directly compared without labeling their measurement windows.

### FCF normalization

The current valuation's simple FCF is approximately `$10.77B` from CFO minus capex. This is inappropriate for a fintech-heavy company because CFO contains customer-fund, credit-book, and related funding flows.

Evidence available in the filings includes:

- FY2025 adjusted FCF headline around `$1.5B`
- Q1 2026 adjusted FCF of `-$56M`
- Q1 2026 filed bridge rows for CFO, customer-fund movements, capex/intangibles, loan-receivable changes, and net fintech funding proceeds

The next implementation must create accepted normalized observations and a persisted calculation table using:

```text
normalized_fcf =
  reported_cfo
  - customer_fund_cash_movement
  - fintech_loan_receivable_movement
  - net_fintech_funding_flow
  - capex
```

Preserve the signs exactly as disclosed. Show reported FCF and fintech-adjusted FCF side by side. Disable or clearly mark FCF yield, EV/FCF, FCF conversion, and net-debt/FCF signals until the full-year bridge is complete.

The latest reviewer estimated that using adjusted FCF changes the apparent valuation from roughly:

- unadjusted FCF yield: `11.5%`
- adjusted FCF yield: approximately `1.6%`
- adjusted EV/FCF: approximately `62x`

Treat those adjusted multiples as reviewer estimates until the deterministic annual bridge is persisted.

### Revenue definition

The run mixes:

- SEC/GAAP `Revenue`
- MELI's `Net revenues and financial income`

Create separate canonical metric keys and never silently substitute one for the other. Multiple tables should either use one consistent denominator or show both with explicit definitions and source periods.

### Segment profitability

The next agent should persist a Commerce/Fintech table with:

- segment revenue
- disclosed versus assumed source
- bear/base/bull operating margin
- operating profit
- confidence
- sensitivity
- consolidated operating-income reconciliation

Use disclosed segment figures where available. When unavailable, assumptions must be explicitly labeled and the table must reconcile to consolidated results.

### Backtest result

The robustness framework worked and produced a legitimate negative conclusion.

The in-sample-selected MA 10/300 strategy had:

- in-sample return: `+82.8%`
- out-of-sample return: `-10.7%`
- out-of-sample excess return versus SPY: `-39.8%`
- positive neighboring-parameter fraction: `0%`

The best full-period strategy also had negative out-of-sample excess return. Do not modify gates to make this pass. The correct conclusion is that the tested moving-average family does not support a tactical MELI signal. A different hypothesis, such as a fundamental-factor regime model, would be a new research test rather than a repair of these results.

## Verification

Commands completed successfully after the latest implementation:

```bash
python3 -m py_compile python/backtesting/run_backtest_grid.py
npm run test:unit
npx tsc --noEmit
git diff --check
npm run build
```

Results:

- 65 unit tests discovered
- 62 passed
- 3 PostgreSQL-gated integration tests skipped
- 0 failures
- Synthetic Python robustness-metric check passed
- Next.js production build passed

The real provider smoke test previously passed against `opencode-go-direct` and `deepseek-v4-flash`.

## Known Issues

1. Full-year fintech-adjusted FCF bridge is not yet persisted as canonical normalized observations.
2. FCF-derived valuation signals still reference unadjusted CFO-minus-capex.
3. GAAP revenue and net revenues plus financial income are not separated consistently.
4. Segment profitability artifacts need explicit ranges and consolidated reconciliation.
5. The active-buyers analysis section may still contain old model wording that calls 84M/121M a discrepancy, even though the latest reviewer correctly resolves it. Materialization should replace stale conflict wording when deterministic definition evidence resolves it.
6. Backtest persistence is not fully idempotent in code. Repeated pipeline resumes insert another 50 rows; cleanup was performed manually after the latest run. Refactor persistence to replace/upsert one run per `combination_key` transactionally.
7. Pipeline terminal cleanup previously left `human_review` running after AI-review failure. It was manually cancelled. Make this transactional in the workflow.
8. The PostgreSQL full-text parser emits a non-fatal `word is too long to be indexed` notice on large raw filing HTML tokens.
9. The worktree includes an untracked `Research References/` directory. Treat it as user-owned and do not remove it.

## Next Steps

1. Implement canonical adjusted-FCF bridge observations for annual and quarterly periods.
2. Recompute or disable all FCF-based valuation signals using the adjusted metric.
3. Split `revenue` from `net_revenues_and_financial_income` throughout metric normalization, analysis, and valuation.
4. Persist and validate the ranged Commerce/Fintech profitability table.
5. Replace stale active-buyer conflict language with the deterministic quarterly-versus-annual reconciliation.
6. Make deterministic backtest persistence idempotent and transactional.
7. Fix terminal cleanup so failed AI review cancels human review and leaves no running stages automatically.
8. Add PostgreSQL integration tests for the FCF bridge, metric-definition separation, backtest resume idempotency, and failed-review cleanup.
9. Run all automated checks.
10. Resume the same MELI run only after the artifacts above are corrected, or create a fresh paid acceptance run if clean end-to-end provenance is preferred.
11. Stop at genuine human review only if the AI reviewer passes.

## Practical Caveats

- Do not include provider credentials in documentation, logs, handovers, or commits.
- Load `.env.local` only at runtime.
- For paid reruns, use the direct provider and explicitly set the valuation timeout/model routing.
- Qwen 3.7 Plus successfully completed valuation generation and semantic repair.
- DeepSeek Pro successfully completed reviewer calls in roughly 111–158 seconds.
- Do not loosen evidence, valuation, or backtest gates merely to obtain a passing run.
- Preserve historical handovers unchanged.
- Preserve all pre-existing dirty-worktree changes.

## Files To Start With

- `src/lib/research/system-pipeline.ts`
- `src/lib/research/pipeline-helpers.ts`
- `src/lib/workflow/quality-gates.ts`
- `src/lib/workflow/validators.ts`
- `src/lib/workflow/orchestrator.ts`
- `src/lib/agent-harness/runner.ts`
- `src/lib/agent-harness/validation.ts`
- `src/lib/agent-harness/registry.ts`
- `src/lib/agent-harness/providers/opencode-go.ts`
- `src/lib/agent-harness/providers/anthropic-compatible.ts`
- `src/lib/valuation/method-protocol.ts`
- `python/backtesting/run_backtest_grid.py`
- `tests/agent-harness.test.ts`
- `tests/pipeline-helpers.test.ts`
- `tests/valuation-method-protocol.test.ts`
- `tests/source-reader-batching.test.ts`
