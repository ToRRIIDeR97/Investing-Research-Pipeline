import { NextRequest } from "next/server";
import { createdResponse, handleApiError, successResponse } from "@/lib/api/errors";
import { listScenarios, readWorkbenchBody, requireRun, saveScenario } from "@/lib/api/workbench";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    return successResponse(await listScenarios(await requireRun((await params).id)));
  } catch (error) {
    return handleApiError(error);
  }
}

/** Saves `{ name, rationale?, source?, change }`; the stored summary is recomputed by the server. Duplicate name: 409. */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const runId = await requireRun((await params).id);
    return createdResponse(await saveScenario(runId, await readWorkbenchBody(request)));
  } catch (error) {
    return handleApiError(error);
  }
}
