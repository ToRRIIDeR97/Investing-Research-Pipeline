# Deterministic pipeline handover

**Date:** 2026-10-11
**Status:** merged to `main` (`f6e56ea7`)
**PRs:** [#43](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/43), [#44](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/44), [#45](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/45), [#46](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/pull/46)
**Plans:** `Implementations/deterministic-pipeline.md` and its four packages (each with `acceptance/` and `verification/` tests)

## What changed

Live META runs kept failing where the model was asked to do work code can do exactly. Each fix moves that work into code and leaves the judgment calls with the model.

| PR | Change |
| --- | --- |
| #43 decision synthesis | `decision/finalize.ts`: flagged catalysts move to `monitoring_dashboard.drivers`, and source-gap or uncited risks become `system:decision-synthesis` gaps. Invented citations go to `decision_record.adjustments`. Code sets the thesis fields and returns; returns are null with a `status` when withheld or unavailable. All checks run before the first write. |
| #44 valuation | `valuation/engine.ts`: operating scenarios carry `yearly_drivers`, and code builds the yearly statements, FCFF schedules, price path, anchors, weighted target and reverse valuation. The model returns only `valuation_assumptions` (discount rate above the FRED DGS10 rate, terminal, rationale). Missing inputs withhold before any model call. `financial_inputs` gains tax columns. Banks keep model-built FCFE schedules, assembled by code. |
| #45 request routing | Team requests are answered from `market_price_history`, the FRED file and research-memory passages without stage resets. Resets happen only on an owner's `requires_rerun`: one automatic reset of 6 or fewer analysis stages, otherwise a pause with `approveRequestReset` and `POST /api/research-runs/:id/request-reset` (run-page panel). Specialist source requests the corpus already answers are recorded `in_corpus`. |
| #46 Anthropic structured output | On `anthropic-direct` with Claude models only, expressible contract schemas go out as `output_config.format`. A schema 400 is resent once without it and remembered for the process. Per-pass telemetry `structuredOutput: {sent, fallback}`. Set `RESEARCH_ANTHROPIC_STRUCTURED_OUTPUT=0` to turn it off. |

## Verification

- Each branch: acceptance and independent verification sets green. The reviewer ran the verification sets against each exact branch.
- Combined: `npx tsc --noEmit` clean, `npm run test:unit` 335 pass / 0 fail, `npm run build` ok, mock SOFI e2e 6/6, `npm run test:db` 606/625. The 19 failures are research-memory AC-13 to AC-16, which also fail on `main` before these PRs.
- `main` after the merges is byte-identical to the integration branch that ran the live check.
- Paid live check, approved by the user, run `7fa1f00a` on Claude Haiku 5.5:
  - reached `human_review` in one pass, with 56 calls, 4 repairs, 0 failed calls, $0.94;
  - valuation complete: FY2028 anchors $146 / $631 / $1,062 against $718.67;
  - 10 team requests and no resets;
  - structured output sent on 38 of 60 passes, with 3 fallbacks.

## Known issues and limits

- Anthropic rejects `COMPANY_GENESIS`, `BUSINESS_PROCESS` and `DECISION_SYNTHESIS` schemas ("compiled grammar is too large"). The fallback handles it, at the cost of one unbilled 400 per schema per worker process. Splitting multi-artifact contracts would be needed to bring them under the limit.
- `VALUATION`, `OPERATING_SCENARIOS`, `AI_REVIEWER` and the registry agents (source-reader, metric-normalizer) use `z.record` or open objects, so they get no structured output.
- The operating-company FCFF path has no mock e2e coverage. The mock operating-company pipeline stops at `historical_record`.
- No sourced beta or equity risk premium: [#42](https://github.com/ToRRIIDeR97/Investing-Research-Pipeline/issues/42).
- Runs `7fa1f00a` and `1d427f3f` wait at the human-review gate.
- Deferred: short evidence labels (E1, E2, …) for citations; vector search, which needs an embedding provider via `RESEARCH_EMBEDDING_*`.

## Local state

- The worker runs `main` with the Anthropic overrides in the "research worker (main, Anthropic)" terminal tab. The web app on port 3002 runs `main`.
- The feature branches, the integration branch and the agent worktrees are deleted. The scratch databases `rr_test_f1`, `rr_test_f2` and `rr_test_f4` are dropped. `research_os_test` is kept.
- This handover file is not committed, like the others in this folder.
