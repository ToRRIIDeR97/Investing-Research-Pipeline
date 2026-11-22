# Research memo: one reading view per run

Status: phase 1 merged (PR 148). Phase 2 built on `claude/research-memo-p2`. Phases 3–4 not started.

- Open decision 1 was taken as proposed: the lead sentences of the conclusion's evidence-bearing paragraphs.
- Open decision 2: the earlier overview stays at `?view=overview` for one release, outside the tab bar.
- Phase 2 deviations:
  - Instead of redirecting old `?view=` values, the four tabs group them as sub-tabs, so every saved link still opens unchanged.
  - The memo's decision panel records Reject, Watchlist and Needs more work. Approval opens the full review form, so open findings are still read and acknowledged there. Mockup: [prototype/workshop/memo-sofi.html](../../prototype/workshop/memo-sofi.html)
(static, SoFi run `0c9a2731`). Review of the current page: see "Evidence" below.

## Problem

The asset report page (`src/app/assets/[id]/view/page.tsx`, 1,006 lines) has twelve tabs, one per stored data
type. None of them answers "should I own this, and why?" from start to finish. Findings from walking the SoFi run:

| # | Symptom | Cause in code |
| --- | --- | --- |
| E1 | "Base" is $1.13 in the header, $9.36 on the Report tab, $3.34 in the Overview table, `9.35520481127344` on the Valuation tab | Four readers of four artifacts: `assetSnapshot` reads `report_facts.cases.pv_per_share` (value today); `valuationSummary` reads `valuation_scenario_set.terminal_anchor_*` (2030 target) and labels it with the case name; the Overview table reads `annual_price_target_path`; `ValuationSection` prints `read_models.valuation_signals` unformatted |
| E2 | "Weighted" is $1.38 (−90%) in the header and $9.48 (−33.6%) on the Report tab | Same split: `report_facts.weighted.pv_per_share` against `valuation_scenario_set.weighted_target` |
| E3 | Exhibit rows render as `bear; 0.3; fcfe; 0.1309; …; 2,030` | Older report standards go through `ExhibitData` in `research-report.tsx`; a `{columns, rows}` object (the `report_facts.cases` shape) falls to the `<dl>` branch and its array rows are joined as text |
| E4 | KPI bars read backwards for lower-is-better metrics (credit losses, share count) | `KpiGauges` (`valuation-visuals.tsx:164`) places points by numeric value, but the footer always prints Bear on the left and Bull on the right |
| E5 | Valuation tab shows snake_case ids, raw floats and an empty chart; Metrics chart labels rows with hash ids and the axis with `-2000000000` | `ValuationSection` and `MetricsSection` render read-model rows directly |
| E6 | Workbench tab is a dead end for this run | `ValuationWorkbench` can't recompute model-built schedules (bank cash flow to equity) |
| E7 | Four status words for one run: "Needs your decision", "needs more work", "Conclusion withheld · Decision: Pending review", "Research incomplete" | Asset cards, `researchBriefAction`, `Verdict` (`statusWord`) and the Overview `incomplete` flag each phrase status independently |
| E8 | "Must be true" mixes thesis conditions with data to-dos ("beta is verified", "Q3 operating income is supplied") | The Overview prints `investment_thesis.must_be_true` as is |
| E9 | Prose is written for the validator: "the packet's bank-capital-constrained cash-flow method", "falsifier", "240,989 thousand" | Model output shown verbatim; no reader-facing writing standard for these fields |

## Goal

One default tab, **Memo**, that reads top to bottom in a fixed order: verdict, why, what would change the view, how
the value was reached, risks, the business now, open questions. Every number on it comes from one server-built object,
so no two places on the page can disagree. Everything else regroups under three tabs: **Model**, **Financials**,
**Audit**.

Non-goals: changing the pipeline, stage contracts or valuation maths in phases 1–3; a dark theme; the Home, Themes and
Reviews pages (except sharing the status vocabulary).

## Design decisions

- **D1. "Value" always means value per share today** (`report_facts.cases.pv_per_share`, weighted from
  `report_facts.weighted.pv_per_share`). A future price is always labelled "End-2030 price target" and appears only in
  the valuation section. The Report tab's verdict bar changes to match.
- **D2. The memo is built on the server.** `buildResearchMemo(artifacts, reportDocument)` in
  `src/lib/research/reporting/research-memo.ts` returns a typed `ResearchMemo`. The report route attaches it as `memo`
  to both the summary and the full response. Reason: the summary payload drops artifact bodies over 64 KB
  (`read-model.ts:SUMMARY_BODY_LIMIT_BYTES`), and `valuation_scenario_set.method_schedules` can exceed that. It reuses
  `assetSnapshot` and the existing `valuationSummary` internals, reading `report_facts` first as those do. It never
  re-derives a figure the code already stored.
