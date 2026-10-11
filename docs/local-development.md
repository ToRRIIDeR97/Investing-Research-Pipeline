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

The worker claims queued `research_run_jobs` atomically, renews its lease every 10 s, and records its heartbeat. It keeps polling when the database is briefly unreachable. Ctrl+C (SIGINT) or SIGTERM aborts the current model call and puts the job back in the queue without using an attempt; the next worker reruns the interrupted stage. A second Ctrl+C exits at once, and the job then waits for its 5-minute lease to expire. Use `--once` for a single queued job:

```bash
DATABASE_URL=postgresql://research_os:research_os_dev@localhost:5432/research_os \
  RESEARCH_MODEL_PROVIDER=mock RESEARCH_ACCEPTANCE_PROVIDER=mock \
  npm run worker:research -- --once
```

Create a run from the asset research UI or `POST /api/assets/:assetId/research-runs`; creation returns `201` with the run. Then `POST /api/research-runs/:runId/run-system-pipeline` queues execution and returns `202` with a job ID. The UI performs both steps. Monitor the run through `/api/research-runs/:runId/jobs`, `/api/research-workers/health`, and the UI progress view.

Set `RESEARCH_RUN_ID` and run `npm run run:research:resume` to queue continuation through the same path. A running worker is required. Failed runs restart at their first failed stage; waiting human gates still require explicit approval through the UI or approval endpoints.

To stop a run for good, use **Cancel run** on the run page or `POST /api/research-runs/:runId/cancel`. A cancelled run can't be resumed or queued again; a worker running it stops its model call within about 10 s.

For a deterministic database-backed acceptance run with no live network calls, migrate a separate test database and point `DATABASE_URL` at it:

```bash
createdb -h 127.0.0.1 -O research_os research_os_test
DATABASE_URL=postgresql://research_os:research_os_dev@localhost:5432/research_os_test npm run db:migrate
DATABASE_URL=postgresql://research_os:research_os_dev@localhost:5432/research_os_test npm run db:seed
DATABASE_URL=postgresql://research_os:research_os_dev@localhost:5432/research_os_test npm run test:sofi-v3
```

`test:sofi-v3` and `test:db` read `DATABASE_URL`, falling back to the one in `.env.local`. Both refuse to run when a research worker has sent a heartbeat to that database in the last 30 s, because the worker and the tests would claim each other's jobs.

On this Windows checkout, PostgreSQL 18 is available as the `postgresql-x64-18` service on port 5433. Docker is not running, and the local `.env` contains entries Docker Compose cannot parse. Use the configured `WINDOWS_DATABASE_ADMIN_URL` to create a separate `research_os` database, then point `DATABASE_URL` at that database before running migrations, seed, or tests, including `npm run test:sofi-v3`. The mock acceptance test passes without `SKIP_V3_CONTENT_VALIDATORS`.

Run all database-backed suites one file at a time with `npm run test:db`. The suites share one database, so parallel runs let their runs, jobs and cleanup interfere. The command forces the mock provider and reads only `DATABASE_URL` from `.env.local`, and refuses a database with a live worker, as above. `tests/research-run-harness.test.ts` inserts an asset with the slug `sofi` and fails its setup on a database that already holds the real SoFi asset.

For a live run, `scripts/new-equity-run.ts` requires `RUN_PAID_RESEARCH=1` and respects `RESEARCH_ACCEPTANCE_BUDGET_USD`. It stops at the research-plan gate. Review and explicitly approve that persisted plan before resuming paid work.

Keep credentials and provider settings in `.env.local`; do not commit them.
