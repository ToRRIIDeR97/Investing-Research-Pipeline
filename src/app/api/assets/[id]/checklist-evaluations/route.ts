import { NextRequest } from "next/server";
import { ApiError, createdResponse, handleApiError, successResponse } from "@/lib/api/errors";
import { evaluateForAsset, listEvaluations, readChecklistBody, requireChecklistAsset } from "@/lib/api/checklists";

type Params = { params: Promise<{ id: string }> };

/** The asset's checklist evaluations, newest first. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    return successResponse(await listEvaluations(await requireChecklistAsset((await params).id)));
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Evaluates `{ checklist_id, research_run_id? }` on one of the asset's runs (by default its newest run with a report):
 * measures by code, judgements by one model call behind the paid gate. Stores and returns the evaluation.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    // The evaluation can start a paid model call, so it refuses another origin as the chat does.
    const origin = request.headers.get("origin");
    if (origin && origin !== `${request.nextUrl.protocol}//${request.headers.get("host")}`) throw new ApiError("Cross-origin requests are not allowed.", 403);
    const assetId = await requireChecklistAsset((await params).id);
    return createdResponse(await evaluateForAsset(assetId, await readChecklistBody(request)));
  } catch (error) {
    return handleApiError(error);
  }
}
