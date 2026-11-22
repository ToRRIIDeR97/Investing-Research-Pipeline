# Next.js security upgrade and visible Wikimedia lookup speed

Branch `claude/ui-remaster` (uncommitted UI remaster on base `f356f2c`). One agent (TOR-1) wrote this plan, the tests and the code; the verification tests are not independent or hidden.

## Feature map

### Task A: Next.js advisory

- **Trigger:** `npm run build` on Next 16.4.1 stopped with `SecurityFatalError` (the build refuses a version with a known advisory).
- **Evidence (baseline `npm audit --json`, saved as `scratchpad/audit-before.json`):** `next` is moderate, range `16.0.0 - 16.4.4`, through seven GitHub advisories. All of them name `16.4.5` as the first patched 16.x release (checked with `gh api advisories/<id>`):
  - GHSA-mfr8-8qww-v76h (`use cache` through `unstable_cache`);
  - GHSA-vc7v-qv4w-wrv8 (nested `use cache` root params);
  - GHSA-7qx7-33qx-rqx2 (SVG rejection bypass in image optimisation);
  - GHSA-f3mh-rxg3-f5g2 (HttpOnly cookie exposure on Edge routes);
  - GHSA-pc58-hwjq-p385 (response injection when forwarding fetched responses);
  - GHSA-rhh4-g77r-r9qj (`use cache` binary arguments);
  - GHSA-vvgp-ww4w-46vf (fallback shell cache poisoning).
- **Lowest fix in the same major:** 16.4.5 (released 2026-11-03). 16.4.6 only has backported bug fixes, so it isn't needed. `eslint-config-next` is pinned to match (`^16.4.1`), and 16.4.5 exists, so it moves too.
- **Upgrade notes, 16.4.2 to 16.4.5:**
  - 16.4.2 has Turbopack consistency and GC fixes, which affect only the build.
  - 16.4.3: "Don't load the app-page runtime in proxy.ts". This changes how `src/proxy.ts` is loaded, not its API; we still export `proxy` and `config`. It also has font and OpenTelemetry fixes.
  - 16.4.4 has Turbopack CSS and CSP-nonce fixes, and swaps jsonwebtoken for fast-jwt internally.
  - 16.4.5 has security fixes only.
  - None of these change the route handler API, `next.config.ts` `headers()`, or proxy semantics. **Expected breakage: none.**
- **Consumers:**
  - `src/proxy.ts`: host, CSRF and token guard;
  - `next.config.ts`: frame headers;
  - every `src/app/api/**/route.ts`;
  - the turbopack `next build`;
  - `eslint.config.mjs` through `eslint-config-next`;
  - the dev preview `pragma-preview` (webpack dev on port 3110).
- **Install layout:** the worktree's `node_modules` is a junction to the main checkout's `node_modules`, which other worktrees share too, and a `test:db` run was using it. Installing through the junction would upgrade every checkout. **Decision:** remove only the junction (`rmdir`, not the target), then run `npm ci` in this worktree for a real local `node_modules`. This happens with the preview stopped and no `test:db` process running. The main checkout stays on 16.4.1 until this branch merges.

### Task B: Wikimedia lookup speed

- **Trigger:** a new company's logo takes about 30 s because `spacingMs()` is 6.5 s without `WIKIMEDIA_CONTACT` (Wikimedia allows 10 requests a minute for an unidentified User-Agent and 200 with contact details). Nothing tells the operator why, or how to fix it.
- **Causal path:**
  1. `CompanyLogo` and `Leadership` call `useCompanyProfile`.
  2. The hook POSTs to `/api/company-profiles`.
  3. That calls `lookupCompanyProfiles` (`store.ts`).
  4. `lookupCompanyProfiles` calls `getCompanyProfilesWithin` (`cache.ts`, 2.5 s deadline), then `resolveOnce` and `resolveCompanyProfile`.
  5. `resolveCompanyProfile` calls `wikimediaFetchJson` (`resolve.ts`: limiter, spacing, User-Agent, Retry-After).
- **Guarantees to keep:**
  - one request at a time;
  - a 429 or 503 honours Retry-After (at least 60 s) and is never cached;
  - no operator detail in the User-Agent unless `WIKIMEDIA_CONTACT` is set;
  - the contact value is sanitised (`[^\w@.:/+~-]` stripped, 120 characters at most).

## Parts

| ID | Outcome | Criteria | Files | Depends on |
| --- | --- | --- | --- | --- |
| P1 | Next 16.4.5 installed and locked; `npm audit` shows no `next` advisory; the four checks pass; `/`, `/assets` and `/assets/<id>/view` render | AC-1, AC-5 | `package.json`, `package-lock.json`, local `node_modules` | none |
| P2 | Lookup identity is explicit: `wikimediaIdentified()`, `wikimediaSpacingMs()`, and a single server log line the first time lookups run unidentified | AC-2 | `src/lib/company-profiles/resolve.ts` | none |
| P3 | The API reports `throttled` while lookups are pending and unidentified; the UI shows a quiet note where logos or leadership are still loading | AC-3 | `store.ts`, `use-company-profiles.ts`, `company.tsx` | P2 |
| P4 | `docs/operations.md` and `.env.example` explain the limit, the log line, what to put in `WIKIMEDIA_CONTACT` (and what not to) and how to check it took effect | AC-4 | `docs/operations.md`, `.env.example` | P2 |

## Acceptance criteria

