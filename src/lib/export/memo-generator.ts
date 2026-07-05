import postgres from "postgres";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";

// ============================================================
// Memo Generator — §5.9, §10
// Generates Markdown memos from accepted database records.
// Markdown is a rendering target, not the source of truth.
// ============================================================

/**
 * Generate a research memo from accepted database records.
 */
export async function generateMemo(params: {
  runId: string;
  assetId: string;
  generatedBy: string;
}): Promise<{ exportId: string; storagePath: string; contentHash: string }> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    // Gather all accepted research data
    const [asset] = await sql`SELECT * FROM assets WHERE id = ${params.assetId}`;
    const [run] = await sql`SELECT * FROM research_runs WHERE id = ${params.runId}`;

    // Thesis
    const theses = await sql`
      SELECT * FROM theses
      WHERE research_run_id = ${params.runId} AND status != 'rejected'
      ORDER BY created_at DESC LIMIT 1
    `;

    // Thesis drivers
    const drivers = theses.length > 0
      ? await sql`SELECT * FROM thesis_drivers WHERE thesis_id = ${theses[0].id}`
      : [];

    // Risks
    const risks = await sql`
      SELECT * FROM risks WHERE research_run_id = ${params.runId}
      ORDER BY severity DESC
    `;

    // Valuation signals
    const signals = await sql`
      SELECT vs.*, vm.name as method_name
      FROM valuation_signals vs
      LEFT JOIN valuation_methods vm ON vs.valuation_method_id = vm.id
      WHERE vs.research_run_id = ${params.runId}
      ORDER BY vs.lens_family, vs.signal_name
    `;

    // Key evidence claims (facts only)
    const facts = await sql`
      SELECT * FROM evidence_claims
      WHERE research_run_id = ${params.runId}
        AND claim_category = 'fact'
        AND review_status != 'rejected'
      ORDER BY confidence DESC NULLS LAST
      LIMIT 20
    `;

    // Review decision
    const reviews = await sql`
      SELECT * FROM review_decisions
      WHERE research_run_id = ${params.runId}
      ORDER BY reviewed_at DESC LIMIT 1
    `;

    // Source gaps
    const gaps = await sql`
      SELECT * FROM source_gaps
      WHERE research_run_id = ${params.runId} AND status = 'open'
      ORDER BY severity DESC
    `;

    // Build the memo
    const thesis = theses[0];
    const review = reviews[0];

    const sections: string[] = [];

    // Header
    sections.push(`# Research Memo: ${asset.canonical_name}`);
    sections.push("");
    sections.push(`**Asset**: ${asset.canonical_name} (${asset.slug})`);
    sections.push(`**Type**: ${asset.asset_kind}`);
    sections.push(`**Run Type**: ${run.run_type}`);
    sections.push(`**Research Question**: ${run.research_question || "N/A"}`);
    sections.push(`**Generated**: ${new Date().toISOString()}`);
    sections.push("");

    // Thesis
    sections.push(`## Thesis`);
    sections.push("");
    if (thesis) {
      sections.push(`> ${thesis.one_sentence_thesis}`);
      sections.push("");
      if (thesis.why_now) {
        sections.push(`**Why Now**: ${thesis.why_now}`);
        sections.push("");
      }
      if (thesis.market_missing) {
        sections.push(`**What the Market is Missing**: ${thesis.market_missing}`);
        sections.push("");
      }

      // Drivers
      if (drivers.length > 0) {
        sections.push(`### Key Drivers`);
        sections.push("");
        for (const driver of drivers) {
          sections.push(`- **${driver.driver_name}** (${driver.driver_type}): ${driver.description || "—"}`);
          if (driver.value_impact) sections.push(`  - Impact: ${driver.value_impact}`);
          if (driver.confidence) sections.push(`  - Confidence: ${driver.confidence}`);
        }
        sections.push("");
      }
    } else {
      sections.push("*No thesis generated yet.*");
      sections.push("");
    }

    // Valuation Signals
    sections.push(`## Valuation Signals`);
    sections.push("");
    if (signals.length > 0) {
      sections.push("| Signal | Lens | Value | Signal | Cheapness |");
      sections.push("|--------|------|-------|--------|-----------|");
      for (const sig of signals) {
        const value = sig.current_value_text || sig.current_value || "—";
        sections.push(
          `| ${sig.signal_name} | ${sig.lens_family} | ${value} | ${sig.signal} | ${sig.cheapness_score || "—"} |`
        );
      }
      sections.push("");
    } else {
      sections.push("*No valuation signals generated yet.*");
      sections.push("");
    }

    // Key Evidence
    sections.push(`## Key Evidence (Facts)`);
    sections.push("");
    if (facts.length > 0) {
      for (const fact of facts) {
        sections.push(`- ${fact.claim_text} *(confidence: ${fact.confidence || "—"})*`);
      }
      sections.push("");
    } else {
      sections.push("*No fact claims recorded yet.*");
      sections.push("");
    }

    // Risks
    sections.push(`## Risks`);
    sections.push("");
    if (risks.length > 0) {
      for (const risk of risks) {
        sections.push(`### ${risk.risk_name}`);
        sections.push(`- **Type**: ${risk.risk_type}`);
        sections.push(`- **Severity**: ${risk.severity}`);
        if (risk.description) sections.push(`- ${risk.description}`);
        if (risk.what_would_confirm) sections.push(`- **Would confirm**: ${risk.what_would_confirm}`);
        sections.push("");
      }
    } else {
      sections.push("*No risks recorded yet.*");
      sections.push("");
    }

    // Source Gaps
    if (gaps.length > 0) {
      sections.push(`## Open Source Gaps`);
      sections.push("");
      for (const gap of gaps) {
        sections.push(`- **${gap.severity}**: ${gap.description}`);
      }
      sections.push("");
    }

    // Review Decision
    sections.push(`## Review Decision`);
    sections.push("");
    if (review) {
      sections.push(`- **Status**: ${review.status}`);
      if (review.conviction) sections.push(`- **Conviction**: ${review.conviction}`);
      if (review.priority) sections.push(`- **Priority**: ${review.priority}`);
      if (review.watchlist_reason) sections.push(`- **Watchlist Reason**: ${review.watchlist_reason}`);
      if (review.position_sizing_note) sections.push(`- **Position Sizing**: ${review.position_sizing_note}`);
      if (review.what_would_change_mind) sections.push(`- **What Would Change Mind**: ${review.what_would_change_mind}`);
      if (review.open_questions) sections.push(`- **Open Questions**: ${review.open_questions}`);
      sections.push(`- **Reviewed By**: ${review.reviewed_by}`);
      sections.push(`- **Reviewed At**: ${review.reviewed_at}`);
    } else {
      sections.push("*Pending human review.*");
    }
    sections.push("");

    // Footer
    sections.push("---");
    sections.push("*Generated from database records by Research OS*");

    const content = sections.join("\n");
    const contentHash = createHash("sha256").update(content).digest("hex");

    // Write to storage
    const exportDir = join(process.cwd(), "storage", "exports");
    await mkdir(exportDir, { recursive: true });
    const fileName = `${asset.slug}_${run.run_type}_${Date.now()}.md`;
    const storagePath = `storage/exports/${fileName}`;
    await writeFile(join(process.cwd(), storagePath), content, "utf-8");

    // Create exports record
    const rows = await sql`
      INSERT INTO exports (
        asset_id, research_run_id, export_type,
        template_version, storage_path, content_hash,
        generated_by, generated_at
      ) VALUES (
        ${params.assetId}, ${params.runId}, 'markdown_memo',
        '1.0', ${storagePath}, ${contentHash},
        ${params.generatedBy}, NOW()
      )
      RETURNING id
    `;

    return {
      exportId: rows[0].id,
      storagePath,
      contentHash,
    };
  } finally {
    await sql.end();
  }
}
