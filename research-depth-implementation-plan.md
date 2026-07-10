# Research Depth Implementation Plan

Date: 2026-07-09
Repo: Investing Research Pipeline
Status: proposed implementation plan

## Goal

Make the research pipeline stop treating structurally complete but analytically thin runs as complete.

The current app already has the right high-level architecture: staged workflow, asset profiles, validators, source-linked evidence, AI review, human review, and exports. The problem is that many gates are presence checks rather than depth checks. A run can complete with one source document, thin evidence, no numeric valuation anchors, and an export packet that says "Fail for investment action."

This plan turns research depth into deterministic workflow state:

- Thin but useful output becomes `needs_more_work`.
- Action-ready research requires source breadth, profile coverage, valuation anchors, review pass, and human approval.
- Source gaps become first-class blockers or accepted exceptions, not passive markdown notes.
- Export packets render the truth, but do not decide completion after the fact.

## Non-Goals

- Do not rebuild the whole app.
- Do not replace the current stage FSM.
- Do not require manual review for every extracted sentence.
- Do not force deep-dive standards onto `quick_scan`.
- Do not make the pipeline never finish. It should finish as `completed`, `needs_more_work`, `failed`, or `waiting_for_human`.

## Current Failure Modes

1. Source discovery is declared but not meaningfully executed.
   - `source-discovery-agent` exists in `src/lib/opencode/agent-registry.ts`.
   - `runSystemResearchPipeline` does not call it.
   - The pipeline stores a single SEC/company context source and continues.

2. Source validation is declared but silently skipped.
   - `source_discovery` declares `validationRules: ["source_validation"]`.
   - `advanceStage` only handles `source_link_validation`, `asset_profile_validation`, and `point_in_time_validation`.

3. Completion validators check existence, not depth.
   - One source passes `source_inventory`.
   - Any completed analysis task passes `analysis_sections`.
   - Any valuation signal and any scenario pass valuation, even when scenarios have no value anchors.

4. Export-level gates are too late.
   - `research-package-generator.ts` can detect inferred source gaps and failed investment readiness.
   - The run can still be marked `completed`.

5. Human gates are auto-approved in the system pipeline.
   - The system pipeline approves research plan and human review itself.
   - This is fine for smoke tests, but not for real research runs.

6. Agent outputs bypass staging.
   - Architecture says `agent output -> staging -> validation -> accept/reject -> final table`.
   - The system pipeline inserts directly into final tables with `review_status = 'accepted'`.

## Target State

For a `deep_dive` or `full_initiation_report`, a completed run must have:

- Minimum source breadth by asset profile.
- Explicit source gaps for unavailable sources.
- Evidence claims linked to sources.
- Required modules covered with non-placeholder outputs.
- Profile-appropriate valuation lenses attempted.
- Numeric scenario value anchors or explicit blocking gaps.
- AI review result of `pass`, or explicit `needs_more_work` state.
- Human review decision when required.

For a `quick_scan`, the pipeline can complete with lower depth, but must label the output as triage only and avoid action-ready language.

## Phase 1: Add Run Quality Gates

### 1.1 Create a shared quality gate module

Add:

```text
src/lib/workflow/quality-gates.ts
```

Responsibilities:

- Load run, asset, profile, stages, tasks, sources, evidence, metrics, signals, scenarios, source gaps, review findings, and review decisions.
- Infer missing source gaps using the same logic currently embedded in export generation.
- Return a structured quality report.

Suggested type:

```ts
export interface ResearchQualityGateResult {
  status: "pass" | "needs_more_work" | "fail";
  actionReadiness: "triage_only" | "research_scaffold" | "review_ready" | "investment_ready";
  errors: string[];
  warnings: string[];
  missingCoverage: Array<{
    key: string;
    severity: "low" | "medium" | "high" | "critical";
    area: string;
    description: string;
    requiredForCompletion: boolean;
  }>;
  counts: {
    sources: number;
    evidence: number;
    metrics: number;
    valuationSignals: number;
    scenarios: number;
    scenariosWithValueAnchors: number;
    openSourceGaps: number;
    reviewDecisions: number;
  };
}
```

### 1.2 Move inferred source-gap logic out of exports

Current likely home:

```text
src/lib/export/research-package-generator.ts
```

Move reusable logic into:

```text
src/lib/workflow/quality-gates.ts
```

Then import it from the export generator so review packets and workflow validation use the same truth.

Acceptance criteria:

- Export output still shows inferred gaps.
- Workflow validation can fail or mark needs-more-work from the same inferred gaps.

