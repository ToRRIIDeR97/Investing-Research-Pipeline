import { NextRequest } from "next/server";
import { createdResponse, handleApiError } from "@/lib/api/errors";
import { createNotebookItem, notebookKind, readNotebookBody, requireAsset } from "@/lib/api/notebook";

type Params = { params: Promise<{ id: string; kind: string }> };

/** Adds a pin, KPI, annotation or journal entry (kind: pins | kpis | annotations | journal). */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { id, kind } = await params;
    const assetId = await requireAsset(id);
    return createdResponse(await createNotebookItem(assetId, notebookKind(kind), await readNotebookBody(request)));
  } catch (error) {
    return handleApiError(error);
  }
}
