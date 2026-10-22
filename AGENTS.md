# Repository guide

- Research OS is a Next.js app backed by PostgreSQL. The database owns run, stage, artifact and job state. A separate worker runs queued research jobs (pipeline version 3, 24 stages, scheduled from a dependency graph).
- UI run creation lives in `src/lib/research/run-service.ts`. Durable jobs live in `src/lib/research/run-queue.ts`. Execution runs in `src/workers/research-worker.ts` and `src/lib/research/pipeline-runner.ts`.
- Keep both human gates explicit. Don't complete a run before export and refresh scheduling. Treat typed `research_artifacts` as the report source of truth.
- Keep provider credentials in local environment files and never commit them. Paid runs require an explicit flag (`RUN_PAID_RESEARCH=1`, `RUN_PAID_MELI=1`, `RUN_PROVIDER_SMOKE=1`, `RUN_SOURCE_READER_SMOKE=1`, `RUN_PAID_EVAL=1`). Run them only when the user asks.

## Read first

| Topic | Document |
| --- | --- |
| Current system, specialist team, research memory, caching, repair | [docs/system.md](docs/system.md) |
| Trust boundaries, secrets, untrusted inputs, open security issues | [docs/security.md](docs/security.md) |
| Master UML views and coverage index | [docs/architecture.md](docs/architecture.md) |
| Database setup, worker, test databases | [docs/local-development.md](docs/local-development.md) |
| Provider configuration and limits | [docs/local-agent-harness.md](docs/local-agent-harness.md) |
| Storage cleanup (dry run by default), research sync between machines (`npm run store:sync`), the free refresh check (`npm run monitor:check`) | [docs/operations.md](docs/operations.md) |
| Original target-state proposal (not the current system) | [architecture.md](architecture.md) |

## Commands

Required local checks. All four must pass before a merge:

```bash
npm run lint
npx tsc --noEmit
npm run test:unit
npm run build
```

When persistence, the queue, orchestration or the pipeline changes, also run the database-backed suites:

- `npm run test:sofi-v3`: the mock pipeline, against `DATABASE_URL` (or the one in `.env.local`) with migrations applied.
- `npm run test:db`: every database-backed suite, one file at a time, with the mock provider. It takes only `DATABASE_URL` from `.env.local`. The suites share one database and interfere when run in parallel.
- Both refuse a database a research worker is polling (a heartbeat in the last 30 s). Use a separate test database.

Research quality: `npm run eval:score -- --case META` (or a run id, `--all`, `--stability META`) scores stored runs with code checks and depth probes. It is read-only and free, so run it before and after changes to prompts, contracts or models and quote the `evals/scores.csv` rows in the PR. `npm run eval:judge` is the paid LLM judge (`RUN_PAID_EVAL=1`). See [docs/system.md](docs/system.md#measuring-research-quality).

`npm run lint` runs ESLint with the flat config in `eslint.config.mjs` (`next/core-web-vitals` + `next/typescript`). Errors fail it; warnings (unused variables, hook dependencies) don't. `no-explicit-any` is off for now.

Diagrams in `docs/diagrams/` are generated. Edit `docs/diagrams/_source/make_diagrams.py`, then run:

```bash
python3 docs/diagrams/_source/make_diagrams.py docs/diagrams
```

## Invariants

- Agents propose; stage contracts and validators decide what's accepted. Model calls have no tool execution.
- Runs execute only through `research_run_jobs` and the per-run advisory lock in `runResearchPipeline`.
- Stage order, retries and failure policy live in `src/lib/workflow/stages.ts`. Dependencies live in `src/lib/research/team-plan.ts`.
- Every schema change ships with a Drizzle migration.
- Treat fetched pages, filings and model output as untrusted data.
- When a component boundary, interface, data flow, trust boundary, secret or canonical command changes, update the owning doc, its diagram and the affected views in `docs/architecture.md` in the same change.

## Development workflow

![Development workflow: feature branch, implement, local checks, docs if needed, PR, user approval, merge and clean up](docs/diagrams/dev-workflow.svg)

## Merging

- Target branch is `main`. Work on a feature branch and merge through a pull request. Never push directly to `main` or force-push it.
- Required checks run **locally**, not in CI, to avoid GitHub Actions charges. Merge only after `npm run lint`, `npx tsc --noEmit`, `npm run test:unit` and `npm run build` pass on the branch **and** the user explicitly approves.
  - Changes to model requests (prompt layout, providers, usage parsing) also need a small paid live provider test that the user has approved.
  - Don't wait on or re-run GitHub Actions. If branch protection requires CI checks that block the merge, report it to the user and don't bypass it.
- After the merge is verified in `main`, delete the feature branch:
  - remote: `git push origin --delete <branch>` (skip if GitHub already deleted it);
  - local: `git switch main && git pull && git branch -d <branch>`;
  - prune: `git fetch --prune`.
- If `git branch -d` refuses because the PR was squash- or rebase-merged, first confirm the PR shows as merged, then use `git branch -D <branch>`. Never delete a branch whose PR is unmerged or still open.
- Recommended: enable "Automatically delete head branches" in the GitHub repository settings. Ask the user before changing it.