## Phase 2: Implement Real Validators

### 2.1 Add missing `source_validation`

Modify:

```text
src/lib/workflow/validators.ts
src/lib/workflow/orchestrator.ts
```

Add validator:

```ts
export async function validateSourceDepth(runId: string): Promise<ValidationResult>
```

For `deep_dive` and `full_initiation_report`, require:

- At least 5 source documents, unless missing sources are explicitly recorded as source gaps.
- At least 1 primary company or issuer source.
- At least 1 filing or formal report when applicable.
- At least 1 IR/presentation/transcript source for public companies when available.
- At least 1 peer, industry, macro, or asset-class context source.
- Source quality scores present.
- Failed source attempts logged or source gaps recorded.

For `quick_scan`, require:

- At least 1 credible source.
- Source gaps recorded if source breadth is thin.

Wire `source_validation` in `advanceStage`.

Important: unknown validation rules should become warnings or errors, not silent skips.

### 2.2 Add analysis coverage validation

Add validator:

```ts
export async function validateAnalysisCoverage(runId: string): Promise<ValidationResult>
```

Checks:

- Required profile modules have outputs that are not just placeholder task rows.
- Analysis output has sections for required modules or explicit `missing_modules`.
- Each required module has either:
  - evidence support,
  - a metric observation,
  - or an explicit source gap.

Do not pass a module just because a task was inserted with the module key.

### 2.3 Add valuation depth validation

Add validator:

```ts
export async function validateValuationDepth(runId: string): Promise<ValidationResult>
```

Checks:

- Every required valuation lens has a signal.
- `not_applicable` methods have reasons.
- Deep dives require at least one numeric value anchor unless blocked by a high-severity source gap.
- Operating companies require DCF/reverse DCF attempts or explicit source blockers.
- Financials require tangible book, ROE/COE, credit/funding metrics, or explicit source blockers.
- Holding companies/funds require NAV/discount-related anchors or explicit source blockers.
- Scenarios should include bear/base/bull or an explicit reason.

### 2.4 Add AI review outcome validation

Add validator:

```ts
export async function validateReviewOutcome(runId: string): Promise<ValidationResult>
```

Checks:

- Latest AI review task exists.
- `pass_fail` is parsed.
- If `pass_fail` is `needs_more_work` or `fail`, the stage should not pass for action-ready completion.
- Unsupported claims, critical missing coverage, or category errors become errors for `deep_dive` and `full_initiation_report`.

Also fix structured-output persistence if review output is sometimes stored as a string instead of JSON.

## Phase 3: Make Completion Criteria Run-Type Aware

### 3.1 Define run-type quality thresholds

Add to:

```text
src/lib/workflow/quality-gates.ts
```

Suggested defaults:

```ts
const RUN_TYPE_THRESHOLDS = {
  quick_scan: {
    minSources: 1,
    minEvidenceClaims: 5,
    requireValueAnchors: false,
    requireHumanReview: false,
  },
  deep_dive: {
    minSources: 5,
    minEvidenceClaims: 25,
    requireValueAnchors: true,
    requireHumanReview: true,
  },
  full_initiation_report: {
    minSources: 8,
    minEvidenceClaims: 40,
    requireValueAnchors: true,
    requireHumanReview: true,
  },
  valuation_refresh: {
    minSources: 2,
    minEvidenceClaims: 10,
    requireValueAnchors: true,
    requireHumanReview: true,
  },
  thesis_investigation: {
    minSources: 2,
    minEvidenceClaims: 8,
    requireValueAnchors: false,
    requireHumanReview: true,
  },
  source_update: {
    minSources: 1,
    minEvidenceClaims: 0,
    requireValueAnchors: false,
    requireHumanReview: false,
  },
};
```

### 3.2 Populate profile completion criteria

Modify:

```text
src/db/seed.ts
```

Currently `completion_criteria_json` is `{}`. Populate profile-specific expectations:

- Operating company:
  - business segments
  - revenue drivers
  - margins
  - FCF/capex/working capital
  - share count/net debt
  - driver DCF/reverse DCF
  - peer multiple context

- Financials:
  - tangible book value
  - ROE vs COE
  - NIM
  - credit losses
  - CET1/capital
  - deposit/funding mix
  - residual income valuation

- Fund/holding company:
  - NAV
  - NAV per share
  - discount/premium to NAV
  - portfolio composition
  - leverage
  - buybacks/capital allocation

Do not rely only on `required_modules_json`; use `completion_criteria_json` for enforcement.

## Phase 4: Upgrade Source Discovery and Ingestion

