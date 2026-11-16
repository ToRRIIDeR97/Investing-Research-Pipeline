import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { pipelineSql } from "@/db/pipeline-sql";

export const sourceIngestionHandler: StageHandler<unknown> = {
  stageKey: "source_ingestion",
  async execute(ctx: ResearchRunContext): Promise<unknown> {
    const sql = pipelineSql();
    const rows = await sql`
      SELECT COUNT(*) as cnt FROM document_parses dp
      JOIN source_documents sd ON dp.source_document_id = sd.id
      LEFT JOIN research_run_sources rrs ON rrs.source_document_id = sd.id
      WHERE (sd.research_run_id = ${ctx.runId} OR rrs.research_run_id = ${ctx.runId})
        AND dp.status = 'completed'
    `;
    const count = Number(rows[0].cnt);
    return { status: "success", parsedCount: count };
  },
  async validate(ctx: ResearchRunContext, output: any): Promise<ValidationResult> {
    const sql = pipelineSql();
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
    return makeValidationResult(errors);
  }
};
