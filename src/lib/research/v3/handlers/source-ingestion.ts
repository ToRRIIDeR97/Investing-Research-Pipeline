import type { V3RunContext, V3StageHandler, ValidationResult } from "../../v3-context";
import { v3ValidationResult } from "../../v3-context";
import postgres from "postgres";

export const sourceIngestionHandler: V3StageHandler<unknown> = {
  stageKey: "source_ingestion",
  async execute(ctx: V3RunContext): Promise<unknown> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const rows = await sql`
        SELECT COUNT(*) as cnt FROM document_parses dp
        JOIN source_documents sd ON dp.source_document_id = sd.id
        LEFT JOIN research_run_sources rrs ON rrs.source_document_id = sd.id
        WHERE (sd.research_run_id = ${ctx.runId} OR rrs.research_run_id = ${ctx.runId})
          AND dp.status = 'completed'
      `;
      const count = Number(rows[0].cnt);
      return { status: "success", parsedCount: count };
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: V3RunContext, output: any): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const rows = await sql`
        SELECT COUNT(*) as cnt FROM document_parses dp
        JOIN source_documents sd ON dp.source_document_id = sd.id
        LEFT JOIN research_run_sources rrs ON rrs.source_document_id = sd.id
        WHERE (sd.research_run_id = ${ctx.runId} OR rrs.research_run_id = ${ctx.runId})
          AND dp.status = 'completed'
      `;
      const errors: string[] = [];
      if (Number(rows[0].cnt) === 0) {
        errors.push("No completed document parses for this run");
      }
      return v3ValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
