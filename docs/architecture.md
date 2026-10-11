# Research OS — master architecture views

This document holds the master UML 2.5.1 views of the **current** system, traced from source on 2026-10-05 (pipeline version 3, 24 stages).

- [system.md](system.md) owns component responsibilities, the specialist team and the research-memory narrative.
- [security.md](security.md) owns trust boundaries.
- [`../architecture.md`](../architecture.md) is the July 2026 target-state proposal and doesn't describe current behavior.

Diagrams are generated. Edit the script, run it, and commit both the script and the SVGs:

```bash
python3 docs/diagrams/_source/make_diagrams.py docs/diagrams
```

Labels in the views: *unverified* means the relationship wasn't proven from source. *assumption* means a runtime fact that wasn't observed. Issue numbers refer to open GitHub issues.

## 1. Structural — Component

![UML component view of Research OS](diagrams/component.svg)

**Drill-down: agent harness** (`src/lib/agent-harness/`):

- `providers/provider.ts` selects the provider from `RESEARCH_MODEL_PROVIDER`:
  - `mock`;
  - `direct-openai-compatible` (the default);
  - `opencode-go-direct`, which uses the Anthropic protocol for qwen and minimax models;
  - `anthropic-direct`, which calls the Anthropic Messages API (`api.anthropic.com`), omits `temperature` for Claude models and caches the instructions and the repeatable task prompt (`anthropic-cache.ts`). For Claude models it also sends the task's output schema as `output_config.format` when `anthropic-schema.ts` can express it, and resends once without it if the API rejects the schema (`RESEARCH_ANTHROPIC_STRUCTURED_OUTPUT=0` turns this off);
  - `local-openai-compatible`.
- `registry.ts` picks the model in this order:
  1. an explicit override;
  2. `RESEARCH_ALL_AGENTS_MODEL`;
  3. `RESEARCH_<AGENT>_MODEL`;
  4. the tier variable (`RESEARCH_CHEAP_MODEL`, `RESEARCH_MID_MODEL`, `RESEARCH_VISION_MODEL`);
  5. the agent's default model.
- `runner.ts` makes up to 4 model attempts with one schema repair, compaction fallback and output-limit doubling.
- `cache.ts` handles prompt-cache layout and the affinity key.
- `output-parser.ts` and `validation.ts` parse and check structured output.

Model calls have no tool execution. [local-agent-harness.md](local-agent-harness.md) covers the configuration.

**Drill-down: stages** (`src/lib/workflow/stages.ts`; dependencies in `src/lib/research/team-plan.ts:41`). Run-type skips are set at creation through `skipForRunTypes`. Stages 16–19 are skipped for `quick_scan`. Stages 1–15, 20 and 24 are skipped for `backtest_only`.

| # | Stage | failureState | Retries | # | Stage | failureState | Retries |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | intake | fail_run | 2 | 13 | operating_model | skip_and_continue | 2 |
| 2 | asset_identity | fail_run | 2 | 14 | operating_scenarios | skip_and_continue | 2 |
| 3 | archetype_composition | fail_run | 2 | 15 | asset_valuation | skip_and_continue | 2 |
| 4 | research_plan **(gate)** | pause_for_human | 2 | 16 | indicator_design | fail_run | 1 |
| 5 | source_discovery | skip_and_continue | 3 | 17 | strategy_design | fail_run | 1 |
| 6 | source_ingestion | skip_and_continue | 3 | 18 | backtest_execution | fail_run | 1 |
| 7 | evidence_extraction | fail_run | 2 | 19 | backtest_review | fail_run | 1 |
| 8 | historical_record | fail_run | 2 | 20 | decision_synthesis | skip_and_continue | 2 |
| 9 | company_genesis | skip_and_continue | 2 | 21 | ai_reviewer | fail_run | 1 |
| 10 | historical_diagnosis | skip_and_continue | 2 | 22 | human_review **(gate)** | pause_for_human | 0 |
| 11 | business_process_analysis | skip_and_continue | 2 | 23 | export | skip_and_continue | 2 |
| 12 | moat_analysis | skip_and_continue | 2 | 24 | refresh_schedule | skip_and_continue | 1 |

Handlers are registered in the `STAGE_HANDLERS` map (`src/lib/research/handlers/index.ts`).

## 2. Structural — Deployment

![UML deployment view: everything on one developer host plus Postgres and external HTTPS services](diagrams/deployment.svg)

