# Research Pipeline Handover - Output Upgrade

**Date tag:** 2026-07-09
**Last updated:** 2026-07-09
**Scope:** Research OS pipeline exports, SOFI package generation, source intelligence, valuation/backtest artifacts
**Status:** current

## Executive Summary

The research pipeline output generator was upgraded so generated research folders are closer to the manual SOFI research standard. The key improvement is that package exports now expose richer section files, source-intelligence artifacts, processed CSVs, copied backtest outputs, and stricter review gates instead of silently producing thin research.

The final verified SOFI export is:

```text
storage/exports/sofi_deep_dive_1783410738946_research_package
```

The system still does not yet match the manual SOFI folder analytically. It now reports that honestly: the generated review packet flags incomplete source breadth, missing IR/industry context, missing numeric valuation anchors, and thin evidence depth.

## Current State

The dev server was restarted and left running at:

```text
http://localhost:3000
```

The SOFI run used for verification:

```text
run_id: 2b75f0e3-2784-4a08-a432-0a3490506ee1
asset_id: 87c0cd44-a8cd-4eb2-80db-c2b36b0c8c08
symbol: SOFI
```

Latest package manifest counts:

```text
evidence: 12
metrics: 12
valuation_signals: 11
scenarios: 4
risks: 1
catalysts: 3
indicators: 12
strategy_combinations: 50
backtests: 1
backtest_artifacts: 5
sources: 1
inferred_source_gaps: 5
```

## What Changed

Main implementation file:

```text
src/lib/export/research-package-generator.ts
```

Changes made there:

- Added `02_industry_research.md` to canonical generated files.
- Added stricter inferred source-gap detection so a run cannot look complete just because agents failed to create `source_gaps` rows.
- Added richer `09_review_packet.md` completion gates and a stronger final recommendation section.
- Added richer `05_valuation.md` sections: summary, valuation method selection, dashboard conclusion, historical cheapness/expensiveness, and value-driver map.
- Fixed backtest metric rendering by accepting `sharpe` as well as `sharpe_ratio`, and by parsing JSON values that arrive serialized.
- Added copied backtest artifacts into generated packages.
- Added generated CSVs:
  - `data/processed/aligned_research_dataset.csv`
  - `data/processed/valuation_dashboard.csv`
  - `data/backtest_outputs/backtest_artifacts.csv`
  - merged `data/backtest_outputs/equity_curves.csv`
  - merged `data/backtest_outputs/trade_log.csv`
- Added source-intelligence files:
  - `source_intelligence/asset_specific_source_plan.md`
  - `source_intelligence/filing_download_log.md`
- Reworked the 50 strategy combinations into distinct strategy families instead of repetitive label swaps.

## Verification

Commands run successfully:

```bash
npm run build
npx tsc --noEmit
```

The final export was generated through the real app API:

```bash
curl -sS -X POST http://localhost:3000/api/research-runs/2b75f0e3-2784-4a08-a432-0a3490506ee1/export \
  -H 'Content-Type: application/json' \
  -d '{"generatedBy":"codex-pipeline-output-upgrade"}'
```

The API returned:

```text
researchPackage.exportId: ae65f364-b814-4517-9975-5de1d55f0097
researchPackage.storagePath: storage/exports/sofi_deep_dive_1783410738946_research_package
memo.storagePath: storage/exports/sofi_deep_dive_1783410738888.md
```

Backtest metrics now render correctly in `08_backtest_results.md`:

```text
Return: 6.1%
Sharpe: 0.247
Max drawdown: -61.7%
Benchmark return: 98.1%
Trades: 9
Invested days: 582
Observations: 1255
Ending equity: 106061.76
Volatility: 44.2%
```

Copied/merged data counts:

```text
data/backtest_outputs/equity_curves.csv: 1255 lines
data/backtest_outputs/trade_log.csv: 9 lines
data/processed/aligned_research_dataset.csv: 36 lines
```

## Important Outputs

Final upgraded package:

```text
storage/exports/sofi_deep_dive_1783410738946_research_package
```

Important files to inspect:

```text
storage/exports/sofi_deep_dive_1783410738946_research_package/02_industry_research.md
storage/exports/sofi_deep_dive_1783410738946_research_package/02_source_intelligence.md
storage/exports/sofi_deep_dive_1783410738946_research_package/05_valuation.md
storage/exports/sofi_deep_dive_1783410738946_research_package/08_backtest_results.md
storage/exports/sofi_deep_dive_1783410738946_research_package/09_review_packet.md
storage/exports/sofi_deep_dive_1783410738946_research_package/10_strategy_combinations.md
storage/exports/sofi_deep_dive_1783410738946_research_package/manifest.json
```

Important copied artifacts:

```text
storage/exports/sofi_deep_dive_1783410738946_research_package/data/backtest_outputs/backtest_summary.csv
storage/exports/sofi_deep_dive_1783410738946_research_package/data/backtest_outputs/equity_curves.csv
storage/exports/sofi_deep_dive_1783410738946_research_package/data/backtest_outputs/trade_log.csv
storage/exports/sofi_deep_dive_1783410738946_research_package/data/processed/aligned_research_dataset.csv
storage/exports/sofi_deep_dive_1783410738946_research_package/data/processed/valuation_dashboard.csv
```

Manual SOFI research benchmark for comparison:

```text
/Users/japardinathaniel/Library/CloudStorage/GoogleDrive-sensen13575757@gmail.com/Other computers/My Computer/Google Drive/Investing Framework/research/2026-06-24_SOFI
```

## Known Issues

- The SOFI system package is structurally improved but still analytically thin.
- The final package has only one source document, so source breadth is still failing.
- The source agents did not collect company IR, earnings presentation, transcript, peer data, or industry/macro sources.
- Numeric valuation anchors are missing in the generated scenarios, so the package cannot produce a real fair-value range like the manual folder.
- The research reviewer stage previously timed out on the SOFI run; the export can still be generated from completed data, but the review gate should not be treated as clean.
- `02_industry_research.md` is intentionally honest: for SOFI it fails the industry gate because the run lacks peer and industry sources.

## Next Steps

1. Upgrade source collection before analysis:
   - SEC filings.
   - Company IR releases, presentations, and transcripts.
   - Peer/industry sources.
   - Macro/credit/funding sources for financials.
2. Add source ingestion tasks that create real `source_documents` rows, not only agent summaries.
3. Add valuation-coder or valuation-model output that creates bear/base/bull value anchors.
4. Extend the backtest layer to test the generated 50 combinations instead of only one generic moving-average strategy.
5. Convert quarterly fundamentals into availability-date-aligned datasets to avoid lookahead bias.
6. Improve the UI to surface the generated markdown/CSV package sections as user-facing pages, tables, and charts.

## Practical Caveats

- Do not treat the latest SOFI output as investment-ready. It is a better scaffold and audit trail, not a full manual-equivalent research packet.
- The package generator now exposes missing work more clearly, so a red/failed gate can be a success condition if the upstream data is thin.
- `npm run build` can invalidate a running Next dev server's `.next` cache. After building, restart `npm run dev` before testing API routes.
- If `npx tsc --noEmit` is run in parallel with `next build`, it may fail on missing `.next/types` files while build rewrites generated types. Run it serially.

## Files To Start With

```text
src/lib/export/research-package-generator.ts
src/lib/research/system-pipeline.ts
src/lib/opencode/agent-registry.ts
src/lib/backtesting/executor.ts
src/lib/backtesting/service.ts
src/app/api/research-runs/[id]/export/route.ts
src/app/assets/[id]/view/page.tsx
src/app/assets/[id]/run/page.tsx
architecture.md
```
