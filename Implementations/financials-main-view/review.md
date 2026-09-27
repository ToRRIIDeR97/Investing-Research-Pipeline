# Financials implementation review

Implemented and reviewed by the root agent on 27 September 2026. No delegation, commits, paid research, or database writes were used. The earlier workspace edits were preserved. This is the implementation agent's review, not a separate review by the original chat's plan author.

## Candidate

Application changes add Financials beside Overview and Report, with an overview and three statement detail tabs. They reuse the selected report's typed historical artifact, the existing formatter, and Recharts. URL parameters own view, statement, frequency, period and run selection. Run changes reject stale responses and hide the previous run while loading. Report prose, chapter IDs, citations and secondary tools remain available.

The classifier preserves observation objects, order, duplicates and provenance. Tables retain reporting basis, currency, segment and geography distinctions. Value buttons open exact amounts and available sources. Missing sources say unavailable. Charts refuse ambiguous series and retain gaps. Annual observations are never synthesized. The Financials component requires no new dependency, API, migration or research pipeline change.

Candidate file hashes: `../../output/financials-main-view/candidate-files.json`.
Combined candidate identity: `2acc739595f26476ae1d9a217b3adc409f27cce8a27cd29643f796343f154120`.
Before-edit copies of modified existing source files are in `../../output/financials-main-view/before/`. These copies, rather than the much larger pre-existing Git diff, were used to review this task's changes.

## Checks actually run

From the repository root:

```powershell
npx tsx --test tests/financial-statements.test.ts Implementations/financials-main-view/acceptance/*.test.ts Implementations/financials-main-view/verification/*.test.ts Implementations/report-visual-reader/acceptance/*.test.ts Implementations/report-visual-reader/verification/*.test.ts
npx tsc --noEmit
```

19 tests passed, zero failed or skipped. Type checking passed. Logs are in `../../output/financials-main-view/tests.log` and `types.log`. The seven original Financials tests were not modified. Four new regression tests cover window navigation, chart ambiguity/gaps, duplicate provenance, annual records with retained quarter fields and unknown metadata categories. Eight existing report-reader tests cover compatibility and source/value handling. Broader pipeline suites were not run because backend behavior did not change.

The temporary visual-fixture route was removed after testing. Its source is saved as `../../output/financials-main-view/visual-fixture.tsx.txt`, outside application routes. A stale generated Next type file for that temporary route caused the first cleanup type check to fail; removing that generated file made the final check pass. No test assertions or compiler settings were weakened.

## Acceptance evidence

| Criterion | Observed result |
| --- | --- |
| AC-1 | Overview, Report and Financials are visible peers. All four statement links work. Earlier periods, reload, Back and Forward preserve the selected run, statement and headings. Invalid statement/frequency/end parameters recover to all statements, quarterly and latest periods. An unrelated `qa=preserved` parameter survives navigation. Financials has no chapter rail. |
| AC-2 | Original acceptance and verification suites pass against all 306 saved observations. Detail tables include loan loss reserve, loans held for sale, loans held for investment and aliases. Other reported metrics remain in a disclosure. |
| AC-3 | Browser shows reserve 56.459 million and exact 56,459,000 USD with its stored SEC link; net revenue 1,218.676 million; credit losses 13.755 million; operating cash flow negative 3,890.444 million. Mixed-currency fixture separates USD/EUR, preserves zero/null and displays duplicate 8 / 9 with both exact amounts. Missing provenance is explicit. |
| AC-4 | Latest tables use Q2 2025 through Q2 2026. Earlier window uses Q1 2024 through Q1 2025 in every statement and chart. Quarterly-only run disables Annual with a visible reason. Annual-only fixture initially has no quarterly data; choosing Annual shows 2024 and 2025 with saved values 7 and 9 million. Empty fixture disables both frequencies and period controls. |
| AC-5 | Four tabs captured and visually reviewed at desktop 1440x1024 and mobile 390x844. Shared columns align; mobile titles stack above scrollable tables, and page width does not overflow. Keyboard focus is visible, tables scroll with arrow keys, sources open with Enter and close with Escape, returning focus to the value. Charts have numeric alternatives. 720x512 reflow also passed. Native 200% browser zoom is unverified, as described below. |
| AC-6 | The original Financial history chapter hash survives reload and links to Financials. Run history changed from the 25 September run to the 23 September run, after which Financials showed only Q1 2023 and unavailable cash flows, with no prior-run table figures. Fresh-preview browser error/warning logs were empty. Research artifacts, report hash, run, export and refresh schedule matched the pre-interaction response exactly. |

