# Security

Research OS is a local, single-user tool with no hosted deployment. It handles provider credentials, database credentials, financial source material and research decisions. Its main risks are:

- unauthenticated control of paid model calls and research state by anything that can reach the app port;
- secret leakage into logs, prompts or child processes;
- untrusted web, filing and model content reaching the database or executing as code.

This document was verified against source on 2026-10-05. Each claim says whether it was observed in source or is an assumption. Open findings link to their GitHub issues.

![Trust boundaries: Z0 local clients → Z1 unauthenticated API and worker holding secrets → Z2 Postgres and ./storage; Z3 LLM, embedding and web hosts return untrusted content; Z4 python3 and the repair sandbox run model-written code](diagrams/trust-boundaries.svg)

## Assets

| Asset | Where | Sensitivity |
| --- | --- | --- |
| Provider and search keys | Process environment or ignored `.env.local`: `RESEARCH_MODEL_API_KEY`, `OPENCODE_GO_API_KEY`, `ANTHROPIC_API_KEY`, `RESEARCH_EMBEDDING_API_KEY`, `RESEARCH_WEB_SEARCH_API_KEY`. `.env.example` documents names only | High: direct spend |
| Model budget | `model_budget_limits`, `model_budget_ledger`, `model_budget_reservations` | High: paid calls |
| Research state and decisions | Postgres: runs, stages, artifacts, evidence, `claim_relationships`, `document_embeddings`, `review_decisions`, … | Medium: private analysis; integrity matters |
| Prompts, outputs, call metadata | `model_call_logs`, agent traces. Cache metadata stores hashes and byte counts, never prompt content | Medium |
| Files | `storage/sources`, `storage/backtests`, `storage/exports` (gitignored) | Medium |
| Database credentials | `DATABASE_URL`. `docker-compose.yml` sets a development password and publishes port 5432 | Low on its own; high when combined with network exposure |

## Trust boundaries

| Zone | Contents | Trust |
| --- | --- | --- |
| Z0 Local clients | Browser, curl, any process or LAN host that can reach the Next.js port | Untrusted: 59 handlers in 52 `route.ts` files have no authentication |
| Z1 App and worker | Next.js server, research worker, agent harness; holds secrets | Trusted code |
| Z2 Data stores | Postgres (pgvector image), `./storage` | Trusted; reached by Z1 only (by design, not enforced beyond the DB password) |
| Z3 External hosts | LLM endpoint, embedding endpoint, configured search endpoint or DuckDuckGo/Bing HTML, discovered URLs, SEC, FRED, Yahoo, Stooq, World Bank, EIA, FDIC, Coinbase, blockchain.info | Their output is untrusted data |
| Z4a python3 children | `run_backtest.py` (model-written code), `run_backtest_grid.py`, `docling_parser.py`, `pdftotext` | Run with the developer's OS privileges |
| Z4b Repair sandbox | `src/lib/research/repair/sandbox.ts`: model-written JavaScript in a separate Node process | Defence in depth (see below) |

## Authentication and authorization

