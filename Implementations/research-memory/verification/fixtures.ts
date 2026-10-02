// Independent fixtures for the research-memory verification tests. Kept self-contained on purpose.
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STAGE_CONFIGS } from "../../../src/lib/workflow/stages";

export const skipDb = process.env.RUN_DB_INTEGRATION !== "1";

export function loadEnv() {
  // Tests pass explicit embedding and OCR providers; never reach a configured paid endpoint.
  delete process.env.RESEARCH_EMBEDDING_PROVIDER;
  delete process.env.RESEARCH_OCR_URL;
  if (process.env.DATABASE_URL || !existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]] && !["RESEARCH_EMBEDDING_PROVIDER", "RESEARCH_OCR_URL"].includes(match[1])) {
      process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
}

export function memory(): any {
  try { return require(resolve(__dirname, "../../../src/lib/research/memory")); }
  catch (error) { throw new Error(`src/lib/research/memory/index.ts is missing or failed to load: ${(error as Error).message}`); }
}

export type Run = { runId: string; assetId: string; assetSlug: string; assetName: string; symbol: string; cutoffAt: Date };

export async function newRun(sql: postgres.Sql, options: { budget?: number; name?: string } = {}): Promise<Run> {
  const assetId = randomUUID(), runId = randomUUID();
  const run = { assetId, runId, assetSlug: `memory-v-${assetId.slice(0, 8)}`, assetName: options.name || "Andes Payments Verification",
    symbol: "ANDV", cutoffAt: new Date("2026-10-01T00:00:00Z") };
  await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind, status, base_currency)
    VALUES (${assetId}, ${run.assetName}, ${run.assetSlug}, 'equity', 'active', 'USD')`;
  await sql`INSERT INTO research_runs (id, asset_id, run_type, status, source_cutoff_at, pipeline_version, budget_limit_usd)
    VALUES (${runId}, ${assetId}, 'deep_dive', 'running', '2026-10-01', 3, ${options.budget ?? 10})`;
  for (const [order, stage] of STAGE_CONFIGS.entries()) {
    await sql`INSERT INTO research_stages (research_run_id, stage_key, stage_order, status)
      VALUES (${runId}, ${stage.key}, ${order}, ${stage.key === "evidence_extraction" || stage.key === "moat_analysis" ? "running" : "completed"})`;
  }
  return run;
}

export const corpusContext = (run: Run) => ({ runId: run.runId, runType: "deep_dive", assetId: run.assetId, assetName: run.assetName,
  assetSlug: run.assetSlug, symbol: run.symbol, profileId: "", profileKey: "", requiredModules: [], requiredLenses: [],
  marketDataCutoffAt: null, pipelineVersion: 3 });

export const handlerContext = (run: Run) => ({ ...run, runType: "deep_dive", pipelineVersion: 3, marketDataCutoffAt: null,
  profileId: null, profileKey: null, researchQuestion: "Assess the business.", budgetLimitUsd: 10, budgetSpentUsd: 0,
  budgetRemainingUsd: 10, testMode: true, syntheticFixtureId: null, composedProfile: null, archetypeKeys: [], overlayKeys: [],
  timingHypothesis: null }) as any;

export const source = (title: string, content: string, mimeType: string, role: string, extra: Record<string, unknown> = {}) => ({
  sourceType: `web_${role}`, title, publisher: "verify.example", url: `https://verify.example/${randomUUID()}`, content, mimeType,
  qualityScore: "0.9", publishedAt: "2026-08-01", periodEnd: null, metadata: { source_role: role, system_generated: true, ...extra }, chunkTitle: title,
});

/** Plain-text sections as "Title\n\nBody" separated by blank lines. */
export const sections = (entries: Array<[string, string]>) => entries.map(([title, body]) => `${title}\n\n${body}`).join("\n\n");

export async function removeRuns(sql: postgres.Sql, runs: Run[]) {
  const runIds = runs.map(r => r.runId), assetIds = runs.map(r => r.assetId);
  const documents = (await sql`SELECT id FROM source_documents WHERE research_run_id = ANY(${runIds}::uuid[])
    OR id IN (SELECT source_document_id FROM research_run_sources WHERE research_run_id = ANY(${runIds}::uuid[]))`).map(r => String(r.id));
  const runTables = (await sql`SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'research_run_id'`).map(r => String(r.table_name));
  for (let pass = 0; pass < 5; pass++) {
    await sql`DELETE FROM research_artifact_claim_links WHERE artifact_id IN (SELECT id FROM research_artifacts WHERE research_run_id = ANY(${runIds}::uuid[]))`.catch(() => undefined);
    await sql`DELETE FROM claim_relationships WHERE from_claim_id IN (SELECT id FROM evidence_claims WHERE research_run_id = ANY(${runIds}::uuid[]))
      OR to_claim_id IN (SELECT id FROM evidence_claims WHERE research_run_id = ANY(${runIds}::uuid[]))`.catch(() => undefined);
    await sql`DELETE FROM evidence_links WHERE evidence_claim_id IN (SELECT id FROM evidence_claims WHERE research_run_id = ANY(${runIds}::uuid[]))`.catch(() => undefined);
    for (const name of [...runTables, "research_runs"]) {
      const column = name === "research_runs" ? "id" : "research_run_id";
      await sql`DELETE FROM ${sql(name)} WHERE ${sql(column)} = ANY(${runIds}::uuid[])`.catch(() => undefined);
    }
    if (documents.length) {
      await sql`DELETE FROM document_embeddings WHERE document_chunk_id IN (SELECT id FROM document_chunks WHERE source_document_id = ANY(${documents}::uuid[]))`.catch(() => undefined);
      for (const name of ["source_locations", "document_chunks", "document_parses", "source_role_assignments"]) {
        await sql`DELETE FROM ${sql(name)} WHERE source_document_id = ANY(${documents}::uuid[])`.catch(() => undefined);
      }
    }
  }
  if (documents.length) await sql`DELETE FROM source_documents WHERE id = ANY(${documents}::uuid[])`.catch(() => undefined);
  await sql`DELETE FROM assets WHERE id = ANY(${assetIds}::uuid[])`.catch(() => undefined);
}

/** A minimal PDF; an empty string makes a page without a text layer. */
export function pdf(pages: string[]): Uint8Array {
  const stream = (s: string) => `<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`;
  const ids = pages.map((_, i) => 4 + i * 2);
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${ids.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pages.flatMap((text, i) => [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${ids[i] + 1} 0 R >>`,
      stream(text ? `BT /F1 18 Tf 72 700 Td (${text}) Tj ET` : "")])];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out));
}

export const pdftotextAvailable = () => !require("node:child_process").spawnSync("pdftotext", ["-v"]).error;
