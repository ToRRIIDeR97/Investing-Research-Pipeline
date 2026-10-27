# Research depth and architecture review (2026-10-21)

Status: recommendations only. No code was changed.

Inputs:
- The JD.com initiation the user supplied (ChatGPT plus web search, following the Asset Research Agent Framework);
- The latest paid META run, `4fae0fb1-76b3-4d2b-b386-e48eb9547a75` (2026-10-13);
- Main at `cfcbdbfa`, and the dev database.

Method: 11 reviewers looked at the code and the database, 7 on research depth and 4 on architecture. An independent verifier then checked each finding against the code and the database. A completeness pass added 3 more areas. 125 findings survived: 53 high, 44 medium and 28 low. One was refuted and dropped. The verifier corrected 88 of the 125, and the corrections are folded in. The full text of every finding, with evidence and the verifier's notes, is in [2026-10-21-research-depth-review-findings.md](2026-10-21-research-depth-review-findings.md). Finding IDs below (RQ-SRC-1, AR-SEC-1 and so on) refer to that file.

## 1. Summary

The META report is shallow mainly because of how the pipeline feeds and constrains the models. The model isn't the main limit, and the data wasn't missing.

- **The analysts see a small slice of what was collected.** The run stored about 7.65 MB of filings and pages (about 1.9M tokens). The source reader read 102 passages (170 KB, about 2%). The moat stage got 14 MD&A passages and 106 claims, and every report section got the same 14 passages.
- **Captured numbers never reach the stages that write about them.** `financial_statement_set` holds 20 quarters of Family of Apps and Reality Labs revenue and operating income, Class B share counts, buybacks, receivables and payables. The report says they are "not in the reviewed claims".
- **Almost nothing is computed before the models reason.** No code computes margins, FCF conversion, working-capital days, net cash, buyback yield, segment profit pools or history percentiles. A bug leaves `historical_record.ttm_series` and `statistics` empty in every run.
- **The output schemas leave no room for depth.** The operating model holds 3 numbers per segment for one year. 7.7K output tokens became a 424-byte artifact.
- **One number chosen by the model decides the valuation.** The engine models 3 explicit years, which fall on Meta's capex peak, then applies a NOPAT multiple the model picks freely. Terminal value is 99-129% of EV. Two attempts 7 minutes apart moved the multiple from 18x to 14x, and the base value from $514 to $395.
- **Nothing frames the investment question.** The research plan is a template with no model call. The user's research question is missing from 49 of 79 calls, including every analysis stage.
- **The reviewer checks citations and format, not depth, and its verdict doesn't gate.** Every META run since 2026-10-08 got `conditional_pass` while carrying critical findings.
- **Nothing measures research quality**, so none of this showed up as a regression.

Model choice matters, but it comes after these fixes. All 79 META calls ran on Claude Haiku 5.5. Moving the analysis stages to Opus 5.5 with today's packets would cost 4-7x more. It would still give the model 2% of the corpus and a 3-number schema to fill.

**The JD example can't be reproduced today.** JD is a foreign private issuer, and the 20-F/6-K path fetches no 6-K exhibits and captures no statements. There's no FX or ADS conversion either. So a JD run would compare RMB per ordinary share with a USD per-ADS price.

## 2. The JD example against the META run

