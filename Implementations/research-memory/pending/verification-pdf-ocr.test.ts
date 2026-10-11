import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { createServer } from "node:http";
import { once } from "node:events";
import { storeDiscoveredSources } from "../../../src/lib/research/sources/corpus";
import { corpusContext, loadEnv, memory, newRun, pdf, pdftotextAvailable, removeRuns, skipDb, source } from "../verification/fixtures";

loadEnv();
const noPdf = !pdftotextAvailable();

async function worker(handler: (method: string, url: string, body: any) => { status: number; json: unknown }) {
  const log: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    log.push(`${request.method} ${request.url}`);
    let body: any = null;
    if (request.method === "POST") { try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = null; } }
    const { status, json } = handler(String(request.method), String(request.url), body);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(json));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { log, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
}

const env = (url: string) => ({ RESEARCH_OCR_URL: url, RESEARCH_OCR_TOKEN: "verify-token-999", RESEARCH_OCR_MODEL_REVISION: "m", RESEARCH_OCR_CODE_REVISION: "c" });
const ir = (page: number, text: string) => ({ documentId: "d", assetVersionId: "v", parser: { id: "o", version: "1", configurationHash: "h" },
  pages: [{ pageNumber: page, width: 1, height: 1, blocks: [{ blockId: `b${page}`, type: "paragraph", readingOrder: 0, text, confidence: 0.95 }] }] });

test("AC-15: a middle page without text is the only unreadable page of three", { skip: noPdf }, async () => {
  const result = await memory().extractPdfPages(pdf(["Cover Page", "", "Closing Page"]));
  assert.deepEqual(result.pages.map((p: any) => p.page), [1, 2, 3]);
  assert.deepEqual(result.unreadablePages, [2]);
  assert.equal(result.text.split("\f").length, 3);
  assert.match(result.text.split("\f")[2], /Closing Page/);
});

test("AC-15: with OCR off, extraction never touches the network", { skip: noPdf }, async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("network used"); }) as typeof fetch;
  try {
    const result = await memory().extractPdfPages(pdf(["Text", ""]), { ocr: memory().createOcrClient({}) });
    assert.deepEqual(result.unreadablePages, [2]);
  } finally { globalThis.fetch = original; }
});

test("AC-15: a cited document's unreadable pages are reported even when a passage matched", { skip: skipDb }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    const [stored] = await storeDiscoveredSources(sql, corpusContext(run) as any, [source("Deck", `Wallet Growth\n\nWallet users doubled to nine million. ${run.runId}\f\nCards\n\nCard volume rose.\f \t \n`, "text/plain", "earnings_presentation")]);
    const { retrievePassages } = memory();
    const result = await retrievePassages(sql, { runId: run.runId, need: { key: "wallet", query: "wallet users", sourceRoles: ["earnings_presentation"] } });
    assert.ok(result.passages.length > 0);
    const gap = result.gaps.find((g: any) => g.reason === "unreadable_pages");
    assert.deepEqual(gap?.pages, [3]);
    assert.equal(gap?.source_id, stored.sourceId);
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});

test("AC-16: two empty pages are both read, and a failed upload leaves pages unreadable without throwing", { skip: noPdf }, async () => {
  const { createOcrClient, extractPdfPages } = memory();
  const ok = await worker((method, _url, body) => method === "PUT" ? { status: 201, json: {} } : { status: 200, json: ir(Number(body?.pageNumber), "Scanned page text") });
  try {
    const result = await extractPdfPages(pdf(["Intro", "", ""]), { ocr: createOcrClient(env(ok.url)) });
    assert.deepEqual(result.pages.slice(1).map((p: any) => p.source), ["ocr", "ocr"]);
    assert.deepEqual(result.unreadablePages, []);
    assert.equal(ok.log.filter(l => l === "POST /v1/ocr").length, 2);
  } finally { ok.close(); }
  const refused = await worker(method => method === "PUT" ? { status: 413, json: { error: "invalid asset size" } } : { status: 200, json: ir(2, "should not be used") });
  try {
    const result = await extractPdfPages(pdf(["Intro", ""]), { ocr: createOcrClient(env(refused.url)) });
    assert.deepEqual(result.unreadablePages, [2]);
    assert.equal(result.pages[1].source, "none");
  } finally { refused.close(); }
});

test("AC-16: loopback HTTP and HTTPS endpoints are accepted without contacting them", () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("contacted at creation"); }) as typeof fetch;
  try {
    assert.ok(memory().createOcrClient(env("http://localhost:7777")));
    assert.ok(memory().createOcrClient(env("https://ocr.internal.example")));
  } finally { globalThis.fetch = original; }
});
