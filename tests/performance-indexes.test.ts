import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { loadEnv, skipDb as skip } from "../Implementations/research-memory/acceptance/fixtures";

loadEnv();

const INDEXES: Record<string, { table: string; columns: string }> = {
  document_chunks_source_document_idx: { table: "document_chunks", columns: "(source_document_id)" },
  evidence_claims_run_review_idx: { table: "evidence_claims", columns: "(research_run_id, review_status)" },
  evidence_links_claim_idx: { table: "evidence_links", columns: "(evidence_claim_id)" },
  source_locations_chunk_idx: { table: "source_locations", columns: "(document_chunk_id)" },
  source_locations_source_document_idx: { table: "source_locations", columns: "(source_document_id)" },
  source_documents_research_run_idx: { table: "source_documents", columns: "(research_run_id)" },
  source_documents_url_idx: { table: "source_documents", columns: "(url)" },
  source_documents_asset_idx: { table: "source_documents", columns: "(asset_id)" },
  research_runs_asset_status_idx: { table: "research_runs", columns: "(asset_id, status)" },
};

test("chunk, claim, link and location lookups by their foreign keys have indexes the planner can use", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    const rows = await sql`SELECT indexname, tablename, indexdef FROM pg_indexes WHERE indexname = ANY(${Object.keys(INDEXES)}::text[])`;
    for (const [name, { table, columns }] of Object.entries(INDEXES)) {
      const row = rows.find(r => r.indexname === name);
      assert.ok(row, `${name} exists`);
      assert.equal(row.tablename, table);
      assert.ok(String(row.indexdef).endsWith(`USING btree ${columns}`), String(row.indexdef));
    }
    // The valuation share-count lookup and the source view filter chunks by document.
    const plan = await sql.begin(async tx => {
      await tx`SET LOCAL enable_seqscan = off`;
      return tx`EXPLAIN SELECT id FROM document_chunks WHERE source_document_id = ${"00000000-0000-0000-0000-000000000000"}::uuid AND text LIKE '%diluted%'`;
    });
    assert.match(plan.map(r => r["QUERY PLAN"]).join("\n"), /document_chunks_source_document_idx/);
  } finally { await sql.end(); }
});