- **D3. Four tabs, with redirects for old links.** `?view=` values map as follows: `overview` → `memo`;
  `valuation` and `workbench` → `model`; `kpis` and `metrics` → `financials`; `report`, `evidence`, `sources`,
  `backtests` and `runs` → `audit` (with an anchor). The notebook stays a drawer on every tab; its full page stays
  reachable at `?view=notebook` from the drawer, not from the tab bar.
- **D4. The valuation bridge comes from the stored schedule.** It uses the base case's
  `method_schedules[].terminal_present_value` and `explicit_present_value` ÷ `diluted_shares`. For SoFi that is
  +$5.06 and −$3.93, which sum to `pv_per_share` $1.13. If the three don't reconcile within one cent, the bridge is
  hidden and the case table stays. The "why today's value is below the 2030 target" note appears only when the
  explicit present value is negative.
- **D5. Signals combine `monitoring_dashboard` items with untestable conditions.** Each item becomes a gauge whose
  position is `t = (value − bear) / (bull − bear)`, clamped to 0–1, so bear is always on the left. This also fixes E4 in
  `KpiGauges` for the existing screens. `question_register` entries with status `blocked` appear as "Can't test yet"
  rows. `thesis_breakers` supply the "turns bearish if" text where a breaker's name matches a KPI; otherwise breakers
  are listed under the gauges. "Must be true" is no longer shown on its own.
- **D6. Citations open a source drawer built from `report_document.evidence`** (quote, URL, source title, published
  date). Memo items carry `evidence_ids` from the report paragraphs they come from. This replaces the Evidence and
  Sources tabs as the main way to check a claim; full lists move to Audit.
- **D7. The decision panel posts to the existing `POST /api/research-runs/:id/review`.** It offers the same five
  statuses, plus optional conviction and "what would change your mind" fields. It shows only while the run's
  `human_review` stage is pending. The full form stays on the Reviews page, and the route and its validation are
  unchanged.
- **D8. One status vocabulary.** `runStatusLabel(run, report)` returns one of: Researching, Needs your decision,
  Needs more work, Decided, Failed. It is used by asset cards, the hero and the memo. "Conclusion withheld" becomes the
  memo's confidence line, not a status.
- **D9. Old-standard exhibits render as tables.** In `ExhibitData`, an object with `columns: string[]` and
  `rows: unknown[][]` becomes a `RecordTable` with `plainLabel` headers and the existing number formatting: ratios as
  %, years without separators. This fixes E3 in Audit.

## Open decisions (need the user)

1. **"Why" reasons before the writing contract (phase 4) exists.** Proposed: the first sentence of the conclusion
   chapter's evidence-bearing paragraphs, up to three, each with the paragraph's `evidence_ids`. Alternative: show only
   the conclusion's `implication` and `key_figures` until phase 4. The first reads better; the second can't
   mis-extract.
2. **Keep the old Overview** reachable for one release (`?view=overview-legacy`) or drop it immediately.
3. **Phase 4 (writing contract) is a paid change.** It needs the user's approval and a small live provider test, per
   AGENTS.md.

## Phases

Each phase is one PR off `main` and passes `npm run lint`, `npx tsc --noEmit`, `npm run test:unit` and
`npm run build` locally.

### Phase 1: memo read model and number fixes (no layout change yet)

- Add `src/lib/research/reporting/research-memo.ts` with the `ResearchMemo` type and `buildResearchMemo`:
  - verdict: price, verified flag, value per case, weighted, gap, confidence (from `confidence_assessment.valuation`
    and the count of open questions), status (D8);
  - bridge (D4), signals (D5), risks (top four from `risk_register`), snapshot rows (latest quarter against the same
    quarter a year earlier, from `researchObservations`), open questions (`question_register`), reasons (decision 1),
    `evidence_ids` per item.
- Attach `memo` in `src/app/api/research-runs/[id]/report/route.ts` (summary and full).
- Fix `KpiGauges` orientation (E4).
- Change `Verdict` in `research-report.tsx` to show "Value today" from `report_facts` and label terminal anchors
  "End-2030 price target" (E1, E2).
