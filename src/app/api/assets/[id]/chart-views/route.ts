import { NextRequest } from "next/server";
import { handleApiError, successResponse, createdResponse } from "@/lib/api/errors";
import {
  assertAssetExists,
  listSavedChartViews,
  saveChartView,
} from "@/lib/charts/saved-views";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await assertAssetExists(id);
    return successResponse(await listSavedChartViews(id));
  } catch (error) {
    return handleApiError(error);
  }
}
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await assertAssetExists(id);
    const body = await request.json();
    return createdResponse(await saveChartView(id, body?.config ?? body));
  } catch (error) {
    return handleApiError(error);
  }
}