| JD trait | META run | Why | Findings |
| --- | --- | --- | --- |
| One central reframing insight ("two engines; will management let core economics accrue?") | None. The executive section opens with Q2 revenue; the judgment is paragraph 13 of 13 | The plan is a template, and the thesis is first written at decision_synthesis | GAP-1-1, GAP-1-2, RQ-BIZ-1, RQ-RPT-4 |
| What the investor owns (voting vs economic control) | "Governance cannot be assessed" | DEF 14A and 13D/G aren't fetched. Ownership risk factors score negative in passage ranking, so the 10-K text on 10-vote Class B shares and the CEO's voting control never surfaces | RQ-SRC-3, RQ-BIZ-3, GAP-2-3 |
| Segment economics (who earns, who burns) | Reality Labs revenue "not in the reviewed claims" | 20 quarters are captured, but the business and moat stages get no history | RQ-ANA-4, RQ-BIZ-2, RQ-SRC-4 |
| 20-quarter statistics, current vs history | A 2,300-row raw observation table, 72% of the report | The TTM/statistics bug, no analytics pack, and writers may not compute tables | RQ-EVAL-3, RQ-ANA-1, RQ-ANA-8 |
| Cash conversion and working-capital days | Absent | Not computed. The only working-capital helper is dead code with wrong denominators | RQ-ANA-5, RQ-ANA-6 |
| Net cash, buybacks, per-share outcomes | The capital-allocation chapter is built from founder_profile and strategic_dna only | Not computed, not delivered | RQ-ANA-7, RQ-BIZ-4 |
| End-demand constraint | No demand data; the only macro series is the US 10-year yield | One FRED series for every asset. The IAB ad-market figures stay free text | RQ-SRC-9, RQ-BIZ-8 |
| Moat attack table with competitor numbers | Peers: an aggregator page for Alphabet, nothing for Pinterest. TikTok absent | Peers are found by web search, not EDGAR, and a SQL NULL filter drops undated peer documents | RQ-SRC-5, GAP-3-2, RQ-BIZ-6, RQ-BIZ-7 |
| Management scored on separate axes | No management assessment | No stage does it | RQ-BIZ-4 |
| DCF as operating case x valuation assumptions | One discount rate and one terminal value per case | Assumptions are welded to cases | RQ-VAL-4 |
| Reverse DCF in FCF-growth terms | "The price implies a 64% margin or 43% growth" | It solves for a uniform 3-year driver under the model's own terminal multiple | RQ-VAL-3 |
| FCF-yield cross-check, no-rerating return | null | Left to the model | RQ-VAL-2 |
| Impairment and tail cases below the bear case | None | Not in any contract | RQ-MOD-4, RQ-VAL-10 |
| Monitoring dashboard with history context | Current levels typed by the model | Code fills only two KPIs, matched by name regex, and one regex misses | RQ-ANA-9 |
| Scorecard, "what would change my mind" | Absent | Not in the outline contract | RQ-RPT-4 |

## 3. Root causes

### 3.1 Inputs are capped far below the context window (RQ-SRC-1, GAP-3-1, GAP-3-2, GAP-3-3)

- The passage budget is clamped to 32-128 and split evenly across 8 roles, 12 each. Filings (4,602 passages) got 12, the same as one aggregator IR page. 26 unused slots weren't reassigned.
- `.env.local` sets source-reader batches to 4 chunks / 16 KB. The code default is 8 / 36 KB.
- At most 150 claims are accepted. Packets are cut to 120 claims with 280-character quotes. `filing_passages` is 24 KB from the newest filing of each form, and only 4 task types get it.
- `loadReportInputs` filters on `sd.published_at <= cutoff` (`src/lib/research/reporting/store.ts:34`). A NULL date fails that test, so every claim from an undated document is dropped from every specialist and report packet: the IAB/PwC report, the Snap 10-K PDF and the transcript page. With `IS NULL OR`, the replay returns 149 claims instead of 106.
- The same run sent the reviewer 481K-token prompts, so the context window isn't the limit.

The report called eight things "not available": founder voting control, Class B shares, peer pricing, the US ad-market size, Reality Labs revenue history, $278.99bn of leases not yet commenced, the November 2025 $30bn notes, and receivables. All eight are in the run's own chunks, claims or history.

### 3.2 Computed facts don't exist or don't arrive (RQ-ANA-1..9, RQ-EVAL-3, RQ-RPT-2, RQ-RPT-3)

