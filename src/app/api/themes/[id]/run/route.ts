import { NextRequest } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { runTheme, sameOrigin } from "@/lib/api/themes";

type Params = { params: Promise<{ id: string }> };

/**
 * Runs the theme research pipeline (model calls behind the paid gate and the theme budget; SEC fetches only).
 * 200 with the completed theme; 502 with the theme marked failed and its reader-facing error; 409 while running.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    sameOrigin(request);
    const theme = await runTheme((await params).id);
    return successResponse(theme, theme.status === "failed" ? 502 : 200);
  } catch (error) {
    return handleApiError(error);
  }
}
