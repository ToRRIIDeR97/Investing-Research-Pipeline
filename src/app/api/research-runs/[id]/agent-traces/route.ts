import { NextRequest } from "next/server";
import { db } from "@/db";
import { agent_traces } from "@/db/schema/ai";
import { ApiError, handleApiError, successResponse } from "@/lib/api/errors";
import { eq, desc } from "drizzle-orm";

// The fields the run page lists. Tool input and output JSON are most of a row's size.
const summaryFields = {
  id: agent_traces.id,
  task_id: agent_traces.task_id,
  agent_name: agent_traces.agent_name,
  tool_name: agent_traces.tool_name,
  status: agent_traces.status,
  created_at: agent_traces.created_at,
};

const DEFAULT_TRACE_LIMIT = 200;
const MAX_TRACE_LIMIT = 1000;

/** `?limit=` as a whole number from 1 to MAX_TRACE_LIMIT; absent means DEFAULT_TRACE_LIMIT, anything else null (#130). */
function parseTraceLimit(value: string | null): number | null {
  if (value === null || value === "") return DEFAULT_TRACE_LIMIT;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_TRACE_LIMIT ? limit : null;
}

// The newest traces first, at most `?limit=` of them (default 200). `?summary=1` returns only summaryFields; the run page polls it.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const summary = request.nextUrl.searchParams.get("summary") === "1";
    const limit = parseTraceLimit(request.nextUrl.searchParams.get("limit"));
    if (limit === null) throw new ApiError(`limit must be a whole number from 1 to ${MAX_TRACE_LIMIT}`, 400, "VALIDATION_ERROR");

    const traces = await (summary ? db.select(summaryFields) : db.select())
      .from(agent_traces)
      .where(eq(agent_traces.research_run_id, runId))
      .orderBy(desc(agent_traces.created_at))
      .limit(limit);

    return successResponse(traces);
  } catch (error) {
    return handleApiError(error);
  }
}
