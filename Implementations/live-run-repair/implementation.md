# Live-run fixes and the repair specialist

## Problem and behavior

The paid MercadoLibre run `9af5c76c-c881-4043-ae38-9bb09fae7344` (2026-09-28,
`deepseek-v4.1-flash`, $0.81 spent) stopped twice for reasons unrelated to the
model or the evidence:

1. The deterministic filing parser found almost no primary statements. MELI's
   inline XBRL separates each heading from its table with an empty spacer table and
   blank paragraphs, prefixes headings with "MercadoLibre, Inc. - Interim ...", and
   older filings say "Statement of Cash Flows". The parser recognised SoFi's layout only.
2. FY2023 revenue failed annual-to-quarter reconciliation (13,617 vs 13,131 and
   15,107 vs 14,621). The 2023 10-Qs tag revenue `RevenueFromContractWithCustomer...`;
   later filings recast the same periods as `us-gaap:Revenues`. Restatement tracking
   was per tag, so original and recast quarters were mixed in one series. Taking the
   latest filing per period reconciles exactly (3,186 + 3,585 + 3,927 + 4,409 = 15,107).
3. A report follow-up round reopened `source_discovery`. The rerun searched the web
   from scratch and rebuilt role coverage only from that search, so investor
   relations, founder history and peer documents fetched earlier no longer counted.
   Open source gaps written by `historical_record` in the first pass also failed
   source validation although that stage was about to rerun.
4. The failed stage blocked every later stage, but the run ended with
   "Pending research stages have unsatisfied dependencies", hiding the cause.

Parsing failures will recur for other issuers. A new on-demand **repair** specialist
handles the case the deterministic parser still cannot: it writes a run-scoped
JavaScript module that locates statement tables. The module runs isolated and only
returns table locations; the existing extractor reads every value from tagged XBRL
facts, and the normal completeness and reconciliation gates still decide.

Before: a filing whose headings the parser cannot read stops the run.
After: tags identify the statements; if they cannot, the repair agent's module does,
the result is validated and saved with the run, and only an unresolved repair stops it.

## Scope and invariants

Likely files: `src/lib/research/history/filing-statements.ts`, `filing-store.ts`,
`handlers/historical-record.ts`, new `src/lib/research/repair/`, `team-plan.ts`,
`team.ts`, `handlers/source-discovery.ts`, `sources/corpus.ts`,
`workflow/orchestrator.ts`, `agent-harness/registry.ts`, `providers/mock.ts`, docs.

Invariants: both human gates; export before refresh before completion; typed
`research_artifacts` remain the source of truth; budget accounting through the
model harness; every financial value comes from a tagged filing fact; completeness
and balance reconciliation gates are never weakened. No new dependencies, commits,
paid runs or deployments. Generated code is never written under `src/`, never
imported by the worker, and never given credentials, file, process or network APIs.
The repair specialist cannot be requested by the report agent and receives no
planning brief. The first live run's heading fix predates this plan (see evidence).

## Acceptance criteria

- **AC-1 Heading variants.** A statement heading is found across empty spacer tables
  (alone or inside a text block), blank siblings, an issuer prefix joined by a dash,
  the words Interim/Unaudited/Condensed in any order before "Consolidated" (and
  "Interim" after it), and singular "Statement of". A table with text between heading
  and statement still ends the search, and at most six non-blank siblings are read.
- **AC-2 Tag identification.** When a filing still lacks a statement, a table without
  a recognised heading is classified by non-dimensional tags: balance sheet = Assets,
  Liabilities (or LiabilitiesAndStockholdersEquity) and a stockholders' equity tag;
  cash flow = net cash from operating, investing and financing activities; income
  statement = a revenue tag, NetIncomeLoss and basic EPS. Continuing-operations and
  noncontrolling-interest variants of these tags count. Only the first qualifying table
  in document order is used for each missing statement. A statement already found by
  heading is never replaced, and a note table with only part of a fingerprint, or only
  dimensional facts, is not classified. Each table records `identified_by`: `heading`,
  `xbrl_tags` or `repair`.
- **AC-3 Restatements across tags.** For the same metric key, periodicity, fiscal
  period, unit, segment and basis, the observation from the latest filing is used even
  when its tag differs. `restatement_version` increments only when the value changed.
  Within one filing, the metric's documented concept order breaks ties.
- **AC-4 Follow-up discovery keeps coverage.** When `source_discovery` reruns, documents
  already linked to the run count toward role coverage together with newly fetched
  documents; the same plausibility rules apply to both.
- **AC-5 Stale gaps.** Reopening stages for a team request resolves open source gaps
  owned by the reopened stages with a superseded note. If the rerun records the same
  gap again, it becomes open again rather than being lost.
- **AC-6 Blocked-run cause.** When no pending stage can start because a failed stage
  blocks it, the run becomes `needs_more_work` with a reason naming that stage and its
  failure reason.
- **AC-7 Repair specialist.** `TEAM_ROLES.repair` exists (agent `repair-agent`, stage
  `historical_record`, on demand) with a registry configuration. It is excluded from
  team briefs and from report request roles.
- **AC-8 Trigger.** Repair runs only when capture leaves a readable filing missing a
  primary statement or with unresolved facts. Complete captures and unreadable files
  never call the agent.
- **AC-9 Sandbox.** The module source runs in a separate Node process with an empty
  environment and the permission model (no file or child-process access), inside a
  context without `process`, `require`, `fetch` or host objects, with a time limit and
  output size limit. Throws, timeouts, escapes and invalid output become attempt errors.
