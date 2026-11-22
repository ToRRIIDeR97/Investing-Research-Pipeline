import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api/errors";
import { deleteScenario, requireRun } from "@/lib/api/workbench";

type Params = { params: Promise<{ id: string; scenarioId: string }> };

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const { id, scenarioId } = await params;
    await deleteScenario(await requireRun(id), scenarioId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleApiError(error);
  }
}
