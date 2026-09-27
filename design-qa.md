# Report reader design QA — 26 September 2026

final result: passed

## Current scope and reference

The selected neutral business-flow direction is implemented in the actual full-report reader. Current reference: `C:/Users/sense/.codex/generated_images/01a0d662-fa55-7e33-8072-3d57e13bb221/exec-6efa4b95-ddf1-483e-b9e9-edfcebe172cc.png` (1095 × 1437).

The report uses the existing off-white, charcoal and slate colors, serif chapter headings, a chapter rail and unboxed diagrams/exhibits. The main application header remains available above report navigation. The saved report's full prose is retained below the figures; the mockup's shortened illustrative text is not substituted for research. The cash-flow title and notes were clarified to distinguish cash receipts from revenue.

## Comparison and responsive evidence

All current captures are in `output/report-visual-reader/`.

- `comparison.png`: first comparison. Chapter labels, flow labels and icons were too small (P2); these were enlarged. Connector visibility was improved.
- `comparison-final.png`: final side-by-side comparison, visually inspected. Each panel is 1080 × 1417; the reference is scaled to the actual captured viewport content size. Desktop viewport was 1095 × 1437; browser scrollbar/chrome accounts for the smaller captured content dimensions.
- `business-desktop-final.png`: final chapter, sources and neutral diagram.
- `funding-desktop.png`: chart with exact underlying observations expanded.
- `analysis-wide.png`: two-column analysis and supporting evidence at 1440 × 1024.
- `business-mobile.png`, `funding-mobile.png`, `history-mobile.png`: phone checks at 390 × 844 (375px document client width). Diagrams and chart fit; the financial table scrolls inside its 335px container while retaining readable measure labels and period columns. No page-wide overflow.

No remaining P0, P1 or P2 visual findings in the inspected reader. Temporary viewport overrides were reset; the actual report remains open for review.

## Interaction and data checks

- All sixteen chapters, fourteen research questions and sixteen sources accessible.
- Chapter and analysis mode survive reload; jumps to analysis keep the chapter hash. Summary → Full report works.
- Chapter search shows a no-match state and restores navigation after keyboard clearing.
- Source citation opens the supporting passage; Escape closes the dialog.
- Financial search for `loan loss reserve` shows **Loan loss reserve**, USD millions, GAAP, and five quarterly values. Q2 2026 displays 56.459 million with the original value preserved. No raw field name or metadata is displayed.
- Earlier/latest paging and table expansion checked. Missing versus zero and exact precision also have automated checks.
- Funding chart uses nineteen stored comparable observations, latest 45,543,160,000 USD. Underlying data table opens and retains this exact value.
- Final checked browser console contained no errors or warnings.

## Code checks and limits

Type checking passed. Eight new acceptance/verification tests passed. The targeted visual/adaptive-report run passed 27 tests with one database-dependent skip; the unit suite passed 190 with three database-dependent skips and no failures. Targeted diff whitespace check passed. Logs are under `storage/report-visual-reader/`.

The new visual guide is supplied to section writers and reviewers, and was tried locally against saved SoFi research. This is an author trial; no fresh paid model evaluation or database-backed pipeline was run. The exact-hash legacy visuals supplement the live reader without rewriting its report or approval. Future authored visuals participate in review, export and approval hashing. Full source mapping and limitations are in `Implementations/report-visual-reader/review.md`.

---

# Previous application design QA

The following historical review predates the report-reader work. Its unit-test limitation has been superseded by the current clean unit run above; unrelated existing implementation is preserved.

final result: passed

## Design and scope

The selected third variant is now applied to the dashboard, asset catalog, asset details, research brief, full report, evidence, metrics, valuation, sources, backtests, run history, review queue, decision form, new-research form, plan presentation, and run workspace.

Shared design: warm white canvas, Inter, narrow reading column, horizontal navigation, plain dividers, restrained status colors, native disclosures, and black primary actions. Detailed tables use a wider column and scroll inside their container on small screens. Repeated status cards, permanent sidebars, technical subtitles, decorative folders, glass effects, and redundant explanatory copy were removed.

Reference: `C:/Users/sense/.codex/generated_images/01a0d456-82b0-7413-8c41-b8c0ae45c6a5/exec-d0d1a4f5-539e-4f16-8435-6bb87051841f.png`.

The saved research is longer than the image's illustrative content. It remains intact and scrolls naturally. Workflow status comes from the selected run. The research-plan gate and final investment review retain separate actions and endpoints.

## Visual evidence

Captures are in `C:/Users/sense/.codex/visualizations/2026/09/24/01a0d456-82b0-7413-8c41-b8c0ae45c6a5/`.

- `app-reference-comparison.png`: selected image and current brief together at matching image dimensions. The reference was normalized to the actual capture size. Completed status and longer text are intentional data differences.
- `app-home-desktop.png`, `app-catalog-desktop.png`, `app-asset-desktop.png`: opening screens.
- `app-decision-desktop.png`, `app-reviews-desktop.png`: review queue and decision form.
- `app-run-complete-desktop.png`, `app-run-pending-desktop.png`, `app-stages-desktop.png`, `app-intake-desktop.png`: run states and controls.
- `app-full-report-desktop.png`, `app-report-backtests-desktop.png`, `app-report-sources-desktop.png`, `app-evidence-desktop.png`: detailed research views. Later final mobile evidence capture includes the improved minimum claim width.
- `app-metrics-chart.png`: final chart with one selectable metric and readable axis labels.
- `app-home-mobile.png`, `app-catalog-mobile.png`, `app-decision-mobile.png`, `app-run-mobile.png`, `app-evidence-mobile.png`, `app-backtests-mobile.png`, `app-search-mobile.png`, `app-attach-mobile.png`: responsive views and controls.
- `app-plan-component-desktop.png`, `app-plan-component-mobile.png`: the actual ResearchPlanCard component rendered against the latest saved plan in a temporary local HTML preview with disabled actions. No live run currently waits at the plan gate. This verifies the component's presentation, not the live approval transition. The temporary preview was removed afterward.

