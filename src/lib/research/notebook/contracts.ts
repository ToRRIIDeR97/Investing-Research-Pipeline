/**
 * Request contracts for the investing notebook. Everything the operator types is untrusted text: control
 * characters are removed and the UI renders it as plain text only. References are checked against the code's
 * own catalogues (report exhibits, Financials metrics), so a pin or KPI can only name something code can draw.
 */
import { z } from "zod";
import { EXHIBITS } from "../reporting/exhibits";
import { metricDef } from "../reporting/metric-catalogue";

export const NOTEBOOK_KINDS = ["pins", "kpis", "annotations", "journal"] as const;
export type NotebookKind = typeof NOTEBOOK_KINDS[number];
/** Upper bound on rows of each kind per asset; there is no authentication, so writes are bounded. */
export const MAX_NOTEBOOK_ROWS = 200;
/** Largest request body the notebook routes read. */
export const MAX_NOTEBOOK_BODY_BYTES = 65_536;

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g;
/** One line of text: control characters and line breaks become spaces, whitespace collapses. */
const line = (max: number, empty = false) => z.string()
  .transform((s) => s.replace(CONTROL, " ").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim())
  .pipe(empty ? z.string().max(max) : z.string().min(1, "Required").max(max));
/** Free text: line breaks kept (normalised to \n), other control characters removed. */
const prose = (max: number, empty = true) => z.string()
  .transform((s) => s.replace(/\r\n?/g, "\n").replace(CONTROL, "").replace(/\n{3,}/g, "\n\n").trim())
  .pipe(empty ? z.string().max(max) : z.string().min(1, "Write something first").max(max));

const finite = z.number().finite();
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Not an id");
const exhibitKey = z.string().refine((key) => EXHIBITS.some((e) => e.key === key), "Unknown report exhibit");
/** A catalogue metric ("metric:operating_margin") or a captured observation key ("revenue"). */
export const kpiMetricKey = z.string().max(200).regex(/^(metric:)?[A-Za-z][A-Za-z0-9_]*$/, "Unknown metric key")
  .refine((key) => !key.startsWith("metric:") || Boolean(metricDef(key.slice(7))), "Unknown Financials metric");

export const pinCreate = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exhibit"), ref_key: exhibitKey, note: prose(2000).optional() }).strict(),
  z.object({ kind: z.literal("metric"), ref_key: z.string().refine((key) => Boolean(metricDef(key)), "Unknown Financials metric"),
    frequency: z.enum(["quarterly", "annual"]), note: prose(2000).optional() }).strict(),
]);
export const pinUpdate = z.object({ note: prose(2000).optional(), position: z.number().int().min(0).max(10_000).optional() }).strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

const kpiFields = {
  label: line(120), metric_key: kpiMetricKey, segment: line(200, true).nullable().optional(),
  bear_line: finite.nullable().optional(), bull_line: finite.nullable().optional(), note: prose(2000).optional(),
  position: z.number().int().min(0).max(10_000).optional(),
};
const linesDiffer = (v: { bear_line?: number | null; bull_line?: number | null }) =>
  v.bear_line == null || v.bull_line == null || v.bear_line !== v.bull_line;
export const kpiCreate = z.object(kpiFields).strict().refine(linesDiffer, "The danger and target lines must differ");
export const kpiUpdate = z.object(kpiFields).partial().strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update").refine(linesDiffer, "The danger and target lines must differ");

