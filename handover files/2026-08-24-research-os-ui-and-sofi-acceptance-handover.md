# Research OS handover - UI report and SOFI live acceptance

**Date tag:** 2026-08-24
**Last updated:** 2026-08-24
**Scope:** Research OS V4 UI, report read model, output validation, agent writing rules, and the latest paid SOFI run
**Status:** current

## Executive summary

The current worktree contains a large, uncommitted Research OS upgrade. It adds the seven-tab research reader, saved and URL-backed chart views, a clearer run console, stronger artifact validation, Next.js 16 support, and automatic loading of the project `unslop` skill for every new research-agent session.

The latest paid SOFI V4 run reached `waiting_for_human`. All 21 automated stages completed, the database holds 39 artifacts with status `validated`, and the latest completed AI review returned `pass` with a quality score of 92. The run cost US$0.530049 against a US$10 cap. Export and refresh scheduling remain pending until a human records a decision.

This is good progress, but the repository is not clean enough to call finished. TypeScript, unit tests, the webpack production build, and whitespace checks pass. ESLint exits successfully with 151 warnings. The default Turbopack production build cannot create its local CSS worker in the managed environment. One paid model call also used Qwen because `.env.local` differs from the DeepSeek-only example configuration.

## Current state

- Repository: `/Users/japardinathaniel/Documents/GitHub/Investing Research Pipeline`
- Branch tip inspected: `8060ee7d`, `feat: replace research harness backend`
- Framework: Next.js 16.3.1, React 19.2.8, TypeScript 5.8
- Pipeline: V4
- Development command: `npm run dev`
- Local URL: `http://localhost:3000`
- Current SOFI research page: `/assets/87c0cd44-a8cd-4eb2-80db-c2b36b0c8c08/research/general?run=59d6397b-3f09-40f4-90ae-cb240cfbad36`
- The development server reported ready on 2026-08-24. The shell could not probe its port across the managed session boundary, so this session did not record an HTTP status assertion.
- The worktree has 59 modified tracked files plus untracked application files, tests, skills, documents, archives, and `Temp Download/`. Preserve all unrelated work. Do not reset or delete it.
- No commit was created for this handover.

## What changed

### Research reader and application UI

- `src/app/assets/[id]/research/[section]/page.tsx` adds seven report tabs: General, Financials & KPIs, Valuation, Thesis & Risks, Evidence, Backtests, and Updates.
- `src/lib/research/report-ui.ts` maps the 25 canonical report sections to those tabs, keeps stable anchors, preserves the selected run in links, rejects unsafe Markdown link schemes, and pivots financial observations into period columns.
- `src/lib/research/artifacts/read-model.ts` assembles persisted artifacts, evidence, metrics, canonical Markdown, and incomplete-section state for the reader.
- `src/components/report/` renders the report and its structured data.
- `src/components/charts/ChartBuilder.tsx`, `src/lib/charts/`, `/api/charts/query`, and the asset chart-view routes add chart construction, saved views, URL state, range selection, and sparse-series alignment.
- The home, asset library, asset detail, run, review, and application-shell screens were remade around the same run and artifact data.
- `src/lib/research/run-console.ts` selects the active human checkpoint and hides recovered retry attempts from the open-failure count.

### Research and output quality

- Historical records, diagnosis, operating models, scenarios, valuation, decisions, and AI review have tighter validators and regression coverage.
- The operating-model validator now accepts financial-services revenue only when the model decomposes it into operational drivers. Direct CAGR assumptions still fail.
- The AI reviewer rejects false claims about reconciled backtest counts and routes invalid review output through revision.
- The report read model retains source quotes, locators, artifact version, and status instead of flattening missing provenance into filler.
- Quality gates block materially incomplete twenty-quarter coverage and require the canonical V4 reviewer verdict.

### Agent runtime and writing rules

- `.opencode/skills/unslop/SKILL.md` is the local project copy of Cursor pstack's MIT-licensed skill.
- `src/lib/agent-harness/runner.ts` loads `unslop` into every new research-agent system prompt, even when the caller does not name a skill.
- `tests/agent-harness.test.ts` proves the shared runner includes the unslop instructions.
- `.opencode/README.md` and `docs/open-source-provenance.md` record how the skill is loaded and where it came from.
- The source-reader total deadline is now 45 minutes with three model attempts. A resumed transport failure starts with a compacted packet instead of replaying the full source packet.
- `src/lib/agent-harness/session-store.ts` writes JSON values through an explicit JSONB-safe serializer.

### Platform update

- `package.json` and `package-lock.json` move the app to Next.js 16.3.1 and React 19.2.8.
- The lint script now runs ESLint directly because `next lint` is no longer used.
- `next.config.ts` sets `outputFileTracingRoot` to the repository root.
- `tsconfig.json` includes Next development types and uses the React JSX transform.

## Latest paid SOFI run

Run ID: `59d6397b-3f09-40f4-90ae-cb240cfbad36`

- Asset: SoFi Technologies, Inc.
- Created: `2026-08-19T16:24:28.918Z`, which is 2026-08-20 in Singapore
- Status: `waiting_for_human`
- Budget: US$10
- Recorded cost: US$0.530049
- Automated stages completed: 21 of 21
- Human review: waiting
- Export: pending
- Refresh schedule: pending
- Persisted artifacts: 39 with status `validated`
- Latest completed AI review: `pass`, quality score 92

