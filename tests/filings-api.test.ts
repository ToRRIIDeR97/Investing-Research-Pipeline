// F-5 and F-6: the filings library routes and filing notes against PostgreSQL. Only the asset's own stored filings
// are listed and served, as outlines, sections and plain text built from document_chunks; a filing note is kept on
// its filing and outlives the document. Brings its own assets, runs and documents and removes them afterwards.
import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { NextRequest } from "next/server";

const request = (url: string, method = "GET", body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

test("filings routes serve only the asset's stored filings, and filing notes stay on their filing", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const assetId = crypto.randomUUID(), otherAssetId = crypto.randomUUID(), runId = crypto.randomUUID(), otherRunId = crypto.randomUUID();
  const ids = { q: crypto.randomUUID(), qOld: crypto.randomUUID(), k: crypto.randomUUID(), old: crypto.randomUUID(), peer: crypto.randomUUID(),
    failed: crypto.randomUUID(), other: crypto.randomUUID(), bare: crypto.randomUUID() };
  const list = await import("../src/app/api/assets/[id]/filings/route");
  const one = await import("../src/app/api/assets/[id]/filings/[docId]/route");
  const text = await import("../src/app/api/assets/[id]/filings/[docId]/text/route");
  const notebook = await import("../src/app/api/assets/[id]/notebook/route");
  const notes = await import("../src/app/api/assets/[id]/notebook/[kind]/route");
  const at = (id: string, docId = "") => ({ params: Promise.resolve({ id, docId, kind: "annotations" }) });
  const outline = (asset: string, doc: string, query = "") => one.GET(request(`/api/assets/${asset}/filings/${doc}${query}`), at(asset, doc));
  try {
    const [profile] = await sql`SELECT id, version FROM research_profiles ORDER BY profile_key LIMIT 1`;
    assert.ok(profile, "A research profile must be seeded (npm run db:seed).");
    for (const [id, slug] of [[assetId, `filings-${assetId.slice(0, 8)}`], [otherAssetId, `filings-${otherAssetId.slice(0, 8)}`]])
      await sql`INSERT INTO assets (id, canonical_name, slug, primary_profile_id, status, asset_kind, base_currency)
        VALUES (${id}, 'Filings test asset', ${slug}, ${profile.id}, 'active', 'equity', 'USD')`;
    for (const [id, asset] of [[runId, assetId], [otherRunId, otherAssetId]])
      await sql`INSERT INTO research_runs (id, asset_id, run_type, status, research_question, requested_by, profile_id, profile_version,
          source_cutoff_at, market_data_cutoff_at, budget_limit_usd, pipeline_version, metadata_json)
        VALUES (${id}, ${asset}, 'full_initiation_report', 'completed', 'Filings test question.', 'filings-test', ${profile.id},
          ${Number(profile.version || 1)}, '2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z', '0', 3, ${sql.json({})})`;
    const doc = async (id: string, run: string, over: { source_type: string; title: string; url: string; published: string | null; retrieved?: string; metadata?: Record<string, unknown> }) => {
      await sql`INSERT INTO source_documents (id, source_type, title, url, published_at, retrieved_at, file_hash, storage_path, metadata_json)
        VALUES (${id}, ${over.source_type}, ${over.title}, ${over.url}, ${over.published}, ${over.retrieved ?? daysAgo(1)}, ${`filings-test-${id}`},
          ${"storage/does-not-exist/" + id}, ${sql.json((over.metadata ?? {}) as never)})`;
      await sql`INSERT INTO research_run_sources (research_run_id, source_document_id) VALUES (${run}, ${id})`;
    };
    await doc(ids.q, runId, { source_type: "sec_filing_10-q", title: "Filings Co 10-Q report 2026-09-30", url: "https://www.sec.gov/Archives/q3.htm", published: daysAgo(30), metadata: { form: "10-Q" } });
    await doc(ids.qOld, runId, { source_type: "sec_filing_10-q", title: "Filings Co 10-Q (earlier copy)", url: "https://www.sec.gov/Archives/q3.htm", published: daysAgo(30), retrieved: daysAgo(20), metadata: { form: "10-Q" } });
    await doc(ids.k, runId, { source_type: "sec_filing_10-k", title: "Filings Co 10-K/A report 2025-12-31", url: "javascript:alert(1)", published: daysAgo(270) });
    await doc(ids.old, runId, { source_type: "sec_filing_10-k", title: "Filings Co 10-K 2022", url: "https://www.sec.gov/Archives/k22.htm", published: daysAgo(1200), metadata: { form: "10-K" } });
    await doc(ids.peer, runId, { source_type: "peer_company_primary", title: "Peer Inc 10-K", url: "https://www.sec.gov/Archives/peer.htm", published: daysAgo(60) });
    await doc(ids.failed, runId, { source_type: "sec_filing_8-k", title: "Filings Co 8-K download failed", url: "https://www.sec.gov/Archives/8k.htm", published: daysAgo(40), metadata: { form: "8-K", fetch_status: "failed" } });
    await doc(ids.other, otherRunId, { source_type: "sec_filing_10-q", title: "Other Co 10-Q", url: "https://www.sec.gov/Archives/other.htm", published: daysAgo(30), metadata: { form: "10-Q" } });
    await doc(ids.bare, runId, { source_type: "sec_filing_8-k", title: "Filings Co 8-K earnings", url: "https://www.sec.gov/Archives/8k-2.htm", published: daysAgo(90), metadata: { form: "8-K" } });

    // The 10-Q's passages: a raw parse and the research-memory parse, which the library prefers.
    const parse = async (docId: string, parser: string, version: string, chunks: [number, string | null, string][]) => {
      const [p] = await sql`INSERT INTO document_parses (source_document_id, parser_name, parser_version, status, completed_at)
        VALUES (${docId}, ${parser}, ${version}, 'completed', NOW()) RETURNING id`;
      for (const [index, title, body] of chunks)
        await sql`INSERT INTO document_chunks (source_document_id, document_parse_id, chunk_index, section_title, text) VALUES (${docId}, ${p.id}, ${index}, ${title}, ${body})`;
    };
    await parse(ids.q, "raw", "1", [[0, null, "<html><body>raw html that should not be served</body></html>"]]);
    await parse(ids.q, "research-memory", "2", [
      [0, "Management's Discussion and Analysis", "Revenue grew 20% on member growth."],
      [1, "Management's Discussion and Analysis", "Net interest margin   widened.\n\nDeposits rose."],
      [2, "Risk Factors", "<b>Credit</b> losses may rise &amp; funding costs may rise."],
    ]);
    await parse(ids.other, "research-memory", "2", [[0, "Business", "Another company's text."]]);

    // List: the asset's filings from the last two years, one per URL, newest first; not the peer's, the failed
    // download, the old 10-K or another asset's filing.
    const listed = await (await list.GET(request(`/api/assets/${assetId}/filings`), at(assetId))).json();
    assert.deepEqual(listed.map((f: { id: string }) => f.id), [ids.q, ids.bare, ids.k]);
    assert.deepEqual(listed.map((f: { form: string }) => f.form), ["10-Q", "8-K", "10-K"]);
    assert.deepEqual(listed.map((f: { has_text: boolean }) => f.has_text), [true, false, false]);
    assert.equal((await list.GET(request("/"), at(crypto.randomUUID()))).status, 404);
    assert.equal((await list.GET(request("/"), at("not-a-uuid"))).status, 404);

    // Outline from the research-memory passages; sections expand to their text.
    const view = await (await outline(assetId, ids.q)).json();
    assert.equal(view.filing.form, "10-Q");
    assert.equal(view.has_text, true);
    assert.deepEqual(view.sections.map((s: { title: string }) => s.title), ["Management's Discussion and Analysis", "Risk Factors"]);
    assert.equal(view.total_chars, view.sections[0].chars + view.sections[1].chars);
    assert.doesNotMatch(JSON.stringify(view), /raw html/);
    const section = await (await outline(assetId, ids.q, "?section=1")).json();
    assert.equal(section.title, "Risk Factors");
    assert.equal(section.text, "Credit losses may rise & funding costs may rise.");
    assert.equal((await outline(assetId, ids.q, "?section=9")).status, 404);
    assert.equal((await outline(assetId, ids.q, "?section=../../etc")).status, 404);
    const empty = await (await outline(assetId, ids.k)).json();
    assert.deepEqual([empty.has_text, empty.sections.length, empty.filing.url], [false, 0, "javascript:alert(1)"], "the URL is data; the UI links it only through safeUrl");

    // Ownership: another asset's filing, a peer document and a failed download are not served.
    for (const [asset, docId] of [[assetId, ids.other], [otherAssetId, ids.q], [assetId, ids.peer], [assetId, ids.failed], [assetId, crypto.randomUUID()], [assetId, "x"]])
      assert.equal((await outline(asset, docId)).status, 404, `${asset === assetId ? "asset" : "other asset"} / ${docId}`);
    assert.equal((await (await outline(otherAssetId, ids.other)).json()).sections.length, 1);

    // Plain-text download.
    const download = await text.GET(request(`/api/assets/${assetId}/filings/${ids.q}/text`), at(assetId, ids.q));
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(download.headers.get("content-disposition") ?? "", /^attachment; filename="10-Q-\d{4}-\d{2}-\d{2}\.txt"$/);
    const body = await download.text();
    assert.match(body, /^# Filings Co 10-Q report 2026-09-30\n/);
    assert.match(body, /\n## Risk Factors\n/);
    assert.doesNotMatch(body, /<[a-z/][^>]*>/i);
    assert.equal((await text.GET(request("/"), at(assetId, ids.k))).status, 404, "no stored text");
    assert.equal((await text.GET(request("/"), at(otherAssetId, ids.q))).status, 404);

    // Filing notes: kept on one of the asset's filings, listed with their anchor, never on another asset's filing.
    const post = (asset: string, payload: unknown) => notes.POST(request(`/api/assets/${asset}/notebook/annotations`, "POST", payload), at(asset));
    const created = await post(assetId, { anchor_kind: "filing", source_document_id: ids.q, section_index: 1, section_title: "Risk Factors",
      quote: "Credit losses may rise", body: "Watch charge-offs.\u0000" });
    assert.equal(created.status, 201);
    const note = await created.json();
    assert.deepEqual([note.anchor_kind, note.source_document_id, note.section_id, note.section_title, note.body],
      ["filing", ids.q, "filing-1", "Risk Factors", "Watch charge-offs."]);
    assert.equal((await post(assetId, { anchor_kind: "filing", source_document_id: ids.other, section_index: 0, section_title: "Business", body: "x" })).status, 404);
    assert.equal((await post(assetId, { anchor_kind: "filing", source_document_id: ids.q, section_index: 0, section_title: "MD&A", body: "x", exhibit_key: "valuation_matrix" })).status, 400);
    assert.equal((await post(assetId, { anchor_kind: "filing", source_document_id: ids.q, section_index: -1, section_title: "MD&A", body: "x" })).status, 400);
    const report = await post(assetId, { research_run_id: runId, section_id: "valuation", section_title: "Valuation", body: "A report note." });
    assert.equal(report.status, 201);
    assert.equal((await report.json()).anchor_kind, "report");
    const all = await (await notebook.GET(request(`/api/assets/${assetId}/notebook`), at(assetId))).json();
    assert.deepEqual(all.annotations.map((a: { anchor_kind: string }) => a.anchor_kind).sort(), ["filing", "report"]);

    // Deleting the filing keeps the note, without its document.
    await sql`DELETE FROM document_chunks WHERE source_document_id = ${ids.q}`;
    await sql`DELETE FROM document_parses WHERE source_document_id = ${ids.q}`;
    await sql`DELETE FROM research_run_sources WHERE source_document_id = ${ids.q}`;
    await sql`DELETE FROM source_documents WHERE id = ${ids.q}`;
    const after = await (await notebook.GET(request(`/api/assets/${assetId}/notebook`), at(assetId))).json();
    const kept = after.annotations.find((a: { id: string }) => a.id === note.id);
    assert.deepEqual([kept.anchor_kind, kept.source_document_id, kept.body], ["filing", null, "Watch charge-offs."]);
  } finally {
    const all = Object.values(ids);
    await sql`DELETE FROM document_chunks WHERE source_document_id = ANY(${all}::uuid[])`;
    await sql`DELETE FROM document_parses WHERE source_document_id = ANY(${all}::uuid[])`;
    await sql`DELETE FROM research_run_sources WHERE source_document_id = ANY(${all}::uuid[])`;
    await sql`DELETE FROM notebook_annotations WHERE asset_id = ANY(${[assetId, otherAssetId]}::uuid[])`;
    await sql`DELETE FROM source_documents WHERE id = ANY(${all}::uuid[])`;
    await sql`DELETE FROM research_runs WHERE id = ANY(${[runId, otherRunId]}::uuid[])`;
    await sql`DELETE FROM assets WHERE id = ANY(${[assetId, otherAssetId]}::uuid[])`;
    await sql.end();
    const { db } = await import("../src/db");
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  }
});
