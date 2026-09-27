# Security boundaries

The app handles provider credentials, database credentials, financial source material, and research decisions. Keep credentials in the process environment or ignored local environment files; `.env.example` documents variable names only. The direct provider restricts outbound hosts with `RESEARCH_MODEL_ALLOWED_HOSTS`. The harness redacts configured secrets from model errors and traces.

The Next.js API accepts client inputs for run creation, source ingestion, and review decisions. Zod schemas validate several request bodies. The worker reads queued jobs from PostgreSQL and calls the configured model provider; model and source text are untrusted inputs that stage validators must check before acceptance. Human approval is required at the research-plan and final-review gates.

Web discovery blocks private URLs and checks source roles against fetched content and URL provenance. These checks are heuristic; a fetched page does not become accepted evidence solely because it appears in a search result. Replaying evidence extraction marks claims from excluded role sources as rejected while retaining their audit records.

No authentication or authorization middleware was found in the current `src/app/api` routes. Treat this as a local, trusted deployment until access control is implemented. Do not expose the app or database to untrusted users.

Checks: `npx tsc --noEmit`, `npm run test:unit`, and `npm run test:sofi-v3` with a local test database. A live provider run is paid and requires `RUN_PAID_RESEARCH=1` in `scripts/new-equity-run.ts`.
