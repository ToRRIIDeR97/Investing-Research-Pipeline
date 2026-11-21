/**
 * The valuation workbench's server side: reads a run's stored valuation, recomputes it under a typed change in code
 * (`computeWhatIf`) and keeps named scenarios in `valuation_scenarios`. Nothing here writes `research_artifacts`, so
 * a report, its hashes and its approval are never touched.
 */
import type { NextRequest } from "next/server";
import { and, asc, count, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { pipelineSql } from "@/db/pipeline-sql";
import { research_runs } from "@/db/schema/workflow";
import { valuation_scenarios } from "@/db/schema/workbench";
import { ApiError } from "@/lib/api/errors";
import { loadWhatIfData } from "@/lib/research/valuation/whatif-data";
import {
  WhatIfError, WorkbenchChange, computeWhatIf, scenarioSummary, whatIfAvailability, workbenchInputs,
  type ScenarioSummary, type WhatIfData, type WhatIfResult,
} from "@/lib/research/valuation/whatif";

export const MAX_WORKBENCH_BODY_BYTES = 32_000;
export const MAX_SCENARIOS_PER_RUN = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Control characters other than tab and newline are dropped from the operator's text.
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();

// The change itself is checked by computeWhatIf, so a change that breaks a rule is a 422 with a reader-facing reason.
export const ComputeRequest = z.object({ change: z.unknown().optional() }).strict();
export const SaveScenarioRequest = z.object({
  name: z.string().transform(clean).pipe(z.string().min(1).max(80)),
  rationale: z.string().transform(clean).pipe(z.string().max(1000)).optional(),
  source: z.enum(["user", "assistant"]).optional(),
  change: z.unknown(),
}).strict();

export type SavedScenario = {
  id: string; name: string; rationale: string; source: "user" | "assistant"; change: WorkbenchChange; result: ScenarioSummary;
  created_at: string; updated_at: string;
};
const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();
const toScenario = (r: typeof valuation_scenarios.$inferSelect): SavedScenario => ({ id: r.id, name: r.name, rationale: r.rationale,
  source: r.source === "assistant" ? "assistant" : "user", change: r.change_json as WorkbenchChange, result: r.result_json as ScenarioSummary,
  created_at: iso(r.created_at), updated_at: iso(r.updated_at) });

export function workbenchId(id: string, what = "Research run") {
  if (!UUID.test(id)) throw new ApiError(`${what} not found`, 404, "NOT_FOUND");
  return id;
}

export async function readWorkbenchBody(request: NextRequest): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_WORKBENCH_BODY_BYTES) throw new ApiError("Request body is too large", 413, "BODY_TOO_LARGE");
  try { return JSON.parse(text); } catch { throw new ApiError("Request body must be JSON", 400, "INVALID_JSON"); }
}

export async function requireRun(runId: string) {
  workbenchId(runId);
  const [row] = await db.select({ id: research_runs.id }).from(research_runs).where(eq(research_runs.id, runId)).limit(1);
  if (!row) throw new ApiError("Research run not found", 404, "NOT_FOUND");
  return row.id;
}

/** The stored artifacts a what-if reads (read only). */
export const loadRunWhatIfData = (runId: string) => loadWhatIfData(pipelineSql(), runId);

/** Runs a what-if, turning a broken rule into a 422 the reader can act on. */
export function compute(data: WhatIfData, change: unknown = {}): WhatIfResult {
  try { return computeWhatIf(data, (change ?? {}) as WorkbenchChange); }
  catch (error) {
    if (error instanceof WhatIfError) throw new ApiError(error.message, 422, "WHATIF_REFUSED");
    throw error;
  }
}

export async function listScenarios(runId: string) {
  const rows = await db.select().from(valuation_scenarios).where(eq(valuation_scenarios.research_run_id, runId))
    .orderBy(asc(valuation_scenarios.created_at)).limit(MAX_SCENARIOS_PER_RUN);
  return rows.map(toScenario);
}

/** The workbench page: availability, the editable inputs, the stored valuation recomputed, and saved scenarios. */
export async function loadWorkbench(runId: string) {
  const data = await loadRunWhatIfData(runId);
  const availability = whatIfAvailability(data);
  const scenarios = await listScenarios(runId);
  if (!availability.available) return { available: false as const, reason: availability.reason, inputs: null, baseline: null, scenarios };
  try {
    return { available: true as const, inputs: workbenchInputs(data), baseline: computeWhatIf(data), scenarios };
  } catch (error) {
    if (error instanceof WhatIfError) return { available: false as const, reason: error.message, inputs: null, baseline: null, scenarios };
    throw error;
  }
}

/** Saves a named scenario; its summary is recomputed here from the stored valuation, never taken from the client. */
export async function saveScenario(runId: string, body: unknown) {
  const v = SaveScenarioRequest.parse(body);
  const [{ total }] = await db.select({ total: count() }).from(valuation_scenarios).where(eq(valuation_scenarios.research_run_id, runId));
  if (total >= MAX_SCENARIOS_PER_RUN) throw new ApiError(`A run keeps at most ${MAX_SCENARIOS_PER_RUN} scenarios. Delete one first.`, 409, "TOO_MANY_SCENARIOS");
  const [dupe] = await db.select({ id: valuation_scenarios.id }).from(valuation_scenarios)
    .where(and(eq(valuation_scenarios.research_run_id, runId), eq(valuation_scenarios.name, v.name))).limit(1);
  if (dupe) throw new ApiError("A scenario with that name already exists", 409, "DUPLICATE_NAME");
  const result = scenarioSummary(compute(await loadRunWhatIfData(runId), v.change));
  // computeWhatIf accepted the change, so it parses; the parsed form drops nothing the engine used.
  const change = WorkbenchChange.parse(v.change ?? {});
  try {
    const [row] = await db.insert(valuation_scenarios).values({ research_run_id: runId, name: v.name, rationale: v.rationale ?? "",
      source: v.source ?? "user", change_json: change, result_json: result }).returning();
    return toScenario(row);
  } catch (error) {
    // A concurrent save of the same name loses to the unique index.
    if ((error as { code?: string; cause?: { code?: string } })?.code === "23505" || (error as { cause?: { code?: string } })?.cause?.code === "23505")
      throw new ApiError("A scenario with that name already exists", 409, "DUPLICATE_NAME");
    throw error;
  }
}

export async function deleteScenario(runId: string, scenarioId: string) {
  const [row] = await db.delete(valuation_scenarios)
    .where(and(eq(valuation_scenarios.id, workbenchId(scenarioId, "Scenario")), eq(valuation_scenarios.research_run_id, runId)))
    .returning({ id: valuation_scenarios.id });
  if (!row) throw new ApiError("Scenario not found", 404, "NOT_FOUND");
}
