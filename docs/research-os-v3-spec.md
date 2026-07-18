# Research OS v3 Specification

**Status:** Implementation contract
**Version:** 3.0.0
**Date:** 2026-07-17
**Pipeline version:** `3`

This document defines the stable contract for Research OS v3. It governs workflow stages, artifacts, quality gates, and human review boundaries. v1 and v2 runs remain immutable; v3 is additive.

---

## 1. Goals

Produce decision-useful investment research whose forecasts and valuations can be traced from source evidence through the real economic processes of a company. Replace presence-based completion with evidence-backed analytical completion.

The target chain is:

```text
Decision context
→ company origins and strategic identity
→ source-role coverage
→ normalized twenty-quarter history
→ historical diagnosis
→ customer and business-process analysis
→ competitive response and moat attack
→ driver-based operating model
→ coherent operating scenarios
→ independent valuation scenarios
→ annual price-target paths
→ thesis breakers and monitoring
→ human-reviewed investment decision
```

---

## 2. Non-negotiable design principles

1. **No giant prompt.** The system is implemented as typed artifacts, bounded stage-specific agent tasks, deterministic validators, explicit artifact dependencies, versioned assumptions, and independent red-team review.
2. **Evidence is not analysis.** `evidence_only` artifacts cannot satisfy analytical completion gates.
3. **Reproducible does not mean valid.** A valuation must pass formula execution, definition reconciliation, assumption ranging, segment reconciliation, annual target reconciliation, and limitation review before it is action-ready.
4. **Preserve old runs.** v1 and v2 runs remain immutable. v3 uses `pipeline_version = 3`.
5. **Backtesting is conditional.** Backtesting runs only when an explicit, testable timing hypothesis exists. Otherwise, it is marked `not_applicable` and does not block the report.

---

## 3. Workflow stages

Allowed stages in order:

| Order | Stage | Requires human approval | Failure state |
|---|---|---|---|
| 1 | `intake` | No | `fail_run` |
| 2 | `asset_identity` | No | `fail_run` |
| 3 | `archetype_composition` | No | `fail_run` |
| 4 | `research_plan` | Yes | `pause_for_human` |
| 5 | `source_discovery` | No | `skip_and_continue` |
| 6 | `source_ingestion` | No | `skip_and_continue` |
| 7 | `evidence_extraction` | No | `fail_run` |
| 8 | `historical_record` | No | `fail_run` |
| 9 | `company_genesis` | No | `skip_and_continue` |
| 10 | `historical_diagnosis` | No | `skip_and_continue` |
| 11 | `business_process_analysis` | No | `skip_and_continue` |
| 12 | `moat_analysis` | No | `skip_and_continue` |
| 13 | `operating_model` | No | `skip_and_continue` |
| 14 | `operating_scenarios` | No | `skip_and_continue` |
| 15 | `asset_valuation` | No | `skip_and_continue` |
| 16 | `decision_synthesis` | No | `skip_and_continue` |
| 17 | `optional_backtest` | No | `skip_and_continue` |
| 18 | `ai_reviewer` | No | `fail_run` |
| 19 | `human_review` | Yes | `pause_for_human` |
| 20 | `export` | No | `skip_and_continue` |
| 21 | `refresh_schedule` | No | `skip_and_continue` |

### Stage transition rules

- A stage may start only when all previous stages are `completed` or explicitly `skipped`.
- A stage with a blocking validator failure must transition to its defined failure state.
- `skip_and_continue` stages record a `skip_reason` and do not block downstream stages unless a later validator requires them.
- `fail_run` stages mark the run `failed` and cancel all downstream stages transactionally.
- `pause_for_human` stages mark the run `awaiting_human`.

### Artifact invalidation

Updating an artifact invalidates all downstream artifacts that depend on it. The invalidation graph is deterministic and stored in `research_artifact_dependencies`.

---

## 4. Required artifacts per run type

### `full_initiation_report`

All v3 artifacts required.

### `deep_dive`

All artifacts except optional backtest and full decision record. The decision record is allowed but not required.

### `valuation_refresh`

Requires:
- `twenty_quarter_history` (if materially changed)
- `historical_diagnosis` (update)
- `operating_model` (update)
- `operating_scenario_set` (update)
- `valuation_scenario_set`
- `annual_price_target_path`
- `expected_return_matrix`
- `risk_register` (update)
- `monitoring_dashboard` (update)

### `thesis_investigation`

Requires:
- Source-role coverage for the specific question
- `company_genesis`
- `historical_diagnosis`
- `business_process_map`
- `moat_assessment`
- `investment_thesis`
- `risk_register`
- `monitoring_dashboard`

### `quick_scan`

Requires:
- `source_role_plan`
- `evidence_summary`
- `company_genesis` (brief)
- `historical_record` (latest 4 quarters or explicit gap)
- `investment_thesis` (preliminary)
- `risk_register` (preliminary)

