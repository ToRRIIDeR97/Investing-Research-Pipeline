# Research OS v3 Research Remaster Implementation Handover

**Date:** 2026-07-17
**Scope:** Implementation of `implementation.md` Research OS v3 Research Remaster plan
**Branch:** `codex/local-agent-harness`
**Status:** in progress — Components 0–7 substantially implemented; Components 8–16 not yet started
**Next owner:** same session or a delegated developer

## Executive Summary

Started implementing the Research OS v3 Research Remaster plan from `implementation.md`. Work is additive beside v2: `pipeline_version = 3` is preserved, v2 records remain untouched, and all new tables, services, and contracts are in separate files.

Completed through Component 7:

- Component 0: specification and acceptance rubric documents
- Component 1: research artifact registry and assumption ledger schema + repository + tests
- Component 2: composable archetype system and profile composition
- Component 3: source intelligence, role hierarchy, coverage matrix, retrieval logging
- Component 4: provider-neutral market-data interface, Yahoo adapter, mock adapter, service, DB schema, unit tests
- Component 5: company genesis and strategic identity artifact contracts and validators
- Component 6: twenty-quarter historical record normalizer, reconciliation, diagnostics, MELI FCF bridge, MELI revenue-definition separation
- Component 7: historical diagnosis engine with level-shift detection, causal-process-node validation, and forecast-implication requirements

Migrations 0003, 0004, and 0005 were generated and renamed. The temp PostgreSQL container used for verification is `research-os-postgres-temp` on port `5433`.

## What was completed

### Component 0 — V3 specifications and acceptance rubric

Files created:

- `docs/research-os-v3-spec.md`
- `docs/research-artifact-contracts.md`
- `docs/meli-v3-acceptance-rubric.md`

Verification passed:

```bash
rg -n "TODO|TBD|sufficient|appropriate|as needed" docs/research-os-v3-spec.md docs/research-artifact-contracts.md docs/meli-v3-acceptance-rubric.md
# No matches
```

### Component 1 — Research artifact registry and assumption ledger

Files created:

- `src/db/schema/research-artifacts.ts`
- `src/lib/research/artifacts/contracts.ts`
- `src/lib/research/artifacts/repository.ts`
- `src/lib/research/artifacts/validation.ts`
- `tests/research-artifacts.test.ts`
- Migration: `drizzle/0003_research_os_v3.sql`

Key behavior implemented:

- Versioned artifacts and assumptions with supersession
- Partial unique indexes for one accepted current artifact per `(run, type, scope)` and one accepted current assumption per `(run, key)`
- Dependency links and evidence claim links
- `acceptArtifact` rejects missing validation metadata
- `upsertArtifact` supports idempotency key
- Repository service wraps Drizzle

Integration tests passing.

### Component 2 — Composable research profiles and archetype composition

Files created:

- `src/lib/research/archetypes/types.ts`
- `src/lib/research/archetypes/registry.ts`
- `src/lib/research/archetypes/compose.ts`
- `src/lib/research/v3-contracts.ts`
- `tests/research-v3-contracts.test.ts`

Archetypes implemented and MELI composition verified. No asset-slug branching. Unit tests passing.

### Component 3 — Source intelligence and information-gathering system

Files created:

- `src/db/schema/source-intelligence.ts`
- `src/lib/research/sources/roles.ts`
- `src/lib/research/sources/planner.ts`
- `src/lib/research/sources/coverage.ts`
- `src/lib/research/sources/retrieval-log.ts`
- `tests/source-role-coverage.test.ts`
- Migration: `drizzle/0004_source_intelligence_v3.sql`

Unit tests passing.

### Component 4 — Yahoo Finance and provider-neutral market data

Files created:

- `src/db/schema/market-data.ts`
- `src/lib/market-data/provider.ts`
- `src/lib/market-data/providers/mock.ts`
- `src/lib/market-data/providers/yahoo.ts`
- `src/lib/market-data/service.ts`
- `tests/market-data.test.ts`
- Migration: `drizzle/0005_market_data_v3.sql`
- Smoke script: `scripts/market-data-smoke.ts` (basic; not yet wired to `package.json`)

