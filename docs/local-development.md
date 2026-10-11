# Local Research OS development

Repository rules and required checks are in [AGENTS.md](../AGENTS.md). Runtime topology is in the [deployment view](architecture.md#2-structural--deployment).

Start the database, apply migrations, then run the Next.js app and the durable research worker in separate terminals:

```bash
docker compose up -d postgres
DATABASE_URL=postgresql://research_os:research_os_dev@localhost:5432/research_os npm run db:migrate

DATABASE_URL=postgresql://research_os:research_os_dev@localhost:5432/research_os npm run dev
DATABASE_URL=postgresql://research_os:research_os_dev@localhost:5432/research_os \
  RESEARCH_MODEL_PROVIDER=mock RESEARCH_ACCEPTANCE_PROVIDER=mock \
  npm run worker:research
```

Compose publishes Postgres on `127.0.0.1:5432` only. Its password comes from `POSTGRES_PASSWORD` in the shell or `.env` and defaults to `research_os_dev`; change `DATABASE_URL` to match. `npm run dev` and `npm run start` bind to `127.0.0.1`.

Install the Python packages once (`python3 -m pip install -r python/requirements.txt`): backtests need pandas, numpy and yfinance, and uploads are parsed with Docling.

The worker claims queued `research_run_jobs` atomically, renews its lease, and records its heartbeat. Use `--once` for a single queued job:

```bash
DATABASE_URL=postgresql://research_os:research_os_dev@localhost:5432/research_os \
  RESEARCH_MODEL_PROVIDER=mock RESEARCH_ACCEPTANCE_PROVIDER=mock \
  npm run worker:research -- --once
```

Create a run from the asset research UI or `POST /api/assets/:assetId/research-runs`; creation returns `201` with the run. Then `POST /api/research-runs/:runId/run-system-pipeline` queues execution and returns `202` with a job ID. The UI performs both steps. Monitor the run through `/api/research-runs/:runId/jobs`, `/api/research-workers/health`, and the UI progress view.

`src/middleware.ts` guards every `/api/*` route. It answers only the Host names `localhost`, `127.0.0.1` and `[::1]`, plus any listed in `RESEARCH_APP_ALLOWED_HOSTS`. A `POST`, `PATCH`, `PUT` or `DELETE` must also carry `Sec-Fetch-Site: same-origin` (browsers add it) or an `Origin` equal to the app's own, so add the header when calling from curl:

```bash
curl -X POST -H 'Sec-Fetch-Site: same-origin' http://127.0.0.1:3000/api/research-runs/$RUN_ID/run-system-pipeline
```

Set `RESEARCH_RUN_ID` and run `npm run run:research:resume` to queue continuation through the same path. A running worker is required. Failed runs restart at their first failed stage; waiting human gates still require explicit approval through the UI or approval endpoints.

For a deterministic database-backed acceptance run with no live network calls:

```bash
npm run test:sofi-v3
```

On this Windows checkout, PostgreSQL 18 is available as the `postgresql-x64-18` service on port 5433. Docker is not running, and the local `.env` contains entries Docker Compose cannot parse. Use the configured `WINDOWS_DATABASE_ADMIN_URL` to create a separate `research_os` database, then point `DATABASE_URL` at that database before running migrations, seed, or tests. The npm `test:sofi-v3` command hardcodes the Docker credentials, so invoke `npx tsx --test tests/sofi-research-e2e.test.ts` with `RUN_DB_INTEGRATION=1`, `RESEARCH_MODEL_PROVIDER=mock`, and `RESEARCH_ACCEPTANCE_PROVIDER=mock` for the Windows service. The mock acceptance test passes without `SKIP_V3_CONTENT_VALIDATORS`.

Run all database-backed suites one file at a time with `npm run test:db`. The suites share one database, so parallel runs let their runs, jobs and cleanup interfere. The command forces the mock provider and reads only `DATABASE_URL` from `.env.local`. `tests/research-run-harness.test.ts` inserts an asset with the slug `sofi` and fails its setup on a database that already holds the real SoFi asset.

For a live run, `scripts/new-equity-run.ts` requires `RUN_PAID_RESEARCH=1` and respects `RESEARCH_ACCEPTANCE_BUDGET_USD`. It stops at the research-plan gate. Review and explicitly approve that persisted plan before resuming paid work.

Keep credentials and provider settings in `.env.local`; do not commit them.
