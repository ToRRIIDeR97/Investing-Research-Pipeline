import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import postgres from "postgres";
import { NextRequest } from "next/server";
import { isSourceUrl, MAX_UPLOAD_BYTES, storedExtension } from "../src/lib/ingestion/upload";
import { invokeDoclingParser } from "../src/lib/ingestion/parser";

function loadLocalEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

test("stored upload extensions are lowercased and allowlisted, and url fields must be http(s) (#20)", () => {
  for (const [name, ext] of [["Report.PDF", "pdf"], ["notes.md", "md"], ["data.CSV", "csv"], ["page.htm", "htm"], ["model.xlsx", "xlsx"],
    ["noext", "bin"], ["shell.php", "bin"], ["archive.tar.gz", "bin"], ["x.pdf/../../y", "bin"], ["trailing.", "bin"]]) {
    assert.equal(storedExtension(name), ext, name);
  }
  assert.equal(isSourceUrl("https://ir.acme.example/annual-report.pdf"), true);
  assert.equal(isSourceUrl("http://acme.example/"), true);
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ftp://acme.example/x", "https://user:pw@acme.example/", "acme.example/report",
    `https://acme.example/${"a".repeat(2100)}`]) {
    assert.equal(isSourceUrl(url), false, url);
  }
});

test("Docling parsing runs without blocking the event loop (#24)", async () => {
  // A stand-in python3 that takes a second, as a real parse of a large PDF would.
  const bin = await mkdtemp(join(tmpdir(), "research-os-python-"));
  await writeFile(join(bin, "python3"), `#!/bin/sh\nsleep 1\necho '{"chunks":[],"tables":[],"metadata":{"parser":"docling"},"warnings":[]}'\n`);
  await chmod(join(bin, "python3"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 50);
  try {
    const result = await invokeDoclingParser(join(bin, "upload.pdf"));
    assert.equal(result.metadata.parser, "docling");
    assert.ok(ticks >= 10, `event loop ticked ${ticks} times during a 1 s parse`);
  } finally {
    clearInterval(timer);
    process.env.PATH = savedPath;
    await rm(bin, { recursive: true, force: true });
  }
});

test("the ingest route refuses oversized or unsized bodies and invalid urls before storing anything (#20, #24)", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  loadLocalEnv();
  const { POST } = await import("../src/app/api/research-runs/[id]/sources/ingest/route");
  const { db } = await import("../src/db");
  const sql = postgres(process.env.DATABASE_URL!);
  const runId = crypto.randomUUID();
  const ingest = (form: FormData, length?: number) => POST(new NextRequest(`http://localhost/api/research-runs/${runId}/sources/ingest`, {
    method: "POST", body: form, ...(length === undefined ? {} : { headers: { "content-length": String(length) } }),
  }), { params: Promise.resolve({ id: runId }) });
  try {
    const [asset] = await sql`SELECT id FROM assets ORDER BY created_at LIMIT 1`;
    await sql`INSERT INTO research_runs (id, asset_id, run_type, status, pipeline_version) VALUES (${runId}, ${asset.id}, 'deep_dive', 'running', 3)`;
    const urlForm = (url: string) => { const form = new FormData(); form.set("source_type", "url"); form.set("url", url); return form; };

    assert.equal((await ingest(urlForm("https://acme.example/report"), MAX_UPLOAD_BYTES + 1)).status, 413);
    assert.equal((await ingest(urlForm("https://acme.example/report"))).status, 413);
    assert.equal((await ingest(urlForm("javascript:alert(1)"), 400)).status, 400);
    const big = new FormData();
    big.set("file", new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "big.pdf"));
    assert.equal((await ingest(big, 1_000)).status, 413);
    assert.equal(Number((await sql`SELECT count(*) FROM source_documents WHERE research_run_id = ${runId}`)[0].count), 0);

    const created = await ingest(urlForm("https://acme.example/report"), 400);
    assert.equal(created.status, 201);
    assert.equal((await created.json()).url, "https://acme.example/report");
  } finally {
    await sql`DELETE FROM source_documents WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql.end();
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  }
});
