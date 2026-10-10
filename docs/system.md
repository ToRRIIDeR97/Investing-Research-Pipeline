# Current system

Research OS creates evidence-backed investment research for an asset. PostgreSQL stores the workflow, sources, artifacts, decisions, and exported report. The Next.js app provides the UI and API; a separate worker runs queued research jobs.

![UML component view: browser UI → unauthenticated API routes → run queue → worker → pipeline runner and orchestrator → agent harness, sources and memory, backtesting and repair, reporting; Postgres, ./storage, child processes and external services](diagrams/component.svg)

| Component | Responsibility | Source |
| --- | --- | --- |
| UI pages | Client components that call the API: command center, asset catalog and detail, run cockpit, report view, review queue | `src/app/**/page.tsx`, `src/components/**` |
| API routes | 49 route files. Reads and writes over research tables, run control (create, enqueue, approve plan, review), upload ingest, chat, export. No authentication | `src/app/api/**`, `src/lib/api/*` |
| Run service and queue | Creates a run (`pending`, version 3) and its 24 stage rows. Enforces one active job per run. Claims with `SKIP LOCKED` under a 5-minute lease, with up to 3 attempts and worker heartbeats | `src/lib/research/run-service.ts`, `run-queue.ts` |
| Research worker | Polls every 5 s. Requeues expired jobs, claims a job, renews the lease and runs the pipeline. When idle, runs backtest tasks | `src/workers/research-worker.ts` |
| Pipeline runner and team | Per-run advisory lock. Scheduling passes over ready stages, team briefs, source and research requests, handlers run in parallel | `src/lib/research/pipeline-runner.ts`, `handlers/**`, `team.ts`, `team-plan.ts`, `sources/collector.ts` |
| Workflow orchestrator | Stage configs (retries, budget, `failureState`), `advanceStage` validation, gates, resume, `completeRun` and `failRun` | `src/lib/workflow/stages.ts`, `orchestrator.ts` |
| Agent harness | Provider selection and model resolution, prompt caching, structured-output parsing and repair, deadlines, telemetry | `src/lib/agent-harness/**`; [local-agent-harness.md](local-agent-harness.md) |
| Sources and research memory | Discovery and safe fetch, structured data fetchers, passages, per-need retrieval, embeddings, evidence graph | `src/lib/research/sources/**`, `src/lib/research/memory/**`, `src/lib/ingestion/**`, `src/lib/market-data/**` |
| Backtesting and repair | Framework backtests for stage 18. Python backtest tasks run model-written code. The statement-repair module runs in a Node sandbox | `src/lib/backtesting/**`, `python/backtesting/**`, `src/lib/research/repair/**` |
| Reporting and export | Adaptive report sections, report snapshot, memo and research-package export | `src/lib/research/reporting/**`, `src/lib/export/**`, `src/lib/valuation/**` |
| Database | 15 schema modules; migrations `0000`–`0006` and `0009` | `src/db/schema/**`, `drizzle/` |

Deeper views are in [architecture.md](architecture.md): deployment, class, the run activity, the state machines and the sequence.


The API creates a version 3 run with its 24 stage rows. A job lets the worker continue the pipeline outside the HTTP request. The research plan and final review stop for a human decision; approval queues another job. Stage contracts validate outputs before the pipeline persists typed artifacts. Export and refresh scheduling finish the run.

The composed research plan links each source role to specific artifacts. Source discovery records coverage only for fetched documents that pass role checks; evidence extraction rejects prior claims when their source is excluded on replay. Coverage records one representative document per role and artifact, while the evidence packet may use other eligible documents from the same run. A fetched page is dated from its HTML date tags; an SEC archive document (`sec.gov/Archives/edgar/data/...`), which has none, takes the filing date from its EDGAR filing index. Undated sources stay usable for analysis but cannot be cited in the report, which drops such citations and records them in the section gaps.

The pipeline runner dispatches independent handlers concurrently; `src/lib/workflow/orchestrator.ts` owns stage transitions, retries, human gates, resume, and completion checks. `src/lib/research/sources/corpus.ts` contains source ingestion and evidence persistence helpers. Quality gates read validated typed artifacts instead of treating completed model tasks as proof of artifact coverage.

Research is assigned to a data collector, four planning specialists and one on-demand repair specialist. Their definitions and stage dependencies live in `src/lib/research/team-plan.ts`.

