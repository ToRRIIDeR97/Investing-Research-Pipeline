import { NextRequest } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { ComputeRequest, compute, loadRunWhatIfData, loadWorkbench, readWorkbenchBody, requireRun } from "@/lib/api/workbench";

type Params = { params: Promise<{ id: string }> };

/** The workbench for a run: whether it can recompute, the editable inputs, the stored valuation and saved scenarios. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const runId = await requireRun((await params).id);
    return successResponse(await loadWorkbench(runId));
  } catch (error) {
    return handleApiError(error);
  }
}

/** Recomputes the stored valuation with `{ change }` applied, in code; a change that breaks a rule is a 422. No write. */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const runId = await requireRun((await params).id);
    const { change } = ComputeRequest.parse(await readWorkbenchBody(request));
    return successResponse(compute(await loadRunWhatIfData(runId), change));
  } catch (error) {
    return handleApiError(error);
  }
}
