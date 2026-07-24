# MELI v3 Acceptance Rubric

**Status:** Implementation acceptance rubric
**Asset:** MercadoLibre (`MELI`)
**Date:** 2026-07-17

This rubric defines the blocking and non-blocking criteria for a Research OS v3 initiation report on MercadoLibre. Every blocking criterion must be satisfied by evidence-backed artifacts, not generic prose.

---

## 1. Information gathering

### Blocking criteria

- [ ] Founder/company-history sources are present or explicitly waived.
- [ ] Latest SEC filings and earnings materials are ingested.
- [ ] Earnings presentations and transcripts are ingested where available.
- [ ] Proxy/governance material is ingested or explicitly waived.
- [ ] Peer and industry primary sources are ingested or explicitly waived.
- [ ] Relevant government/regulatory and macro data are ingested or explicitly waived.
- [ ] Yahoo-backed point-in-time market history is ingested.
- [ ] Every unresolved source-role gap is explicit and linked to the artifact it blocks.

### Non-blocking criteria

- [ ] Analyst reports or consensus estimates are present as secondary cross-checks only.
- [ ] Media commentary is present but not used as primary evidence.

---

## 2. Composable profile

### Blocking criteria

- [ ] Profile is composed of: `operating_company_core`, `marketplace`, `payments_network`, `lender`, `logistics_network`, `advertising_platform`, `emerging_market_multi_country` overlay.
- [ ] No `assetSlug === "mercado-libre"` special case exists in v3 contract code.
- [ ] Required modules for Commerce, Fintech, Credit, Logistics, and Advertising are present.
- [ ] Forbidden valuation methods are respected.
- [ ] Backtesting is required only if a timing hypothesis artifact is accepted.

---

## 3. Historical foundation

### Blocking criteria

- [ ] Twenty completed fiscal quarters are accounted for, with documented gaps if any.
- [ ] Commerce KPIs: GMV, active buyers, transactions, take rate.
- [ ] Fintech KPIs: TPV, active fintech users, credit originations, credit portfolio.
- [ ] Credit KPIs: provisions, NPL ratio, funding cost, interest income, credit losses.
- [ ] Logistics KPIs: shipped items, fulfillment penetration, unit economics.
- [ ] Advertising KPIs: ad revenue, ad impressions/GMV proxy, ad take rate.
- [ ] Country/geography context: Brazil, Argentina, Mexico, and other disclosed segments.
- [ ] GAAP revenue is separated from "net revenues and financial income".
- [ ] Reported CFO-minus-capex and fintech-adjusted FCF are shown side by side.
- [ ] Annual values reconcile to the sum of quarters or explain the difference.
- [ ] Share-count and balance-sheet history are present.
- [ ] Restatements and definition changes are preserved with both versions.

### Non-blocking criteria

- [ ] Historical percentile and TTM calculations are present.
- [ ] Seasonality by fiscal quarter is analyzed.

---

## 4. Company genesis and strategic identity

### Blocking criteria

- [ ] `company_genesis` artifact exists and is accepted.
- [ ] Founder motivation is supported by a contemporary or retrospective source, or marked `unknown`.
- [ ] Alternative founder motivation interpretations are recorded.
- [ ] Original product, customer, geography, and revenue model are distinguished from the current business.
- [ ] At least one present-day strategic implication is derived from historical evidence.
- [ ] `strategic_history_timeline` artifact exists and is accepted.
- [ ] `strategic_dna` artifact exists and is accepted.

### Non-blocking criteria

- [ ] Early failure or near-failure is included if evidence exists.
- [ ] Initial funding and constraints are described.

---

## 5. Business, customer, and process analysis

### Blocking criteria

- [ ] `segment_model` artifact exists for: Marketplace, Payments, Credit, Logistics, and Advertising.
- [ ] Each segment has customer/end user, revenue model, pricing unit, and cash-conversion mechanics.
- [ ] `customer_decision_map` artifact exists for buyers, sellers, advertisers, and borrowers.
- [ ] `business_process_map` exists with process nodes for each major economic engine.
- [ ] `bottleneck_register` identifies binding constraints (e.g., fulfillment capacity, credit capital, regulatory licenses).
- [ ] `competitive_response_matrix` models active competitors in each segment (Amazon, Shopify, Nu, local banks, etc.).
- [ ] MELI's five major economic engines (Marketplace, Payments, Credit, Logistics, Advertising) are all represented.

### Non-blocking criteria

- [ ] Switching-cost and multi-hominging analysis is present.
- [ ] Regulatory constraints by country are documented.

---

## 6. Moat analysis

### Blocking criteria

- [ ] `moat_assessment` exists and does not infer moat solely from growth or margins.
- [ ] Each claimed moat has customer-consequence, competitor-consequence, financial evidence, and operating evidence.
- [ ] `moat_attack_matrix` tests at least five of the required attacks: price cut, multi-sourcing/vertical integration, substitute, open standard, regulation, supplier capture, distribution shift, new entrant, underinvestment, overinvestment.
- [ ] Each attack has a financial translation and residual moat assessment.
- [ ] `no_moat_counterfactual` exists and changes margins, growth, reinvestment, or valuation inputs.
- [ ] `moat_assessment`, `moat_attack_matrix`, and `no_moat_counterfactual` are all accepted.