### 4.1 Call `source-discovery-agent` in the system pipeline

Modify:

```text
src/lib/research/system-pipeline.ts
```

Before `fetchSecContext`/evidence extraction:

- Run `source-discovery-agent`.
- Ask for required primary sources, secondary sources, freshness constraints, failed attempts, and recommended ingestion tasks.
- Persist discovery output as a task.
- Create `source_gaps` for unavailable required sources.

### 4.2 Ingest multiple real sources

Implement source fetchers for common source types:

```text
src/lib/ingestion/source-fetchers.ts
```

Initial source types:

- SEC companyfacts and submissions.
- SEC recent filing metadata.
- Company investor relations URL.
- Earnings transcript URL when provided.
- User-uploaded source documents.
- Market data snapshot when available.

Later source types:

- Peer/industry sources.
- Macro/funding sources.
- Regulatory sources.
- On-chain or commodity data sources.

### 4.3 Persist failed source attempts

Add table if needed, or initially store in `source_gaps.metadata_json` if schema changes are not desired.

Preferred table:

```text
source_attempts
```

Fields:

- `id`
- `research_run_id`
- `asset_id`
- `source_type`
- `url`
- `attempt_status`
- `failure_reason`
- `attempted_at`
- `metadata_json`

This lets source discovery pass honestly when sources are unavailable.

## Phase 5: Use Staging Before Final Writes

### 5.1 Stop marking generated records as accepted immediately

Modify direct persistence functions in:

```text
src/lib/research/system-pipeline.ts
```

Current direct final writes:

- `persistEvidence`
- `persistMetrics`
- `persistValuation`
- `persistThesisRiskCatalyst`

Target behavior:

- Stage agent outputs first where schemas exist.
- Promote only valid outputs.
- Default review status should be `pending` for agent-generated records unless validator explicitly accepts low-risk factual extraction.

### 5.2 Expand staging schemas

Modify:

```text
src/lib/agents/staging.ts
```

Add staging schemas for:

- analysis sections
- scenarios
- thesis
- thesis drivers
- risks
- catalysts

Do not block implementation on perfect schemas. Start with minimum required fields and source/evidence linkage.

### 5.3 Link thesis/risk/catalyst records to evidence

The schema already supports `evidence_claim_ids` for drivers, risks, and catalysts.

Validators should warn or fail when:

- A thesis driver has no evidence links and no assumption marker.
- A risk is generic and not connected to source evidence or a source gap.
- A catalyst has no evidence and no explicit uncertainty.

## Phase 6: Fix Human Review and Completion Status

### 6.1 Stop auto-approving human review for real runs

Modify:

```text
src/lib/research/system-pipeline.ts
```

Current behavior:

- `approveResearchPlan(runId, "system-research-pipeline")`
- `approveHumanReview(runId, "system-research-pipeline")`

Target behavior:

- Allow auto-approval only when a request flag or env var indicates smoke-test mode.
- Example env var: `RESEARCH_PIPELINE_AUTO_APPROVE=true`.
- Default app behavior should pause for human review.

### 6.2 Make `needs_more_work` first-class

Modify:

```text
src/lib/workflow/orchestrator.ts
src/lib/workflow/validators.ts
```

Rules:

- If hard validators fail but output is useful, mark run `needs_more_work`.
- If a required stage fails with `failureState: skip_and_continue`, final run should still become `needs_more_work`, not `completed`.
- If AI review says `needs_more_work`, final run should become `needs_more_work`.
- Export can still be generated for a `needs_more_work` run, but should be labeled as scaffold or review packet, not action-ready.

### 6.3 Require review decision for completion

For run types where human review is required:

- A run cannot become `completed` without a `review_decisions` row.
- The review decision must not be `needs_more_work`, `reject`, or `archived`.
- If review decision is `approved_for_tracking`, label as tracking-ready, not position-ready.

## Phase 7: UI Changes

### 7.1 Add a quality summary endpoint

Add:

```text
src/app/api/research-runs/[id]/quality/route.ts
```

Returns `ResearchQualityGateResult`.

### 7.2 Surface quality status on Run Research page

Modify:

```text
src/app/assets/[id]/run/page.tsx
```

Add a "Quality Gates" panel that shows:

- Action readiness.
- Source breadth.
- Evidence depth.
- Required module coverage.
- Valuation anchor status.
- AI review outcome.
- Human review status.
- Missing blockers.

Make the status more prominent than raw completed-stage count.

### 7.3 Surface quality status on View Research page

Modify:

```text
src/app/assets/[id]/view/page.tsx
```