- **Observed:** there is no `middleware.ts`, and no auth, session or token check in `src/app/api/**`. Any client that reaches the port can:
  - start paid work (`POST …/chat`, `run-system-pipeline`, `approve-plan`, `request-reset`, `backtests`). `request-reset` decides a team-request re-run above the automatic limit: `rerun` reopens analysis stages that make new model calls, and either decision queues the run;
  - write state (`PATCH /api/evidence/:id/review` takes `reviewed_by` from the body; `POST /api/staging/:id/accept`; `POST …/model-calls`);
  - read every research record;
  - list, create, rename and delete saved charts (`/api/saved-charts`). Saved charts are shared by everyone who can reach the instance; there is no per-user board.

  Tracked in [#8](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/8) and [#13](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/13).
- **Assumption:** `next dev` and `next start` listen on all interfaces, because no `-H` flag is passed. Treat this as a local, trusted deployment until access control exists. Don't expose the app or the database to untrusted users.
- Human approval is required at the research-plan gate and the final-review gate. A team-request re-run above `RESEARCH_MAX_AUTO_RESET_STAGES` analysis stages (default 6), or any re-run after the run's one automatic re-run, also waits for a reviewer. A re-run decision can't complete or bypass either gate: it is refused unless the run is paused on that re-run, and while the plan or final-review gate is waiting. Because of the point above, the approval APIs themselves aren't access-controlled.

## Secrets

- Keep credentials in the process environment or in ignored local environment files. `.gitignore` excludes `.env.*` and allows `.env.example`.
- Paid runs are opt-in:
  - `RUN_PAID_RESEARCH=1` for `new-equity-run.ts`, `resume-research-run.ts` and `provider-cache-smoke.ts`;
  - `RUN_PAID_MELI` for `new-meli-run.ts`;
  - `RUN_PROVIDER_SMOKE=1` for `provider-smoke.ts`;
  - `RUN_SOURCE_READER_SMOKE` for `source-reader-smoke.ts`.
- The harness `redact()` (`src/lib/agent-harness/runner.ts:139`) only replaces `RESEARCH_MODEL_API_KEY`, `ANTHROPIC_API_KEY`, `DATABASE_URL` and `bearer` tokens. Provider error bodies are truncated and pattern-scrubbed. The embedding provider removes only its own key. `OPENCODE_GO_API_KEY` and `RESEARCH_WEB_SEARCH_API_KEY` aren't covered ([#10](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/10)).
- **Observed:** the backtest child process receives the full worker environment, `env: { ...process.env }` (`src/lib/backtesting/executor.ts:283`), so model-written code can read every key ([#11](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/11)).
- The web-search key is re-sent on every redirect hop, and `http:` is allowed ([#22](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/22)).

## Untrusted inputs

| Input | Controls in place | Open gaps |
| --- | --- | --- |
| Model endpoint | The direct OpenAI-compatible provider requires HTTPS, a host in `RESEARCH_MODEL_ALLOWED_HOSTS`, no credentials and no private host. The Anthropic-protocol provider checks HTTPS, credentials and the allowlist. Both use `redirect: "error"` | No query check. The Anthropic provider has no private-host check. The `::1` literal never matches `[::1]` ([#25](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/25)) |
| Embedding endpoint (`RESEARCH_EMBEDDING_BASE_URL`) | HTTPS; no credentials, query or fragment; host in `RESEARCH_MODEL_ALLOWED_HOSTS`; timeout; budget preflight. Passage text is sent there, so configure only a provider trusted with the source material. Tests clear `RESEARCH_EMBEDDING_PROVIDER` | No `redirect: "error"` ([#25](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/25)) |
| Fetched pages and PDFs | `isSafePublicUrl` (`src/lib/research/sources/role-discovery.ts:115`): http(s), no credentials, literal private-IPv4 and localhost blocklist. Redirects are re-checked (3 hops max). 15 s timeout, 1 MB text and 10 MB PDF caps, `pdftotext` limited to 20 s. Source roles are checked against fetched content and URL provenance. These checks are heuristic: a page isn't accepted evidence just because search returned it | IPv6 loopback isn't blocked. No DNS-resolution check. CGNAT and IPv6 private ranges are missing ([#9](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/9)). Structured-data fetchers in `corpus.ts` and `yahoo.ts` have no timeout or size cap ([#23](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/23)) |
| Market data (Yahoo chart JSON, Stooq CSV) | The price-history sync uses a 20 s timeout. Stooq bodies are capped at 2 MB, and only dated rows with a positive close are read; an HTML page counts as unavailable. Stored closes are never overwritten, and a close counts as verified only when the two sources agree within 0.5% | Yahoo responses have no size cap. Both sources are free, unauthenticated endpoints that can change or block requests without notice |
| Model output | Structured-output parsing and repair, stage contracts and validators, zod-validated staging. Replaying evidence extraction marks claims from excluded role sources as rejected but keeps their audit records | Only the chat route tells the model that source text is untrusted data. Model `source_requests` (up to 3 queries of up to 300 characters) and report `team_requests` (one search per request, query cut to 300 characters) choose outbound searches ([#27](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/27)). Research-memory passages from fetched documents are placed in team-answer prompts |
| Saved charts (`/api/saved-charts`, `/api/saved-charts/:id`) | Zod-validated (`src/lib/research/reporting/saved-charts.ts`): strict objects, series keys limited to `[A-Za-z][A-Za-z0-9_]*` with an optional `metric:` prefix, at most six series, fixed enums for chart type, frequency, range and mode. Names have control characters removed, are trimmed and capped at 120 characters, and are rendered as plain text. Bodies over 16 KB are refused, ids must be UUIDs, and the table holds at most 200 charts. Stored definitions are re-validated on read and invalid rows are skipped | No authentication or ownership: any client can change or delete any saved chart ([#8](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/8)) |
| Uploads (`POST /api/research-runs/:id/sources/ingest`) | Stored as `<sha256>.<ext>`. The extension can't contain `..`. Docling runs as a `python3` subprocess (120 s timeout) | The extension and the `url` field aren't sanitized ([#20](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/20)). `execFileSync` blocks the event loop, and uploads have no size limit ([#24](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/24)) |
| Backtest code (Z4a) | Import allowlist (pandas, numpy), blocked calls and attributes, read-only `open`, path-escape check, `BACKTEST_TIMEOUT_MS` (120 s) | Not an OS sandbox. Inherits the environment's secrets ([#11](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/11)) |
| Repair module (Z4b) | Separate Node process with an empty environment and the Node permission model, which blocks file, child-process and worker access. A fresh V8 context without `process`, `require`, `fetch`, timers, string code generation or host objects. JSON-only I/O. Bounded time, memory and output. Returns only table locations, which are validated before use | Node 22's permission model doesn't restrict network sockets, so the only protection against network access is that the context has no network API. Treat this as defence in depth, not an isolation boundary for hostile code: V8 escapes are possible in principle, so keep the worker on a trusted host |

## Dependency risk

- Install with `npm ci` from `package-lock.json`.
- `npm audit --package-lock-only --omit=dev` (2026-10-05) reports 1 critical advisory (`next`) and 4 high (`drizzle-orm`, `nanoid`, `postcss`, `sharp`) ([#12](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/12)).
- `python/requirements.txt` lists pandas, numpy and yfinance with `>=` ranges and no hashes. `docling` is imported but not listed ([#21](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/21)).

## Checks

```bash
npx tsc --noEmit
npm run test:unit        # provider URL/host validation, limits, redaction, repair sandbox, embeddings
npm run test:sofi-v3     # mock DB-backed pipeline; needs Postgres on :5433 (#18)
npm audit --package-lock-only --omit=dev
ls middleware.ts src/middleware.ts 2>/dev/null                                  # no output today = no auth middleware
grep -rliwE 'auth|authorization|session|bearer' src/app/api --include=route.ts # no output today
```

A live provider run is paid. It needs one of the flags listed under [Secrets](#secrets) and the user's approval.
