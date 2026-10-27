# Price History and Headcount Handover

**Date:** 2026-10-10
**Status:** Merged to `main`
**PRs:**
- [ToRRIIDeR97/Investing-Research-Pipeline#35](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/35) headcount extraction, merge commit `78eb0715` (branch commit `48e9b492`)
- [ToRRIIDeR97/Investing-Research-Pipeline#36](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/36) price history, merge commit `aa1818b8` (branch commit `c0a23dff`)

## What changed

Both fill data gaps found during the UI workshop. Twelve price-based metrics and six per-employee metrics had no inputs.

| PR | Change | Main files |
|---|---|---|
| #35 | **Headcount.** A deterministic extractor reads total headcount from the run's stored 10-K, 10-Q and 8-K text. It accepts only explicit company-wide counts with a date and rejects forward-looking, segment, contractor and undated wording. It saves `employees` observations (unit `persons`, quarterly plus annual at Q4) with the evidence sentence. `employees` is a stock metric, so it is never summed into TTM figures. No schema change. | `src/lib/research/history/headcount.ts`, `filing-store.ts`, `diagnostics.ts` |
| #36 | **Price history.** Source discovery backfills about 6 years of Yahoo daily bars into `market_price_bars`, then updates incrementally. Splits and dividends go to `corporate_actions`. Bars become public the day after trading and readers respect the run cutoff. Stooq cross-checks closes to within 0.5% for `verified` or `mismatch`. A `market_price_history` artifact holds period-end closes and market caps (share classes summed). The valuation now uses the stored valuation-date close. | `src/lib/market-data/price-history.ts`, `providers/stooq.ts`, `service.ts`, `src/lib/research/history/market-history.ts`, handlers for source discovery, historical record and valuation; migration `drizzle/0010_price_history_verification.sql` |

## Verification

| Check | #35 (rebased) | #36 (rebased) | Combined `main` |
|---|---|---|---|
| `npx tsc --noEmit` | pass | pass | 0 errors in project code (the untracked `Temp Download/` folder still reports its own errors) |
| `npm run test:unit` | 270 pass, 0 fail | 274 pass, 0 fail | 282 pass, 0 fail, 9 skipped |
| `npm run build` | pass | pass | not re-run |

- **#35 DB suites:** `sofi-research-e2e`, `research-workspace` and `persistence-integration` pass, 21 of 21.
- **#36 DB suites:** the new price-history integration test, `persistence-integration` and the SOFI e2e test pass. Full `test:db`: 399 pass, 19 fail. These are the same 19 `Implementations/research-memory` failures already present on `main`.
- **Live provider smoke (#36), Anthropic API:** `claude-haiku-5-5`, request `req_011Cft9bbRe9zFC5waA1thCo`, valid structured JSON in 1,051 ms, cost well under one cent. It checks the provider only, not the valuation packet.
- **META headcount** from stored filings: Q2 2024 70,799 through Q2 2026 75,472.
- **META period-end market caps** (Yahoo, unverified): 2025-09-30 $1.851T, 2025-12-31 $1.670T, 2026-03-31 $1.452T, 2026-06-30 $1.435T.
- **A live paid META run started after the merge:** run `50d91067-7ce8-48f2-822b-1497fdfe7699`, `anthropic-direct` with `claude-haiku-5-5`, log at `/tmp/meta-live-run-2026-10-10.log`. Its outcome is not recorded here.

## Known issues

- **Price verification does not work yet.** Stooq answers with a browser check (and HTTP 403) instead of CSV, so every price stays `unverified`. A free-key second source such as Tiingo or Alpha Vantage would fix it.
- Yahoo's chart endpoint is unofficial.
- Not built yet: enterprise value, the price ratios, the yields and the per-employee ratios. The inputs now exist.
- The headcount extractor misses "N employees with …" tails and has no LLM fallback yet.
- Migration 0010 is applied to the local dev database (port 5432); other databases need `npm run db:migrate`.
- The backtest runner still downloads its own prices without storing them.

## Next steps

1. Review run `50d91067` once it finishes. Check that FY2021 to FY2025 history, segment history, headcount and the market caps reach the artifacts and the UI.
2. Add a working second price source so prices can be verified.
3. Compute the price-based and per-employee metrics in `financialRatios`.
4. Build the chosen UI designs (see the workshop canvas and issue #34).

## Local state

- Local `main` is at `aa1818b8`. The feature branches and agent worktrees are deleted locally and on origin.
- The worker was restarted on the merged code. The web app runs on port 3002.
- This handover file and `2026-10-10-report-kpi-charts-and-sec-history-handover.md` are not committed.
