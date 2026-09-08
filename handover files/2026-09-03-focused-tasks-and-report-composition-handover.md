# Focused research tasks and report composition

Date: 2026-09-03

The approved implementation is in place and passes local checks. One paid evidence-reader canary ran on 2026-09-04. It failed structured-output validation, as recorded below. The existing modified worktree was preserved.

## Task structure

The pipeline now gives separate model calls responsibility for individual saved outputs. These calls reuse the existing agent runtime and configured model. There is no new agent framework or model fallback.

| Stage | Saved tasks and dependencies |
| --- | --- |
| Company history | Founder profile and timeline, then company genesis, then strategic DNA |
| Business analysis | Existing split tasks, now with narrower inputs and dependency-aware caching |
| Moat | Assessment, attack matrix, then no-moat counterfactual |
| Operating model | Driver tree, operating model, reinvestment, then reconciliation |
| Valuation | Existing calculation checkpoints retained |
| Decision | Existing split tasks retained; expected returns come directly from the saved calculation |
| Report | The existing export-writer composes a summary, transitions, section order, closing assessment and disclosures |
| Review | Separate section reviews, followed by a cross-section review |

Each split task receives its own output schema and selected evidence or upstream outputs. Successful outputs survive sibling failures. Input and prompt hashes control reuse, and persisted attempt reservations prevent resume from resetting the retry budget.

## Evidence and runtime changes

- HTML sources get a saved readable parse with exact citation offsets. Original files and previous parses remain intact. Overlapping chunks retain nearby table headers.
- Deterministic extraction handles unambiguous dated numeric rows. It rejects raw markup, staff-member matches, undated figures and sentences whose only numbers are dates.
- Retrieval selects relevant passages within long chunks. Evidence batches group related topics and source periods.
- The evidence stage enforces ten logical tasks and twenty attempt reservations across resumes. Each checkpoint gets at most two model attempts.
- Queue wait no longer extends the checkpoint wall deadline. Caller cancellation, budget exhaustion and checkpoint expiry do not count as provider-health failures.
- Provider concurrency defaults to one. Two-stream execution is opt-in through `RESEARCH_PROVIDER_CONCURRENCY=2` and has local isolation tests. The limiter is process-local.

## Review and export controls

The composer cannot remove any of the twenty-five required report sections or rewrite saved numeric tables. Numbers in its prose must reference saved values, which the renderer resolves in code.

Section findings identify responsible artifacts. The final reviewer must preserve those findings and cannot pass a failed section. Supported blocker findings trigger at most one targeted repair round. Independent task outputs remain reusable. Findings against deterministic calculations require a code or data correction rather than an AI rewrite.

Human approval records the exact artifact snapshot. Changed content blocks export, and an old saved decision cannot approve it again. If the underlying analysis changed, the composition must be regenerated before approval.

## Verification

- `npx tsc --noEmit` passed.
- `git diff --check` passed.
- `node --import tsx --test tests/*.test.ts` passed: 290 tests passed, five database-dependent tests skipped, zero failures.
- The five persistence integration tests passed with explicit mock providers and `RUN_DB_INTEGRATION=1`. They cover sibling failure, cached resume, persisted attempt limits, targeted repair isolation and its one-round limit.
- Both SOFI end-to-end tests passed with explicit mock providers and `RUN_DB_INTEGRATION=1`. The full flow includes both human gates, report export, stale approval rejection and stale composition rejection.
- A read-only check against the saved SOFI quarterly filing extracted both reporting periods for Members and Total Products. Every extracted quote matched its exact saved-text offsets.

The final mock runs also exposed and fixed a fixture bug that assigned founder claims to unrelated sources. A regression test checks both source orders and missing founder sources.

## Remaining acceptance and limits

The first paid canary used one request, one attempt, no repair and provider concurrency one. It sent the saved SOFI member and product table to `opencode-go-direct` with the configured `deepseek-v4-flash-vision-exp` model. The response contained four claim objects, but each omitted `claim_text` and `confidence`. Citation validation also rejected the four objects. The call therefore failed and did not advance to paid analysis or report review. The failing wrapper did not persist provider usage, so exact token use and cost are unavailable.

The temporary canary prompt did not list `claim_text` and `confidence` as explicitly as the production evidence prompt. This makes the result useful as a fail-closed runtime check, but not a fair acceptance result for the production prompt. The wrapper was removed after the run. Before another paid call, use the production `exactJsonPrompt` rules through `callResearchAgent` so the task and usage ledger persist the attempt. Keep concurrency at one.

Mock success does not establish real-model research quality. The HTML fallback does not reconstruct complex visual tables. Task and review packets above 96,000 bytes fail explicitly and need narrower inputs. Composer handoffs disclose summary truncation; detailed section reviewers still inspect the saved artifacts.

No schema migration or new dependency is required. Legacy reports without a composition continue using the existing export path.
