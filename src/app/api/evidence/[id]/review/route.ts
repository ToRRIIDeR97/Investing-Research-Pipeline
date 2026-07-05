import { NextRequest } from "next/server";
import { db } from "@/db";
import { evidence_claims } from "@/db/schema/evidence";
import { handleApiError, successResponse, ApiError } from "@/lib/api/errors";
import { eq } from "drizzle-orm";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const { review_status, reviewed_by } = body as {
      review_status: string;
      reviewed_by?: string;
    };

    if (!review_status) {
      throw new ApiError("review_status is required", 400, "VALIDATION_ERROR");
    }

    const [updated] = await db
      .update(evidence_claims)
      .set({
        review_status,
        reviewed_by: reviewed_by ?? null,
        reviewed_at: new Date(),
      })
      .where(eq(evidence_claims.id, id))
      .returning();

    if (!updated) {
      throw new ApiError("Evidence claim not found", 404, "NOT_FOUND");
    }

    return successResponse(updated);
  } catch (error) {
    return handleApiError(error);
  }
}
