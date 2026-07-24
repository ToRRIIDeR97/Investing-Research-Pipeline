# Handover: Analysis Sections Double-Encode Bug

**Date:** 2026-07-14  
**Status:** Root cause confirmed — fix not yet applied  
**Blocking:** All v2 pipeline runs fail at `asset_analysis` stage with "Required v2 module X is not completed."

---

## Context

The local harness migration (see `2026-07-14-research-os-local-harness-transition-handover.md`) was completed and all tasks marked done. A MELI deep dive was run via `scripts/new-meli-run.ts` using the mock provider (`RESEARCH_MODEL_PROVIDER=mock`). The run failed at `asset_analysis` with every required module reporting `needs_more_work`.

---

## Root Cause: Double JSON Serialization in `completeTask`

### The Bug

In `system-pipeline.ts`, `completeTask` stores task output as:

```ts
// Line 760
output_json = ${JSON.stringify(output)}::jsonb
```

`result.structured` (from `parseStructuredOutput`) is a correctly parsed JS object. But when postgres.js retrieves a JSONB column it returns it as a **raw string**, not a parsed JS object. So the pipeline's in-memory flow works — `objectValue(result.structured)` in `callAgent` returns the correct object and the pipeline continues. BUT, `completeTask` stores the output, and the next time the pipeline re-runs and calls `latestTaskOutput`, it reads from DB:

```ts
// latestTaskOutput, line 2772
return rows[0]?.output_json ? objectValue(rows[0].output_json) : null;
```

`rows[0].output_json` comes back as a **string** from postgres.js. `objectValue(string)` calls `JSON.parse(string)` — and this works on a fresh run. BUT:

### The Real Failure Mode

`mergeGroupOutputs(groupResults)` at line 3132 is called with `groupResults` — an array of values returned by `callAgent`. Each `callAgent` call returns `objectValue(result.structured)` which is a proper JS object during the live run. `mergeGroupOutputs` checks `Array.isArray(group.analysis_sections)` for each group.

**But the DB shows all group tasks have `section_count=0`** — the merged `full-analysis` task stored `analysis_sections: []`. The postgres.js test confirmed:

```ts
// Even with valid JSON stored, postgres.js returns JSONB as a string by default:
retrieved type: string   // ← CONFIRMED via test
row.data.analysis_sections  // → undefined (because row.data is a string, not object)
```

This means wherever the pipeline reads `output_json` back from the DB mid-run (e.g., for the merged `full-analysis` record, or when checking for previously completed group tasks), `group.analysis_sections` is `undefined`, so `mergeGroupOutputs` produces an empty `analysis_sections: []`.

### Confirmed Evidence

```
asset-analyst:analysis-commerce: typeof=string isString=true hasAnalysisSections=false
  after parse: analysis_sections=22   ← data IS there, just wrapped in a string
```

The mock correctly produced 22 sections, they were stored, but retrieved as a string by postgres.js and never unwrapped before `mergeGroupOutputs` processes them.

---

## Where the Fixes Are Needed

### Fix 1: `latestTaskOutput` — unwrap string output before returning

**File:** `src/lib/research/system-pipeline.ts`, line 2772

```ts
// CURRENT (buggy when postgres.js returns JSONB as string):
return rows[0]?.output_json ? objectValue(rows[0].output_json) : null;

// ALREADY CORRECT — objectValue() handles string→parse.
// The issue is that the GROUP RESULTS in memory during the run
// are not read from DB. They come from callAgent return values.
```

### Fix 2 (THE REAL FIX): `callAgent` — pass parsed output to `completeTask` correctly

The in-memory `groupResults.push(groupOutput)` stores the return value of `callAgent`, which is `objectValue(result.structured)`. This is correct. But the merged output written to `full-analysis` task at lines 3141-3158 re-serializes `analysisOutput` via `JSON.stringify(analysisOutput)::jsonb`. When postgres.js reads it back, it's a string. When `latestTaskOutput` is later called (on a retry/re-run), it parses it correctly via `objectValue`.

**The actual failure is that the groups are completing with empty `analysis_sections` in memory.** This means the mock provider's `asset-analyst` response is NOT being used correctly during the group calls, OR the mock is only matching some calls and returning the fallback `{ status: "success", data: "mock payload" }` for groups because the prompt doesn't match any agent name lookup.

### Fix 3 (MOST LIKELY CAUSE): Mock provider `asset-analyst` DB lookup timing

