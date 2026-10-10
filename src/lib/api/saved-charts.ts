import type { NextRequest } from "next/server";
import type { saved_charts } from "@/db/schema/saved-charts";
import { ApiError } from "@/lib/api/errors";
import { savedChartDefinition, type SavedChart } from "@/lib/research/reporting/saved-charts";

/** Upper bound on saved charts; the instance has no authentication, so writes are bounded. */
export const MAX_SAVED_CHARTS = 200;
const MAX_BODY_BYTES = 16_384;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stored row as API output; a row whose definition no longer validates is skipped. */
export function toSavedChart(row: typeof saved_charts.$inferSelect): SavedChart | null {
  const definition = savedChartDefinition.safeParse(row.definition_json);
  if (!definition.success) return null;
  return { id: row.id, name: row.name, definition: definition.data, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() };
}

export async function readJsonBody(request: NextRequest): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError("Request body is too large", 413, "BODY_TOO_LARGE");
  try { return JSON.parse(text); } catch { throw new ApiError("Request body must be JSON", 400, "INVALID_JSON"); }
}

export function savedChartId(id: string) {
  if (!UUID.test(id)) throw new ApiError("Saved chart not found", 404, "NOT_FOUND");
  return id;
}
