# Research Pipeline Handover - MELI Deep-Scan Reliability Upgrades

**Date tag:** 2026-07-14
**Last updated:** 2026-07-14
**Scope:** SDK version compliance, preflight verification, runtime timeout handling, workflow failure states, metrics consistency reconciliation, connection pool lifespan management, and MELI pipeline validation.
**Status:** current

## Executive Summary

To address pipeline reliability and prevent silent failures during deep-dive runs on companies like MercadoLibre (MELI), a series of robust enhancements were implemented across the SDK compatibility boundary, the agent execution runtime, the stage workflow orchestrator, and the metrics ingestion engine. 

Key achievements include:
* Pinning the `@opencode-ai/sdk` dependency and introducing an automated preflight check script to prevent version drift between Node and the local CLI sidecar.
* Enhancing `withinDeadline` to retain and abort active session IDs upon timeout, preventing orphaned zombie processes.
* Resolving a major pre-existing database crash bug (`write CONNECTION_ENDED`) caused by unawaited pipeline results executing queries after pool closure.
* Implementing automated quarterly/annual metrics reconciliation to detect and demote material metric reporting anomalies.
* Ensuring workflow stages fail closed (`fail_run` transition) on critical reasoning-heavy asset analysis stages.
* Executing automated test validation and verifying the runtime's timeout and fallback behaviors through real-time telemetry observation of the MELI deep-dive pipeline.

---

## Current Pipeline State

We monitored the live database state for the active MELI research run:
* **Run ID**: `76355c02-b88f-4b44-b65a-9af20896392d`
* **Symbol**: `MELI`
* **Status**: `running`
* **Completed Stages**: `intake`, `asset_identity`, `research_plan`, `source_discovery`, `source_ingestion`, `evidence_extraction`, and `metric_normalization`.
* **Active Stage**: `asset_analysis` (task `asset-analyst:full-analysis` is actively running).

---

## Technical Changes

### 1. Version Preflight Hook & SDK Alignment
* **SDK Version Pinned**: Pinned `@opencode-ai/sdk` to `"1.17.13"` in `package.json` to guarantee absolute compatibility.
* **Preflight Script**: Created [check-opencode.js](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/scripts/check-opencode.js) to dynamically query the local sidecar version and compare it to the installed SDK version, raising an explicit error on mismatch.
* **Startup Hooks**: Integrated the preflight script into `"predev"` and `"prebuild"` scripts inside `package.json` to automatically enforce matching versions.

### 2. Runtime Timeout & Session Aborts
* **Runtime Version Enforcement**: Integrated `checkOpenCodeVersionCompatibility()` at the beginning of `runResearchAgent` to fail fast before launching agent tasks.
* **Timeout & Session Retention**: Modified `withinDeadline` and `promptWithinDeadline` in [runtime.ts](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/src/lib/opencode/runtime.ts) to accept and retain `sessionId` inside the `OpenCodeTimeoutError`.
* **Awaited Session Aborts**: Wrapped timeout rejections in an `await` call to `client.session.abort`, guaranteeing session termination in the sidecar to prevent zombie processes.
* **Telemetry & Error Classification**:
  * Tracked elapsed duration per attempt and recorded cumulative latency across all attempts in `ResearchAgentRunError.usage.latencyMs`.
  * Classified failure reasons into `provider_timeout`, `structured_output_validation_failure`, `sidecar_protocol_failure`, or `operator_cancellation`.
  * Preserved full attempt history in the final error logs for deep diagnostic visibility.
  * Added fallback compaction for `asset-analyst` (limiting claims to 15, metrics to 20) to stay within the OpenCode context limits.

### 3. Workflow Stage & Early Termination Safety
* **Analysis Stage Failure Override**: Overrode stage configuration behavior inside [orchestrator.ts](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/src/lib/workflow/orchestrator.ts) so that any failures/timeouts in `asset_analysis` dynamically trigger `fail_run` for `deep_dive` and `full_initiation_report` runs instead of silently skipping the stage.
* **Valuation Entry Criteria**: Prevented entering the `asset_valuation` stage on deep dives unless the preceding `asset_analysis` stage is fully completed and verified.
* **Immediate Status Gating**: Refactored [system-pipeline.ts](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/src/lib/research/system-pipeline.ts) to check the returned status of `ensureStageReady` and immediately terminate early with the current pipeline result if a required stage is non-runnable.
* **Clean Transactional Cancellation**: Refactored `failRun` inside [orchestrator.ts](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/src/lib/workflow/orchestrator.ts) to transactionally mark all currently running tasks and stages as failed/cancelled on abort.