| Specialist | Responsibility |
| --- | --- |
| Data | Discover and download sources, decide when the corpus is sufficient for the specialists to start, extract evidence, and fetch documents the specialists request. |
| Financials | Read filing statements, normalize periods and units, preserve reported line items, and reconcile financial records. |
| Business | Assess management, operations, history, competition and intangible advantages; develop operating assumptions and bear/base/bull scenarios. |
| Valuation | Build investment-specific valuation schedules using checked financials and operating assumptions. Application code calculates discounting and value bridges. |
| Report | Plan coverage, combine analyses, ask specialists for missing information, and prepare the document for review. |
| Repair (on demand) | When deterministic filing parsing cannot locate primary statements, write a run-scoped module that locates the statement tables. |

After plan approval, source discovery runs first and alone. It collects the base corpus, then the collector (`source-discovery-agent`) reviews coverage against the research plan and either declares the corpus sufficient or names up to six targeted searches, such as a named competitor's annual report. Targeted searches skip seed sites and generic role queries, and a named peer's filing need not mention the researched company. There are at most three review rounds (`MAX_DISCOVERY_ROUNDS`). A required source role that is still uncovered becomes a medium-severity gap owned by `system:source-collector`: the run continues, and the gap names the affected artifacts and the collector's reason. A failed review does not stop the run; the corpus goes forward with its gaps. Each round is saved in a `source_review` artifact.

Only then do the four planning roles (financials, business, valuation and report) prepare their work plans concurrently, with the collector's assessment and document list; the repair specialist has no plan and cannot receive report requests. These are saved as `agent_brief` artifacts and supplied to their later tasks. The stage scheduler starts independent work together: financial normalization and company history can overlap, followed by historical diagnosis and business-process analysis. Forecasts wait for both business analysis and financial diagnosis; valuation waits for operating scenarios. Tasks receive their owner's purpose, work plan, outstanding requests, accepted upstream artifacts and evidence. Planning does not count as completed analysis.

While a financials, business or valuation stage runs, its own analysis call may return an optional `source_requests` list of up to three named searches (`src/lib/research/sources/source-requests.ts`). The call then pauses its stage. Before the next scheduling pass, the runner fetches those documents, reads only them into evidence, refreshes role coverage and reruns the paused stage, which sees what each request found (`src/lib/research/sources/collector.ts`). Other branches and completed stages are not reopened. Each stage has at most two request rounds (`MAX_STAGE_SOURCE_REQUEST_ROUNDS`) and never repeats a query. Requests are saved per stage in `source_requests` artifacts, so a restarted worker resumes queued requests.

```mermaid
flowchart TD
  Plan[Approved research plan] --> Discovery[Source discovery]
  Discovery --> Review{Collector: corpus sufficient?}
  Review -->|Named searches, up to three rounds| Discovery
  Review -->|Sufficient, or gaps recorded| Briefs[Four specialist plans in parallel]
  Briefs --> Data[Ingestion and evidence]
  Data --> Financials[Financial statements and diagnosis]
  Data --> Business[Company history, operations and moat]
  Financials -.->|Document request| Collector[Collector fetches and reads new documents]
  Business -.->|Document request| Collector
  Valuation -.->|Document request| Collector
  Collector -.->|Rerun only the requesting stage| Financials
  Collector -.-> Business
  Collector -.-> Valuation
  Financials --> Scenarios[Operating model and scenarios]
  Business --> Scenarios
  Scenarios --> Valuation[Investment-specific valuation]
  Valuation --> Report[Report synthesis and review]
  Report -->|Missing information| Requests[Persisted specialist requests]
  Requests -->|Missing disclosures| Data
  Requests -->|Financial question| Financials
  Requests -->|Business question| Business
  Requests -->|Calculation question| Valuation
  Report --> Human[Human report approval]
  Human --> Export[Export and refresh schedule]
```

`team.ts` saves report questions as `team_requests` artifacts with an owner, source role, materiality and response. A request reopens its specialist's stages and dependent stages, invalidates cached outputs and stale report approval, supersedes open source gaps written by the reopened stages, and uses normal validation before the report can continue. A rerun records any gap that still applies, and a replayed source discovery counts documents linked by earlier passes toward role coverage, because web search results vary between calls. When a failed stage blocks all remaining stages, the run stops with that stage's name and reason. Specialists can escalate missing evidence to the data collector, which searches the specific question and applies existing document, source-role and cutoff checks. Answers must reference current evidence or artifacts. A material unanswered request becomes a blocked report question and withholds the conclusion.

Automatic investigation is bounded to two report request rounds with one source escalation per round. The saved request state survives restarts. Missing disclosures remain explicit; the system does not claim that every fact can be obtained. A session lock prevents two workers from executing the same run, and each parallel batch finishes before failure or human-gate transitions. Model attempts reserve estimated budget under a database lock. Actual costs are always recorded, including costs above the reservation; subsequent attempts check both spending and outstanding reservations.