export const reportAnnotationCreate = z.object({
  anchor_kind: z.literal("report").optional(), research_run_id: uuid, section_id: z.string().min(1).max(120).regex(/^[a-z0-9_-]+$/i, "Unknown chapter"),
  section_title: line(300, true).optional(), section_coverage: z.array(z.string().max(40).regex(/^[a-z_]+$/)).max(20).optional(),
  exhibit_key: exhibitKey.nullable().optional(), paragraph_index: z.number().int().min(0).max(500).nullable().optional(),
  quote: line(300, true).optional(), body: prose(4000, false),
}).strict().refine((v) => v.exhibit_key == null || v.paragraph_index == null, "Anchor a note to an exhibit or a paragraph, not both");
/** A note on a passage of a stored filing (the panel's Filings tab): the filing, its section and the passage. */
export const filingAnnotationCreate = z.object({
  anchor_kind: z.literal("filing"), source_document_id: uuid, section_index: z.number().int().min(0).max(5000),
  section_title: line(300), quote: line(300, true).optional(), research_run_id: uuid.nullable().optional(), body: prose(4000, false),
}).strict();
/** A report note (anchor_kind omitted or "report") or a filing note (anchor_kind "filing"). */
export const annotationCreate = z.union([filingAnnotationCreate, reportAnnotationCreate]);
export const annotationUpdate = z.object({ body: prose(4000, false) }).strict();

export const KPI_STATUSES = ["healthy", "caution", "danger"] as const;
const snapshotRow = z.object({
  kpi_id: uuid.nullable(), label: line(120), value: finite.nullable(), display: line(60, true), unit: line(60, true),
  period: line(20, true).nullable(), status: z.enum(KPI_STATUSES).nullable(),
}).strict();
const journalFields = {
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "Not a date"),
  research_run_id: uuid.nullable().optional(), thesis: prose(4000).optional(), price: finite.positive().nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, "Use a three-letter currency code").nullable().optional(),
  change_my_mind: prose(4000).optional(), body: prose(8000).optional(), kpi_snapshot: z.array(snapshotRow).max(50).optional(),
};
const hasWords = (v: { thesis?: string; change_my_mind?: string; body?: string }) => Boolean(v.thesis || v.change_my_mind || v.body);
export const journalCreate = z.object(journalFields).strict().refine(hasWords, "Write a thesis, what would change your mind, or a note");
export const journalUpdate = z.object(journalFields).partial().strict().refine((v) => Object.keys(v).length > 0, "Nothing to update");

export type PinCreate = z.infer<typeof pinCreate>;
export type KpiCreate = z.infer<typeof kpiCreate>;
export type AnnotationCreate = z.infer<typeof annotationCreate>;
export type FilingAnnotationCreate = z.infer<typeof filingAnnotationCreate>;
export type JournalCreate = z.infer<typeof journalCreate>;
export type KpiSnapshotRow = z.infer<typeof snapshotRow>;

/** The create and update contract for each kind, as the routes use them. */
export const NOTEBOOK_CONTRACTS = {
  pins: { create: pinCreate, update: pinUpdate },
  kpis: { create: kpiCreate, update: kpiUpdate },
  annotations: { create: annotationCreate, update: annotationUpdate },
  journal: { create: journalCreate, update: journalUpdate },
} as const;

export interface NotebookPin { id: string; kind: "exhibit" | "metric"; ref_key: string; frequency: "" | "quarterly" | "annual"; note: string; position: number; created_at: string; updated_at: string }
export interface NotebookKpi { id: string; label: string; metric_key: string; segment: string | null; bear_line: number | null; bull_line: number | null; note: string; position: number; created_at: string; updated_at: string }
/**
 * A report note (anchor_kind "report": chapter, exhibit or paragraph) or a filing note (anchor_kind "filing": the
 * filing in source_document_id, null once that document is deleted, and its section in section_id "filing-<n>"). The API
 * always sets both; an annotation without anchor_kind is a report note.
 */
export interface NotebookAnnotation { id: string; anchor_kind?: "report" | "filing"; source_document_id?: string | null; research_run_id: string | null;
  section_id: string; section_title: string; section_coverage: string[];
  exhibit_key: string | null; paragraph_index: number | null; quote: string; body: string; created_at: string; updated_at: string }
export interface NotebookJournalEntry { id: string; research_run_id: string | null; entry_date: string; thesis: string; price: number | null; currency: string | null;
  change_my_mind: string; body: string; kpi_snapshot: KpiSnapshotRow[]; created_at: string; updated_at: string }
export interface Notebook { pins: NotebookPin[]; kpis: NotebookKpi[]; annotations: NotebookAnnotation[]; journal: NotebookJournalEntry[] }
