import { NextRequest } from "next/server";
import { createdResponse, handleApiError, successResponse } from "@/lib/api/errors";
import { createTheme, listThemes, readThemeBody, sameOrigin } from "@/lib/api/themes";

/** Past themes, newest first (request, status and shortlist). */
export async function GET() {
  try {
    return successResponse(await listThemes());
  } catch (error) {
    return handleApiError(error);
  }
}

/** Creates a theme from a validated `ThemeRequest`; running it is a separate, paid step. */
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    return createdResponse(await createTheme(await readThemeBody(request)));
  } catch (error) {
    return handleApiError(error);
  }
}
