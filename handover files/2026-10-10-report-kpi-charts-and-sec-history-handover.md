# Report KPI Charts and SEC Filing History Handover

**Date:** 2026-10-10
**Status:** Merged to `main`
**PRs:**
- [ToRRIIDeR97/Investing-Research-Pipeline#32](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/32), merge commit `5eca6149` (branch commit `f4aad67a`)
- [ToRRIIDeR97/Investing-Research-Pipeline#33](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/33), merge commit `70f675aa` (branch commit `7bac465c`)

**Follow-up issue:** [ToRRIIDeR97/Investing-Research-Pipeline#34](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/34) (valuation page redesign)

## What changed

Both bugs were found while mapping the data behind a UI redesign workshop for the META report.

| PR | Problem | Fix | Files |
|---|---|---|---|
| #32 | Every KPI chart in the report showed "Quarterly series unavailable". `KPIDashboard` required observation `reporting_basis` and `unit` to equal the KPI's labels exactly ("GAAP as reported" / "USD millions" against `gaap` / `USD`). | New pure helper `kpiSeries`: matches basis by meaning, scales raw USD to millions, uses a small alias map (for example `total_revenue` → `revenue`), keeps segment and consolidated series apart, and drops YTD and conflicting rows. | `src/lib/research/reporting/dashboard-series.ts` (new), `src/components/research-dashboards.tsx`, `tests/dashboard-series.test.ts` |
| #32 | The forecast table divided values already in USD millions by 1e6 again ("Base capex 0.12"). | `forecastTableRows` leaves millions alone and converts only raw values. | same |
| #33 | Only `submissions.filings.recent` was read. For META that holds about 1,000 filings back to June 2024, so a run got 2 10-Ks and history stopped at FY2022. | `loadSubmissionFilings` fetches the older `filings.files` pages that overlap the 5-year window, sequentially, and merges and dedupes them. A failed page throws. | `src/lib/research/sources/corpus.ts`, `tests/sec-filing-history.test.ts` |
| #33 | A cash-flow opening balance created an almost empty FY2021 column. | Opening balances are kept only for periods other observations populate. | `src/lib/research/history/filing-statements.ts`, `docs/system.md` |

## Verification

Run on each branch before merge:

| Check | #32 | #33 |
|---|---|---|
| `npx tsc --noEmit` | pass | pass |
| `npm run test:unit` | 264 tests, 256 pass, 0 fail, 8 skipped | 265 tests, 257 pass, 0 fail, 8 skipped |
| `npm run build` | pass | pass |

- DB-backed suites were not run. Neither PR changes persistence, the queue or orchestration. #33 changes source gathering, but only through a function covered by mocked tests.
- **#32 on META run `02c8d48b`:** 9 of 12 KPIs now chart. Seven have 8 quarters; the two segment revenue KPIs have 4 with gaps. Base capex reads 120,464 / 130,000 / 135,000.
- **#33 against live SEC data (3 GETs):** META goes from 2 10-Ks and 7 10-Qs to 5 10-Ks (FY2021 to FY2025) and 12 10-Qs.

## Known issues

- **Forecast units are inferred from size.** The projections carry no unit field, so a raw money value under $10M would be read as already in millions. The proper fix is storing units with each projected value.
- **Three KPIs still lack a useful chart.** Family of Apps operating income and the Reality Labs operating loss have one captured quarter each, and free cash flow has two stale points. They need segment history from the older 10-Qs that #33 now fetches.
- **Q4 diluted weighted shares stay unavailable.** SEC has no Q4 fact for META, and annual minus three quarters is not valid for weighted averages. Q4 per-share metrics show n/a.
- **Existing runs are unchanged.** The new filing history appears only after META's research is re-run.

## Next steps

1. **Price history** (`feat/price-history`) and **headcount extraction** (`feat/headcount-extraction`) are being built in agent worktrees. Both branched from `0c1633f7`, before these merges, so rebase them on `main` before opening PRs.
2. Re-run META research so the FY2021 to FY2025 filings and the segment history land.
3. Build the chosen UI designs from the workshop canvas: statement charts with My charts, the metrics table with a chart panel, the simple KPI status table, the summary-first valuation page (#34), Newsreader headings, directional page motion, and no page titles or subtitles.
4. Valuation pipeline: add depreciation back in the cash-flow proxy, reconcile the cash-flow-model values with the scenario values, and check the reverse valuation's implied 53% margin.