- Fix the `ExhibitData` `{columns, rows}` branch (E3).
- Tests (`tests/research-memo.test.ts`, fixture `Implementations/research-memo/fixtures/sofi-0c9a2731.json`, exported
  from the stored run; public filing data only):
  - SoFi values: bear −1.79, base 1.13, bull 6.74, weighted 1.38, price 14.28 unverified;
  - the bridge parts sum to `pv_per_share` within 0.01; the bridge is hidden when they don't;
  - gauge `t` puts bear at 0 for both higher-better and lower-better KPIs;
  - a withheld valuation (`valuation_status !== "complete"`) returns a verdict with no numbers;
  - no field holds an unformatted float or a snake_case key (string check over the serialised memo);
  - the exhibit table renders column headers, not `;`-joined rows (extend `tests/report-ui.test.ts`).

Acceptance: the header, the Report verdict bar and the memo object show the same value today for SoFi. KPI bars on
Overview and KPIs read bear-left. The SoFi Report exhibits are tables.

### Phase 2: Memo tab and tab consolidation

- `src/components/memo/`: `MemoVerdict`, `MemoReasons`, `MemoSignals`, `MemoValuation` (bridge + case table + discount
  rate), `MemoRisks`, `MemoSnapshot`, `MemoOpenQuestions`, `SourceDrawer`, `DecisionPanel`. Build them on the existing
  tokens in `globals.css` and `palette.ts` (raw hex colours are banned by test) and the existing `ValueRuler` /
  `RiskHeat` where they fit.
- `page.tsx`: the default tab becomes `memo`. The tab bar becomes Memo · Model · Financials · Audit with the D3
  redirects. `KeyNumbers` shrinks to price, value today, gap and range; KPIs move off the header.
- `runStatusLabel` (D8) is used in `asset-cards.tsx`, `AssetHero` status and the memo.
- Charts draw at their measured width, as in the mockup, so labels never shrink at phone width.

Acceptance (browser, SoFi run, 1440 px and 375 px):
- no horizontal scroll;
- every citation chip opens the drawer with a real quote and a link to the filing;
- old `?view=` links land on the right tab;
- a decision posted from the memo appears on the Reviews page;
- the panel is hidden for a run without a pending review.

### Phase 3: Model, Financials and Audit

- **Model:** the case table, bridge and discount-rate breakdown from the memo object, then `ValuationWorkbench` when
  the run is recomputable. Otherwise one inline line explains why it can't recompute and what to do. Removes
  `ValuationSection`'s raw signal table and empty chart (E5, E6).
- **Financials:** `FinancialStatements` plus `KPIDashboard` and the KPI gauges. The Metrics explorer keeps its table,
  and its chart labels rows by metric name, not hash id (E5).
- **Audit:** the full report (`ResearchReport`), evidence, sources, backtests and run history as sections with a local
  contents list.
- Delete the now-unused section components from `page.tsx`.

Acceptance: no tab shows a snake_case key or an unformatted float (checked by a DOM text scan in a browser check on
SoFi and one adaptive-3 run). Workbench still recomputes on a run that supports it.

### Phase 4 (paid, needs approval): reader-facing writing contract

- Add `key_reasons` (at most three: headline, one-sentence explanation, one figure, `evidence_ids`) to the conclusion
  section contract, and a validator that rejects pipeline terms ("packet", "falsifier", "ev<n>") and raw thousands
  units in memo-facing fields. This replaces the decision 1 extraction.
- Run `npm run eval:score -- --case SOFI` before and after, quote the `evals/scores.csv` rows (it already tracks `reader_leaks`) in the PR, and run
  one small live provider test with the user's approval (AGENTS.md: changes to model requests).

## Documentation to update in the same PRs

- `docs/system.md`: the UI pages row (report view tabs, the memo, the summary payload now carrying `memo`) and the
  key-numbers strip section.
- `docs/architecture.md`: the UI component view and coverage index row (memo components, `research-memo.ts`), and the
  report view sequence if it shows the overview request.
- `docs/diagrams/`: regenerate with `python3 docs/diagrams/_source/make_diagrams.py docs/diagrams` if a generated
  diagram shows the report view.

## Risks

- **Reason extraction (decision 1) can pick a weak sentence.** It's mitigated by showing the source chip and
  replacing it in phase 4.
- **Runs without `report_facts`** (older pipeline output) have no value today. The memo falls back to `assetSnapshot`'s
  existing fallback (`value_today_*`) and says when a figure is a 2030 target.
- **Bookmarked tab URLs.** Covered by the D3 redirects.
- **Summary payload size grows** by the memo object. Measured on SoFi: the memo is 38 KB, mostly the quotes of the
  27 cited sources, against a 5.1 MB summary response.
