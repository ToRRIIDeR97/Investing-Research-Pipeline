# UI Redesign Handover

**Date:** 2026-10-10
**Status:** Merged to `main`
**PRs:**
- [ToRRIIDeR97/Investing-Research-Pipeline#37](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/37) type and motion, merge commit `6efb0725`
- [ToRRIIDeR97/Investing-Research-Pipeline#38](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/38) Financials, merge commit `ef18d94d`
- [ToRRIIDeR97/Investing-Research-Pipeline#39](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/39) Report, merge commit `ac394a6a`

**Design source:** the UI workshop canvas (private Claude artifact https://claude.ai/artifact/88eD8d5uvZrQh8AUodbLqy), using the chosen round-2 and round-3 artboards.

## What changed

| PR | Change | Main files |
|---|---|---|
| #37 | Newsreader display font as `--font-display`. Visible page titles and subtitles removed (hidden `h1` kept). Tabs slide 22px in the direction of travel, the active-tab underline glides, and opened sections fade in. Mouse/touch only, off under reduced motion. The first tab click no longer reloads when the run is unchanged. | `src/app/globals.css`, `src/app/assets/[id]/view/page.tsx`, `app-shell.tsx` |
| #38 | **Financials:** a sticky chart panel built from statement rows (click or shift-click). A My charts board backed by a new `saved_charts` table and `/api/saved-charts` routes. A 39-metric catalogue with a formula panel and chart buttons, using price history and headcount. "Compare periods" is the default single-statement layout, with an 8-period window. | `src/components/financials/*`, `src/lib/research/reporting/metric-catalogue.ts`, `chart-series.ts`, `saved-charts.ts`, `drizzle/0011_saved_charts.sql` |
| #39 | **Report:** a KPI health table (Healthy / Caution / In danger, only the latest quarter coloured). A summary-first valuation page (weighted value, Bear/Base/Bull, three computed reasons, collapsible calculation with the yearly price-target table, assumptions, open issues and raw notes). A plain-English label map. No chapter eyebrows. | `src/components/report/*`, `src/lib/research/reporting/kpi-health.ts`, `valuation-summary.ts`, `plain-english.ts`, `research-report.tsx` |

## Verification

- **Each branch:** typecheck, unit tests and build pass.
- **All three combined before merge, and `main` after merge:** typecheck 0 errors in project code (the untracked `Temp Download/` folder still errors), `npm run test:unit` 304 pass, 0 fail, 10 skipped, build pass.
- **DB-backed:** `tests/saved-charts-api.test.ts` and `tests/price-history-integration.test.ts` pass. The full `npm run test:db` was not run.
- **Browser on META, desktop:** Financials chart panel (run `d6236111`), the valuation page and the KPI Dashboard (run `02c8d48b`) match the canvas.
- **Browser on META, 375 px:** the Metrics tab has no page overflow, and the chart panel is not sticky on narrow screens. Headings compute to Newsreader.
- After the merge, the running app on port 3002 serves the view page (200) and `/api/saved-charts` (200).

## Known issues

- **Saved charts are shared:** the app has no auth, so everyone using the instance sees the same charts (documented in `docs/security.md`).
- **All prices are unverified:** the Stooq cross-check is blocked, so price-based metrics are marked unverified.
- **Valuation mismatch:** the page shows the cash-flow model ($376 base) disagreeing with the scenario values ($564 base), flagged as not final. The pipeline fix is in progress in a separate session (branch `feat/valuation-financial-inputs`).
- **No visible quarter on two KPIs:** Family of Apps operating income and the Reality Labs operating loss have no Q2 2026 value, so the table shows Q1 2026 with a quarter label.
- **Test data:** one saved chart made during testing is in the local dev database ("Revenue vs Income from operations vs Operating margin").
- **Migration 0011:** applied to the local dev database only.
- **No longer rendered:** `forecastTableRows` is still exported and tested but unused. The KPI "Find a KPI" search was removed.

## Next steps

1. Finish the valuation-inputs session (packet data and a withheld outcome), then do a fresh paid META run on the Anthropic API.
2. Add a working second price source so prices can be verified.
3. Consider auth or per-user saved charts if the app gets more than one user.

## Local state

- Local `main` is at `ac394a6a`. The UI feature branches and agent worktrees are deleted locally and on origin.
- The worker runs in the main checkout with Anthropic overrides. The web app is on port 3002.
- This handover and the other 2026-10-10 handovers in this folder are not committed.