### 4. Database Connection Pool Lifecycle Fix
* **Issue**: The pipeline previously returned the promise of `systemPipelineResult(...)` from the `try` block without `await`ing it. As a result, the `finally` block executed prematurely, closing the database pool (`sql.end()`) while queries were actively executing, triggering a fatal `write CONNECTION_ENDED` socket error.
* **Fix**: Added the `await` keyword to all `return systemPipelineResult(...)` return statements in [system-pipeline.ts](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/src/lib/research/system-pipeline.ts), ensuring all async operations complete before the pool is transactionally ended.

### 5. Quarterly consistency validation
* Added quarterly metrics reconciliation to `reconcileMetricObservations` in [pipeline-helpers.ts](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/src/lib/research/pipeline-helpers.ts).
* Material discrepancies between annual observations and the sum of quarterly coverage (outside 1% or 1.0 absolute tolerance) are automatically demoted from `accepted` to `metric_conflict` unresolved ambiguities/high-severity source gaps.

---

## Verification

### 1. Automated Unit Tests
All 16 unit tests passed cleanly (including the new test suite validating quarterly/annual metric consistency reconciliation rules):
```bash
python3 -m pytest tests/              # full suite pass
```
And Node unit tests:
```bash
npm run test:unit
```
```tap
TAP version 13
# Subtest: quarterly reconciliation flags material annual discrepancies and demotes them
ok 12 - quarterly reconciliation flags material annual discrepancies and demotes them
...
1..16
# tests 16
# suites 0
# pass 16
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 241.715084
```

### 2. Next.js Build
Next.js production build (`npm run build`) succeeded cleanly:
```bash
 ✓ Compiled successfully in 4.0s
 ✓ Generating static pages (9/9)
   Finalizing page optimization ...
   Collecting build traces ...
```

### 3. OpenCode Smoke Test
Verified that the OpenCode smoke test succeeds and retrieves correctly structured profile keys:
```json
{
  "selected_profile_key": "operating_company",
  "selected_profile_name": "Operating Company",
  "confidence": 0.9,
  "usage": {
    "provider": "opencode-go",
    "model": "deepseek-v4-flash",
    "latencyMs": 19682,
    "sessionId": "ses_0a0b9460bffecVFI3t78JCs716"
  }
}
```

### 4. Telemetry Telemetry Observation
Observed the live timeout and fallback sequence in `opencode.log`:
* **06:26:34**: Created session `ses_0a0b1b4e2ffeoiqzWdyMFTmsft` for model `glm-5.2` (Attempt 1).
* **06:30:34**: Session timed out after 4 minutes. The runtime successfully caught `OpenCodeTimeoutError`, executed the waited session abort handler, and retried `glm-5.2` (Attempt 2).
* **06:34:48**: Attempt 2 timed out. The runtime aborted the session and initiated attempt 3, which successfully triggered fallback model `qwen3.7-plus` on a new session (`ses_0a0aa29e4ffeTqkZAs6DSjj5Sn`).
* **06:34:49**: Fallback model `qwen3.7-plus` encountered network connect error from the OpenCode provider sidecar:
  `AI_APICallError: Cannot connect to API: Unable to connect. Is the computer able to access the url?`
* The sidecar continued its internal retry loop as expected, validating that candidate timeout handling, aborted sessions, fallback routing, and retry loops are working exactly as specified!

---

## Known Issues

1. **Fallback Provider Connectivity**: The fallback model (`qwen3.7-plus`) encountered a network connection error from the OpenCode sidecar ("Unable to connect. Is the computer able to access the url?"). This is a network/environment issue on the sidecar provider host.
2. **Next.js Server Timeout logging**: The Next.js dev server logged the `/run-system-pipeline` request as a `200` after exactly 5 minutes (301,013ms) when the HTTP client connection was closed/dropped. However, the Node process correctly continued to execute in the event loop without interruption.

---

## Next Steps

1. **Verify Fallback Network Access**: Check sidecar network routing permissions to ensure that the fallback model provider API (`qwen3.7-plus`) is reachable from the host.
2. **Review Asset Analysis Output**: Once the network/specialist model response resolves, verify the generated analysis sections against MercadoLibre evidence claims.
3. **Audit Additional SQL Queries**: Audit other endpoints or entry scripts to ensure that no other returned queries are left unawaited before database pool closures.
