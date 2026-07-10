import { NextRequest } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { evaluateResearchQuality } from "@/lib/workflow/quality-gates";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const quality = await evaluateResearchQuality(id);
    return successResponse(quality);
  } catch (error) {
    return handleApiError(error);
  }
}