### Non-blocking criteria

- [ ] Network-effect metrics are tested for engagement per participant.
- [ ] Brand maintenance spending is documented.

---

## 7. Forecast and valuation

### Blocking criteria

- [ ] `driver_tree` exists: revenue decomposed by buyers × transactions × ATV × take rate for Marketplace; TPV × take rate for Payments; earning assets × yield − funding cost − credit losses − operating expense for Credit; etc.
- [ ] `operating_model` exists with segment reconciliation.
- [ ] `operating_scenario_set` exists with exactly one accepted bear/base/bull set.
- [ ] Scenario probabilities sum to 1.0 (±0.001).
- [ ] Bear/base/bull differ by business-process outcomes, not blanket percentage changes.
- [ ] `top_down_bottom_up_reconciliation` exists and resolves or explains gaps.
- [ ] `reinvestment_model` exists and links capital to growth.
- [ ] `valuation_method_run` exists for at least two valid methods where possible (e.g., DCF, SOTP).
- [ ] `valuation_scenario_set` exists and is independent from operating scenario assumptions.
- [ ] `annual_price_target_path` exists for every fiscal year from first forecast through terminal year.
- [ ] Final-year target equals the scenario's terminal value anchor.
- [ ] `reverse_valuation` translates current price into operational requirements.
- [ ] `expected_return_matrix` includes bear/base/bull returns, probability-weighted return, and maximum plausible permanent loss.
- [ ] MELI uses normalized revenue/FCF definitions, not unadjusted CFO-minus-capex for FCF-derived targets.
- [ ] Segment SOTP assumptions reconcile to consolidated results.
- [ ] Dividends, dilution, buybacks, net debt, and currency are handled explicitly where material.

### Non-blocking criteria

- [ ] Three-year and five-year annual target tables are shown.
- [ ] Sensitivity tables are present for key assumptions.

---

## 8. Decision artifacts

### Blocking criteria

- [ ] `investment_thesis` exists and is synthesized after operating and valuation acceptance.
- [ ] `risk_register` exists with no source-gap-as-risk misclassification.
- [ ] `catalyst_register` exists and distinguishes catalysts from drivers.
- [ ] `thesis_breakers` exist with measurable thresholds and model consequences.
- [ ] `monitoring_dashboard` links every material assumption to a KPI and model input.
- [ ] `confidence_assessment` scores data, history, process, moat, forecast, valuation, and downside.
- [ ] `decision_record` is created by a genuine human reviewer, not an AI or test harness.
- [ ] No placeholder risks, catalysts, or thesis language exists.

### Non-blocking criteria

- [ ] Strong-business/weak-stock case is calculated separately.
- [ ] Revenue-growth/margin-decline case is calculated separately.

---

## 9. Quality gates and workflow

### Blocking criteria

- [ ] All 18 blocking gates in `docs/research-os-v3-spec.md` pass or are explicitly waived by a human.
- [ ] AI review has no unresolved critical findings.
- [ ] Human review is required for run types that require it and is recorded.
- [ ] Optional backtest is `not_applicable` unless a timing hypothesis is accepted.
- [ ] No stage remains in a `running` status after terminal failure.
- [ ] Retry/resume does not duplicate artifacts, scenarios, costs, or targets.

### Non-blocking criteria

- [ ] Stage latency and cost telemetry are recorded.
- [ ] AI reviewer findings are linked to affected artifacts.

---

## 10. Export package

### Blocking criteria

- [ ] Report follows the canonical order defined in `docs/research-artifact-contracts.md`.
- [ ] Every material table is generated from persisted structured data.
- [ ] Annual price targets reconcile with valuation model outputs.
- [ ] Missing or rejected artifacts are visibly marked, not replaced with filler.
- [ ] Generated files include manifest, schema versions, model versions, source coverage, and quality-gate results.
- [ ] Golden MELI package matches this rubric and contains no placeholder text.

### Non-blocking criteria

- [ ] Narrative transitions are polished by the export writer.
- [ ] Superseded artifacts appear in an audit appendix.

---

## 11. Verification commands

```bash
npx tsc --noEmit
npm run test:unit
RUN_DB_INTEGRATION=1 npm run test:integration
npm run build
```

Optional smoke tests:

```bash
RUN_MARKET_DATA_SMOKE=1 npm run test:market-data-smoke
RUN_PROVIDER_SMOKE=1 npm run test:provider-smoke
```

---

## 12. Acceptance decision

A MELI v3 run is accepted when:

1. All automated checks pass.
2. Every blocking criterion in this rubric has evidence in accepted artifacts.
3. The AI reviewer has no unresolved critical findings.
4. A genuine human review decision is recorded.
5. The export package is generated and matches the rubric.

The workflow must stop at human review and never fabricate approval.