There's no hosted deployment and no CI workflow in the repository, so there are no rollback or on-call procedures, and therefore no `docs/operations.md`.

Local entry points:
- `npm run dev`;
- `.claude/launch.json`, which runs `scripts/dev-with-db.cjs` on :3000 or plain `next dev` on :3002.

The port 5433 database used by `npm run test:sofi-v3` is a Windows PostgreSQL service and isn't defined in `docker-compose.yml` ([#18](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/18)).

## 3. Structural — Class

![UML class view of core persisted domain types and multiplicities](diagrams/class.svg)

Schema modules (`src/db/schema/`) and their key tables:

| Module | Key tables |
| --- | --- |
| core | assets, instruments, listings, entities |
| profiles | research_profiles, profile_module_schemas, asset_profile_assignments |
| workflow | runs, stages, tasks, task dependencies, validation results |
| research-run-jobs | jobs, worker heartbeats |
| corpus | source documents, parses, chunks, `document_embeddings`, tables, locations |
| source-intelligence | source_retrieval_attempts, source_role_coverage, source_role_assignments, source_document_metadata |
| evidence | claims, links, `claim_relationships`, gaps |
| metrics | metric_definitions, metric_observations, metric_observation_inputs |
| valuation | valuation_methods, valuation_signals, scenarios |
| research-v2 | analysis_sections, valuation_model_runs, valuation_artifacts, indicator_definitions, indicator_observations, strategy_combinations |
| research-artifacts | artifacts, dependencies, claim links, assumptions |
| thesis | theses, risks, catalysts, review decisions, notebooks, exports |
| ai | staging, model calls, budgets, traces |
| backtesting | backtest_runs, backtest_artifacts |
| market-data | market_price_bars (with Stooq cross-check status), corporate_actions, market_data_fetches, instrument_provider_mappings |
| saved-charts | saved_charts (My charts board definitions; series keys, never values) |

Migrations are `0000`–`0006`, `0009_research_memory_graph`, which adds provenance and review fields plus a uniqueness constraint to `claim_relationships`, `0010_price_history_verification`, which adds the cross-check columns to `market_price_bars`, `0011_saved_charts`, which adds the `saved_charts` table, and `0012_task_budget_reservation`, which adds `research_tasks.budget_reservation_usd` for in-flight budget reservations.