The first local server launch lacked DATABASE_URL and returned connection errors. The preview was restarted using the existing local PostgreSQL configuration on port 5433, database `research_os`, through a process-only environment override. No environment file was changed. No new browser errors were recorded in the clean final preview.

Source access was verified without opening a remote filing. The displayed original-source URL for reserve was `https://www.sec.gov/Archives/edgar/data/1818874/000181887426000054/sofi-20260630.htm`, resolved from the saved source document. The review concerns presentation of saved research, not verification of those filings' investment claims.

## Visual review

Source truth: the four images in `designs/`, subject to the corrections in the plan. Screenshot root: `../../output/financials-main-view/`.

| View | Desktop | Mobile | Combined reference comparison |
| --- | --- | --- | --- |
| All statements | `all-desktop.png`, `all-desktop-full.png` | `all-mobile.png`, `all-mobile-full.png` | `all-comparison.png` |
| Income statement | `income-desktop.png`, `income-desktop-full.png` | `income-mobile.png`, `income-mobile-full.png` | `income-comparison.png` |
| Balance sheet | `balance-desktop.png`, `balance-desktop-full.png` | `balance-mobile.png`, `balance-mobile-full.png` | `balance-comparison.png` |
| Cash flow | `cashflow-desktop.png`, `cashflow-desktop-full.png` | `cashflow-mobile.png`, `cashflow-mobile-full.png` | `cashflow-comparison.png` |

The references are 1487x1058 pixels. Browser CSS viewports were 1440x1024 and 390x844, devicePixelRatio 1. The browser tool returned desktop screenshot files at 1425x1013 and mobile files at 375x812. Reference and desktop captures were normalized to 1440x1024 for the side-by-side comparison boards. Full-page captures retain every vertically scrollable row. The focused `balance-table-comparison.png` checks label readability, exact displayed amounts, rules and numeric alignment. It deliberately includes the extra required detail rows absent from the mockup.

Typography uses the existing Inter/sans-serif shell and Georgia headings. Tables use 14px tabular figures, with smaller secondary unit labels. The warm white, charcoal, slate and thin rules follow the plan. There are no added card grids, shadows or generated-image UI assets. Installed Lucide icons and data-driven Recharts provide the small controls and charts. The existing application header is retained.

The initial overview was too tall because it displayed per-row units and a separate period toolbar. This was a P2 density issue. The fix moved uniform units to each table header, aligned frequency/window controls with the tabs and abbreviated the overview to the specified measures. Final overview captures and `all-comparison.png` show the corrected layout. Detail tabs intentionally remain longer than the mockups because they expose all observations, including distinct aliases and reporting bases. Their full-page captures show the complete tables and charts.

Other intentional differences: no decorative current date; corrected statement subtitles; Back to all statements links; separate frequency/window controls; truthful missing-cash-flow notes; per-cell source actions; chart values drawn from observations, including the corrected cash-flow direction. Exact numbers are available in value dialogs rather than padded with trailing decimal zeroes.

Additional evidence includes `reserve-source.png`, `annual-empty.png`, `annual-values.png`, `empty.png`, `mixed-currency.png`, `duplicate-source-unavailable.png`, `narrow-reflow.png` and `state-check.json`.

## Remaining limitation

The in-app browser ignored five zoom-in shortcuts, and the measured viewport and devicePixelRatio did not change. Native browser 200% zoom was therefore not verified. The 720x512 narrow reflow check is separate evidence and is not claimed as a zoom test. No unresolved P0/P1/P2 visual defect was found in the states that could be inspected.

Visual final result: passed. The native zoom check remains a test gap.
