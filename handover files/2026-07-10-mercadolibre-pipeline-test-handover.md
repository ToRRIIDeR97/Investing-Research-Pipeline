# Research Pipeline Handover - MercadoLibre Foreign-Issuer Test

**Date tag:** 2026-07-10
**Last updated:** 2026-07-10
**Scope:** Research OS system pipeline, foreign-issuer source discovery, structured agent output, workflow failure handling
**Status:** current

## Executive Summary

A fresh `deep_dive` system-pipeline run was executed for MercadoLibre, Inc. (`MELI`). The run successfully completed intake, identity resolution, research-plan approval, source discovery, source ingestion, and evidence extraction. It then stopped during metric normalization because the metric-normalizer returned JSON that did not contain the required top-level output keys.

The test exposed a more fundamental source-intelligence defect: MercadoLibre is a foreign private issuer and uses `20-F` and `6-K` filings rather than `10-K` and `10-Q`, but the source collector only recognizes and downloads `10-K`/`10-Q`. The system should resolve filing equivalents based on issuer jurisdiction and SEC filer status. It should not treat the absence of US domestic forms as permission to proceed with search candidates and a generic SEC context blob.

No investment-ready MELI package was produced. The quality gate correctly reports `needs_more_work` with action readiness `research_scaffold`.

## Current State

MercadoLibre asset:

```text
asset_id: 326e7eec-50ae-40dc-b334-b9b74e1b965e
canonical_name: MercadoLibre, Inc.
slug: mercado-libre
symbol: MELI
exchange: NASDAQ
MIC: XNAS
profile: operating_company v1
profile_id: 917d1675-67d1-4dc3-bae6-69e9681c437c
```

Test run:

```text
run_id: 89c8b2e9-c826-42b1-b225-9d30fb8c4bae
run_type: deep_dive
database status: running
quality status: needs_more_work
action readiness: research_scaffold
```

The database status is misleading. The metric-normalizer task is `failed`, but the research run and metric-normalization stage remain `running` because the pipeline route does not reliably transition the run/stage after an uncaught agent-output error.

The dev server was restored to normal approval behavior and left running at:

```text
http://localhost:3000
```

The OpenCode sidecar was healthy at `http://localhost:4096` during the test.

## What Changed

No source code was changed during this test.

Test data created:

- MercadoLibre asset, active operating-company profile assignment, common-stock instrument, and primary `MELI` NASDAQ listing.
- One fresh `deep_dive` research run.
- Five stored source documents and their source files under `storage/sources/`.
- Twelve accepted evidence claims.
- Seventeen deterministic metric observations.

The pipeline's documented `RESEARCH_PIPELINE_AUTO_APPROVE=true` test flag was temporarily applied to the dev process so the test could traverse the research-plan and human-review gates if it reached them. The server was restarted without that flag after the test.

## Verification

The run was created through the real application API and executed through:

```bash
curl -X POST \
  http://localhost:3000/api/research-runs/89c8b2e9-c826-42b1-b225-9d30fb8c4bae/run-system-pipeline
```

Completed workflow stages:

```text
intake
asset_identity
research_plan
source_discovery
source_ingestion
evidence_extraction
```

Persisted quality counts:

```text
sources: 5
evidence: 12
metrics: 17
valuation signals: 0
scenarios: 0
scenarios with value anchors: 0
review decisions: 0
```

Source-reader result:

```text
status: success
model: opencode-go/deepseek-v4-flash
latency: 147202 ms
input tokens: 8990
output tokens: 3852
cost: USD 0.00610624
```

Metric-normalizer failure:

```text
OpenCode returned JSON, but none matched required keys:
normalized_observations, definition_mappings, conversion_notes,
unresolved_ambiguities, quality_flags, source_gaps
```

The quality endpoint returned:

```text
status: needs_more_work
actionReadiness: research_scaffold
evidence depth: 12/25
required valuation lenses present: 0/3
numeric value anchors: 0
AI review: missing
human review: missing
```

## Important Outputs

Run and quality endpoints:

```text
http://localhost:3000/api/research-runs/89c8b2e9-c826-42b1-b225-9d30fb8c4bae
http://localhost:3000/api/research-runs/89c8b2e9-c826-42b1-b225-9d30fb8c4bae/quality
http://localhost:3000/api/research-runs/89c8b2e9-c826-42b1-b225-9d30fb8c4bae/sources
http://localhost:3000/api/research-runs/89c8b2e9-c826-42b1-b225-9d30fb8c4bae/evidence
http://localhost:3000/api/research-runs/89c8b2e9-c826-42b1-b225-9d30fb8c4bae/metrics
http://localhost:3000/api/research-runs/89c8b2e9-c826-42b1-b225-9d30fb8c4bae/model-calls
```

Stored source mix:

```text
primary_source_context: 1
market_data_snapshot: 1
investor_relations candidate: 1
industry_context candidate: 1
macro_context candidate: 1
standalone SEC filings: 0
```

Notable deterministic metrics persisted before the agent failure:

