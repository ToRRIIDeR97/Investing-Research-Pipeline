import type { NextRequest } from "next/server";
import { and, asc, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { assets } from "@/db/schema/core";
import { research_runs } from "@/db/schema/workflow";
import { notebook_annotations, notebook_journal_entries, notebook_kpis, notebook_pins } from "@/db/schema/notebook";
import { ApiError } from "@/lib/api/errors";
import { requireFilingOfAsset } from "@/lib/api/filings";
import {
  MAX_NOTEBOOK_BODY_BYTES, MAX_NOTEBOOK_ROWS, NOTEBOOK_CONTRACTS, NOTEBOOK_KINDS, type Notebook, type NotebookAnnotation,
  type NotebookJournalEntry, type NotebookKind, type NotebookKpi, type NotebookPin,
} from "@/lib/research/notebook/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLES = { pins: notebook_pins, kpis: notebook_kpis, annotations: notebook_annotations, journal: notebook_journal_entries } as const;
const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();
const strings = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export const toPin = (r: typeof notebook_pins.$inferSelect): NotebookPin => ({ id: r.id, kind: r.kind as NotebookPin["kind"], ref_key: r.ref_key,
  frequency: r.frequency as NotebookPin["frequency"], note: r.note, position: r.position, created_at: iso(r.created_at), updated_at: iso(r.updated_at) });
export const toKpi = (r: typeof notebook_kpis.$inferSelect): NotebookKpi => ({ id: r.id, label: r.label, metric_key: r.metric_key, segment: r.segment,
  bear_line: r.bear_line, bull_line: r.bull_line, note: r.note, position: r.position, created_at: iso(r.created_at), updated_at: iso(r.updated_at) });
export const toAnnotation = (r: typeof notebook_annotations.$inferSelect): NotebookAnnotation => ({ id: r.id,
  anchor_kind: r.anchor_kind === "filing" ? "filing" : "report", source_document_id: r.source_document_id ?? null, research_run_id: r.research_run_id,
  section_id: r.section_id, section_title: r.section_title, section_coverage: strings(r.section_coverage), exhibit_key: r.exhibit_key,
  paragraph_index: r.paragraph_index, quote: r.quote, body: r.body, created_at: iso(r.created_at), updated_at: iso(r.updated_at) });
export const toJournal = (r: typeof notebook_journal_entries.$inferSelect): NotebookJournalEntry => ({ id: r.id, research_run_id: r.research_run_id,
  entry_date: String(r.entry_date), thesis: r.thesis, price: r.price, currency: r.currency, change_my_mind: r.change_my_mind, body: r.body,
  kpi_snapshot: Array.isArray(r.kpi_snapshot) ? r.kpi_snapshot as NotebookJournalEntry["kpi_snapshot"] : [], created_at: iso(r.created_at), updated_at: iso(r.updated_at) });
const TO_DTO = { pins: toPin, kpis: toKpi, annotations: toAnnotation, journal: toJournal } as const;

export function notebookKind(kind: string): NotebookKind {
  if (!(NOTEBOOK_KINDS as readonly string[]).includes(kind)) throw new ApiError("Notebook section not found", 404, "NOT_FOUND");
  return kind as NotebookKind;
}
export function notebookId(id: string, what = "Notebook item") {
  if (!UUID.test(id)) throw new ApiError(`${what} not found`, 404, "NOT_FOUND");
  return id;
}

export async function readNotebookBody(request: NextRequest): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_NOTEBOOK_BODY_BYTES) throw new ApiError("Request body is too large", 413, "BODY_TOO_LARGE");
  try { return JSON.parse(text); } catch { throw new ApiError("Request body must be JSON", 400, "INVALID_JSON"); }
}

/** The asset must exist; its id is the scope of every notebook row. */
export async function requireAsset(assetId: string) {
  notebookId(assetId, "Asset");
  const [row] = await db.select({ id: assets.id }).from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!row) throw new ApiError("Asset not found", 404, "NOT_FOUND");
  return row.id;
}

/** A run a note or journal entry names must be one of this asset's runs. */
async function requireRunOfAsset(runId: string | null | undefined, assetId: string) {
  if (!runId) return;
  const [row] = await db.select({ id: research_runs.id }).from(research_runs)
    .where(and(eq(research_runs.id, runId), eq(research_runs.asset_id, assetId))).limit(1);
  if (!row) throw new ApiError("That research run does not belong to this asset", 400, "RUN_NOT_OF_ASSET");
}

export async function loadNotebook(assetId: string): Promise<Notebook> {
  const [pins, kpis, annotations, journal] = await Promise.all([
    db.select().from(notebook_pins).where(eq(notebook_pins.asset_id, assetId)).orderBy(asc(notebook_pins.position), asc(notebook_pins.created_at)),
    db.select().from(notebook_kpis).where(eq(notebook_kpis.asset_id, assetId)).orderBy(asc(notebook_kpis.position), asc(notebook_kpis.created_at)),
    db.select().from(notebook_annotations).where(eq(notebook_annotations.asset_id, assetId)).orderBy(asc(notebook_annotations.created_at)),
    db.select().from(notebook_journal_entries).where(eq(notebook_journal_entries.asset_id, assetId)).orderBy(asc(notebook_journal_entries.entry_date), asc(notebook_journal_entries.created_at)),
  ]);
  return { pins: pins.map(toPin), kpis: kpis.map(toKpi), annotations: annotations.map(toAnnotation), journal: journal.map(toJournal) };
}

