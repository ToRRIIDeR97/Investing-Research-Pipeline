import { NextRequest, NextResponse } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { deleteNotebookItem, notebookId, notebookKind, readNotebookBody, requireAsset, updateNotebookItem } from "@/lib/api/notebook";

type Params = { params: Promise<{ id: string; kind: string; itemId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { id, kind, itemId } = await params;
    const assetId = await requireAsset(id);
    return successResponse(await updateNotebookItem(assetId, notebookKind(kind), notebookId(itemId), await readNotebookBody(request)));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const { id, kind, itemId } = await params;
    const assetId = await requireAsset(id);
    await deleteNotebookItem(assetId, notebookKind(kind), notebookId(itemId));
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleApiError(error);
  }
}
