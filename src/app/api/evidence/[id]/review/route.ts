import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { evidence_claims } from "@/db/schema/evidence";
import { handleApiError, successResponse, ApiError } from "@/lib/api/errors";
import { eq } from "drizzle-orm";

// The API has no accounts, so the reviewer is recorded as such; a body's reviewed_by is ignored (#13).
const UNAUTHENTICATED_REVIEWER = "api:unauthenticated";
const reviewSchema = z.object({ review_status: z.enum(["pending", "accepted", "rejected"]) });

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const id = z.string().guid().parse((await params).id);
    const { review_status } = reviewSchema.parse(await request.json().catch(() => ({})));

    const [updated] = await db
      .update(evidence_claims)
      .set({
        review_status,
        reviewed_by: UNAUTHENTICATED_REVIEWER,
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