- `historical-record.ts` passes plan metric families (`income_statement`, `cash_flow` and so on) as metric keys, so the TTM series and statistics are always empty.
- `metric-catalogue.ts` has 39 metrics, including TTM and ROIC, but it only feeds the UI.
- `historical_diagnosis` runs on the raw levels of companyfacts keys, never on margins, FCF or segments, and labels every metric "unexplained".
- Report inputs leave out `financial_statement_set`, while the doctrine tells writers the statements must be checked. Every report agent therefore concludes the statements were never parsed. They were: 136 tables and 2,488 observations.
- The models end up doing arithmetic. The META prose has 22 hand-made "(derived: ...)" calculations, and about 24% of its larger figures aren't in the cited inputs.

### 3.3 Output contracts cap depth (RQ-MOD-3, RQ-MOD-4, RQ-MOD-7, AR-REL-2)

- On anthropic-direct every schema object is closed (`additionalProperties: false`). The operating-model prompt asks for price x volume, a margin bridge and ROIIC, and the schema has nowhere to put them.
- `reinvestment_model` is `{capex_forecast:[137.5bn], working_capital_forecast:[]}`, and `confidence_assessment` is 154 bytes. Both pass as "validated".
- The valuation analyst objected that terminal capex was 4x D&A and explicit FCF negative, but objections go only into display-only `source_notes`.
- The model writes segment assumptions, and code ignores them: statements are built from consolidated drivers only.
- `decision_synthesis` returns 8 artifacts in one call, and its first attempt hits the 32,768-token output cap.
- About 61% of output tokens are hidden thinking that isn't stored.

### 3.4 The valuation engine (RQ-VAL-1..11, RQ-EVAL-6)

- The default 3-year horizon (`RESEARCH_FORECAST_YEARS`) falls on the capex peak, so explicit FCFF is negative.
- Terminal value is a NOPAT multiple with only a non-negative check. A Gordon value on raw FCFF would capitalise peak capex forever, so the model always picks the multiple.
- D&A is fixed at 9% of revenue while capex runs to 54%.
- The bridge subtracts operating leases, which are already in operating income under US GAAP. It ignores non-operating investments, minority interests and restricted cash.
- Discounting uses whole years from the valuation date, and the full first fiscal year is counted against a mid-year bridge.
- There's no FX or ADS ratio.
- The required lenses (dcf, multiple, cash_flow) pass with three identical placeholder rows: 528.69, "inconclusive".

The verifier recomputed META with a fade to the terminal year plus the timing and bridge fixes. The base value moves from $395 to about $504-626. A ±1pt discount-rate x terminal-growth grid then spans $445-748. "Expensive at a 9% cost of capital" may survive, but the -49% downside doesn't.

### 3.5 No framing, and the plan gate can't steer (GAP-1-1..7, RQ-BIZ-5)

- `buildResearchPlan` is a pure function. Its content is the asset name, the research question and one generic sentence.
- "Request plan changes" writes notes to metadata that nothing reads, and the run sits at the gate unchanged.
- Archetypes can't be set from the UI. Every META, MELI and Exor run was composed as `operating_company_core`, so the advertising_platform, marketplace, logistics_network and holding_company modules never ran.
- The horizon is a global env var.

### 3.6 Review doesn't push back (RQ-RPT-4..8, RQ-EVAL-2, RQ-EVAL-4)

- The reviewer's rules cover entailment, unsupported numbers, contradictions and format. None checks depth, and `quality_score` has no anchors.
- The prompt says "A transparently qualified report may receive conditional_pass", and compose counts conditional_pass as a pass. Round 0's 27 findings (1 critical, 13 high) were never repaired.
- Both team-request rounds are used up before drafting, so review findings can't fetch evidence. A human "needs more work" only rewrites prose, and the review page doesn't show the findings.
- The coverage table is the planner's forecast, copied unchanged. It says no-rerating downside is quantified while the field is null.
- Process narration reaches the reader ("an earlier draft", "the model's note"). Code itself inserts "Citations removed: <uuids>" into reader-facing gaps.

### 3.7 Nothing is measured (RQ-EVAL-1, RQ-EVAL-7, RQ-EVAL-9)

- There is no eval set and no score history. The mock reviewer always returns pass/0.95.
- 14 PRs merged after the last paid run with no before/after comparison.
- Repeated META runs gave weighted targets of 553, then withheld, then 618, then 510, all within five days.
- The human gate stores a status and free text only, so "too shallow" never becomes a number.