Artifact statuses are listed in `src/lib/research/artifacts/contracts.ts`. Pipeline artifacts end at `validated`. Report artifacts are `superseded` by newer versions. `accepted` is never written ([#14](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/14)).

## 4. Behavioral — Activity

![UML activity view of a research run](diagrams/activity-research-run.svg)

Other critical workflows are described in text:

- **Team collaboration** (source discovery review, specialist briefs, source requests, report requests). See the specialist flow chart in [system.md](system.md).
- **Upload ingest:** multipart upload → SHA-256 → `storage/sources` → `source_documents` → Docling subprocess → parses, chunks and passages.
- **Backtest task:** `POST …/backtests` → `backtest_runs` and a task → worker → `backtest-coder` → `python3 run_backtest.py` → `storage/backtests` and `backtest_artifacts`. Stage 18 uses the TypeScript `executeFrameworkBacktest` path instead.
- **Statement repair:** the historical-record stage asks the repair agent for a `locateStatements` module, runs it in a Node sandbox, and saves a `statement_repair` artifact (up to 3 attempts).

### Asset valuation

![UML activity view of the asset valuation stage](diagrams/activity-valuation.svg)

The model makes the judgment calls: yearly drivers in operating scenarios and, for FCFF assets, a discount rate and terminal assumption per scenario. Code builds the statements, schedules, price path, anchors and reverse valuation (`valuation/engine.ts`). Banks keep model-built equity schedules, which code assembles the same way. Details are in [system.md](system.md#valuation-inputs-the-valuation-engine-and-withheld-valuations).

## 5. Behavioral — State machine

![UML state machines for research_run_jobs, research_runs and research_stages](diagrams/state-machines.svg)

Guards:

- Every job update requires `status = 'running' AND lease_owner = <worker>` (`run-queue.ts`).
- Gate approvals and the re-run decision take `FOR UPDATE` locks (`orchestrator.ts:409`, `466`, `535`, `580`).
- `retryCount` lives in `validation_result_json`.
- `resumeResearchRun` (`orchestrator.ts:959`) restarts at the first failed stage when a run is enqueued.
- An arriving team request reopens nothing (`team.ts:processResearchRequests`). Only an owner's `requires_rerun` answer reopens its stage and dependents (`requestResetPlan`): automatically once per run when at most `RESEARCH_MAX_AUTO_RESET_STAGES` (default 6) analysis stages reopen; otherwise the run and the `ai_reviewer` stage become `waiting_for_human` with `metadata_json.request_reset` until `approveRequestReset` records `rerun` or `skip`. That decision is refused unless the run is paused on the re-run and while the plan or final-review gate waits.

## 6. Interaction — Sequence

![UML sequence view of a research run with report requests, the re-run approval, the plan gate and the lease-expiry path](diagrams/sequence-research-run.svg)

Report requests are answered inside the scheduling loop without resetting stages: system answers from `market_price_history` and the FRED DGS10 document, otherwise the owner's `team_answer` call with research-memory passages, with at most one collector search per request. `requestResetPlan` then leaves the batch answered, reopens stages once automatically, or pauses for `POST …/request-reset`.

## Coverage index

| Subsystem / store / integration / workflow | Views | Source paths / symbols |
| --- | --- | --- |
| UI pages | Component, Sequence | `src/app/**/page.tsx`, `src/components/**` |
| API routes | Component, Sequence, Trust | `src/app/api/**/route.ts`, `src/lib/api/*` |
| Run service and queue | Component, Activity, State, Sequence | `run-service.ts:createResearchRunWithStages`, `run-queue.ts` |
| Research worker | Component, Deployment, Sequence | `src/workers/research-worker.ts` |
| Pipeline runner, team and requests | Component, Activity, State, Sequence | `pipeline-runner.ts:runResearchPipeline`, `team.ts:processResearchRequests`, `systemAnswer`, `requestResetPlan`, `nextRequestBatch`, `team-plan.ts`, `sources/source-requests.ts:queryTermCoverage`, `sources/collector.ts` |
| Workflow orchestrator | Component, Activity, State, Sequence | `orchestrator.ts:advanceStage`, `startReadyStages`, `approveRequestReset`, `completeRun`, `failRun`, `resumeResearchRun` |
| Request re-run decision | State, Sequence, Trust | `src/app/api/research-runs/[id]/request-reset/route.ts`, run page panel in `src/app/assets/[id]/run/page.tsx` |
| Agent harness and prompt caching | Component, Sequence, Trust | `src/lib/agent-harness/**` |
| Research memory and evidence graph | Component, Class | `src/lib/research/memory/**` |
| Sources, ingestion and market data | Component, Deployment, Trust | `src/lib/research/sources/**`, `src/lib/ingestion/**`, `src/lib/market-data/**` |
| Backtesting | Component, Deployment, Trust | `src/lib/backtesting/**`, `python/backtesting/**` |
| Repair specialist sandbox | Component, Deployment, Trust | `src/lib/research/repair/**` |
| Reporting and export | Component | `src/lib/research/reporting/**`, `src/lib/export/**` |
| Valuation engine | Activity | `handlers/asset-valuation.ts`, `valuation/engine.ts`, `handlers/operating-scenarios.ts` |
| Financials view: metric catalogue, statement charts, My charts | Component, Class | `src/components/financial-statements.tsx`, `src/components/financials/**`, `reporting/metric-catalogue.ts`, `reporting/chart-series.ts`, `reporting/saved-charts.ts`, `src/app/api/saved-charts/**` |
| Postgres | Component, Deployment, Class | `src/db/schema/**`, `src/db/schemas.ts`, `drizzle/`, `docker-compose.yml` |
| `./storage` | Component, Deployment, Trust | `storage/` (gitignored) |
| Child processes | Component, Deployment, Trust | `python/**`, `repair/sandbox.ts` |
| LLM and embedding providers | Component, Deployment, Sequence, Trust | `providers/*.ts`, `memory/embeddings.ts` |
| Search and data APIs | Component, Deployment, Trust | `sources/role-discovery.ts`, `sources/corpus.ts`, `market-data/providers/yahoo.ts`, `market-data/providers/stooq.ts` |
| Research run workflow | Activity, State, Sequence | see the rows above |
| Development workflow | [dev-workflow.svg](diagrams/dev-workflow.svg) | [AGENTS.md](../AGENTS.md) |

## Unresolved boundaries

- Research-request and source-request loops are one activity node; the research-request path and its re-run approval have their own frame in the sequence view. The source-request loop has no sequence view.
- Network exposure of the dev server (assumed to bind all interfaces) hasn't been observed at runtime.