If a run is `needs_more_work`, show:

- "Research scaffold, not action-ready."
- Top missing items.
- Link to source gaps and review packet.

Do not let a completed-looking report hide failed investment gates.

## Phase 8: Export Changes

### 8.1 Use quality gate output in package generation

Modify:

```text
src/lib/export/research-package-generator.ts
```

Instead of independently inferring all readiness, call:

```ts
evaluateResearchQuality(runId)
```

Use the returned result in:

- `manifest.json`
- `09_review_packet.md`
- `02_source_intelligence.md`
- `05_valuation.md`

### 8.2 Add machine-readable quality manifest

Add to generated package:

```text
quality_gates.json
```

This should include:

- status
- actionReadiness
- missingCoverage
- warnings
- errors
- counts

## Phase 9: Testing and Verification

### 9.1 Unit tests for quality gates

Add tests for:

- One-source deep dive returns `needs_more_work`.
- Deep dive with zero scenario value anchors fails valuation depth.
- Quick scan can pass with lower thresholds.
- AI review `needs_more_work` prevents completed status.
- Accepted source gaps can allow completion only when explicitly accepted.

If the repo does not yet have a test runner, add lightweight script-level tests first.

### 9.2 Integration verification with existing runs

Use known runs:

- SOFI run: `2b75f0e3-2784-4a08-a432-0a3490506ee1`
- EXOR run: `675d5937-2f31-4419-bdab-c15c8ac5acf9`

Expected after implementation:

- SOFI should become `needs_more_work`, not `completed`, because:
  - 1 source document
  - thin evidence depth
  - no numeric scenario value anchors
  - inferred source gaps

- EXOR should become `needs_more_work`, not `completed`, because:
  - profile mismatch/category issue
  - only 2 sources
  - no current price/NAV discount anchor
  - no scenario value anchors

### 9.3 Commands

Run after implementation:

```bash
npx tsc --noEmit
npm run build
```

If adding tests:

```bash
npm test
```

or add a specific script:

```bash
npm run test:quality-gates
```

## Suggested Implementation Order

1. Create `quality-gates.ts` and move inferred gap logic into it.
2. Add `/api/research-runs/[id]/quality`.
3. Add `source_validation`, `analysis_coverage_validation`, `valuation_depth_validation`, and `review_outcome_validation`.
4. Wire validators in `stages.ts` and `orchestrator.ts`.
5. Make unknown validator rules fail loudly.
6. Change final run completion to respect quality gate status.
7. Stop auto-approving human review except in explicit smoke-test mode.
8. Call `source-discovery-agent` and persist source gaps before extraction.
9. Expand ingestion to more than one source.
10. Switch direct final writes toward staging and pending review.
11. Update Run/View UI quality panels.
12. Update exports to consume quality gate output.
13. Add tests and verify SOFI/EXOR become `needs_more_work`.

## Minimal First PR

If we want the smallest high-impact change first:

1. Add `quality-gates.ts`.
2. Add `validateSourceDepth`, `validateValuationDepth`, and `validateReviewOutcome`.
3. Wire `source_validation`.
4. Make export stage or final completion set run to `needs_more_work` when quality gates fail.
5. Add `/api/research-runs/[id]/quality`.
6. Show the quality result in the Run Research page.

This would not yet make research deeper, but it would stop thin research from pretending to be complete. That is the right first safety move.

## Acceptance Criteria

The implementation is done when:

- A deep-dive run with one source cannot end as `completed`.
- A run with no numeric scenario anchors cannot be marked action-ready.
- AI review `needs_more_work` causes run status `needs_more_work`.
- Source discovery validation is actually executed.
- Unknown validation rule names are not silently skipped.
- Exported review packet and DB run status agree.
- The UI clearly distinguishes:
  - completed/action-ready
  - completed for triage only
  - needs more work
  - failed
  - waiting for human review

## Open Questions

- Should source gaps be "accepted" by human review, or should there be a separate source-gap acceptance action?
- Should `quick_scan` ever become `completed`, or should it use a distinct status like `triage_complete`?
- Should source fetching browse the public web, or only use user-provided/official URLs and SEC APIs?
- Should profile mismatch, like EXOR being treated as an operating company, fail asset identity or fail AI review?
- Should valuation code generation be required for `full_initiation_report`, or only for operating companies with enough data?

## Recommended Product Rule

Use this mental model:

```text
Stages complete work.
Quality gates decide trust.
Human review decides acceptance.
Exports render the truth.
```

That keeps the app deterministic without rewarding shallow research.