- **AC-10 Validation.** The module defines `locateStatements(filings)` and returns
  `{source_document_id, table_index, statement}` entries (statement: balance, income,
  cashflow or equity). Each filing entry carries its id, form, period end, missing
  statements and candidate tables (`table_index`, `preceding_text`, `concepts`,
  `fact_count`, `row_labels`, `identified_as`). Unknown documents or tables, invalid
  statement types, and overrides of a
  heading-identified table are rejected. Located tables are extracted by the existing
  deterministic extractor. Repair succeeds only when every filing then passes coverage
  and balance reconciliation. At most three attempts. The module writer receives
  `filings` (the same entries the module gets) and `previous_attempts`, each with its
  `errors`. A failed model call (budget, authentication, provider) propagates like any
  other agent call; it is not counted as a repair attempt. Unresolved repair keeps the original failure message and adds a summary.
- **AC-11 Persistence.** Each repair saves a `statement_repair` artifact with every
  attempt's module source, SHA-256, errors and outcome, and the repaired documents.
  The saved `financial_statement_set` marks repaired tables `identified_by: repair`.

## Implementation sequence

1. Heading and tag identification, table overrides and candidate summaries in the
   filing extractor (AC-1, AC-2); latest-filing selection (AC-3).
2. Sandbox runner and pure repair loop with an injected module writer (AC-9, AC-10).
3. Registry, team role and mock response; handler integration and artifact (AC-7, AC-8, AC-11).
4. Source coverage union, gap supersession and re-opening, blocked-run cause (AC-4..AC-6).
5. Docs: system, security and adaptive-research notes.

## Verification

Working directory: repository root. Database tests need PostgreSQL with migrations
(`DATABASE_URL` from `.env.local`) and `RUN_DB_INTEGRATION=1`; they skip otherwise.

```bash
npx tsx --test Implementations/live-run-repair/acceptance/*.test.ts
RUN_DB_INTEGRATION=1 npx tsx --test Implementations/live-run-repair/acceptance/*.test.ts Implementations/live-run-repair/verification/*.test.ts
npm run test:unit
npx tsc --noEmit
```

| Criterion | Acceptance | Verification |
|---|---|---|
| AC-1 | statements.test.ts | statements.test.ts |
| AC-2 | statements.test.ts | statements.test.ts |
| AC-3 | statements.test.ts | statements.test.ts |
| AC-4 | orchestration.test.ts (DB) | orchestration.test.ts (DB) |
| AC-5 | orchestration.test.ts (DB) | orchestration.test.ts (DB) |
| AC-6 | orchestration.test.ts (DB) | orchestration.test.ts (DB) |
| AC-7 | repair.test.ts | repair.test.ts |
| AC-8 | repair.test.ts | repair.test.ts |
| AC-9 | repair.test.ts | sandbox.test.ts |
| AC-10 | repair.test.ts | repair.test.ts |
| AC-11 | orchestration.test.ts (DB) | orchestration.test.ts (DB) |

Manual check: rerun the stored MELI filings through capture (all 17 complete, no
balance mismatch, no FY blocking annual/quarter issue). A new paid MELI run needs the
user's explicit approval and is not part of this task.

## Completion evidence

The same agent wrote the plan, both test sets and the implementation, so the
verification set is separately designed but not independently authored. The heading
part of AC-1 was implemented during the live run, before this plan; its acceptance
test still failed at baseline because `identified_by` did not exist.

Baseline (before implementation, 2026-09-28): acceptance 1/16 passing (a text table
ends the heading search), verification 3/19 passing (six-sibling limit; unchanged later
value keeps version 0; a failed stage not blocking an independent stage). Test files that
import the missing repair module failed as a whole at baseline.
Every other failure came from a missing export, the missing `identified_by` field, or the
generic "Pending research stages have unsatisfied dependencies" error, not from setup.

Final results, run from the repository root against the local PostgreSQL on 5432:

- `RUN_DB_INTEGRATION=1 npx tsx --test Implementations/live-run-repair/acceptance/*.test.ts`: 16 pass, 0 fail, 0 skipped.
- `RUN_DB_INTEGRATION=1 npx tsx --test Implementations/live-run-repair/verification/*.test.ts`: 19 pass, 0 fail, 0 skipped.
- `npm run test:unit`: 212 pass, 0 fail, 5 skipped (database tests). `tests/research-team.test.ts`
  now expects five planning roles plus on-demand repair (AC-7).
- `npx tsc --noEmit`: no errors in `src`, `scripts`, `tests` or `Implementations`. Errors remain in the
  untracked `Temp Download/` folder and stale `.next/types`, unrelated to this task.
- Mock SOFI end-to-end (`tests/sofi-research-e2e.test.ts`, mock provider, local database): 5/5.
- Stored MELI filings from run `9af5c76c`: 17/17 filings complete, 34 balance checks, 0 mismatches,
  0 blocking annual-to-quarter issues (previously two FY2023 revenue mismatches).
- Smoke test through the real model harness with the mock provider: `repair-agent` task recorded,
  module located all three statements on the first attempt; temporary rows removed.

Limitations:

- Running the database suites in parallel is flaky. The unchanged `72939cf0` commit failed
  1–2 subtests in each of 3 combined runs; with these changes 1 of 4 combined runs failed one
  subtest. Every suite passes when run alone.
- The Node 22 permission model does not block network sockets; the module context has no
  network API, which is the actual protection (see `docs/security.md`).
- The repair agent has only run with the mock provider. A paid MELI run was not repeated.
- The MELI run `9af5c76c` remains `needs_more_work`; it can be resumed or replaced with a new run.
