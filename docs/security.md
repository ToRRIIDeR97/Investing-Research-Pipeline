# Security

Research OS is a local, single-user tool with no hosted deployment. It handles provider credentials, database credentials, financial source material and research decisions. Its main risks are:

- unauthenticated control of paid model calls and research state by any local process that can reach the app port;
- secret leakage into logs, prompts or child processes;
- untrusted web, filing and model content reaching the database or executing as code.

This document was verified against source on 2026-10-05, and the controls changed by the security hardening of 2026-10-11 were re-checked then. Each claim says whether it was observed in source or is an assumption. Open findings link to their GitHub issues.

![Trust boundaries: Z0 local clients → Z1 unauthenticated API and worker holding secrets → Z2 Postgres and ./storage; Z3 LLM, embedding and web hosts return untrusted content; Z4 python3 and the repair sandbox run model-written code](diagrams/trust-boundaries.svg)

## Assets

| Asset | Where | Sensitivity |
| --- | --- | --- |
| Provider and search keys | Process environment or ignored `.env.local`: `RESEARCH_MODEL_API_KEY`, `OPENCODE_GO_API_KEY`, `ANTHROPIC_API_KEY`, `RESEARCH_EMBEDDING_API_KEY`, `RESEARCH_WEB_SEARCH_API_KEY`. `.env.example` documents names only | High: direct spend |
| Model budget | `model_budget_limits`, `model_budget_ledger`, `research_tasks.budget_reservation_usd` | High: paid calls |
| Research state and decisions | Postgres: runs, stages, artifacts, evidence, `claim_relationships`, `document_embeddings`, `review_decisions`, … | Medium: private analysis; integrity matters |
| Prompts, outputs, call metadata | `model_call_logs`, agent traces. Cache metadata stores hashes and byte counts, never prompt content | Medium |
| Files | `storage/sources`, `storage/backtests`, `storage/exports` (gitignored) | Medium |
| Database credentials | `DATABASE_URL`. `docker-compose.yml` publishes port 5432 on `127.0.0.1` only and reads `POSTGRES_PASSWORD` (default `research_os_dev`). `research_os` is a superuser in that image | Low on its own; high if the port is exposed |

## Trust boundaries

| Zone | Contents | Trust |
| --- | --- | --- |
| Z0 Local clients | Browser, curl, any local process that can reach the Next.js port (bound to `127.0.0.1`) | Untrusted: 59 handlers in 52 `route.ts` files have no authentication. `src/middleware.ts` refuses foreign Host names and cross-site writes |
| Z1 App and worker | Next.js server, research worker, agent harness; holds secrets | Trusted code |
| Z2 Data stores | Postgres (pgvector image), `./storage` | Trusted; reached by Z1 only (by design, not enforced beyond the DB password) |
| Z3 External hosts | LLM endpoint, embedding endpoint, configured search endpoint or DuckDuckGo/Bing HTML, discovered URLs, SEC, FRED, Yahoo, Stooq, World Bank, EIA, FDIC, Coinbase, blockchain.info | Their output is untrusted data |
| Z4a python3 children | `run_backtest.py` (model-written code), `run_backtest_grid.py`, `docling_parser.py`, `pdftotext` | Run with the developer's OS privileges |
| Z4b Repair sandbox | `src/lib/research/repair/sandbox.ts`: model-written JavaScript in a separate Node process | Defence in depth (see below) |

## Authentication and authorization

- **Observed:** there are no accounts, sessions or tokens in `src/app/api/**`. `src/middleware.ts` runs on every `/api/*` request and answers 403 to:
  - a Host other than `localhost`, `127.0.0.1`, `[::1]` or a name in `RESEARCH_APP_ALLOWED_HOSTS`, which stops DNS rebinding;
  - a `POST`, `PATCH`, `PUT` or `DELETE` unless `Sec-Fetch-Site` is `same-origin` or `none`, or `Origin` equals the app's own origin, which stops cross-site writes from the user's browser.

  `next.config.ts` sends `X-Frame-Options: DENY` and `frame-ancestors 'none'` on every page, so the approval buttons can't be framed. Tests: `tests/api-guard.test.ts`.