- **AC-1:** `next` and `eslint-config-next` are `^16.4.5` in `package.json`. The lockfile and the installed `next` are 16.4.5 or later, still major 16. Tests: `acceptance/ac1-next-patched.test.ts`.
- **AC-2:** Tests: `acceptance/ac2-wikimedia-identity.test.ts`.
  - `wikimediaIdentified()` is false when `WIKIMEDIA_CONTACT` is unset, blank, or sanitises to nothing, and true otherwise.
  - `wikimediaSpacingMs()` is 6 500 unidentified and 400 identified.
  - `createUnidentifiedNotice(log)` logs one line, once, and only while unidentified. The line names `WIKIMEDIA_CONTACT`, the 10 and 200 limits, and the operations doc.
  - `wikimediaFetchJson` emits that line before its first unidentified request.
  - The existing guarantees still hold: the identified User-Agent carries the sanitised contact, and a 429 with `Retry-After` blocks later calls without a request.
- **AC-3:** Tests: `acceptance/ac3-throttled.test.ts`, plus the browser check.
  - `lookupThrottled(pending, identified)` is true only when keys are pending and lookups are unidentified.
  - The store returns it as `throttled`.
  - The client hook carries it into `ProfileState.throttled`.
  - `Leadership` shows the slow-lookup note while loading and throttled.
  - The monogram gets the same text as its `title`.
- **AC-4:** Tests: `acceptance/ac4-docs.test.ts`.
  - `docs/operations.md` mentions the log line's opening words, `WIKIMEDIA_CONTACT`, the 6.5 s and 0.4 s spacing and the slow-lookup note.
  - `.env.example` keeps `WIKIMEDIA_CONTACT` empty and explains the 10 and 200 limits and the format.
- **AC-5:** `npm audit` no longer lists the seven advisories. `npm run lint`, `npx tsc --noEmit`, `npm run test:unit` and `npm run build` pass. The three pages render in the browser pane. Tests: `verification/v1-audit.test.ts`, plus the command log below.

Verification tests (author-owned, same author):

- `verification/v1-audit.test.ts`: runs `npm audit --json` (network, free). It asserts no `next` advisory remains and that `next` isn't listed at all.
- `verification/v2-privacy.test.ts`:
  - The notice never contains the contact or other environment values.
  - The unidentified User-Agent is unchanged from AC-3b.
  - Hostile contact values are still sanitised.
  - `.env.example` ships no value.

## Freeze

- Base SHA `f356f2c` (plus the uncommitted remaster).
- The frozen copy is in the session scratchpad, `frozen/next-security-and-wikimedia/`.
- Test changes after the freeze: see "Test changes".

## Test changes

- **AC-5, `verification/v1-audit.test.ts` (review round 1):** the test now skips when `npm audit` returns no JSON report (the npm registry is unreachable).
  - **Why:** `npm run test:db` globs `Implementations/*/verification/*.test.ts`, so the database suite would otherwise fail offline for a reason unrelated to the database.
  - **What stays the same:** every assertion. With a report, `next` must be absent and none of the seven advisory IDs may appear.
- No other test changed. `diff -r` against the frozen copy shows only this file.

## Completion evidence

### Install

1. Stopped `pragma-preview`, after the parent session stopped its hung `test:db`.
2. Removed only the worktree's `node_modules` junction.
3. Ran `npm ci` in the worktree, which added 455 packages.

Result: the worktree has `next` 16.4.5, and the main checkout's `node_modules` is still on 16.4.1. The lockfile diff touches only `next`, `@next/*` and `eslint-config-next` (all 16.4.5).

### Required checks

All four ran on the final tree with Next 16.4.5:

| Command | Result |
| --- | --- |
| `npm run lint` | exit 0: 0 errors, 121 warnings (all existing) |
| `npx tsc --noEmit` | exit 0 |
| `npm run test:unit` | exit 0: 719 tests, 656 pass, 0 fail, 63 skipped (database or paid gates) |
| `npm run build` | exit 0: "Next.js 16.4.5 (Turbopack)", "Compiled successfully", no `SecurityFatalError`; one existing file-tracing warning in `src/lib/research/memory/indexing.ts` |

### Audit

`npm audit`: `next` is no longer listed. The count went from 12 to 11 moderate, and the 11 left are dev-only (drizzle-kit/esbuild, typescript-eslint, minimatch). `npm audit --omit=dev`: 0 vulnerabilities.

### TOR tests

Ran `npx tsx --test` on this package's `acceptance` and `verification` tests plus `ui-remaster/acceptance/ac3b-polite-lookups.test.ts`: 18 of 18 pass.

### Browser pane (`pragma-preview`, Next 16.4.5 webpack dev, port 3110)

- `/`: renders the SoFi hero with its logo and leadership photos.
- `/assets`: renders four cards. The Apple, Bitcoin and SoFi logos load from `commons.wikimedia.org` at 330 px.
- `/assets/92303fee-…/view`: renders the hero, the key numbers and the thesis, with no console errors.

### Live throttled check

Free, unidentified requests, and no personal detail sent.

1. **New company:** a `POST` for COST, which wasn't cached, answered `pending: ["ticker:COST"], throttled: true`. Thirty-two seconds later it answered with the logo and `throttled: false`.
2. **Server log:** the dev server logged exactly one `[company-profiles] Wikimedia lookups are unidentified: …` line.
3. **UI note:** I deleted the `ticker:SOFI` row in the preview copy `research_os_nb_preview`. The view page then showed "Still looking up this company…" under the Leadership placeholder, with the same text as the monogram's tooltip. About 38 s later the row was back, the note was gone, and the leaders and logo were back.
