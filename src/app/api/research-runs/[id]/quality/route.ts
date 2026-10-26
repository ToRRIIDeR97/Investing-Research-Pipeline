import { NextRequest } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { evaluateResearchQuality } from "@/lib/workflow/quality-gates";
import { sqlClient } from "@/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const quality = await evaluateResearchQuality(id, sqlClient);
    return successResponse(quality);
  } catch (error) {
    return handleApiError(error);
  }
}
