# Optimisation audit fixes handover

**Date:** 2026-10-11
**Status:** merged to `main` (`26db8ea5`, tree identical to the tested commit `ad99e4cc`)
**PRs:** [#47](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/47) memory and storage, [#48](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/48) security, [#49](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/49) run lifecycle, [#50](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/50) research memory, [#51](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/51) stage outputs, [#52](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/52) performance
**Audit:** `handover files/2026-10-11-optimization-audit.md` (66 verified findings with evidence and fixes)

## What changed

Each PR description lists its findings, deferrals, model-request changes and migration. In short:

- **Run lifecycle (#49):** provider 5xx/overload retries with backoff; transient model failures retry the stage; cut-off replies retry with a larger limit; the worker survives DB errors, shuts down cleanly and requeues; transactional state changes; orphaned-run reconcile; run cancel (`POST /api/research-runs/:id/cancel`); `test:db` refuses a database a live worker uses.
- **Memory and storage (#47):** run page polls only while active and selects only the columns it shows; packets stored once; budget reservation in `research_tasks.budget_reservation_usd`; SEC filings reused by Archives URL.
- **Security (#48):** linear-time HTML parsing, decoded-size caps and timeouts on every fetch, loopback binding plus Host/Origin middleware, Postgres bound to 127.0.0.1, backtest child gets no keys, upload/staging/evidence-review/export guards, `/advance` removed.
- **Research memory (#50):** period-aware ranking with recency ties and copy collapse, stored `search_tsv` with a GIN index, companyfacts JSON out of passage scope, founder search before reading batches; unbuilt-feature tests moved to `Implementations/research-memory/pending/`.
- **Stage outputs (#51):** cutoff runs never use the live price, XBRL word zeros parse, non-calendar fiscal quarters kept, sector benchmarks, withheld backtests, risks/catalysts replaced on retry, prompt/validator contradictions fixed. Two fixes came from the paid check: the operating model now gets `forecast_period` and rejects a restated base year, and `normalizeOutlineStructure` repairs the report outline's chapter labels.
- **Performance (#52):** report sections and source-reader batches run four at a time (`RESEARCH_AGENT_CONCURRENCY`), team answers get their owner's slice, the Anthropic cache breakpoint ends at the shared prefix, five indexes, and every prompt carries the untrusted-data rule.

## Verification

- Every batch: independent reviewer approval (1 to 3 rounds), reviewer-written tests, all checks on its own scratch DB.
- Combined (`ad99e4cc`): tsc clean; unit 454 tests, 423 pass, 0 fail; build ok; `test:db` 741/741 (main was 606/625); mock e2e 6/6.
- Paid checks on the Anthropic adapter, user-approved, $0.99 in total: provider smoke and cache smoke passed; META run `e13c7632` exposed the operating-model forecast-year bug (fixed, run cancelled); META run `81e42ee2` reached the human-review gate after the outline fix: 58 calls, 3 repairs, $0.616, against 56 calls and $0.936 on main run `7fa1f00a`.

## Not done yet (needs the user)

- **Dev database migrations 0012 to 0014 are not applied.** Auto mode refused the migration on the shared dev DB. Until they run, the merged code fails on `research_tasks.budget_reservation_usd` and `document_chunks.search_tsv`. Backup taken first: `research_os-before-audit-merge.dump` (142 MB, pg_dump 15, in the session scratchpad).
- **The main checkout is still at `f6e56ea7`** (not pulled), because its dev server hot-reloads and would break before the migration. Order: migrate, `git pull`, restart.
- **No research worker is running.** The old "research worker (main, Anthropic)" tab was stopped for the paid check. The web app tab on port 3002 still runs the old code and listens on all interfaces until it is restarted on the merged code (which binds `127.0.0.1`).
- Runs `7fa1f00a` and `1d427f3f` wait at human review on the dev DB. The prompt changes alter request hashes, so resuming them makes fresh model calls.

## Known issues and deferrals

- Still open: #8 (no accounts; loopback binding and same-origin checks only), #11 (no OS sandbox for backtest code), #12 (advisories that need major upgrades), #27 (model output still chooses search queries), #14, #19, #34, #42.
- Deferred findings: P7 (scheduler lockstep), M5, M8, M9, M10 (retention and storage hygiene), RMEM11 (graph retrieval), the 151 duplicate SEC files already stored (cleanup is destructive and needs approval), and the residual DNS-rebinding race in the SSRF guard.
- The financials owner can still ask for a historical-record re-run that the stored figures don't need (seen in `81e42ee2`, request-2-2); the re-run gate stops it, but it costs a reviewer decision.

## Local state

- Kept: scratch DB `rr_paidcheck` (restored copy of the dev DB plus the paid test runs; drop with `dropdb -h 127.0.0.1 rr_paidcheck`), and the reviewers' uncommitted independent tests in `audit-reviewer-tests.tar.gz` (session scratchpad).
- Removed: the six feature branches (local and remote), 22 agent worktrees, 20 scratch databases.
- This handover file is not committed, like the others in this folder.
