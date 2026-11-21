import { NextRequest } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { getTheme } from "@/lib/api/themes";

type Params = { params: Promise<{ id: string }> };

/** One theme with its full result. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    return successResponse(await getTheme((await params).id));
  } catch (error) {
    return handleApiError(error);
  }
}
