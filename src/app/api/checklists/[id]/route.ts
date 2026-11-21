import { NextRequest, NextResponse } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { deleteChecklist, getChecklist, readChecklistBody, updateChecklist } from "@/lib/api/checklists";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    return successResponse(await getChecklist((await params).id));
  } catch (error) {
    return handleApiError(error);
  }
}

/** Replaces the checklist's name and items. */
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    return successResponse(await updateChecklist(id, await readChecklistBody(request)));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    await deleteChecklist((await params).id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleApiError(error);
  }
}