### 3.8 Model and effort settings (RQ-MOD-1, RQ-MOD-2, RQ-MOD-6, AR-PERF-2, AR-PERF-5)

- `RESEARCH_ALL_AGENTS_MODEL` overrides the per-agent variables. Models are chosen per agent, not per task, and asset-analyst serves both 410-token team answers and decision synthesis.
- No `output_config.effort` is sent, so Haiku runs at its default.
- The cost ledger ignores Haiku 5.5's 5x rate above 100K tokens, and 74% of META's input tokens were in such prompts. The logged cost is $1.05; the real cost was about $3.74. The ledger also has no Opus or Sonnet prices and would record them at $0.50/$1.00 per MTok.

## 4. Recommendations, in order

Fix inputs and computation before paying for a bigger model. Each phase ships and tests on its own with the mock provider. Only Phase 4 changes model requests, so only Phase 4 needs the paid live test that AGENTS.md requires.

### Phase 0. Correctness fixes (days, no model-request change)

| # | Change | Findings | Size |
| --- | --- | --- | --- |
| 1 | Keep undated documents: `published_at IS NULL OR published_at <= cutoff`, except in point-in-time runs | GAP-3-2 | S |
| 2 | Fix the TTM/statistics bug: build TTM keys from observed flow keys, and add an invariant | RQ-EVAL-3, RQ-ANA-2 | S |
| 3 | Fetch DEF 14A and 13D/G for domestic filers, add a governance retrieval need, and stop penalising ownership, control and competition risk passages | RQ-SRC-3, GAP-2-3, RQ-BIZ-3, RQ-BIZ-6 | S |
| 4 | Derive the 10-Q count from the 20-quarter window (about 16, not 12) | RQ-SRC-6 | S |
| 5 | Split the passage budget by the square root of each role's size and reassign unused slots. Remove the 4 chunk / 16 KB batch override | RQ-SRC-1 | S |
| 6 | Team requests: fall back to the issuer's own documents, and search on a short document field instead of the question prose | RQ-SRC-8, GAP-3-3 | S |
| 7 | Cost ledger: Haiku's >100K tier, Opus and Sonnet prices, and a warning for unknown `claude-*` models | RQ-MOD-6, AR-PERF-2 | S |
| 8 | Report tables: reject paths that aren't flat rows, render FCFF schedules as rows, cap row counts | RQ-RPT-1, AR-REL-4 | S-M |
| 9 | Wire up "Request plan changes", or hide it until it works | GAP-1-3 | S |

### Phase 1. Deterministic analytics pack

Write one pure module, `src/lib/research/history/analytics.ts`, that saves a `financial_analytics` artifact after `historical_record` and reuses MetricBook. It holds:
- 20-quarter statistics (median, min, max, latest, percentile) for revenue growth, gross, operating and FCF margin, capex/revenue and SBC/revenue;
- Segments: revenue, operating income, margin, TTM, share of group operating income, cumulative losses and an earner/burner role;
- Cash conversion: FCF, FCF/NI, OCF/NI, capex/D&A, a growth-capex proxy and incremental ROIC;
- Working capital: DSO, DIO, DPO, cash-conversion cycle and NWC/revenue;
- A capital-allocation ledger: net cash, period-end shares by class, buybacks and dividends as a % of FCF, the SBC offset, and yields.

Then get it to the stages that need it:
- A digest of about 8-12 KB goes in the shared, cached prefix for genesis, business, moat, the operating model, scenarios, valuation and decision.
- A `report_facts` block gives writers per-case PV, weighted PV, terminal-value share, FCF yield, implied multiple and no-rerating return, so writers cite numbers instead of computing them.
- A small `financial_statement_summary` stops reports claiming the statements weren't parsed.
- The pack replaces raw `historical_record` in report packets.

