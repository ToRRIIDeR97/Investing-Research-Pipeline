import { NextRequest } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";
import {
  assertAssetExists,
  deleteChartView,
  getSavedChartView,
  updateChartView,
} from "@/lib/charts/saved-views";

type RouteContext = { params: Promise<{ id: string; blockId: string }> };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { id, blockId } = await params;
    await assertAssetExists(id);
    return successResponse(await getSavedChartView(id, blockId));
  } catch (error) {
    return handleApiError(error);
  }
}
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { id, blockId } = await params;
    await assertAssetExists(id);
    const body = await request.json();
    return successResponse(await updateChartView(id, blockId, body ?? {}));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const { id, blockId } = await params;
    await assertAssetExists(id);
    return successResponse(await deleteChartView(id, blockId));
  } catch (error) {
    return handleApiError(error);
  }
}
