# Adaptive research reports

## Problem and behavior

The current export projects rich analytical artifacts into 25 fixed sections after
review. A company-specific question can disappear from the report, and the human
does not approve the exact exported text. Use Asset Research Agent Framework v2.1
as analytical coverage and the supplied JD report as an editorial reference.

For example, a retailer's report can add a section on loss-making expansion,
explain the mechanism and counterevidence, and cite the underlying evidence.
Required coverage remains visible even when evidence is unavailable. New reports
are composed before review; approval binds their exact content and input snapshot.

## Scope and invariants

Keep the 24 stages, durable jobs, both human gates, typed artifact source of truth,
budget accounting, and export before refresh before completion. Reuse the existing
model harness, artifact table, source corpus, and mock provider. Preserve all
pre-existing working-tree edits. Historical reports keep their legacy renderer.
No new dependencies, paid runs, commits, or deployment are needed.

Work touches research planning, reporting, historical evidence linkage, general
decision instructions, reviewer/export handlers, approval route, report read model,
and the existing report/review UI. Report composition and bounded repair run inside
the ai_reviewer stage. Evidence investigation is bounded to the accepted corpus;
unavailable evidence is recorded for follow-up, never invented or silently treated
as proof. New external discovery and automatic recalculation of an approved model
remain separate work requiring explicit dependency-aware stage replay.

## Acceptance criteria

- AC-1: New plans carry versioned framework coverage, historical cutoff policy,
  material research questions, and bounded report work. Coverage is independent
  of heading count/order; custom sections are allowed. Legacy reports still render.
- AC-2: A report preserves causal explanation, counterevidence, implications,
  assumptions and gaps. Evidence references must resolve to accepted, dated source
  passages available by the source cutoff. Artifact references must resolve to the
  supplied snapshot. Tables use artifact data rather than model-authored numbers.
- AC-3: Required coverage has satisfied/qualified/blocked/not_applicable outcomes.
  Missing coverage, unexplained exceptions, and unsupported satisfied conclusions
  fail validation. No-moat conclusions can satisfy a completed investigation.
  A blocked material question withholds the investment conclusion.
- AC-4: The worker plans and writes sections, reviews the complete report, and
  permits at most one targeted repair round per input snapshot. Retries reuse
  cached tasks and persisted sections. Unresolved research gaps remain explicit.
- AC-5: Report versions and input fingerprints are immutable and reproducible.
  A human approval must name the report hash shown to the reviewer. A changed
  report or changed upstream content invalidates approval and export. Duplicate
  approval of the same version is idempotent. Export reproduces approved text.
- AC-6: General decision prompts derive risks from the asset profile and evidence.
  Historical diagnosis cites metric-specific evidence or declares a source gap;
  it must never attach arbitrary claims or a fabricated UUID.
- AC-7: The report is readable before approval and after export in the existing
  UI, including citations, tables, custom sections, and limitations. Model text
  cannot inject HTML/scripts. Both human gates remain explicit.
- AC-8: Resume and legacy compatibility preserve export/refresh completion rules.
  Persistence failures propagate. No report can be approved before it exists for
  a run using the new framework.

## Sequence

1. Author both test sets and record baseline; preserve a starting snapshot.
2. Add coverage, report contracts, validation, rendering, and immutable snapshots.
3. Integrate planning, section writing, bounded review/repair, mock responses.
4. Fix evidence linkage and company-specific decision assumptions.
5. Bind human approval/export to report/input hashes and expose report UI.
6. Run tests, database mock acceptance, typecheck, and browser visual inspection.

## Verification

Working directory: repository root. Existing runner is Node test through tsx.

- Visible: `npx tsx --test Implementations/adaptive-research/acceptance/*.test.ts`
- Separately designed: `npx tsx --test Implementations/adaptive-research/verification/*.test.ts`
- Regression: `npm run test:unit`
- Types: `npx tsc --noEmit`
- Database: load local environment without printing secrets; set
  RUN_DB_INTEGRATION=1, RESEARCH_MODEL_PROVIDER=mock,
  RESEARCH_ACCEPTANCE_PROVIDER=mock; run
  `npx tsx --test tests/sofi-research-e2e.test.ts` against local PostgreSQL 5433.
- Manual: inspect a report and review screen in a browser, including narrow width.

AC-1 through AC-6 have deterministic checks in both sets. AC-4/5/8 also require
database execution; AC-7 requires render checks and visual evidence. The same
root agent authors tests and implementation. Verification tests are separately
designed, not hidden or independently authored.

## Completion evidence

Initial implementation completed on 2026-09-25 by the root agent without delegation
or paid provider calls. The later user-authorized live test is recorded below.
The existing working tree was retained; a pre-change source snapshot is under
`%TEMP%/codex-adaptive-research-baseline`. Core report tests preceded implementation:
six new-feature checks failed at the explicit missing-module assertion, and the
legacy-rendering check passed. The metric-evidence check then reproduced a
fabricated all-zero claim ID before that behavior was corrected. Additional
orchestration, API and persistence tests were added during integration. The only
change to an initial assertion fixture was a TypeScript literal annotation.

Observed final checks:

- `npx tsc --noEmit`: passed.
- `npm run test:unit`: 190 passed, 3 database-related tests skipped, no failures.
- Both task test folders, with RUN_DB_INTEGRATION=1: 13 passed, no skips.
- `npx tsx --test tests/sofi-research-e2e.test.ts`: 3 passed. Covers plan approval,
  draft report, stale-hash rejection, human-requested revision, return to human
  review, preserved prior report, exact approved-text export, and refresh completion.