Related changes: make business_process_analysis depend on historical_diagnosis, fill monitoring KPI levels from the pack by metric_key, rebuild historical_diagnosis on the pack, and delete the dead helpers.

Findings: RQ-ANA-1, RQ-ANA-3..10, RQ-SRC-4, RQ-BIZ-2, RQ-RPT-2, RQ-RPT-3, GAP-3-4, GAP-3-8, AR-PERF-3, RQ-MOD-8. Side effect: report-stage prompts fall under Haiku's 100K price tier, which cuts the cost of the current setup.

### Phase 2. Valuation engine v2

- **Horizon:** a 5-year default, with a per-run `forecast_years` in [3, 10] set at the plan gate.
- **Terminal value:** a value-driver terminal with code-generated fade years: TV = NOPAT x (1 - g/RONIC) / (r - g). RONIC defaults from history and from the explicit period's incremental ROIC, and the model may depart from that only with a stored rationale. Keep the multiple as a cross-check.
- **Capex and D&A:** D&A from a PP&E roll-forward, maintenance vs growth capex, and invested capital and ROIC per year.
- **Matrix:** valuation sets {conservative, base, aggressive} separate from the operating cases. That gives a 3x3 grid and an r x g grid.
- **Reverse valuation:** solve for the implied terminal multiple, the implied perpetual growth and the implied 10-year FCF growth.
- **Cross-checks in code:** current and own-history EV/NOPAT, P/FCF and FCF yield; a no-rerating return per case; real values for the required lenses.
- **Sanity flags:** terminal value above 0.85 of EV, value/price outside 0.6-1.6, a multiple outside its own history. Each flag comes with a per-share attribution of the gap.
- **Fixes:** timing (year fractions and a year-to-date stub) and the bridge (operating leases, investments, minority interests, restricted cash).
- **FX and ADS ratio:** withhold the valuation when either is missing.
- **Segment SOTP cross-check:** value loss-making segments as an explicit loss stream, both persisting and fading.
- **What-if:** a read-only `valuation-whatif.ts` script for rate, terminal or horizon changes without a model call.

Findings: RQ-VAL-1..11, RQ-MOD-4, RQ-EVAL-6, AR-QOL-4, GAP-1-5.

### Phase 3. Framing and analyst behaviour

- **Framing call at the plan stage, editable at the gate.** One mid-tier call; on Haiku it costs about what a team-brief call does, under a cent. It returns the central question, what the investor owns, the engines and how each is valued, key questions with falsifiers, named peers, priority documents, the horizon and the archetypes. "Request changes" re-drafts it.
- **Inject the approved framing into every packet**, inside the cached prefix in `callResearchAgent`, including evidence extraction.
- **Make the outline answer each framing question.** Insert missing ones as blocked.
- **Give the prompts' asks typed homes:** per-year reinvestment rows, segment price and volume drivers, an `analysis_memo` with figure paths, and confidence by framework area.
- **Management assessment** on separate axes. **Moat classification** with 0-5 scores and citations; "strong" requires history and peer evidence.
- **Peers via EDGAR:** resolve names against `company_tickers.json`, fetch companyfacts and build a peer table.
- **Demand backdrop by country:** FRED for the US, World Bank for others, DEXCHUS for China.
- **Archetypes from SIC code and industry**, not a fixed default.
- **IR sources:** seed from the issuer's own earnings exhibits, and fetch every 8-K 2.02 release in the window.
- **Doctrine clean-up:** remove the contradiction ("write the judgment last" vs "the first section summarises the judgment") and the rules validators already enforce. Add 4-5 behaviour rules instead.

Findings: GAP-1-1..7, RQ-BIZ-1, RQ-BIZ-3..8, RQ-MOD-3, RQ-MOD-5, RQ-MOD-7, RQ-SRC-5, RQ-SRC-7, RQ-SRC-9, RQ-SRC-10.

### Phase 4. Model tiering and effort

