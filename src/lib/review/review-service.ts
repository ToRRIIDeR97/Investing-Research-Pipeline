import postgres from "postgres";

// ============================================================
// Review Service — §16, §27.11
// Human review decisions are first-class structured data.
// ============================================================

interface CreateReviewDecisionInput {
  assetId: string;
  runId: string;
  status: string;
  conviction?: string;
  priority?: string;
  watchlistReason?: string;
  positionSizingNote?: string;
  whatWouldChangeMind?: string;
  openQuestions?: string;
  reviewedBy: string;
}

/**
 * Create a review decision for a research run.
 */
export async function createReviewDecision(
  input: CreateReviewDecisionInput
): Promise<string> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const rows = await sql`
      INSERT INTO review_decisions (
        asset_id, research_run_id, status,
        conviction, priority, watchlist_reason,
        position_sizing_note, what_would_change_mind,
        open_questions, reviewed_by, reviewed_at
      ) VALUES (
        ${input.assetId}, ${input.runId}, ${input.status},
        ${input.conviction || null}, ${input.priority || null},
        ${input.watchlistReason || null},
        ${input.positionSizingNote || null},
        ${input.whatWouldChangeMind || null},
        ${input.openQuestions || null},
        ${input.reviewedBy}, NOW()
      )
      RETURNING id
    `;
    return rows[0].id;
  } finally {
    await sql.end();
  }
}

/**
 * Get the review queue — pending review items across all assets.
 */
export async function getReviewQueue(filters?: {
  assetId?: string;
  status?: string;
  priority?: string;
}) {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    // Get runs that need review (completed or waiting_for_human)
    const runs = await sql`
      SELECT
        rr.id as run_id,
        rr.asset_id,
        rr.run_type,
        rr.status as run_status,
        rr.research_question,
        rr.completed_at,
        a.canonical_name as asset_name,
        a.slug as asset_slug,
        a.asset_kind,
        rd.id as review_id,
        rd.status as review_status,
        rd.conviction,
        rd.priority,
        rd.reviewed_at
      FROM research_runs rr
      JOIN assets a ON rr.asset_id = a.id
      LEFT JOIN review_decisions rd ON rd.research_run_id = rr.id
      WHERE rr.status IN ('completed', 'waiting_for_human')
        ${filters?.assetId ? sql`AND rr.asset_id = ${filters.assetId}` : sql``}
      ORDER BY rr.completed_at DESC NULLS LAST, rr.created_at DESC
      LIMIT 50
    `;

    return runs;
  } finally {
    await sql.end();
  }
}

/**
 * Update an existing review decision.
 */
export async function updateReviewDecision(
  id: string,
  updates: Partial<CreateReviewDecisionInput>
) {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const rows = await sql`
      UPDATE review_decisions
      SET
        status = COALESCE(${updates.status || null}, status),
        conviction = COALESCE(${updates.conviction || null}, conviction),
        priority = COALESCE(${updates.priority || null}, priority),
        watchlist_reason = COALESCE(${updates.watchlistReason || null}, watchlist_reason),
        position_sizing_note = COALESCE(${updates.positionSizingNote || null}, position_sizing_note),
        what_would_change_mind = COALESCE(${updates.whatWouldChangeMind || null}, what_would_change_mind),
        open_questions = COALESCE(${updates.openQuestions || null}, open_questions)
      WHERE id = ${id}
      RETURNING *
    `;
    return rows[0];
  } finally {
    await sql.end();
  }
}
