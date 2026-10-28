import { NextRequest } from "next/server";
import { db } from "@/db";
import { theses } from "@/db/schema/thesis";
import { handleApiError, successResponse, ApiError } from "@/lib/api/errors";
import { eq } from "drizzle-orm";

// The API has no accounts, so a status change records the reviewer as such; a body's reviewed_by is ignored (#13, #135).
const UNAUTHENTICATED_REVIEWER = "api:unauthenticated";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError("A JSON object body is required", 400, "VALIDATION_ERROR");
    }

    const allowedFields = [
      "one_sentence_thesis",
      "why_now",
      "market_missing",
      "status",
    ] as const;

    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (field in body) {
        updates[field] = body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      throw new ApiError("No valid fields to update", 400, "VALIDATION_ERROR");
    }

    if ("status" in updates) {
      updates.reviewed_by = UNAUTHENTICATED_REVIEWER;
      updates.reviewed_at = new Date();
    }
    updates.updated_at = new Date();

    const [updated] = await db
      .update(theses)
      .set(updates)
      .where(eq(theses.id, id))
      .returning();

    if (!updated) {
      throw new ApiError("Thesis not found", 404, "NOT_FOUND");
    }

    return successResponse(updated);
  } catch (error) {
    return handleApiError(error);
  }
}