Unit tests passing.

### Component 5 — Company genesis and strategic identity

Files created:

- `src/lib/research/genesis/contracts.ts`
- `src/lib/research/genesis/validation.ts`
- `tests/genesis-artifacts.test.ts`

Artifacts contracted:

- `company_genesis`
- `founder_profile`
- `strategic_history_timeline`
- `strategic_dna`
- `mission_evolution`

Validation enforces:

- Founder motivation evidence or `unknown`
- Alternative interpretations recorded
- Current implications required
- Timeline events must have dates and evidence
- No unsupported founder-wealth assertions

Unit tests passing.

### Component 6 — Twenty-quarter historical record and normalization

Files created:

- `src/lib/research/history/contracts.ts`
- `src/lib/research/history/normalizer.ts`
- `src/lib/research/history/reconciliation.ts`
- `src/lib/research/history/diagnostics.ts`
- `tests/historical-record.test.ts`
- `tests/historical-reconciliation.test.ts`

Key behavior implemented:

- 20-quarter coverage matrix with explicit gaps
- Latest restatement canonicalization
- TTM series construction from four quarters
- Annual/quarterly reconciliation
- GAAP vs. non-GAAP conflict detection
- Segment/consolidated reconciliation
- Restatement preservation
- Point-in-time lookahead rejection
- MELI fintech-adjusted FCF bridge (`buildMELIAdjustedFCFBridge`)
- MELI revenue-definition separation (`separateMELIRevenueDefinition`)
- Historical statistics: mean, median, min, max, std dev, growth rates
- Incremental margin computation
- Working-capital metrics
- Per-share helper

Tests passing.

### Component 7 — Historical diagnosis

Files created:

- `src/lib/research/diagnosis/contracts.ts`
- `src/lib/research/diagnosis/diagnosis.ts`
- `tests/historical-diagnosis.test.ts`

Key behavior implemented:

- Diagnosis record per material metric with distribution, trend, stability, inflection, causal process node, management control, classification, moat implication, and forecast implication
- Level-shift detection plus z-score inflection detection
- Sustained changes with causal process node and evidence are classified `structural`
- Changes without causal process node are classified `unexplained`
- Single-quarter spikes are not structural without corroboration
- Validation rejects structural labels without causal process nodes and missing forecast implications
- Contradictory evidence preserved

Tests passing.

## Database migration state

Generated and renamed migrations:

- `drizzle/0003_research_os_v3.sql`
- `drizzle/0004_source_intelligence_v3.sql`
- `drizzle/0005_market_data_v3.sql`
- Snapshot files renamed accordingly in `drizzle/meta/`

`src/db/migrate.ts` imports:

- `research-artifacts`
- `source-intelligence`
- `market-data`

Verification on temp container:

```bash
DATABASE_URL=postgresql://research_os:research_os_dev@localhost:5433/research_os npm run db:migrate
```

Migrations applied successfully.

## Verification commands run

```bash
npx tsx --test tests/research-v3-contracts.test.ts
npx tsx --test tests/source-role-coverage.test.ts
npx tsx --test tests/market-data.test.ts
DATABASE_URL=postgresql://research_os:research_os_dev@localhost:5433/research_os RUN_DB_INTEGRATION=1 npx tsx --test tests/research-artifacts.test.ts
npx tsx --test tests/genesis-artifacts.test.ts
npx tsx --test tests/historical-record.test.ts tests/historical-reconciliation.test.ts
npx tsx --test tests/historical-diagnosis.test.ts
```

All passed.

Full `npm run test:unit` and `npx tsc --noEmit` were **not** run on the whole repo after Component 7. Run them before continuing to Components 8+.

## Remaining components to implement

