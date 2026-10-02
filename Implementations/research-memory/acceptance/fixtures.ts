// Fixtures for the research-memory acceptance tests.
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

/** The memory module is new; load it lazily so a missing module fails each test with a clear message. */
export function loadMemory(): any {
  try {
    return require(resolve(__dirname, "../../../src/lib/research/memory"));
  } catch (error) {
    throw new Error(`src/lib/research/memory/index.ts is missing or failed to load: ${(error as Error).message}`);
  }
}

const filler = (n: number) => Array.from({ length: n }, (_, i) =>
  `<p>Prospectus summary paragraph ${i}. The offering, the selling stockholders, the use of proceeds and the dividend policy are described in later sections of this prospectus.</p>`).join("\n");

/** A MercadoLibre-style final prospectus: cover, contents, then the founding story past the first 9,000 characters. */
export function prospectusHtml(nonce: string = randomUUID()) {
  return `<html><head><title>d424b1.htm</title><style>.cover { font-size: 12pt }</style></head><body>
<div style="display:none"><ix:header><ix:hidden>dei:EntityRegistrantName MercadoLibre hidden ${nonce}</ix:hidden></ix:header></div>
<p style="text-align:center"><b>PROSPECTUS</b></p>
<p>16,077,185 shares MERCADOLIBRE, INC. Common stock. This is the initial public offering of our common stock. Fixture ${nonce}.</p>
<p><b>TABLE OF CONTENTS</b></p>
<table><tr><td><b>Prospectus summary</b></td><td>1</td></tr><tr><td>Business</td><td>58</td></tr><tr><td>Management</td><td>74</td></tr></table>
${filler(70)}
<p style="font-weight:bold">BUSINESS</p>
<p>We are the largest online commerce platform in Latin America, based on unique visitors and page views.</p>
<p><b>History of MercadoLibre</b></p>
<p>In March of 1999, Marcos Galper&iacute;n, our co-founder and Chief Executive Officer, while working towards his master&#146;s degree in business administration from Stanford Business School, wrote our business plan and began to assemble a team of professionals to implement it.</p>
<p>We were incorporated in Delaware in October 1999 and launched our marketplace in Argentina in August 1999.</p>
<p><b>RISK FACTORS</b></p>
<p>Our business depends on continued growth of e-commerce in Latin America.</p>
<table><tr><th>Year</th><th>Net revenues</th></tr><tr><td>2005</td><td>$31.4</td></tr><tr><td>2006</td><td>$51.7</td></tr></table>
</body></html>`;
}

export const earningsText = (nonce: string = randomUUID()) => [
  "Third Quarter 2026 Results",
  "",
  `Net revenues grew 34 percent year over year to 7.4 billion dollars. Fixture ${nonce}.`,
  "",
  "Credit Quality",
  "",
  "Non-performing loans over 90 days fell to 6.1 percent of the credit portfolio.",
].join("\n");

export type Ctx = { runId: string; assetId: string; assetSlug: string; assetName: string; symbol: string; cutoffAt: Date };

