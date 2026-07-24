# Local Research OS development

Start the database, apply migrations, then run the Next.js app and the durable research worker in separate terminals:

```bash
docker compose up -d postgres
DATABASE_URL=postgresql://research_os:research_os_dev@localhost:5432/research_os npm run db:migrate

DATABASE_URL=postgresql://research_os:research_os_dev@localhost:5432/research_os npm run dev
DATABASE_URL=postgresql://research_os:research_os_dev@localhost:5432/research_os \
  RESEARCH_MODEL_PROVIDER=mock RESEARCH_ACCEPTANCE_PROVIDER=mock \
  npm run worker:research
```

The worker claims queued `research_run_jobs` atomically, renews its lease, and records its heartbeat. Use `--once` for a single queued job:

```bash
DATABASE_URL=postgresql://research_os:research_os_dev@localhost:5432/research_os \
  RESEARCH_MODEL_PROVIDER=mock RESEARCH_ACCEPTANCE_PROVIDER=mock \
  npm run worker:research -- --once
```

Create a run from the asset research UI or `POST /api/assets/:assetId/research-runs`; the API returns `202` with a job ID. Monitor the run through `/api/research-runs/:runId/jobs`, `/api/research-workers/health`, and the UI progress view.

For a deterministic database-backed acceptance run with no live network calls:

```bash
npm run test:sofi-v3
```

Keep credentials and provider settings in `.env.local`; do not commit them.
