# Research product requirements

User direction recorded 27 September 2026. These requirements supersede the presentation-only scope of `Implementations/financials-main-view/implementation.md`. This document specifies the intended product; it is not a claim that the implementation is complete.

## Financial statements

Financials must contain the complete primary financial statements in the issuer's 10-Q and 10-K filings, with both quarterly and annual history. A shortlist of research metrics does not satisfy this requirement.

- Preserve every reported line, issuer-specific label, section heading, subtotal, total, unit, sign, fiscal period and comparative column. Preserve the filing's presentation order and hierarchy. Retain reported zero, missing value and not-applicable as distinct states.
- Cover the income statement, balance sheet and cash-flow statement. Retain equity and comprehensive-income statements when reported as separate primary statements. Keep notes and supporting schedules available through source links; do not pretend all filing disclosures belong in the three primary tables.
- Preserve each filing's identity, accession, publication date, source locator and restatement version. Keep reported values separately from normalized or derived values. Include custom issuer tags; a fixed US-GAAP concept shortlist is insufficient.
- Store annual observations explicitly. Store quarterly and year-to-date flows separately. Derive a standalone quarter only from compatible reported periods, with the formula and both source references. Do not sum balances, turn TTM into annual filings, subtract EPS or average-share values as additive flows, or assume every issuer uses calendar quarters.
- Reconcile subtotals, assets against liabilities plus equity, cash-flow movements and opening/closing cash, and annual against quarterly flows where comparable. Explain rounding, currency, restatement and definition differences.
- Completeness is measured against the actual filing tables and required periods, not against a fixed metric count. A missing filing or incomplete extraction must produce a visible coverage gap and a failed completeness check, never a claim of complete statements.
- Target the latest 20 reported quarters and their corresponding annual filings, subject to listing history and issuer reporting frequency. Do not fabricate quarters for semiannual reporters. Preserve the run's source cutoff.

## KPI Dashboard

Add KPI Dashboard beside Overview, Report and Financials. It shows every KPI selected for monitoring, with its quarterly history and changes quarter over quarter.

- Each KPI has a stable metric key, readable name, definition, unit, reporting basis, source references, period, last-updated time and historical observations.
- Display the latest observation, prior comparable quarter, absolute change and percentage change when meaningful. Percentage metrics use percentage-point changes. Handle a zero prior value, missing quarters and definition changes explicitly.
- Show the relevant bear threshold, base range, bull threshold, thesis breaker and affected model assumption beside the series. Mark analyst thresholds as assumptions.
- Reuse the same KPI definitions and observations in Monitoring and decision. Do not create a separate manually maintained copy.
- Refresh when accepted research data changes and show freshness. "Live" means the latest captured disclosures and research updates, not invented real-time company fundamentals. A refresh must respect the existing job queue, budget, cutoff and review gates.

## Financials > Metrics

Add Metrics alongside the statement tabs. Include net income margin, gross margin, SG&A margin, ROE, ROIC and other ratios appropriate to the company.

- Show the definition, numerator, denominator, units, period convention and linked inputs for every calculated ratio.
- Align units, currencies, reporting basis and periods before calculation. Use beginning/end average balance denominators where the definition requires them. Label annualized quarterly returns explicitly.
- Distinguish company-reported ratios from calculated ratios. Do not substitute net income for operating income or invent tax, invested capital, COGS or SG&A inputs.
- If the business model makes a measure inapplicable, say so and explain briefly. If inputs are absent, show unavailable and identify the missing inputs. Inapplicable and unavailable are different states.

## Report writing and organization

- Remove standalone Financial history and Evidence & limitations chapters from the reader. Financial history belongs in Financials. Keep material uncertainty beside the affected claim and retain source access and research-quality checks.
- Write in the voice of an analyst explaining the company directly. Avoid phrases such as "the artifact shows", "the supplied evidence says", "the saved record contains" and references to internal schemas, packets or storage. Keep citations next to claims, with source details on demand.
- Direct prose must not overstate certainty. Facts, estimates and analyst assumptions remain distinguishable. A missing disclosure that changes a conclusion must remain visible in that analysis.
- Do not put a generic Supporting evidence panel under every section. Place useful numerical exhibits beside the argument they support. Keep additional source material in citation dialogs and the Sources destination.
- Select charts for a specific question: trend, comparison, composition or a demonstrated business mechanism. Do not require a chart in every chapter or insert one simply because a template has a slot. Financial Services and Technology should show relevant segment numbers when comparable data exists.
- Management should include a sourced organization chart with names, roles, effective dates and documented reporting relationships. Do not infer reporting lines from job seniority. Unknown relationships remain unknown.

## Valuation and scenarios

Combine scenarios, valuation, downside and permanent loss into one Valuation chapter. Clearly label Bear, Base and Bull throughout. Cases are scenarios; valuation methods are a separate dimension.