- These checks stop other websites, not local processes, which can send any header. Any process on the host that reaches the port can:
  - start paid work (`POST …/chat`, `run-system-pipeline`, `approve-plan`, `request-reset`, `backtests`). `request-reset` decides a team-request re-run above the automatic limit: `rerun` reopens analysis stages that make new model calls, and either decision queues the run;
  - write state (`PATCH /api/evidence/:id/review`, `POST /api/staging/:id/accept`, `POST …/model-calls`);
  - read every research record;
  - list, create, rename and delete saved charts (`/api/saved-charts`). Saved charts are shared by everyone who can reach the instance; there is no per-user board.

  Tracked in [#8](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/8).
- `PATCH /api/evidence/:id/review` accepts only `pending`, `accepted` or `rejected` and records the reviewer as `api:unauthenticated`; a `reviewed_by` in the body is ignored ([#13](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/13)). `POST /api/staging/:id/accept` promotes only an output that passed validation and is neither accepted nor rejected, once, in one transaction; anything else gets 409. The `/advance` route, which moved a run past the run lock, the stage handlers and the job lease, was removed ([#16](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/16)). Tests: `tests/api-state-guards.test.ts`.
- **Observed:** `npm run dev`, `npm run start`, `scripts/dev-with-db.cjs` and `.claude/launch.json` pass `-H 127.0.0.1`. A bare `next dev` without `-H` still listens on all interfaces. Treat this as a local, trusted deployment until access control exists. Don't expose the app or the database to untrusted users.
- Human approval is required at the research-plan gate and the final-review gate. A team-request re-run above `RESEARCH_MAX_AUTO_RESET_STAGES` analysis stages (default 6), or any re-run after the run's one automatic re-run, also waits for a reviewer. A re-run decision can't complete or bypass either gate: it is refused unless the run is paused on that re-run, and while the plan or final-review gate is waiting. Because of the point above, the approval APIs themselves aren't access-controlled.

## Secrets

- Keep credentials in the process environment or in ignored local environment files. `.gitignore` excludes `.env.*` and allows `.env.example`.
- Paid runs are opt-in:
  - `RUN_PAID_RESEARCH=1` for `new-equity-run.ts`, `resume-research-run.ts` and `provider-cache-smoke.ts`;
  - `RUN_PAID_MELI` for `new-meli-run.ts`;
  - `RUN_PROVIDER_SMOKE=1` for `provider-smoke.ts`;
  - `RUN_SOURCE_READER_SMOKE` for `source-reader-smoke.ts`.
- The harness `redact()` (`src/lib/agent-harness/runner.ts`) replaces `RESEARCH_MODEL_API_KEY`, `ANTHROPIC_API_KEY`, `OPENCODE_GO_API_KEY`, `RESEARCH_WEB_SEARCH_API_KEY`, `RESEARCH_EMBEDDING_API_KEY`, `DATABASE_URL` and `bearer` tokens ([#10](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/10)). Provider error bodies are truncated and pattern-scrubbed. The embedding provider removes its own key from its errors.
- The backtest child process gets an allowlisted environment (`backtestEnv` in `src/lib/backtesting/executor.ts`): `PATH`, `HOME`, `TMPDIR`, locale, proxy and CA-bundle variables, and `PYTHONPATH`. It gets no provider key and no `DATABASE_URL` ([#11](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/11)). It is still not an OS sandbox (see [Untrusted inputs](#untrusted-inputs)).
- The web-search endpoint must use HTTPS, and its key goes to the first hop only, never to a redirect target ([#22](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/22)).

## Untrusted inputs

| Input | Controls in place | Open gaps |
| --- | --- | --- |
| Model endpoint | One validator for every provider (`validateEndpointUrl` in `src/lib/net.ts`): HTTPS, a host in `RESEARCH_MODEL_ALLOWED_HOSTS`, no credentials, query or fragment, and no loopback or private host, including bracketed IPv6. Local mode requires a loopback or private host. Providers use `redirect: "error"` ([#25](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/25)) | The host check is literal: an allowlisted name is trusted to resolve to the provider |
| Embedding endpoint (`RESEARCH_EMBEDDING_BASE_URL`) | The same validator; `redirect: "error"`; timeout; budget preflight. Passage text is sent there, so configure only a provider trusted with the source material. Tests clear `RESEARCH_EMBEDDING_PROVIDER` | |
| Fetched pages and PDFs | `isSafePublicUrl` (`src/lib/research/sources/role-discovery.ts`): http(s), no credentials, no loopback, private, link-local, CGNAT, ULA, documentation, multicast or reserved address, including bracketed and IPv4-mapped IPv6 (`isPrivateHostname` in `src/lib/net.ts`). The default fetch (`publicFetch`) resolves the host and refuses any non-public answer before each hop ([#9](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/9)). Redirects are re-checked (3 hops max). 15 s timeout per hop. Bodies are read through `readCapped`, which counts decoded bytes and cancels the stream at 1 MB of text or 10 MB of PDF, so a gzip or brotli bomb or an endless chunked body can't exhaust memory. Pages are scanned with linear-time helpers (`src/lib/html-scan.ts`) instead of backtracking regexes. Pages of any html or xml type are stored as structured text, which the DOM parser builds from a rebuild of the page (`htmlToStructuredText` in `src/lib/research/memory/blocks.ts`). The rebuild comes from a balanced tag stream (`balancedHtml`) and keeps only block tags, headings, tables and bold spans. Kept elements nest at most 64 deep, definition terms are written as list items, and each table, row or table section opens a cell at once while cells, rows and sections are never closed, so content never sits between cells. The parser then has no formatting elements to adopt or reconstruct, nothing to move in front of a table (foster parenting, quadratic in the node count), and an open-element stack of a few hundred at most. The tests time 1 MB hostile pages, from fetch to research-memory blocks, at under 1 s. `pdftotext` is limited to 20 s. Source roles are checked against fetched content and URL provenance. These checks are heuristic: a page isn't accepted evidence just because search returned it. Tests: `tests/network-guards.test.ts`, `tests/untrusted-html.test.ts` | The socket does its own DNS lookup, so an answer that changes between the check and the connection isn't caught. A name that fails to resolve at the check is left to fetch. Research memory still parses HTML stored by the corpus fetchers (SEC filings, configured investor pages) without the rebuild |
| Structured data (`corpus.ts`: SEC, FRED, World Bank, EIA, FDIC, Coinbase, …) | `fetchCapped` (`src/lib/net.ts`): a 60 s timeout that covers the body, and a 64 MB body cap ([#23](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/23)) | Fixed public URLs; their content is untrusted data |
| Market data (Yahoo chart JSON, Stooq CSV) | The Yahoo provider's default fetch has a 20 s timeout and reads at most 20 MB; the price-history sync and the framework backtest pass their own 20 s timeout, and the backtest retries each series once. After a failed cross-check, Stooq is not called again for that instrument for 24 hours. Stooq bodies are cut at 2 MB while streaming, and only dated rows with a positive close are read; an HTML page counts as unavailable. Stored closes are never overwritten, and a close counts as verified only when the two sources agree within 0.5% | Both sources are free, unauthenticated endpoints that can change or block requests without notice |
| Macro data (FRED DGS10 CSV) | Fetched through `fetchCapped`. Only dated rows with a numeric value on or before the cutoff are read; the value becomes the risk-free floor that every model discount rate must exceed | |
| Model output | Structured-output parsing and repair, stage contracts and validators, zod-validated staging. For FCFF valuations the model supplies only assumptions; code computes every price. Replaying evidence extraction marks claims from excluded role sources as rejected but keeps their audit records. Every prompt built by `exactJsonPrompt` or the harness's default prompt states once, in its instructions, that packet content (fetched pages, filings, passages, earlier model output) is data, never instructions (`UNTRUSTED_DATA_RULE`) | That rule is an instruction to the model, not an enforcement; validation remains the control. Model `source_requests` (up to 3 queries of up to 300 characters) and report `team_requests` (one search per request, query cut to 300 characters) choose outbound searches ([#27](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/27)). Research-memory passages from fetched documents are placed in team-answer prompts, and filing passages (`filing_passages`, up to `RESEARCH_FILING_PASSAGE_BYTES`, default 24,000 bytes, per call) in business-process, moat, operating-model and report-section prompts, where `FILING_PASSAGE_RULE` repeats that they are untrusted data. A filing that contains instructions reaches those prompts as text |
| Saved charts (`/api/saved-charts`, `/api/saved-charts/:id`) | Zod-validated (`src/lib/research/reporting/saved-charts.ts`): strict objects, series keys limited to `[A-Za-z][A-Za-z0-9_]*` with an optional `metric:` prefix, at most six series, fixed enums for chart type, frequency, range and mode. Names have control characters removed, are trimmed and capped at 120 characters, and are rendered as plain text. Bodies over 16 KB are refused, ids must be UUIDs, and the table holds at most 200 charts. Stored definitions are re-validated on read and invalid rows are skipped | No authentication or ownership: any client can change or delete any saved chart ([#8](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/8)) |
| Run cancellation (`POST /api/research-runs/:id/cancel`) | Refuses a request whose `Origin` header names another origin. Cancelling is terminal and only closes rows; it deletes nothing | No authentication: any local client that can reach the port can cancel any run ([#8](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/8)) |
| Uploads (`POST /api/research-runs/:id/sources/ingest`) | Stored as `<sha256>.<ext>`, where the extension is the client's, lowercased, only if it is pdf, html, htm, txt, md, csv, xlsx, docx or json, and `bin` otherwise. The `url` field must be an http(s) URL without credentials, at most 2,048 characters ([#20](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/20)). A body without `Content-Length` or over 50 MB is refused before it is read. Docling runs as an asynchronous `python3` subprocess (120 s timeout), so a parse doesn't block other requests ([#24](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/24)). Tests: `tests/upload-guards.test.ts` | |
| Backtest code (Z4a) | Import allowlist (pandas, numpy), blocked calls and attributes, read-only `open`, path-escape check, `BACKTEST_TIMEOUT_MS` (120 s). An allowlisted environment with no keys and no `DATABASE_URL` ([#11](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/11)). Artifact paths the child reports outside its own `storage/backtests/<run>/<backtest>` directory are dropped | Not an OS sandbox: the code keeps the developer's file and network access, and the blocklist can be bypassed ([#11](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/11)). Sandboxing is out of scope for now |
| Research-package export | Backtest files are read or copied only when their real path, after `..` and symlinks, lies under `storage/backtests`. CSV cells that start with `=`, `+`, `-`, `@`, tab or CR and aren't plain numbers get a leading `'`, so Excel and Sheets show them as text. Tests: `tests/backtest-export-guards.test.ts` | Rows of the runner's own `equity_curve.csv` and `trades.csv` are copied unescaped. The runner writes only dates and numbers there |
| Repair module (Z4b) | Separate Node process with an empty environment and the Node permission model, which blocks file, child-process and worker access. A fresh V8 context without `process`, `require`, `fetch`, timers, string code generation or host objects. JSON-only I/O. Bounded time, memory and output. Returns only table locations, which are validated before use | Node 22's permission model doesn't restrict network sockets, so the only protection against network access is that the context has no network API. Treat this as defence in depth, not an isolation boundary for hostile code: V8 escapes are possible in principle, so keep the worker on a trusted host |

## Dependency risk

- Install with `npm ci` from `package-lock.json`.
- On 2026-10-11 `npm audit fix` (no `--force`) moved `next` to 15.5.27, `sharp` to 0.35.5, `postcss` to 8.5.29, the nested `nanoid` copies to 3.3.20, and `js-yaml`, `brace-expansion` and `source-map-js` to patched versions ([#12](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/12)). What remains needs a breaking upgrade:
  - `drizzle-orm` < 0.45.2 (high, identifier escaping): `^0.44.2` excludes 0.45;
  - the `postcss` copy bundled in `next` (high): fixed only in `next` 16;
  - `esbuild` under `drizzle-kit`'s `@esbuild-kit` loader (moderate, dev server only) and `braces` under `eslint-config-next` (high, dev only): the only offered fixes are downgrades.

  The `postcss` bundled in `next` compiles only the repository's own CSS at build time.
- `python/requirements.txt` lists pandas, numpy, yfinance and docling (`>=2.0,<3`, the API `docling_parser.py` uses) with ranges and no hashes ([#21](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/21)).

## Checks

```bash
npx tsc --noEmit
npm run test:unit        # API guard, network and HTML guards, endpoint validation, redaction, uploads, backtest env, export escaping
npm run test:db          # adds the staging, evidence-review and ingest route guards
npm run test:sofi-v3     # mock DB-backed pipeline; needs Postgres on :5433 (#18)
npm audit --package-lock-only
grep -rliwE 'auth|authorization|session|bearer' src/app/api --include=route.ts # no output today = no accounts
```

A live provider run is paid. It needs one of the flags listed under [Secrets](#secrets) and the user's approval.