Desktop viewport: 1440 × 1024. Mobile viewport: 390 × 844. Temporary viewport overrides were reset. All inspected mobile pages had document width no greater than viewport width. Long data tables scroll locally.

## Findings resolved

- Duplicate progress panels and always-visible diagnostic cards became a single progress summary and expandable sections.
- Long review-question text and additional notes now open on demand.
- Late polling responses could restore an old run's status after starting a new draft. Responses are now ignored when they belong to a previous run. New drafts and created runs keep the URL in sync.
- Review links now retain the exact selected historical run when opening the report.
- Report dates are readable, raw backtest metrics are collapsed, and the displayed Sharpe value supports the saved `sharpe` field.
- Mobile evidence columns were too narrow for comfortable reading. Claims now retain a readable minimum width inside the scrollable table.
- Chart axis labels were clipped and multiple unrelated metrics overlapped. The history chart now shows one selectable metric with compact axis labels.
- Development hot reloads exhausted PostgreSQL connections. The database client is now reused during development, and the Next.js development server was restarted. API reads recovered with HTTP 200; the database and research worker were not restarted.

No remaining P0, P1, or P2 visual findings in the inspected screens.

## Functional and code checks

- `npx tsc --noEmit`: final run passed.
- `git diff --check -- src/app src/components src/db/index.ts`: passed.
- `npm run test:unit`: 166 tests reported, 162 passed, 1 failed, 3 skipped. The failure is outside this UI work: `tests/agent-harness.test.ts` imports missing `src/lib/agent-harness/tools`. The log is saved as `ui-unit-results.log` in the capture directory. Backend/UI stitching tests and the brief gate-routing test passed in that run.
- Asset type filters, search, and no-match results checked. Crypto filter returns Bitcoin.
- Review form changes, additional notes, cancellation, and fresh form state checked. No decision submitted.
- Historical review `c2200dca` opens that run's report and run workspace; latest run `ce9f6573` shows 24/24 completed stages.
- Stage disclosures, source attachment controls, draft settings, and new-draft state checked. No run created, source uploaded, backtest queued, or approval submitted.
- Evidence filter `loan platform` returns 19 records; global search returns Bitcoin.
- Annual bear/base/bull targets expand to stored values. Detailed report, sources, metrics, and backtests open correctly.
- History chart selection changed from Operating Cash Flow to Net Income and updated the displayed series.
- Native disclosure controls and labelled inputs retained. Focus indicators, reduced-motion support, and responsive form layouts are present.
- Two development stylesheet hot-reload errors occurred during editing. They were cleared operationally by reload/restart; no new application errors appeared during the final checked flows.

## Limits

The visual QA passes. The full unit suite is not clean because of the unrelated missing module above. No database-backed pipeline or paid research was run. Approval and submission endpoints retain their existing handlers but were not exercised against live data. The plan gate was checked using the real component and saved plan, not by moving a live run into that state. Existing backend work was preserved.

## Financials main view, 27 September 2026

The Financials implementation and its latest visual review are recorded in [Implementations/financials-main-view/review.md](Implementations/financials-main-view/review.md). Earlier review records above are preserved.

Source references: `Implementations/financials-main-view/designs/`. Rendered evidence: `output/financials-main-view/`. Full-view side-by-side comparisons are `all-comparison.png`, `income-comparison.png`, `balance-comparison.png` and `cashflow-comparison.png`; the focused numeric/table check is `balance-table-comparison.png`.

CSS viewports: 1440x1024 desktop, 390x844 mobile, and 720x512 reflow. Device pixel ratio: 1. Source images: 1487x1058 pixels. Browser screenshot files: 1425x1013 desktop, 375x812 mobile, and 705x501 narrow. The desktop comparison boards normalize both panels to 1440x1024. Every main tab also has a full-page capture. Final state uses the selected saved SoFi run and Q2 2025 through Q2 2026.

The first comparison found excessive overview height, a P2 spacing issue. Shared unit labels moved to table headers, the period/frequency controls moved onto one row, and the overview was abbreviated to its specified measures. Post-fix captures were compared with the four references. Georgia headings, 14px tabular numbers, the existing sans-serif UI, warm white background, slate text, thin rules and unboxed sections match the selected direction. Figures, gaps and cash-flow signs follow the saved observations. Extra detail rows, unit distinctions, updated subtitles and source actions are required corrections to the generated mockups. No new raster assets were needed; the existing shell and installed icon/chart libraries are reused.

Primary interactions passed: four statement links, peer navigation, shared earlier/latest period controls, reload and browser Back/Forward, invalid parameters, unrelated-query preservation, run switching, source dialog Enter/Escape and focus return, keyboard table scrolling, annual/empty/duplicate/mixed-currency fixtures and old report chapter deep links. Fresh-preview browser error and warning logs were empty. All four mobile views contain table overflow without page overflow. The remaining native 200% zoom check is unverified because the in-app browser ignored zoom shortcuts; 720x512 reflow was tested separately.

No actionable P0/P1/P2 visual findings remain in inspected states. No additional implementation changes are required from this visual comparison.

final result: passed
