import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, successResponse } from "@/lib/api/errors";

// POST, not GET: a page asks for up to 40 logos at once. It reads only; the proxy's same-origin check still applies.
const subject = z.union([
  z.object({ asset_id: z.string().uuid() }).strict(),
  z.object({ name: z.string().trim().min(1).max(200), ticker: z.string().trim().min(1).max(20).nullish(), kind: z.string().max(40).nullish() }).strict(),
]);
const body = z.object({ subjects: z.array(subject).min(1).max(40) }).strict();

/** Logos and leadership for a batch of companies, by asset id or by name and ticker (theme candidates). */
export async function POST(request: NextRequest) {
  try {
    let json: unknown;
    try { json = await request.json(); } catch { throw new ApiError("Body must be JSON", 400, "INVALID_JSON"); }
    const { subjects } = body.parse(json);
    const { lookupCompanyProfiles } = await import("@/lib/company-profiles/store");
    return successResponse(await lookupCompanyProfiles(subjects));
  } catch (error) {
    return handleApiError(error);
  }
}