export async function createNotebookItem(assetId: string, kind: NotebookKind, body: unknown) {
  const table = TABLES[kind];
  const [{ total }] = await db.select({ total: count() }).from(table).where(eq(table.asset_id, assetId));
  if (total >= MAX_NOTEBOOK_ROWS) throw new ApiError(`This notebook section holds at most ${MAX_NOTEBOOK_ROWS} items. Delete one first.`, 409, "TOO_MANY_ITEMS");
  if (kind === "pins") {
    const v = NOTEBOOK_CONTRACTS.pins.create.parse(body);
    const frequency = v.kind === "metric" ? v.frequency : "";
    const [dupe] = await db.select({ id: notebook_pins.id }).from(notebook_pins).where(and(eq(notebook_pins.asset_id, assetId),
      eq(notebook_pins.kind, v.kind), eq(notebook_pins.ref_key, v.ref_key), eq(notebook_pins.frequency, frequency))).limit(1);
    if (dupe) throw new ApiError("That is already pinned", 409, "ALREADY_PINNED");
    const [row] = await db.insert(notebook_pins).values({ asset_id: assetId, kind: v.kind, ref_key: v.ref_key, frequency, note: v.note ?? "", position: total }).returning();
    return toPin(row);
  }
  if (kind === "kpis") {
    const v = NOTEBOOK_CONTRACTS.kpis.create.parse(body);
    const [row] = await db.insert(notebook_kpis).values({ asset_id: assetId, label: v.label, metric_key: v.metric_key, segment: v.segment || null,
      bear_line: v.bear_line ?? null, bull_line: v.bull_line ?? null, note: v.note ?? "", position: v.position ?? total }).returning();
    return toKpi(row);
  }
  if (kind === "annotations") {
    const v = NOTEBOOK_CONTRACTS.annotations.create.parse(body);
    await requireRunOfAsset(v.research_run_id, assetId);
    if (v.anchor_kind === "filing") {
      // A filing note sits on one of the asset's own filings (the same check the filings routes make).
      await requireFilingOfAsset(assetId, v.source_document_id);
      const [row] = await db.insert(notebook_annotations).values({ asset_id: assetId, anchor_kind: "filing", source_document_id: v.source_document_id,
        research_run_id: v.research_run_id ?? null, section_id: `filing-${v.section_index}`, section_title: v.section_title, section_coverage: [],
        exhibit_key: null, paragraph_index: null, quote: v.quote ?? "", body: v.body }).returning();
      return toAnnotation(row);
    }
    const [row] = await db.insert(notebook_annotations).values({ asset_id: assetId, anchor_kind: "report", research_run_id: v.research_run_id, section_id: v.section_id,
      section_title: v.section_title ?? "", section_coverage: v.section_coverage ?? [], exhibit_key: v.exhibit_key ?? null,
      paragraph_index: v.paragraph_index ?? null, quote: v.quote ?? "", body: v.body }).returning();
    return toAnnotation(row);
  }
  const v = NOTEBOOK_CONTRACTS.journal.create.parse(body);
  await requireRunOfAsset(v.research_run_id, assetId);
  const [row] = await db.insert(notebook_journal_entries).values({ asset_id: assetId, research_run_id: v.research_run_id ?? null, entry_date: v.entry_date,
    thesis: v.thesis ?? "", price: v.price ?? null, currency: v.currency ?? null, change_my_mind: v.change_my_mind ?? "", body: v.body ?? "",
    kpi_snapshot: v.kpi_snapshot ?? [] }).returning();
  return toJournal(row);
}

export async function updateNotebookItem(assetId: string, kind: NotebookKind, itemId: string, body: unknown) {
  const table = TABLES[kind];
  const parsed = NOTEBOOK_CONTRACTS[kind].update.parse(body) as Record<string, unknown>;
  if (kind === "journal") await requireRunOfAsset(parsed.research_run_id as string | null | undefined, assetId);
  if (kind === "kpis") {
    if ("segment" in parsed) parsed.segment = parsed.segment || null;
    // The lines must differ as stored, not only within one request.
    const [stored] = await db.select({ bear: notebook_kpis.bear_line, bull: notebook_kpis.bull_line }).from(notebook_kpis)
      .where(and(eq(notebook_kpis.id, itemId), eq(notebook_kpis.asset_id, assetId))).limit(1);
    const bear = "bear_line" in parsed ? parsed.bear_line : stored?.bear, bull = "bull_line" in parsed ? parsed.bull_line : stored?.bull;
    if (stored && bear != null && bull != null && bear === bull) throw new ApiError("The danger and target lines must differ", 400, "LINES_EQUAL");
  }
  const [row] = await db.update(table).set({ ...parsed, updated_at: new Date() } as never)
    .where(and(eq(table.id, itemId), eq(table.asset_id, assetId))).returning();
  if (!row) throw new ApiError("Notebook item not found", 404, "NOT_FOUND");
  return (TO_DTO[kind] as (r: unknown) => unknown)(row);
}

export async function deleteNotebookItem(assetId: string, kind: NotebookKind, itemId: string) {
  const table = TABLES[kind];
  const [row] = await db.delete(table).where(and(eq(table.id, itemId), eq(table.asset_id, assetId))).returning({ id: table.id });
  if (!row) throw new ApiError("Notebook item not found", 404, "NOT_FOUND");
}