- Start with a side-by-side numerical assumptions table. For each material driver, show the historical reference, unit, forecast year, Bear/Base/Bull values, rationale and affected financial line. Unsupported numbers remain unavailable; narrative adjectives do not count as quantified assumptions.
- Show annual schedules with actual fiscal years and Year 1, Year 2, etc. Link operating drivers to revenue, margins, reinvestment, capital, dilution and per-share outcomes.
- Select multiple valuation methods where economically appropriate and explain their purpose. Do not force three DCF methods on every company. For a mixed lending and technology company, evaluate P/B or P/TBV exits, earnings-based valuation, residual income and cash-flow or segment valuation where the required inputs support them.
- For a discounted-cash-flow method, expose yearly cash flows, discount rate, discount factors, present values, terminal assumptions and value, enterprise/equity bridge, diluted shares and value per share. For residual income or an exit multiple, show that method's actual schedule and formula; do not label it DCF.
- Each method has Bear/Base/Bull assumptions and results. Do not interpolate price targets and present them as an operating model. Keep scenario probabilities, sensitivities, reverse expectations, no-rerating returns and permanent-loss analysis together.
- Calculations must run through the deterministic model and its validation. The report writer selects and explains stored schedules; it does not invent or recompute model outputs in prose.

## Starting research, chat and interaction

- Put a clear Start research action on the home page and asset list, and New research on an existing asset. The flow selects or adds the company, captures the research question, scope, budget and cutoff, then opens the existing durable workflow and explicit human gates.
- Provide an obvious Ask AI action within the selected research. Questions should use that run's report, underlying data and citations, and state when the saved research cannot answer. Preserve conversation context. Keep proposed assumption changes and reruns reviewable; a chat answer must not silently rewrite approved research or bypass a gate.
- Give buttons immediate press/loading feedback and use short, consistent transitions for tabs, drawers and expandable sections. Keep keyboard focus stable, support reduced motion, avoid layout jumps and never delay access to content for animation.

## Baseline gaps

Repository evidence at the time this direction was recorded:

- `history/sec-companyfacts.ts` imports 15 configured metrics, primarily quarterly observations. It is not a filing-statement parser.
- `history/normalizer.ts` filters out annual observations when building the historical record. Adding annual controls alone cannot fix this.
- `handlers/historical-record.ts` asks the normalizer to process accepted claims and supplements them with company facts. Accepted excerpts do not guarantee complete primary tables.
- `decision/contracts.ts` has monitoring thresholds but no required stable metric key, unit or linked quarterly series for each KPI.
- `forecast/contracts.ts` permits narrative scenario drivers and unstructured resulting financial statements. It does not require a numerical assumptions schedule.
- `valuation/contracts.ts` requires annual projections and price targets but does not require method-specific valuation schedules.
- `reporting/visuals.ts` supports process and history figures, but no organization-chart contract.
- `research-report.tsx` renders every stored section and repeats Supporting evidence. Historical saved prose must be regenerated to change its writing voice faithfully.
- `assets/[id]/run/page.tsx` has intake and progress messages, but no conversational research-answer endpoint. Research entry points are difficult to discover from the home and asset-list pages.

## Delivery order and acceptance

1. Extend the research plan, source collection, typed statement extraction and completeness validation. Prove full line coverage against actual stored 10-Q/10-K tables, both period types, fiscal-calendar cases, custom tags, restatements and reconciliations.
2. Extend typed KPI definitions, numeric scenario assumptions, appropriate valuation schedules and sourced management relationships. Test formulas, units, missing data and provenance independently of presentation.
3. Build KPI Dashboard, Financials Metrics, the combined Valuation reader and purposeful exhibits. Remove the two standalone report chapters and repetitive evidence panels without deleting evidence or quality checks.
4. Add clear research entry points, contextual chat and interaction feedback. Test budget and gate boundaries, run isolation, failed requests, keyboard use and reduced motion.
5. Regenerate a selected research run through the normal workflow to populate the new outputs, review it at both human gates, then verify the actual desktop and mobile screens with vision. Do not mark the upgrade complete using mock numbers or screenshots of a sparse legacy report.

Existing approved research remains versioned. A migration or new UI must not silently change its financial values, report hash, approval, export or refresh schedule. Paid regeneration requires the existing paid-run configuration and budget controls.

## Implementation status, 27 September 2026

Implemented filing-table capture and quarterly/annual observations, Financials Metrics, KPI Dashboard, combined Valuation presentation, numerical scenario and valuation contracts, sourced organization visuals, report-writing rules, research entry points, contextual chat and reduced-motion-aware interaction feedback.

The selected SoFi run was backfilled from its stored filings without model calls. Capture produced 115 tables from 17 filings, 2,344 quarterly observations and 1,066 annual observations. Every captured filing has income, balance-sheet and cash-flow tables with no unresolved tagged facts. All 34 supported balance-sheet equations pass. This measures the stored corpus; it is not a claim that every historical filing or every issuer format has been covered. Raw table cells preserve original comparative columns and cumulative cash-flow figures; compatible standalone quarters are separately derived for comparison.

Existing SoFi prose and approved models were preserved. Its 20 monitoring KPIs now have a dashboard; 13 have quarterly series and seven explicitly identify missing histories. New writing style, management organization charts and full method-specific schedules require a new research run through the existing human gates. Paid research is currently disabled, so no paid regeneration or live-provider chat was run.

See `output/research-workspace-upgrade/verification.md` for actual checks and remaining limits. The implementation is available for use; the regenerated real-company report acceptance step remains pending.