Source text reaches the source reader through the research memory (`src/lib/research/memory/`, plan in `Implementations/research-memory`). When a source is stored, it is also split into passages along its headings, tables and pages, with HTML entities decoded, and saved as a `research-memory` parse whose chunks carry the section path. The original raw chunks stay as they were, because valuation reads them verbatim. Documents stored before this are indexed the first time a run retrieves from them. Evidence extraction asks one need per source role present in the run (for example "founder and company origin" for founder-history documents), scoped to the run's eligible documents, and passages whose section titles match rank first. The founder pass reads passages returned for the founder need and, after them, founding statements found in filings and investor material. The founder check counts only claims that affirm the founder or origin; absence statements, claims describing the supplied excerpt, and system inventory claims do not count. A role whose need matches nothing contributes its documents' first passages, except founder history, which records the gap instead of reading a cover page. Fetched web pages are stored as structured text with Markdown headings, so their sections survive.

Embeddings are off by default. With `RESEARCH_EMBEDDING_PROVIDER=openai-compatible` (or `mock` for tests), evidence extraction first gives every passage of the run's eligible documents a vector, stored in `document_embeddings` per embedding model, in requests of at most 64 passages; a misconfigured provider stops the stage with an error that names the variable. Each request is preceded by budget preflight and recorded in `model_call_logs` as the `embedder` agent, and so is the one-text request that embeds each need's query. When the budget refuses a request or the provider fails, that document stops embedding, keeps its keyword index, and records the failure in its parse warnings. Retrieval then fuses keyword and vector rankings with reciprocal rank fusion (k = 60), so a passage can be found by meaning without sharing a query word; it uses only vectors of the configured model. Vectors stay in the jsonb column and are compared in application code, streamed in batches: on a local database, 4,000 passages of 1,536 dimensions rank in about one second. pgvector can replace this comparison later behind the same function.

The evidence graph is written as research proceeds. A source-reader output may list contradictions between two of its claims (`{claim_texts, description, confidence}`); once both claims are stored, `persistEvidence` writes a `contradicts` row in `claim_relationships` with the confidence, the extractor and its prompt version, both claims' source locations and `review_status = 'unreviewed'`. Saving an artifact through `saveReportArtifact` or the artifact repository links it in `research_artifact_claim_links` (`support_type = 'cites'`) to the run's claims named under `evidence_ids`, `evidence_claim_ids`, `supporting_claim_ids` or `claim_ids` at any depth. A retrieval need can name seed claims or artifacts: the passages holding those claims, and the claims one unrejected relationship away, are returned with `matched: "graph"`, break ties among equally relevant passages, and take up to half of the result slots.