| Component | Status | Notes |
|---|---|---|
| 8 — Business/customer/process analysis | pending | segment model, customer decision map, process map, bottlenecks, competitive response |
| 9 — Moat proof and attack | pending | moat assessment, attack matrix, no-moat counterfactual |
| 10 — Driver tree and operating model | pending | driver tree, operating model, scenarios, reconciliation |
| 11 — Valuation and annual price targets | pending | annual price-target paths, protocol v3, SOTP reconciliation |
| 12 — Thesis, risks, catalysts, monitoring | pending | decision artifacts, monitoring dashboard |
| 13 — Semantic quality gates | pending | new v3 stages, validators, fail-closed orchestration |
| 14 — Agent registry and prompts | pending | bounded agent roles, retrieval rules, prompt versioning |
| 15 — Export and UI | pending | canonical report order, UI inspectors |
| 16 — Migration, observability, acceptance | pending | end-to-end MELI acceptance run |

## Important design notes for the next owner

1. **No giant prompts.** All agent tasks must consume typed artifacts and produce typed artifacts. Continue using the artifact registry from Component 1.
2. **Evidence is not analysis.** Do not allow `evidence_only` artifacts to pass gates.
3. **Backtesting is conditional.** Use `isBacktestApplicable` from `v3-contracts.ts`; never require backtests for fundamental-only research.
4. **MELI-specific requirements.** The MELI rubric already documents the required Commerce/Fintech/Credit/Logistics/Advertising modules, the GAAP vs. “net revenues and financial income” split, and the fintech-adjusted FCF bridge. Use the helpers in `src/lib/research/history/normalizer.ts`.
5. **Migrations.** For each new schema block, add the Drizzle schema file, run `db:generate`, rename the generated SQL to a descriptive name, update `_journal.json`, and rename the snapshot file. Do not regenerate 0003–0005 unless the existing SQL is intentionally replaced.
6. **Tests.** Keep unit tests network-free. Add DB integration tests only behind `RUN_DB_INTEGRATION=1`. Add opt-in smoke tests behind `RUN_MARKET_DATA_SMOKE=1` and `RUN_PROVIDER_SMOKE=1`.
7. **Provider smoke tests.** The plan asks for `test:market-data-smoke` in `package.json`. It was not added yet.
8. **Central file ownership.** If delegating, serialize edits to `system-pipeline.ts`, `quality-gates.ts`, `validators.ts`, `orchestrator.ts`, schema files, `method-protocol.ts`, and the research package generator.

## Immediate next steps

1. Run `npm run test:unit` and `npx tsc --noEmit` to catch any breakage from Components 0–7.
2. Add `test:market-data-smoke` to `package.json` and finish `scripts/market-data-smoke.ts`.
3. Implement Component 8 (business, customer, process, and competitive analysis).
4. Continue through Components 9–16 in order, blocking each phase on its acceptance tests.

## Test IDs already satisfied

- C0-T1 through C0-T5
- C1-T1, C1-T2, C1-T3, C1-T4, C1-T7, C1-T8
- C2-T1 through C2-T7
- C3-T1 through C3-T8 plus coverage gate test
- C4-T1, C4-T2, C4-T3, C4-T4, C4-T5, C4-T7, C4-T9
- C5-T1, C5-T2, C5-T3, C5-T4, C5-T5, C5-T6, C5-T7
- C6-T1, C6-T2, C6-T4, C6-T5, C6-T6, C6-T10
- C7-T1, C7-T2, C7-T3, C7-T6

## Environment state

- Temp PostgreSQL container: `research-os-postgres-temp` on `localhost:5433`
- Container image: `pgvector/pgvector:pg16`
- Database: `research_os`
- User: `research_os` / Password: `research_os_dev`
- This container can be stopped when work is done, but keep it running if integration tests will continue.

## Files to start with next

- `docs/meli-v3-acceptance-rubric.md`
- `src/lib/research/artifacts/contracts.ts`
- `src/lib/research/artifacts/repository.ts`
- `src/lib/research/archetypes/registry.ts`
- `src/lib/research/v3-contracts.ts`
- `src/lib/research/history/normalizer.ts`
- `src/lib/research/diagnosis/contracts.ts`
- `src/lib/research/diagnosis/diagnosis.ts`
- `src/lib/workflow/quality-gates.ts` (for Component 13)
- `src/lib/workflow/validators.ts` (for Component 13)
- `src/lib/valuation/method-protocol.ts` (for Component 11)