- Per-task tiers: `callResearchAgent` reads `RESEARCH_<TIER>_MODEL` (premium, mid or cheap), which beats `RESEARCH_ALL_AGENTS_MODEL`. Add an optional `RESEARCH_STAGE_<KEY>_MODEL`.
- Send `output_config.effort`: high for premium, medium for mid, low for cheap. Opus 5.5 defaults to medium, so set it explicitly.
- Output caps of 65,536 tokens for decision_synthesis and operating_scenarios. Size the premium timeout from measured latency.
- Split decision_synthesis: a premium call for the thesis and memo, a cheap call for the registers.
- Record the effective config on each run (AR-QOL-3).
- This changes model requests, so it needs the small paid live test before merge.

Cost per META-sized run, at list prices, from the META token logs:

| Setup | Estimated cost |
| --- | --- |
| Today: Haiku 5.5 everywhere (logged as $1.05) | about $3.74 |
| Opus 5.5 at high effort on the 6 analysis stages, Sonnet 5.5 on outline and reviewer, Haiku for the rest, today's packets (reviewer estimate) | about $13-18 |
| As above, plus report sections on Sonnet 5.5, today's packets | about $22-26 |
| After Phase 1 trimming, with 3.5x more evidence read: Opus for analysis, Sonnet for report and review | about $12 (rough) |

Assumptions: logged input tokens include cache reads and writes. Opus and Sonnet cache reads are $0.20/MTok. The $22-26 range doubles Opus output at the top end to allow for high effort. Trimmed report sections are about 60K tokens each.

Input tokens are about two-thirds of a tiered run's cost, and the report stage uses the most. Trim first: the deeper run then costs about what an untrimmed model upgrade would cost for a shallower one.

Pricing reference (claude-api skill, 2026-10): Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, and Haiku 5.5 $0.10/$0.50 per MTok up to 100K-token prompts, $0.50/$2.50 above. Use adaptive thinking with `output_config.effort`; `budget_tokens` returns a 400 on these models.

### Phase 5. Review that gates on depth, and measurement

- **Depth checks:** add `depth_checks` to the reviewer contract, keyed to framework sections 8 and 11 and to the JD traits. Code derives the verdict. If the stored data supports a decision-critical check and the report lacks it ("missing"), the verdict is needs_more_work. "data_unavailable" allows at most conditional_pass.
- **Effective verdict:** an unresolved critical finding, or a high calculation finding that code confirms, blocks `approved_for_position`.
- **Review findings can send work back:** reserve one team-request round for after the review, add an analysis_rework category mapped to the owning stage, and show findings on the human review page.
- **Coverage:** the conclusion writer returns the final coverage, checked against `report_facts`.
- **Substance checks** also cover gaps, captions and tables, with narrow leak patterns. Dropped citations go to metadata, not to the reader.
- **Report opening:** classification, decisive insight, value table, what you own, scorecard, what would change my mind, and at most 3 decision-critical gaps. Everything else goes to an appendix.
- **Eval harness:**
  - `evals/eval-set.json` covers SOFI, DECK, MELI and META, plus JD as a coverage stress case.
  - `npm run eval:score` is SELECT-only with no model calls. It runs the code checks and `depth-probes.ts`, which flags facts reported as unavailable that are actually in the database.
  - An opt-in LLM judge (`RUN_PAID_EVAL=1`) scores each rubric dimension on a higher tier. The rubric puts JD at 3 of 4, so the scale doesn't stop at JD.
  - Human 0-4 ratings at the review gate.
  - Stability across repeated runs.

Findings: RQ-RPT-4..8, RQ-EVAL-1..9, GAP-3-7.

### Phase 6. Foreign private issuers (needed for JD)

- Fetch 6-K exhibits, and pick 6-Ks by exhibit content instead of reportDate.
- Accept 20-F and 40-F in statement capture and companyfacts, and use the dominant ISO currency instead of assuming USD.
- Fail completeness with fewer than 12 covered quarters.
- Extract quarterly tables from 6-K Ex-99.1 press releases, which have no inline XBRL.
- Add Phase 2's FX and ADS work.

Findings: RQ-SRC-2, RQ-VAL-6. Effort is large. If JD-type names are a priority, do this before Phase 3.

