# Repository guide

- Research OS is a Next.js app backed by PostgreSQL. The database owns run, stage, artifact, and job state.
- Use `npx tsc --noEmit` for types, `npm run test:unit` for unit tests, and `npm run test:sofi-v3` for the database-backed mock pipeline. The last command needs PostgreSQL on port 5433 with migrations applied.
- UI run creation lives in `src/lib/research/run-service.ts`; durable jobs in `src/lib/research/run-queue.ts`; execution in `src/workers/research-worker.ts` and `src/lib/research/system-pipeline.ts`.
- Keep both human gates explicit. Do not complete a run before export and refresh scheduling. Treat typed `research_artifacts` as the report source of truth.
- Keep provider credentials in local environment files. Never commit them. Paid runs require `RUN_PAID_RESEARCH=1`.
- See [system](docs/system.md), [security](docs/security.md), and [local development](docs/local-development.md).
