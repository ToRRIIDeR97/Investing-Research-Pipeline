import { NextRequest } from "next/server";
import { db } from "@/db";
import { theses } from "@/db/schema/thesis";
import { handleApiError, successResponse, ApiError } from "@/lib/api/errors";
import { eq } from "drizzle-orm";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const allowedFields = [
      "one_sentence_thesis",
      "why_now",
      "market_missing",
      "status",
      "reviewed_by",
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