The provider log for this run contains:

- `deepseek-v4-flash`: 117 successful calls, 13 failed calls, and 1 cancelled call, with US$0.519162 recorded cost
- `qwen3.7-plus`: 1 successful call, with US$0.010887 recorded cost

The Qwen call matters. `.env.local` currently sets `RESEARCH_VISION_MODEL=qwen3.7-plus` and `RESEARCH_ASSET_ANALYST_FALLBACK_MODEL=qwen3.7-plus`. `.env.example` sets both to `deepseek-v4-flash`. If the next paid run must stay within the user's DeepSeek-only approval, align those local values before sending another prompt.

The AI reviewer has a history of retries and revisions on this run. One review attempt returned `pass` prose but failed downstream self-consistency validation. A revision completed successfully. Earlier valid reviews noted incomplete historical coverage and valuation inconsistencies. The latest review passed, but the human reviewer should inspect those facts instead of relying on the final score alone.

## Verification

The following checks ran on 2026-08-24 against the current worktree:

- `npx tsc --noEmit`: passed with no output.
- `npm run test:unit`: passed after local IPC permission was granted. Result: 267 tests, 263 passed, 4 skipped, 0 failed.
- `npm run lint`: exited 0 with 0 errors and 151 warnings.
- `npx next build --webpack`: passed. Next compiled, ran TypeScript, generated all static pages, and collected build traces.
- `git diff --check`: passed.
- `npm run dev`: Next reported ready at `http://localhost:3000`.

The first unit-test attempt failed because `tsx` could not create its local IPC socket inside the sandbox. The permitted rerun passed. This was an environment restriction, not a test failure.

`npm run build` failed twice, including once with elevated permission, because Turbopack could not bind the local worker it uses while processing `src/app/globals.css`. The same source tree built successfully with `npx next build --webpack`. Do not report the default build as passing until it succeeds in the intended deployment environment or the project deliberately chooses webpack for production builds.

The four skipped unit-suite groups require database integration or explicit integration flags. This session did not run the SOFI database acceptance suite, research artifact registry integration, research run integration, or SOFI backtest persistence integration.

## Known issues

1. The current `.env.local` permits Qwen fallbacks. This does not match a strict DeepSeek-only live-run scope.
2. ESLint reports 151 warnings. New UI warnings include synchronous state updates inside effects, missing effect dependencies, and unused imports or variables in the report reader, run screen, review screen, shell, and chart builder.
3. The package's default `npm run build` uses Turbopack and fails in this managed environment. The webpack production build passes.
4. The latest SOFI run is waiting for a real human decision. Export and refresh scheduling should stay blocked until that decision exists.
5. Reviewer history records incomplete historical coverage and some valuation or backtest inconsistencies. The latest reviewer pass does not erase those earlier findings.
6. The worktree mixes product code, tests, documentation, local skills, downloaded archives, a spreadsheet, and `Temp Download/`. Separate and review these groups before committing.

## Next steps

1. Review SOFI run `59d6397b-3f09-40f4-90ae-cb240cfbad36` in the seven-tab reader. Check historical coverage, valuation consistency, source provenance, and the revised AI review before recording the human decision.
2. If another paid run is needed, change the two Qwen values in `.env.local` to `deepseek-v4-flash` first. Confirm all model environment keys match the approved provider and model.
3. Fix the React effect warnings in the new UI files, then rerun ESLint. Decide separately whether the older unused-code warnings belong in this change.
4. Run `npm run build` in the real deployment environment. If Turbopack fails there too, either fix the worker constraint or deliberately change the production build script to `next build --webpack`.
5. Run the database-backed acceptance suites only against the local test database and preserve existing SOFI records.
6. Split the worktree into reviewable commits. Keep downloaded datasets and `Temp Download/` out of application commits unless they are intentionally part of the project.

## Practical caveats

- Do not auto-approve `human_review` to make the run look complete.
- Do not weaken artifact validators to silence model-output failures.
- Do not send another paid prompt until the model fallback settings match the approved scope.
- Keep generated research prose under the project unslop skill. Schemas and validators still decide factual and structural validity.
- Preserve V3 historical records as read-only. New runs use V4.

## Files to start with

- `src/app/assets/[id]/research/[section]/page.tsx`
- `src/lib/research/artifacts/read-model.ts`
- `src/lib/research/report-ui.ts`
- `src/lib/research/run-console.ts`
- `src/components/report/`
- `src/components/charts/ChartBuilder.tsx`
- `src/lib/charts/`
- `src/app/assets/[id]/run/page.tsx`
- `src/lib/agent-harness/runner.ts`
- `src/lib/agent-harness/session-store.ts`
- `.opencode/skills/unslop/SKILL.md`
- `tests/agent-harness.test.ts`
- `tests/report-ui.test.ts`
- `tests/research-report-read-model.test.ts`
- `tests/run-console.test.ts`
- `tests/ui-remaster.test.ts`
- `handover files/2026-08-10-agent-harness-v4-live-run-handover.md`