### Phase 7. Research that builds across runs

- **Lineage:** `prior_run_id` in run metadata. Carry forward documents, blocked questions, unavailable requests, the decision and the valuation as a ~10 KB `prior_research` block.
- **Change log:** a `version_change_log` artifact that diffs the valuation and drivers against the prior run (framework section 14).
- **Monitoring:** `monitor-check.ts` captures statements from any new 10-Q or 10-K on EDGAR and scores the dashboard items. Show "refresh due" in the UI, and never start paid runs automatically.
- **Reuse:** once a higher tier is in use, reuse genesis and unchanged claims.
- **Refresh run types:** make them real, or remove them.

Findings: GAP-2-1..7.

### Later, and only if the probes still miss: read-only lookup tools

Two run-scoped tools, `search_passages` and `get_series`, would let analysts look things up instead of relying on fixed packets. They need:
- An explicit change to the AGENTS.md invariant;
- Request-side tool support, a multi-turn loop, a task-key fingerprint and telemetry;
- A read-only retrieval mode, because `retrievePassages` currently writes index rows.

Findings: GAP-3-1, GAP-3-5, GAP-3-6.

## 5. Architecture

### Security

| ID | Severity | Issue | Fix |
| --- | --- | --- | --- |
| AR-SEC-1 | medium | Store export and import follow symlinks, and import writes anywhere under the project root. Sandboxed backtest code can plant a symlink so the next `store:sync` pushes `~/.ssh` or `.env.local` to GitHub. Anyone who can push to the research-store branch can write files, and so run code, on every machine that syncs | Skip symlinks in `listFiles`; check realpath containment on export and import; import only under `storage/` |
| AR-SEC-3 | medium | Shards have no size cap. The document_chunks shards are at 67-69 MB, and GitHub rejects files over 100 MB, likely within 5-20 runs | Use 256 shards (two hex characters); fail locally above `MAX_FILE_BYTES` |
| AR-SEC-2 | low | Sync pushes the whole database, including model transcripts and task packets, to a branch of the code repository | Optional separate private `RESEARCH_STORE_REMOTE`, a visibility check and a secret scan before push |
| AR-SEC-4 | low | Deferred #8: `RESEARCH_OS_API_TOKEN` is unset, and the gates record whatever approver the request body names | Ignore identity fields, record `api:token` or `api:unauthenticated`, warn at startup |
| AR-SEC-5 | low | Backtest CSV rows are exported unescaped (the S7 fix is incomplete) | Escape every cell |
| AR-SEC-6 | low | The SEC User-Agent is an example.com placeholder, hard-coded in 14 places. SEC may block it, which would break the SEC history | `RESEARCH_SEC_USER_AGENT` |
| AR-SEC-7 | low | Unused dependencies (marked, nanoid, date-fns; pg in production dependencies), a dead `TAVILY_API_KEY`, and untracked folders that aren't ignored | Remove; add `Temp Download/`, `handover files/` and `*.bak` to .gitignore |

These held up under testing. The SSRF guard checks every hop. The backtest sandbox denies the protected paths, including firmlink aliases. Provider fetches use `redirect:"error"`, and `npm audit --omit=dev` reports 0 vulnerabilities.

### Performance

- **AR-PERF-1 (high).** 41% of the paid run's wall clock was the laptop suspended: deadline timers fired 5-15 minutes late. Run the worker under `caffeinate -i -w`. Detect suspension from timer lateness and report it as its own transient reason, not counted as an attempt (also AR-REL-6).
- **AR-PERF-3 (high).** A 455 KB `historical_record` goes into every report prompt. Phase 1 fixes this.
- **AR-PERF-4 (medium).** The asset view downloads 16 MB on load and again every 60 s, whatever the run status. Drop `markdown` from the read model, lazy-load statements and poll only while a run is active. Related: `report_document` is 5.2 MB per version; store artifact references instead (RQ-RPT-9).
- **AR-PERF-5, AR-PERF-6, AR-PERF-7.** Effort control, the output cap, raising concurrency from 3 to 6, and removing unused timeout settings.
- **AR-PERF-8 (medium).** Store export peaks at 3.6 GB RAM and writes 1.08 GB of JSONL. Stream rows with a cursor and shard by month.
- **AR-PERF-9 (low).** 60K stale v1 passages remain indexed, and a 63 MB full-text index serves one route.