export async function createRun(sql: postgres.Sql): Promise<Ctx> {
  const assetId = randomUUID(), runId = randomUUID();
  const ctx = { assetId, runId, assetSlug: `memory-${assetId.slice(0, 8)}`, assetName: "MercadoLibre Fixture",
    symbol: "MELIQA", cutoffAt: new Date("2026-10-01T00:00:00Z") };
  await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind, status, base_currency)
    VALUES (${assetId}, ${ctx.assetName}, ${ctx.assetSlug}, 'equity', 'active', 'USD')`;
  await sql`INSERT INTO research_runs (id, asset_id, run_type, status, source_cutoff_at, pipeline_version, budget_limit_usd)
    VALUES (${runId}, ${assetId}, 'deep_dive', 'running', '2026-10-01', 3, 10)`;
  for (const [order, stage] of STAGE_CONFIGS.entries()) {
    await sql`INSERT INTO research_stages (research_run_id, stage_key, stage_order, status)
      VALUES (${runId}, ${stage.key}, ${order}, ${stage.key === "evidence_extraction" ? "running" : "completed"})`;
  }
  return ctx;
}

/** The corpus RunContext used by storeDiscoveredSources and persistEvidence. */
export const corpusCtx = (ctx: Ctx) => ({ runId: ctx.runId, runType: "deep_dive", assetId: ctx.assetId, assetName: ctx.assetName,
  assetSlug: ctx.assetSlug, symbol: ctx.symbol, profileId: "", profileKey: "", requiredModules: [], requiredLenses: [],
  marketDataCutoffAt: null, pipelineVersion: 3 });

/** The stage ResearchRunContext the handlers receive. */
export const stageCtx = (ctx: Ctx) => ({ ...ctx, runType: "deep_dive", pipelineVersion: 3, marketDataCutoffAt: null,
  profileId: null, profileKey: null, researchQuestion: "Evaluate the company.", budgetLimitUsd: 10, budgetSpentUsd: 0,
  budgetRemainingUsd: 10, testMode: true, syntheticFixtureId: null, composedProfile: null, archetypeKeys: [], overlayKeys: [],
  timingHypothesis: null }) as any;

export function payload(input: { title: string; content: string; mimeType: string; role: string; sourceType?: string }) {
  return {
    sourceType: input.sourceType || `web_${input.role}`, title: input.title, publisher: "fixture.example",
    url: `https://fixture.example/${randomUUID()}`, content: input.content, mimeType: input.mimeType, qualityScore: "0.9",
    publishedAt: "2026-09-01", periodEnd: null, metadata: { source_role: input.role, system_generated: true },
    chunkTitle: input.title,
  };
}

export async function cleanup(sql: postgres.Sql, runIds: string[], assetIds: string[]) {
  const documents = (await sql`SELECT id FROM source_documents WHERE research_run_id = ANY(${runIds}::uuid[])
    OR id IN (SELECT source_document_id FROM research_run_sources WHERE research_run_id = ANY(${runIds}::uuid[]))`).map(r => String(r.id));
  const tables = (await sql`SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'research_run_id'`).map(r => String(r.table_name));
  const documentTables = ["document_embeddings", "source_locations", "document_chunks", "document_parses", "source_role_assignments"];
  for (let pass = 0; pass < 5; pass++) {
    for (const name of ["research_artifact_claim_links", "claim_relationships", "evidence_links"]) {
      try {
        if (name === "research_artifact_claim_links") await sql`DELETE FROM research_artifact_claim_links WHERE artifact_id IN (SELECT id FROM research_artifacts WHERE research_run_id = ANY(${runIds}::uuid[]))`;
        if (name === "claim_relationships") await sql`DELETE FROM claim_relationships WHERE from_claim_id IN (SELECT id FROM evidence_claims WHERE research_run_id = ANY(${runIds}::uuid[]))`;
        if (name === "evidence_links") await sql`DELETE FROM evidence_links WHERE evidence_claim_id IN (SELECT id FROM evidence_claims WHERE research_run_id = ANY(${runIds}::uuid[]))`;
      } catch { /* FK order; retry next pass */ }
    }
    for (const name of [...tables, "research_runs"]) {
      const column = name === "research_runs" ? "id" : "research_run_id";
      try { await sql`DELETE FROM ${sql(name)} WHERE ${sql(column)} = ANY(${runIds}::uuid[])`; } catch { /* retry */ }
    }
    if (documents.length) for (const name of documentTables) {
      try {
        if (name === "document_embeddings") await sql`DELETE FROM document_embeddings WHERE document_chunk_id IN (SELECT id FROM document_chunks WHERE source_document_id = ANY(${documents}::uuid[]))`;
        else await sql`DELETE FROM ${sql(name)} WHERE source_document_id = ANY(${documents}::uuid[])`;
      } catch { /* retry */ }
    }
  }
  if (documents.length) await sql`DELETE FROM source_documents WHERE id = ANY(${documents}::uuid[])`.catch(() => undefined);
  await sql`DELETE FROM assets WHERE id = ANY(${assetIds}::uuid[])`.catch(() => undefined);
}

/** A minimal PDF: one page per entry; an empty string makes an image-only page with no text layer. */
export function pdfWithPages(pages: string[]): Uint8Array {
  const stream = (s: string) => `<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`;
  const pageIds = pages.map((_, i) => 4 + i * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pages.flatMap((text, i) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`,
      stream(text ? `BT /F1 20 Tf 72 700 Td (${text}) Tj ET` : ""),
    ]),
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out));
}

export const hasPdftotext = () => !require("node:child_process").spawnSync("pdftotext", ["-v"]).error;
