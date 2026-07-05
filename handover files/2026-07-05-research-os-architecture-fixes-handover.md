# Research OS Handover - Architecture Fixes

**Date tag:** 2026-07-05
**Last updated:** 2026-07-05
**Scope:** Investing Research Pipeline / Research OS architecture implementation
**Status:** current

## Executive Summary

This handover captures the implementation work done after reviewing the application against `architecture.md`. The main goal was to fix concrete runtime/schema mismatches and close several near-term architecture gaps around evidence links, workflow stage retries, source ingestion parsing, skipped-stage auditability, model cost logging, and Next config.

The application builds successfully after the changes.

## Current State

The repository is a Next.js 15 / React 19 / TypeScript app backed by Drizzle/Postgres schemas. The implementation now better matches the architecture principle that database records are truth, agents produce staged proposals, validators decide acceptance, and evidence must be linked through source locations.

Important caveat: this repo appears fully untracked from Git's perspective in this workspace, so `git status --short` reports many `??` entries including `src/`, `architecture.md`, `package.json`, and generated output directories. Treat that as workspace state, not necessarily files changed by this session.

## What Changed

- Fixed staged evidence acceptance:
  - `src/lib/agents/staging.ts`
  - Evidence claims are inserted into `evidence_claims`.
  - Source provenance is now inserted through `source_locations` and `evidence_links`.
  - Removed the broken assumption that `evidence_claims` has `source_document_id` and `document_chunk_id` columns.
  - Non-assumption staged claims now require a document, chunk, table, or explicit `no_source_reason`.

- Fixed workflow stage retry tracking:
  - `src/lib/workflow/orchestrator.ts`
  - `advanceStage()` no longer selects or updates a nonexistent `research_stages.retry_count` column.
  - Stage retry count is stored in `validation_result_json.retryCount`.

- Wired ingestion to parsing:
  - `src/app/api/research-runs/[id]/sources/ingest/route.ts`
  - Uploaded files now call `invokeDoclingParser()` and `storeParseResults()` when no parse exists yet.
  - URL-only sources are skipped for parsing.
  - Existing file-hash matches are parsed if no parse exists.

- Fixed parser subprocess path handling:
  - `src/lib/ingestion/parser.ts`
  - Replaced shell-string `execSync` with `execFileSync("python3", [script, file])`, which matters because this workspace path contains spaces.

- Preserved skipped workflow stages:
  - `src/app/api/assets/[id]/research-runs/route.ts`
  - New runs now call `createStagesForRun()` so skipped stages are explicitly recorded with reasons.

- Added model budget/cost enforcement primitives:
  - `src/db/schema/ai.ts`
  - `src/lib/agents/model-calls.ts`
  - `src/app/api/research-runs/[id]/model-calls/route.ts`
  - Added `model_budget_limits` and `model_budget_ledger`.
  - Added `recordModelCall()` to require `escalationReason` for premium calls, check hard budget limits, write model call logs, write budget ledger rows, and update run/task costs.
  - Added `POST /api/research-runs/:id/model-calls` to record model calls through that service.

- Fixed Next config warning:
  - `next.config.ts`
  - Moved `serverActions` under `experimental.serverActions`.

- Generated Drizzle migration files:
  - `drizzle/0000_tiny_master_chief.sql`
  - `drizzle/meta/0000_snapshot.json`
  - `drizzle/meta/_journal.json`

## Verification

Commands run:

```bash
npm run build
npm run db:generate
```

Results:

- `npm run build` completed successfully.
- The previous unrecognized `serverActions` config warning is gone.
- Next reports `serverActions` under experiments, which is expected for this version.
- `npm run db:generate` completed and generated an initial migration.

## Important Outputs

The generated migration is an initial schema migration because this workspace did not have a `drizzle/` directory before generation:

```text
drizzle/0000_tiny_master_chief.sql
drizzle/meta/0000_snapshot.json
drizzle/meta/_journal.json
```

Do not blindly apply this to a database that already has tables without checking migration history. If the local database was created by `db:push` or manually, decide whether to baseline, reset, or create an incremental migration.

## Known Issues

- Full OpenCode and LiteLLM sidecar integration is still not implemented. The session added app-level enforcement primitives and an API recording path, but not a real OpenCode runtime adapter or LiteLLM proxy client.
- Ingestion parsing is synchronous inside the API route. It is acceptable for the current implementation pass, but large files should move to a background task/worker to match the architecture more cleanly.
- URL sources are stored but not downloaded or parsed. The ingestion route creates a `source_documents` row with `storage_path` starting with `url:`.
- The basic fallback parser reads files as UTF-8 text. It is not suitable for binary PDFs unless Docling is installed and working.
- The generated initial migration may not match an already-provisioned database state.
- The repo has untracked build/dependency artifacts in this workspace, including `.next/`, `node_modules/`, `.env.local`, and `.DS_Store`.

## Next Steps

1. Decide database migration strategy:
   - For a fresh dev DB, `npm run db:migrate` may be appropriate.
   - For an existing DB, inspect current schema first and avoid replaying a full initial migration onto existing tables.

2. Add route-level tests or integration tests for:
   - Stage output acceptance for evidence claims.
   - Evidence link creation from a chunk-backed staged claim.
   - `advanceStage()` retry behavior.
   - Source upload plus parse storage.
   - Premium model-call rejection without escalation reason.

3. Move parsing to workflow tasks:
   - `source_ingestion` stage should enqueue parse tasks.
   - API upload should remain fast and only create raw source records.

4. Add a real model gateway adapter:
   - Route LiteLLM calls through one service.
   - Require tier and escalation metadata at call time.
   - Use `recordModelCall()` after each call.

5. Add OpenCode runtime integration:
   - Bounded agent task execution.
   - Role-specific permissions.
   - Structured output that lands in `agent_output_staging`.

## Practical Caveats

- `src/lib/agents/staging.ts` currently accepts source references by `source_document_id`, `document_chunk_id`, or `extracted_table_id`. For precise evidence, prefer chunk or table IDs over document-only IDs.
- `recordModelCall()` checks `model_budget_limits` and run `budget_limit_usd`, then updates `research_runs.actual_cost_usd` and `research_tasks.cost_usd`. It does not yet enforce time-period windows despite the `period` column existing.
- Because `source_documents.file_hash` is globally unique, attaching an existing source to multiple runs is still limited by the single nullable `research_run_id` column. A future many-to-many join table would be cleaner.

## Files To Start With

```text
architecture.md
src/lib/agents/staging.ts
src/lib/agents/model-calls.ts
src/lib/workflow/orchestrator.ts
src/app/api/research-runs/[id]/sources/ingest/route.ts
src/app/api/assets/[id]/research-runs/route.ts
src/app/api/research-runs/[id]/model-calls/route.ts
src/lib/ingestion/parser.ts
src/db/schema/ai.ts
src/db/schema/evidence.ts
src/db/schema/corpus.ts
drizzle/0000_tiny_master_chief.sql
next.config.ts
```