### Reliability and data model

- **AR-REL-1 (high).** `skip_and_continue` isn't applied. A skipped stage is stored as failed and blocks its dependents, and errors thrown at a gate bypass the policy. So one missing founder-history document stops valuation. Step 1: record the founder gap as a source gap. Step 2: write `skipped` with a degraded flag.
- **AR-REL-2 (high).** "Validated" means zod-valid, not complete. A single-year model, an empty working-capital forecast and a blocked reconciliation all pass. Add completeness validators.
- **AR-REL-3 (medium).** There's no operating-company end-to-end test, and export has never run on a real operating-company run. Only one run has ever completed (2026-08-06).
- **AR-REL-5 (low).** The dev database has drifted: two migrations from the abandoned v4 branch, and a pipeline_version default of 4. `test-db.cjs` should check the migration journal.
- **AR-REL-7 (low).** Paid-run scripts bypass the job queue, so those runs have no lease, can't be cancelled and aren't reconciled.
- **AR-REL-9 (low), RQ-RPT-10.** Legacy mirror tables are still written, and the export reads them instead of the typed artifacts, so the memo can contradict the approved report.

### Quality of life

- **AR-QOL-1 (high).** Lint and tsc fail in the main checkout because of `Temp Download/` (all 29,122 tsc errors are there, none in project code) and `.cache/`. Exclude both in tsconfig and eslint. Whether to move the folders is your call (also AR-REL-8).
- **AR-QOL-2 (high).** The UI has no Resume or "re-run from this stage", and the resume CLI's provider setting doesn't control the worker.
- **AR-QOL-3 (high).** Provider, models, horizon and caps come from the worker's environment and are never recorded. Record an `effective_config` on each run.
- **AR-QOL-4 (high).** Valuation what-if; Phase 2 covers it.
- **AR-QOL-5 (low).** UI runs have no budget cap, because an empty field is stored as NULL. Default to $10, add a cost and time table by stage, and show a p50/p90 estimate.
- **AR-QOL-6 (low).** Gates are silent. Send a macOS notification from the worker, list the plan gate in the review queue and add detail to queue rows.
- **AR-QOL-7 (medium).** Add a page that compares two runs.
- **AR-QOL-8 (medium).** Pipeline failures are labelled `needs_more_work`, and the brief opens on the newest run even when it failed.
- **AR-QOL-9, AR-QOL-10, AR-QOL-11 (low).**
  - The dev startup config is broken.
  - 24 API routes and the legacy export code are never called.
  - Repo hygiene: tracked data files, 24 merged branches, an 882 MB stale worktree and untracked handover history.

## 6. Suggested sequence

1. Phase 0, plus AR-QOL-1 and AR-SEC-1/3, in one or two small PRs. Then run one mock run and the depth probes on the META run to set a baseline.
2. Phase 1, then Phase 2, which uses Phase 1's ROIC and own-history multiples.
3. Phase 5's eval harness alongside Phase 1, so Phase 1 gets measured.
4. Phase 3, then Phase 4 with the paid live test.
5. Phase 6 when JD-type issuers matter, then Phase 7.

Before/after check for each phase: `npm run eval:score` on the baseline META run (free), the 8 META depth probes, and one approved paid run for model changes.

## 7. Limits of this review

- The numbers come from one run (META `4fae0fb1`), with 3 earlier META runs for stability. They may not carry over to banks (SOFI) or to MELI.
- No paid run was made.
- No JD run exists. The foreign-issuer findings come from the code and a local probe with a CNY/20-F companyfacts fixture.
- Every finding cites `file:line` on `cfcbdbfa`, SQL on the dev database, or both. The code may have moved since.
