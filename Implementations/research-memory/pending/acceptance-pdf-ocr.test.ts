import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { storeDiscoveredSources } from "../../../src/lib/research/sources/corpus";
import { cleanup, corpusCtx, createRun, hasPdftotext, loadEnv, loadMemory, payload, pdfWithPages, skipDb } from "../acceptance/fixtures";

loadEnv();
const skipPdf = !hasPdftotext();

type Seen = { method: string; url: string; auth: string | null; body: Buffer };
async function ocrServer(respond: (seen: Seen) => { status: number; json: unknown }) {
  const seen: Seen[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const entry = { method: String(request.method), url: String(request.url), auth: request.headers.authorization || null, body: Buffer.concat(chunks) };
    seen.push(entry);
    const { status, json } = respond(entry);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(json));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  return { seen, url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

const ocrEnv = (url: string) => ({ RESEARCH_OCR_URL: url, RESEARCH_OCR_TOKEN: "ocr-token-123456", RESEARCH_OCR_MODEL_REVISION: "model-r1", RESEARCH_OCR_CODE_REVISION: "code-r1" });
const ocrPage = (confidence: number) => ({ documentId: "d", assetVersionId: "v", parser: { id: "ocr", version: "1", configurationHash: "h" }, pages: [{ pageNumber: 2, width: 612, height: 792,
  blocks: [{ blockId: "b2", type: "paragraph", readingOrder: 1, text: "Commerce margin rose to 12 percent.", confidence },
    { blockId: "b1", type: "heading", readingOrder: 0, text: "Segment Margins", confidence }] }] });

test("AC-15: PDF pages keep their boundaries and pages without text are unreadable when OCR is off", { skip: skipPdf }, async () => {
  const { extractPdfPages } = loadMemory();
  const result = await extractPdfPages(pdfWithPages(["Annual Results 2026", ""]));
  assert.equal(result.pages.length, 2);
  assert.match(result.pages[0].text, /Annual Results 2026/);
  assert.equal(result.pages[0].source, "text");
  assert.equal(result.pages[1].source, "none");
  assert.deepEqual(result.unreadablePages, [2]);
  assert.equal(result.text.split("\f").length, 2);
});

test("AC-15: indexing records unreadable pages and retrieval reports them as a gap", { skip: skipDb }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    const [stored] = await storeDiscoveredSources(sql, corpusCtx(run) as any, [payload({ title: "Investor deck", mimeType: "text/plain", role: "earnings_presentation",
      content: `Annual Results\n\nRevenue rose 30 percent. Fixture ${run.runId}.\f   \n\f\nOutlook\n\nMargins should expand.` })]);
    const [doc] = await sql`SELECT metadata_json FROM source_documents WHERE id = ${stored.sourceId}`;
    assert.deepEqual(doc.metadata_json.unreadable_pages, [2]);
    const { retrievePassages } = loadMemory();
    const result = await retrievePassages(sql, { runId: run.runId, need: { key: "spectrum", query: "satellite spectrum licences", sourceRoles: ["earnings_presentation"] } });
    const gap = result.gaps.find((g: any) => g.reason === "unreadable_pages");
    assert.ok(gap);
    assert.deepEqual(gap.pages, [2]);
    assert.equal(gap.source_id, stored.sourceId);
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-16: the OCR client is off by default and refuses unsafe endpoints", () => {
  const { createOcrClient } = loadMemory();
  assert.equal(createOcrClient({}), null);
  assert.throws(() => createOcrClient(ocrEnv("http://ocr.example.com")));
  assert.throws(() => createOcrClient(ocrEnv("https://user:pass@ocr.example.com")));
  assert.throws(() => createOcrClient(ocrEnv("https://ocr.example.com/?key=1")));
});

test("AC-16: empty pages are uploaded and read by the OCR worker in reading order", { skip: skipPdf }, async () => {
  const server = await ocrServer(seen => seen.method === "PUT" ? { status: 201, json: { created: true } } : { status: 200, json: ocrPage(0.9) });
  try {
    const { createOcrClient, extractPdfPages } = loadMemory();
    const pdf = pdfWithPages(["Annual Results 2026", ""]);
    const result = await extractPdfPages(pdf, { ocr: createOcrClient(ocrEnv(server.url)) });
    const sha = createHash("sha256").update(pdf).digest("hex");
    const put = server.seen.findIndex(s => s.method === "PUT"), post = server.seen.findIndex(s => s.method === "POST");
    assert.ok(put >= 0 && post > put, "the asset is uploaded before OCR is requested");
    assert.equal(server.seen[put].url, `/v1/assets/${sha}`);
    assert.ok(Buffer.from(pdf).equals(server.seen[put].body));
    assert.equal(server.seen[post].url, "/v1/ocr");
    assert.ok(server.seen.every(s => s.auth === "Bearer ocr-token-123456"));
    const body = JSON.parse(server.seen[post].body.toString());
    assert.deepEqual(body.asset, { sha256: sha, mediaType: "application/pdf" });
    assert.equal(body.pageNumber, 2);
    assert.equal(body.modelRevision, "model-r1");
    assert.equal(body.parserCodeRevision, "code-r1");
    assert.equal(result.pages[1].source, "ocr");
    assert.equal(result.pages[1].text, "Segment Margins\nCommerce margin rose to 12 percent.");
    assert.equal(result.pages[1].confidence, 0.9);
    assert.deepEqual(result.unreadablePages, []);
    assert.equal(server.seen.filter(s => s.method === "POST").length, 1, "pages with text are not sent to OCR");
  } finally { server.close(); }
});

test("AC-16: low-confidence OCR is flagged and a failing worker leaves the page unreadable", { skip: skipPdf }, async () => {
  const { createOcrClient, extractPdfPages } = loadMemory();
  const low = await ocrServer(seen => seen.method === "PUT" ? { status: 201, json: {} } : { status: 200, json: ocrPage(0.3) });
  try {
    const result = await extractPdfPages(pdfWithPages(["Cover", ""]), { ocr: createOcrClient(ocrEnv(low.url)) });
    assert.deepEqual(result.lowConfidencePages, [2]);
  } finally { low.close(); }
  const broken = await ocrServer(seen => seen.method === "PUT" ? { status: 201, json: {} } : { status: 502, json: { error: "engine down" } });
  try {
    const result = await extractPdfPages(pdfWithPages(["Cover", ""]), { ocr: createOcrClient(ocrEnv(broken.url)) });
    assert.equal(result.pages[1].source, "none");
    assert.deepEqual(result.unreadablePages, [2]);
  } finally { broken.close(); }
});
