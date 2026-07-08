# Research OS Handover - OpenCode Backtests And Research Theater

**Date tag:** 2026-07-06
**Last updated:** 2026-07-06
**Scope:** Investing Research Pipeline / OpenCode backtest worker and asset run UI
**Status:** current

## Executive Summary

This handover captures the work after the UI buildout and architecture-fixes handovers. The major additions are a local OpenCode sidecar integration for backtest code generation, a DB-backed backtest task pipeline, a Python execution path for generated strategies, and a user-facing research theater view on the asset run page.

The app is currently running on:

```text
http://localhost:4000
```

Port 3000 is intentionally avoided because another app is using it.

## Current State

The repository is a Next.js 15 / React 19 / TypeScript app with Drizzle/Postgres schemas. The new backtest path is designed as a local v1: Research OS owns state, validation, budgeting, tasks, artifacts, and UI; OpenCode is called as a sidecar through `@opencode-ai/sdk` rather than vendoring the upstream runtime.

The current browser target that was verified is:

```text
http://localhost:4000/assets/8ed535c3-8952-4739-badb-a5603bcdd7e4/run
```

That route returned `HTTP 200`.

## What Changed

- Added OpenCode project config and agent prompt:
  - `opencode.json`
  - `.opencode/agent/backtest-coder.md`
  - Permissions deny broad edits and allow generated output only under `storage/backtests/**`.
  - The agent is instructed to return structured JSON and generate a Python `generate_signals(prices, params)` interface.

- Added OpenCode SDK integration:
  - `@opencode-ai/sdk` in `package.json`.
  - `src/lib/opencode/backtest-coder.ts`.
  - Environment variables in `.env.example`:
    - `OPENCODE_BASE_URL`
    - `OPENCODE_BACKTEST_AGENT`
    - `OPENCODE_MODEL_TIER`
    - `BACKTEST_TIMEOUT_MS`

- Added backtest persistence and API flow:
  - `src/db/schema/backtesting.ts`
  - `drizzle/0001_backtesting.sql`
  - `src/app/api/research-runs/[id]/backtests/route.ts`
  - `src/app/api/backtests/[id]/artifacts/route.ts`
  - Backtests are linked to research runs, research tasks, and assets.

- Added local worker pipeline:
  - `src/workers/research-worker.ts`
  - `npm run worker:research`
  - The worker claims pending backtest tasks, calls OpenCode, runs Python, persists artifacts and metrics, and marks tasks/runs complete or failed.
  - OpenCode calls are recorded through the existing model-call ledger with escalation reason `backtest code generation`.

- Added Python execution path:
  - `python/backtesting/run_backtest.py`
  - `python/requirements.txt`
  - `src/lib/backtesting/executor.ts`
  - `src/lib/backtesting/service.ts`
  - v1 market data uses `yfinance`; strategy execution expects pandas/numpy.
  - Artifacts are written under `storage/backtests/<researchRunId>/<backtestRunId>/`.

- Added user-facing research theater:
  - `src/app/assets/[id]/run/page.tsx`
  - The run page now polls during pipeline phase, resumes the latest active/pending run for the asset, and displays stages, active stage detail, agent traces, artifacts, model calls, and backtest summaries.
  - The UI is intended to make agent research visible as a controlled operations console rather than an opaque spinner.

- Updated asset detail backtest surface:
  - `src/app/assets/[id]/page.tsx`
  - Shows newer backtest summaries and links into run/review flows.

## Verification

Commands and checks performed during this pass:

```bash
npm run build
npm run dev -- --port 4000
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:4000/assets/8ed535c3-8952-4739-badb-a5603bcdd7e4/run
```

Results:

- `npm run build` passed after the research theater changes.
- Next dev server started successfully on port 4000.
- The asset run page returned `200`.

The server process was started from this workspace with:

```bash
npm run dev -- --port 4000
```

## Important Outputs

Key files for the next agent:

```text
src/app/assets/[id]/run/page.tsx
src/app/assets/[id]/page.tsx
src/app/api/research-runs/[id]/backtests/route.ts
src/app/api/backtests/[id]/artifacts/route.ts
src/db/schema/backtesting.ts
src/lib/backtesting/service.ts
src/lib/backtesting/executor.ts
src/lib/opencode/backtest-coder.ts
src/workers/research-worker.ts
python/backtesting/run_backtest.py
python/requirements.txt
opencode.json
.opencode/agent/backtest-coder.md
.env.example
drizzle/0001_backtesting.sql
```

## Known Issues

- The OpenCode sidecar must be running separately. `OPENCODE_BASE_URL` is the URL of that local sidecar server, not the Next app URL. The current example value is `http://localhost:4096`.
- The end-to-end OpenCode happy path still needs a live sidecar acceptance run: create a backtest request, run `npm run worker:research`, confirm generated files, metrics, artifacts, UI visibility, and model-call cost logging.
- Python dependencies from `python/requirements.txt` need to be installed in the environment used by the worker. The runner depends on pandas, numpy, and yfinance.
- Generated artifacts live under `storage/*`, which is ignored by Git.
- `.commandcode/` appears as an untracked local tooling directory. Decide whether to ignore it before pushing.
- The working tree has many modified/untracked files from this feature branch; review with `git status --short` before staging.

## Next Steps

1. Run a full OpenCode sidecar acceptance test:
   - Start the OpenCode server on the URL in `OPENCODE_BASE_URL`.
   - Create a research run/backtest request.
   - Run `npm run worker:research`.
   - Verify DB status, `storage/backtests/**` artifacts, UI display, and `model_calls` / budget ledger rows.

2. Verify database migration strategy:
   - Inspect whether the target database already has the schema.
   - Apply `drizzle/0001_backtesting.sql` only after confirming migration history.

3. Tighten Git hygiene before pushing:
   - Keep `.cache/`, `storage/*`, Python caches, and env files ignored.
   - Decide whether `.commandcode/` should be ignored.
   - Do not stage generated `storage/backtests/**` artifacts.

4. Add tests around:
   - Missing/unreachable `OPENCODE_BASE_URL`.
   - Worker happy path with a simple moving-average strategy.
   - Python timeout and OpenCode failure states.
   - Point-in-time rejection when data exceeds `research_runs.market_data_cutoff_at`.
   - Artifact API returning DB-backed `backtest_artifacts`.

## Practical Caveats

- This is a local v1 pipeline, not a production distributed queue. It is intentionally a DB-backed worker command.
- OpenCode is used as a sidecar runtime through the SDK. The upstream monorepo should remain an ignored reference clone only, not vendored into this app.
- The generated strategy contract is intentionally small: `generate_signals(prices, params)` returns a DataFrame with a numeric `signal` column.
- Keep the research theater user-facing. It should show useful progress, agent activity, evidence/artifact state, and failures without exposing raw implementation noise.

## Files To Start With

```text
handover files/2026-07-05-research-os-architecture-fixes-handover.md
handover files/2026-07-05-research-os-ui-buildout-handover.md
src/app/assets/[id]/run/page.tsx
src/lib/opencode/backtest-coder.ts
src/lib/backtesting/service.ts
src/workers/research-worker.ts
python/backtesting/run_backtest.py
opencode.json
.opencode/agent/backtest-coder.md
```