Each model request has an output limit (32,768 tokens by default; reasoning counts toward it). When a pass spends the whole limit on reasoning and writes no answer, the next attempt doubles the limit, up to `RESEARCH_MAX_OUTPUT_TOKENS_CEILING` (131,072 by default), and `model_call_logs.request_metadata_json.max_output_tokens` records the limit each attempt used. A 429 that reports a spent account limit (for example OpenCode Go's `GoUsageLimitError`) fails at once as `quota_exceeded` instead of being retried, so the run stops with that reason and can be resumed after the limit resets.

Model requests are laid out for provider prompt caching (`src/lib/agent-harness/cache.ts`, adapted from the Codetonomy foundation harness). An agent's instructions are sent as the system message and its task packet as the user message, with run-wide context (asset, question, evidence) at the start of the packet. A schema repair repeats the original request and appends the repair, so the provider can serve the repeated part from cache. Requests in the same run, model and instructions share an opaque affinity key, sent to OpenCode Go as `x-opencode-session`; the run ID itself is never sent. Anthropic-protocol requests mark the instructions with a cache breakpoint. For Claude models, `src/lib/agent-harness/providers/anthropic-cache.ts` also marks the end of the repeatable task prompt, so retries and repairs read it from cache. TTL and switches are documented in [local-agent-harness](local-agent-harness.md#prompt-caching). Provider-reported cache reads and writes are priced separately and stored in `model_call_logs.response_metadata_json`. Each request also records, under `provider_requests[].cache`, hashes and byte counts comparing it with the previous request in its affinity group, and a reason when the cache was missed. These records never contain prompt content. `RUN_PAID_RESEARCH=1 npm run test:provider-cache-smoke` sends six small requests through the configured provider (DeepSeek V4.1 Flash by default, `RESEARCH_SMOKE_MODEL` to change it) and reports the prompt tokens it served from cache.

The mock acceptance test in `tests/sofi-research-e2e.test.ts` exercises API route handlers, queued worker jobs, both human approvals, export, and refresh scheduling against PostgreSQL. It also checks duplicate enqueue requests, lease recovery, failed-run resume, and model-task cache invalidation. It does not exercise the browser UI or paid providers.

## Filing statements and the repair specialist

Source collection selects filings from the five years before the cutoff: up to five annual reports, twelve 10-Qs and four earnings 8-Ks for domestic issuers (`selectResearchFilings` in `src/lib/research/sources/corpus.ts`). SEC's `filings.recent` block holds only the latest 1,000 filings, which for an issuer with heavy Form 4 traffic (META) covers under two years. `loadSubmissionFilings` then fetches the older submission pages listed in `filings.files` that overlap the window, one at a time with the SEC User-Agent, until the rows reach the window start. It accepts only page names shaped `CIK##########-submissions-###.json`, and a failed page fails the SEC context rather than silently shortening history.

`src/lib/research/history/filing-statements.ts` reads primary statements from inline XBRL filings. Headings identify statements first; when a filing still lacks one, non-dimensional us-gaap tag fingerprints identify it. Each table records whether it came from a heading, tags or repair. Values always come from tagged facts. When an issuer recasts an earlier period, the latest filing's value is used for that metric and period even if the tag changed. A cash-flow statement's opening balance (an instant the day before its earliest period starts) is kept only for a period that other observations already fill, so it can't create an otherwise-empty fiscal-year column. Standalone quarters are derived from cumulative periods only for currency facts. Q4 weighted-average share counts and per-share values stay unavailable, because the 10-K reports only the annual figure and annual minus nine months isn't valid for weighted averages.

The extractor also keeps `segment` tables: facts whose context has exactly one dimension, `us-gaap:StatementBusinessSegmentsAxis`, for revenue and `OperatingIncomeLoss`. They become observations with the same `metric_key` as the consolidated line, `segment` set to the XBRL member (for example `meta:FamilyOfAppsMember`) and `metadata_json.statement = 'segment'`. Segment tables don't count toward statement coverage, and consolidated TTM series ignore any observation with a segment or geography. The operating-model stage passes them to the asset analyst as `reported_segment_history`, separate from the consolidated `recent_reported_history`.

If a readable filing still lacks a primary statement, the historical-record stage calls the repair specialist (`src/lib/research/repair/`). It writes a JavaScript `locateStatements(filings)` module from table summaries (surrounding text, tag names, row labels; no values). The module runs in a sandbox described in [security](security.md) and returns only table locations; the normal extractor then reads the facts. A repair is accepted only when every filing has all three statements, no unresolved facts and reconciling balance sheets. There are at most three attempts, each given the earlier errors. Every attempt's source, SHA-256 and errors are saved in a `statement_repair` artifact; nothing is written to the codebase. An unresolved repair leaves the stage failed with the original message and a summary.

Historical v1 and v2 rows remain in the database. The current runner accepts version 3 runs. Source and market-data cutoffs are stored per run.

New plans enable [adaptive reports](adaptive-research.md). The review stage composes
company-specific sections before reviewing the complete document. Human approval
binds the report and its input snapshot; export reproduces that approved version.

## Invariants

- PostgreSQL owns all research state. Files under `storage/` are referenced from database rows by path and hash.
- Agents propose and validators accept. Model calls have no tool execution. Output passes structured-output parsing, then stage contracts and validators, before artifacts are `validated`.
- Execution goes only through `research_run_jobs`, which are owner-guarded by `lease_owner`, and through the per-run advisory lock in `runResearchPipeline`. The API never runs the pipeline in-process.
- The 24 stages, their retries (0–3), budgets and `failureState` come from `STAGE_CONFIGS`. Dependencies come from `STAGE_DEPENDENCIES`. Human gates sit at stage 4 (research plan) and stage 22 (human review).
- Paid model calls are opt-in, and budget is reserved under a database lock before every attempt.

## Known gaps

Verified in source on 2026-10-05 and tracked as GitHub issues:

- No API authentication ([#8](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/8)). `/advance` bypasses the run lock and the handlers ([#16](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/16)).
- `accepted` artifacts are never written ([#14](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/14)). No writer sets a run to `cancelled` ([#15](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/15)).
- `src/db/index.ts` leaves out the `source-intelligence` and `market-data` schemas ([#17](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/17)).
- Data fetchers in `corpus.ts` and `yahoo.ts` have no timeouts ([#23](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/23)). Docling parsing blocks the event loop ([#24](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/24)).
- Security findings are listed in [security.md](security.md).