### `source_update`

Requires only updated evidence and affected artifacts, with explicit invalidation of downstream artifacts.

---

## 5. Blocking versus non-blocking gates

### Blocking gates (hard fail if not satisfied)

1. Evidence integrity: every factual claim has a source link or explicit `no_source_reason`.
2. Source-role coverage: every required role is covered by a substantive source or an explicit gap with waiver rationale.
3. Twenty-quarter record: at least twenty quarters are accounted for, with documented gaps.
4. Historical diagnosis: core metrics have a diagnosis record.
5. Company genesis evidence: founder motivation is supported or marked `unknown`.
6. Business/customer understanding: major segments have customer and cash-conversion mechanics.
7. Operational conversion: process nodes map to financial lines.
8. Bottleneck constraints: forecast volume does not exceed binding capacity without documented expansion.
9. Moat proof and attack: every claimed moat has evidence and a tested attack.
10. Driver-based forecast: no material growth rate exists without a driver path.
11. Scenario coherence: bear/base/bull differ through business-process outcomes; probabilities sum to 1.
12. Reinvestment and balance-sheet effects: capital required is modeled.
13. Valuation validity: formula graph executes; definitions reconcile; assumptions are ranged.
14. Annual price-target reconciliation: every year from first forecast to terminal is present; final year equals terminal anchor.
15. Reverse expectations: current price is translated into operational requirements.
16. Thesis breakers and monitoring: every material assumption maps to a KPI with thresholds.
17. AI review: no unresolved critical finding.
18. Human decision: a genuine human review decision is recorded for run types that require it.

### Non-blocking gates (warnings, can proceed if documented)

- Lower-confidence evidence for minor claims.
- Missing optional source roles when the run type does not require them.
- Source gaps that are formally waived by a human reviewer.
- Backtest marked `not_applicable` when no timing hypothesis exists.

---

## 6. Human approval boundaries

Human review is required and cannot be substituted by an AI or test harness in production.

Human approval points:
- `research_plan`: approve scope, archetypes, and source strategy.
- `human_review`: approve or reject the final investment decision.

A human override of an archetype or a source-role waiver must be logged with:
- `reviewed_by`
- `override_reason`
- `confidence`
- `timestamp`

The system must reject any attempt by a non-human actor to create a `review_decisions` record outside an explicit test-only database fixture.

---

## 7. Optional backtest rules

```text
Fundamental research
├── explicit timing hypothesis → optional backtest branch (status: pending | completed | failed)
└── no timing hypothesis       → backtest status: not_applicable
```

The backtest branch is never required for a fundamental initiation report. If a timing hypothesis artifact is accepted, the backtest may run but its failure does not invalidate the fundamental report unless the thesis explicitly depends on it.

---

## 8. Versioning and supersession

### Artifact versioning

- Every artifact records `artifact_version`, `schema_version`, `validator_version`, and `prompt_version`.
- Accepting an artifact increments version or creates a successor.
- `supersedes_artifact_id` points to the prior accepted artifact.
- Superseded artifacts remain readable but are not used in export or valuation unless explicitly requested in an audit view.

### Assumption versioning

- Every assumption records `assumption_version` and `supersedes_assumption_id`.
- Allowed classifications: `disclosed_fact`, `third_party_data`, `derived_estimate`, `analyst_assumption`, `speculative_option`.
- Assumptions must be ranged (`range_low`, `range_high`) unless they are `disclosed_fact`.

### Model/protocol versioning

- Valuation protocol version is recorded on every model run.
- Protocol v1 historical runs remain readable and are not mutated.
- v3 uses protocol version `2.0` for annual price-target paths.

---

## 9. Quality gate status model

```text
status: pass | needs_more_work | fail
action_readiness: triage_only | research_scaffold | review_ready | investment_ready
```

A run reaches `investment_ready` only when:
- All blocking gates pass.
- AI review passes with no critical findings.
- Human review approves the decision.

---

## 10. Export rules

- Render accepted current artifacts only by default.
- Show superseded versions in an audit appendix.
- Never replace missing sections with generic filler.
- Display missing or rejected artifacts visibly.
- Price-target table must use executable scenario targets.
- Generated files include manifest, schema versions, model versions, source coverage, and quality-gate results.

---

## 11. Ambiguity policy

Any retained qualitative term in this specification (e.g., "material", "major", "core") must have an adjacent rubric or reviewer rule. This document is paired with `docs/research-artifact-contracts.md` and `docs/meli-v3-acceptance-rubric.md`, which define measurable rules.

---

## 12. Verification

```bash
rg -n "TODO|TBD|sufficient|appropriate|as needed" docs/research-os-v3-spec.md docs/research-artifact-contracts.md docs/meli-v3-acceptance-rubric.md
```

Any retained qualitative term must have an adjacent rubric or reviewer rule.