```text
market price: USD 1,799.90 as of 2026-07-09
market cap: USD 91.25B as of 2026-07-09
shares outstanding: 50.70M as of 2026-05-07
cash and equivalents: USD 3.67B for 2025-12-31
total debt: USD 9.19B for 2025-12-31
revenue: USD 10.487B for 2023-12-31
free cash flow: USD 4.567B for 2023-12-31
```

The mixed metric dates are themselves a data-quality warning. Current balance-sheet/share facts were found, while several income-statement and cash-flow facts fell back to 2023 despite newer SEC-derived evidence claims being available.

## Known Issues

### 1. Filing discovery is hard-coded to domestic US forms

`fetchSecContext` filters recent filings with:

```text
10-K
10-Q
```

This excludes foreign-private-issuer equivalents such as:

```text
20-F: annual report equivalent
6-K: interim/current foreign-issuer report used for results and material updates
40-F: Canadian MJDS annual report equivalent
```

The immediate MELI consequence was zero downloaded standalone filings, even though the SEC ticker/CIK resolution worked and the companyfacts/submissions APIs were reachable.

### 2. Candidate URLs are counted as source documents

The investor-relations, industry, and macro entries are JSON search/source-plan candidates, not collected substantive documents. Counting them toward the five-source deep-dive threshold overstates source completeness.

### 3. Evidence persistence cannot satisfy the deep-dive gate

`persistEvidence` slices agent output to 12 claims, while `deep_dive` requires at least 25. Even a successful source-reader call cannot pass the configured evidence-depth threshold.

### 4. Metric-normalizer schema mismatch stops the run

The agent produced parseable JSON, but none of the parsed objects contained all six required top-level keys. The task was marked failed and no retry recovered it.

### 5. Failure state is not propagated

After the task failure:

```text
research_tasks.status: failed
research_stages.metric_normalization.status: running
research_runs.status: running
```

The API route logged the exception, but no durable failed or `needs_more_work` transition occurred.

### 6. OpenCode message-history compatibility warning

Reading the completed source-reader session through the OpenCode message-history endpoint produced:

```text
Expected OutputFormatJsonSchema
```

This was not the live source-reader failure; the source-reader task completed successfully. It appears to be a session-history decoding/version-compatibility issue between the installed SDK and sidecar. Do not misdiagnose it as the reason the pipeline stopped.

### 7. Existing metadata JSONB merge defect reproduced

The MELI run's `metadata_json` became array-shaped after research-plan approval, confirming the previously documented JSONB concatenation issue remains unresolved.

## Next Steps

1. Replace the `10-K`/`10-Q`-only filter with issuer-aware filing-family resolution.
   - Determine filer category/jurisdiction from SEC submissions metadata.
   - Map domestic annual/quarterly forms to `10-K`/`10-Q`.
   - Map foreign private issuers to `20-F` plus relevant `6-K` result filings.
   - Support `40-F` for Canadian MJDS issuers.
   - Preserve the original form type and semantic role in source metadata.
2. Fetch and store actual filing documents before analysis; source-plan/search candidates must not satisfy substantive source-depth thresholds.
3. Add tests using at least `MELI` for `20-F`/`6-K` and a Canadian foreign issuer for `40-F`.
4. Raise or configure the evidence persistence cap so a `deep_dive` can reach its 25-claim minimum.
5. Make metric-normalizer output recovery more robust.
   - Persist the raw model response for debugging.
   - Validate and retry malformed structured output with an explicit repair prompt.
   - Record failed model calls as well as failed tasks.
6. Catch pipeline-stage exceptions and atomically mark the task, stage, and run as `failed` or `needs_more_work` with the same failure reason.
7. Improve deterministic fact selection for foreign issuers so recent custom-taxonomy or foreign-filer facts do not silently fall back to stale annual values.
8. Fix `research_runs.metadata_json` merges so the field remains an object.
9. Rerun MELI from a new run after the above changes and require successful analysis, valuation, backtest, review, and export before calling the foreign-issuer path verified.

## Practical Caveats

- The current MELI run is diagnostic evidence, not an investment research result.
- Do not resume this run without first fixing or deliberately resetting its inconsistent running/failed state; a fresh run is safer for verification.
- Do not loosen quality thresholds to make the run pass. The source and evidence layers need to become materially deeper.
- `6-K` is not a one-to-one quarterly form. Select filings by document description, reporting period, attached earnings materials, and recency rather than ingesting every `6-K` indiscriminately.
- Market and accounting facts use different observation dates. Preserve `period_end`, filing/availability date, retrieval date, and market-data timestamp separately.

## Files To Start With

```text
src/lib/research/system-pipeline.ts
src/lib/opencode/runtime.ts
src/lib/opencode/agent-registry.ts
src/lib/workflow/quality-gates.ts
src/lib/workflow/orchestrator.ts
src/lib/workflow/validators.ts
src/app/api/research-runs/[id]/run-system-pipeline/route.ts
src/app/api/research-runs/[id]/quality/route.ts
src/db/schema/core.ts
```
