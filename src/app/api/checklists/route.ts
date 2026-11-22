import { NextRequest } from "next/server";
import { createdResponse, handleApiError, successResponse } from "@/lib/api/errors";
import { createChecklist, listChecklists, readChecklistBody } from "@/lib/api/checklists";

/** Every checklist, the default first (the built-in default is stored on the first listing when none exist). */
export async function GET() {
  try {
    return successResponse(await listChecklists());
  } catch (error) {
    return handleApiError(error);
  }
}

/** Adds a checklist `{ name, items }`. */
export async function POST(request: NextRequest) {
  try {
    return createdResponse(await createChecklist(await readChecklistBody(request)));
  } catch (error) {
    return handleApiError(error);
  }
}