- `git diff --check`: no whitespace errors; repository CRLF warnings only.
- Browser vision: report/review screens on local port 3101, desktop and 390x844.
  Narrative and notices were readable; the table scrolled within the narrow page.
  Removed an inherited search input that did not filter the new report.

The Windows database tests loaded `.env`, used WINDOWS_DATABASE_ADMIN_URL with
database path `research_os`, and set RESEARCH_MODEL_PROVIDER and
RESEARCH_ACCEPTANCE_PROVIDER to `mock`. The configured test role lacked table
permissions; no grants or account settings were changed. The revision-path test
also caught an incorrect stage retry column during implementation; that reference
was removed and the expanded integration test subsequently passed.

AC-1 through AC-8 are covered by the implementation and checks above, within the
declared accepted-corpus investigation scope. The legacy renderer remains available.
No migration, dependency, commit, or deployment was created. The separately
designed verification tests were run by the same author, not an independent agent.

Remaining limits: model-generated reasoning still needs live evaluation against
the JD editorial benchmark. Re-investigation uses accepted evidence and existing
analytical artifacts. Automatic discovery of new external sources and dependent
model recalculation remain outside this implementation. No real investment report
has been approved on the user's behalf.

The historical research-depth plan describes an earlier architecture; this is
the authoritative plan for this task, without relocating historical work.

## Live SOFI validation, 2026-09-25

The user explicitly authorized a paid SOFI test with DeepSeek V4.1 Flash for every
required model role. Run d2ea550f-7068-4706-9a62-abc89b4ceb9f uses the existing
$10 application budget. Final human investment approval remains pending.

Preflight found that report contracts were validated but absent from first-attempt
prompts. Added a database acceptance assertion; it failed with "Missing
first-attempt schema for report_outline". The outline, section, and reviewer
packets now include their output schema. All 16 existing task/database checks
and TypeScript passed after that correction.

The paid run then stopped at valuation. The model returned diluted_shares as
1,351,990,000 individual shares, matching the supplied SEC fact; the handler
understood only denominators in millions. This is a parser failure, not missing
financial evidence. AC-L1: normalize explicitly named raw-share and million-share
fields by their defined units; preserve supported book-value inference; reject
missing, zero, negative, or non-finite denominators rather than substituting the
reported minimum. Existing minimum dilution adjustment remains in force.
Acceptance share-denominator.test.ts and verification share-units.test.ts cover
this requirement with different values and boundary cases. The root agent owns
both tests and the correction. The full live result and comparison will be saved
under live-sofi-2026-09-25/.

AC-L2: when a typed research task with an explicit output contract fails semantic or schema validation, its repair
must receive the original submitted task, full output schema, and complete prior
response, including fields beyond character 12,000. It must still pass the same
validators. The live decision response had one semantic risk-classification
error; its repair lost the tail and invented field names because the old repair
prompt included only a 12,000-character excerpt and key names. Acceptance
repair-context.test.ts and verification repair-tail.test.ts exercise the actual
runner with scripted providers, including different prompt paths and a late field.
Default registry-only tasks retain the existing compact-repair size contract.
Explicit contracts retain the response-byte limit, deadline, and repair-count bound.

AC-L3: the full-report reviewer receives every structured section and its exact
content/input hashes, with complete artifacts and source passages once each.
Do not duplicate the rendered Markdown or embed another copy of the corpus in
the document field. The original saved report must reconstruct byte-for-byte
from this review representation. The live provider rejected the initial large
request with HTTP 400 without a detailed reason; duplicate payload size is the
working diagnosis, not a provider-confirmed cause. The SOFI database acceptance
test checks the sent packet; verification/review-packet.test.ts independently
reconstructs a report with long evidence and table data and checks both hashes.

### Live test outcome

Run d2ea550f-7068-4706-9a62-abc89b4ceb9f reached waiting_for_human on
2026-09-25 at 04:56:51 UTC. All six required model roles used
deepseek-v4.1-flash through opencode-go-direct: 32 logged harness attempts and
40 provider requests including repairs and a rejected request. Application cost
estimate: $1.419156; this is not a provider invoice and excludes the small separate
smoke/receipt probes. No investment approval was submitted; export and refresh
remain pending. The report has 16 sections and withholds its conclusion.

The final automated review returned conditional_pass with 15 findings, including
six high-severity evidence/research findings. This is not a clean research-quality
pass. The live evaluation found better causal explanation and gap disclosure, but
also citation mismatches, 99/200 historical cells, 19,712 paragraph words, and 98
overly detailed tables. See [the comparison](live-sofi-2026-09-25/comparison.md)
and [the proof ledger](live-sofi-2026-09-25/proof.json).

The schema assertion failed before the initial prompt correction. The valuation
unit issue and decision-repair context loss reproduced in the real paid run.
The AC-L3 verification initially failed at the missing review projection, then
passed exact reconstruction after implementation. Reviewer prompt size fell from
4,199,617 to 1,350,082 characters; the retry succeeded without regenerating any
report section or changing report content. The provider did not explain the first
HTTP 400 beyond Bad Request, so payload size remains an inference.

Final checks: TypeScript passed; unit suite 190 passed with three database skips;
targeted acceptance, verification and SOFI database suite 23 passed with no skips.
The live valuation check verified five projection denominators and 15 adjusted
price targets. Browser vision confirmed readable narrative and the withheld
notice, while exposing poor readability in the raw artifact tables. The root
agent authored both implementation and verification. No delegation, migration,
dependency, commit or deployment occurred.