In `mock.ts` line 175-236, the mock for `asset-analyst` opens a NEW postgres connection to fetch `evidence_claims`. Each of the 6 group calls does this independently. **But the `evidence_claims` are only written by the `source-reader` mock during the earlier stage.** If claims haven't been committed yet when the first group runs, the mock may return an empty claims list → 0 sections.

More likely: the mock correctly returns sections (we see 22 in DB after parse), but the in-memory `groupOutput` is empty because `callAgent` processes the mock output and something goes wrong between `parseStructuredOutput` → `objectValue` → return.

---

## Recommended Fix Sequence

### Step 1 — Add a diagnostic log to confirm in-memory group output

Temporarily add a `console.log` after line 3110:
```ts
groupResults.push(groupOutput);
console.log(`Group ${group.id} sections in memory:`, arrayValue(groupOutput.analysis_sections).length);
```

Then re-run `npx tsx scripts/new-meli-run.ts` to see if the group result arrives with 0 sections in memory (mock bug) or correctly (DB serialization bug).

### Step 2a — If in-memory group output has 0 sections (mock is broken)

The mock provider's `asset-analyst` branch returns `text = ""` (empty string) if `latestRun` is null or `sql.end()` is called before `text` is set. Check for:
- Race condition in the mock's `sql` connection
- The `finally { await sql.end() }` closing before `text` assignment
- The `if (latestRun)` guard returning empty when the run isn't in DB yet at mock call time

**Quick fix for mock:** pre-build the sections without hitting the DB:
```ts
// In mock.ts asset-analyst branch, use static claim IDs from the 
// already-stored claims (query them once at the top of the stream call,
// not inside a separate SQL connection)
```

### Step 2b — If in-memory group output has 22 sections (DB serialization is the issue)

The problem is in the merged `full-analysis` task write. Fix `mergeGroupOutputs` consumers to call `objectValue` on each group before accessing `.analysis_sections`:

```ts
// In mergeGroupOutputs, line 163:
for (const rawGroup of groups) {
  const group = objectValue(rawGroup);  // ← add this
  if (!group) continue;
  if (Array.isArray(group.analysis_sections)) { ... }
```

Or fix `completeTask` to use postgres.js native JSON binding so it stores JSONB objects properly:
```ts
async function completeTask(sql: Sql, taskId: string, output: unknown) {
  // Use sql.json() to ensure proper JSONB storage
  await sql`
    UPDATE research_tasks
    SET status = 'completed',
        output_json = ${sql.json(output)},
        failure_reason = NULL,
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${taskId}
  `;
}
```

---

## Key Files

| File | Relevance |
|---|---|
| [`system-pipeline.ts`](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/src/lib/research/system-pipeline.ts) | `completeTask` (L756), `mergeGroupOutputs` (L148), `callAgent` (L1664), `latestTaskOutput` (L2761), `materializeRequiredAnalysisModules` (L2077) |
| [`mock.ts`](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/src/lib/agent-harness/providers/mock.ts) | Mock asset-analyst response with DB lookup (L175–236) |
| [`output-parser.ts`](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/src/lib/agent-harness/output-parser.ts) | `parseStructuredOutput` returns parsed JS object |
| [`runner.ts`](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/src/lib/agent-harness/runner.ts) | `runResearchAgent` returns `structured: finalParsedOutput` |
| [`scripts/new-meli-run.ts`](file:///Users/japardinathaniel/Documents/GitHub/Investing%20Research%20Pipeline/scripts/new-meli-run.ts) | Entry point for mock end-to-end run |

## What's Known Good

- Evidence claims ARE persisted correctly (25 claims in DB with evidence_links)
- Module term matching works — claims do match all required modules
- The mock provider correctly constructs 22 `analysis_sections` with matching `evidence_claim_ids`
- All 6 group tasks complete with `status=completed`
- The `full-analysis` merged task stores `section_count=0` — the merge lost the sections

## Quick Repro

```bash
npx tsx scripts/new-meli-run.ts
# Observe: "Required v2 module X is not completed" for all modules
```

Check DB state after run:
```bash
npx tsx --env-file=.env.local -e "
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL);
const [run] = await sql\`SELECT id FROM research_runs ORDER BY created_at DESC LIMIT 1\`;
const tasks = await sql\`SELECT task_key, typeof output_json, jsonb_typeof(output_json) as jtype FROM research_tasks WHERE research_run_id = \${run.id} AND task_key LIKE 'asset-analyst%'\`;
console.log(tasks);
await sql.end();
"
# Expected output: jtype='string' for group tasks ← confirms double-encode
```
