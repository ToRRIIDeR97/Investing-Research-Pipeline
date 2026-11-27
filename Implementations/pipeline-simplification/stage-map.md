# Stage map: cost, outputs and what each stage adds

Measured on 2026-11-26 from three paid SoFi runs on the local database:

- `0c9a2731`: before the lean report change.
- `7c70364e`: lean report format, before the analysis prompt cap and the bank valuation.
- `e79c411c`: branch `lean-combined` (lean report + analysis prompt cap + bank valuation). It was still drafting the report when this was written.

Each cell is model calls / cost in USD. "Code" means the stage makes no model call.

| # | Stage | Kind | Outputs | Read by | 0c9a | 7c70 | e79c | Quality score reads it directly |
|---|---|---|---|---|---|---|---|---|
| 1 | intake | code | run setup | asset_identity | 0 | 0 | 0 | no |
| 2 | asset_identity | code | asset identity | archetype_composition | 0 | 0 | 0 | no |
| 3 | archetype_composition | code | composed archetypes | research_plan | 0 | 0 | 0 | no |
| 4 | research_plan | model, **gate 1** | research_plan, framing | every later stage | 1 / 0.006 | 1 / 0.005 | 1 / 0.006 | no |
| 5 | source_discovery | model | source list, gaps | ingestion | 5 / 0.016 | 9 / 0.034 | 7 / 0.025 | no |
| 6 | source_ingestion | code | documents, passages | evidence_extraction | 0 | 0 | 0 | no |
| 7 | evidence_extraction | model | evidence claims | all analysis | 17 / 0.082 | 15 / 0.079 | 15 / 0.081 | no |
| 8 | historical_record | model + code | historical_record, financial_analytics, statement set | all analysis, report | 9 / 0.057 | 6 / 0.052 | 4 / 0.034 | **yes** (TTM statistics, analytics pack) |
| 9 | company_genesis | model | founder profile, timeline, strategic DNA | business_process_analysis, history chapter | 7 / 0.360 | 6 / 0.197 | 4 / 0.060 | no |
| 10 | historical_diagnosis | code | historical_diagnosis | business_process_analysis, operating_model | 0 | 0 | 0 | no |
| 11 | business_process_analysis | model | segments, customer decisions, process map, bottlenecks, competition, management | moat, report | 4 / 0.364 | 8 / 0.550 | 4 / 0.155 | no |
| 12 | moat_analysis | model | moat assessment, attack matrix, no-moat counterfactual | operating_model, report | 2 / 0.134 | 2 / 0.248 | 2 / 0.056 | no |
| 13 | operating_model | model | driver tree, operating model, top-down/bottom-up check, reinvestment | operating_scenarios | 2 / 0.282 | 1 / 0.164 | 2 / 0.042 | no |
| 14 | operating_scenarios | model | bear/base/bull scenario set | asset_valuation | 2 / 0.066 | 2 / 0.085 | 4 / 0.159 | no |
| 15 | asset_valuation | code (bank) or model | valuation set, reverse valuation, price path | decision, report_facts | 5 / 0.411 | **15 / 1.883** | 3 / 0.048 | via report_facts |
| 16 | indicator_design | code | indicators | strategy_design | 0 | 0 | 0 | no |
| 17 | strategy_design | code | strategies | backtest_execution | 0 | 0 | 0 | no |
| 18 | backtest_execution | code | backtest results | backtest_review | 0 | 0 | 0 | no |
| 19 | backtest_review | code | backtest_review | decision, monitoring chapter | 0 | 0 | 0 | no |
| 20 | decision_synthesis | model | thesis, risks, catalysts, expected returns, breakers, dashboard, decision | report | 4 / 0.251 | **8 / 1.085** | 3 / 0.073 | **yes** (expected_return_matrix) |
| 21 | report_draft | model | report_document | review, human | **42 / 3.348** | 11 / 0.116 | in progress | **yes** (the report text) |
| 22 | ai_reviewer | model | report_review, repair | human | **43 / 4.360** | 22 / 0.331 | in progress | **yes** (depth checks, verdict) |
| 23 | human_review | code, **gate 2** | decision | export | 0 | 0 | 0 | no |
| 24 | export | code | export | refresh_schedule | 0 | 0 | 0 | no |
| 25 | refresh_schedule | code | refresh dates | none | 0 | 0 | 0 | no |

Bold costs were driven by loops, not by the stage's own work: 7c70's valuation and decision ran four times, and 0c9a's report prompts were 100–540K tokens.

## Cost by mechanism

| Mechanism | 0c9a | 7c70 | e79c (so far) |
|---|---|---|---|
| Stage work (one call per task) | 46 / 1.674 | 59 / **3.830**, mostly four valuation and decision passes | 45 / 0.722 |
| Report sections | 73 / **5.455** | 18 / 0.210 | pending |
| Report outline | 4 / 0.832 | 2 / 0.024 | pending |
| Report review | 4 / 0.947 | 8 / 0.178 | pending |
| Specialist question rounds | 3 / 0.471 | 4 / 0.032 | 2 / 0.017 |
| Specialist answers | 13 / 0.359 | 15 / 0.555 | 6 / 0.037 |
| Stage reruns (applied / skipped) | 1 / 0 | 3 / 3 | 1 / 0 |
| Run total | 9.74, failed at review | 4.83, failed at review | 0.78 so far |

## What the map shows

1. **Stage count isn't the cost.** 14 of the 25 stages make no model call. Merging them changes how the pipeline reads, not what it costs.
2. **Cost came from loops and oversized prompts, and both are fixed on `lean-combined`.** e79c's analysis stages cost $0.72, against $3.83 on 7c70, for the same work.
3. **The complexity that failed runs is in the coordination mechanisms.** Those are the specialist question rounds with owner-triggered reruns, the approval prompts, and the review that fails the run instead of reporting to you. Both measured runs ended at `ai_reviewer` with `needs_more_work`, never reaching the human gate.
4. **Most analysis stages reach the quality score only through the report text.** The score reads the historical record and analytics, report_facts, the expected-return table, the report and its review.
