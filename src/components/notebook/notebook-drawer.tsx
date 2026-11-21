"use client";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { MessageSquareText, NotebookPen, X } from "lucide-react";
import ui from "@/components/research-ui.module.css";
import styles from "./notebook-drawer.module.css";
import notes from "./notebook.module.css";
import type { ReportDocument } from "@/lib/research/reporting/report";
import { kpiSnapshot, placeAnnotations } from "@/lib/research/notebook/readings";
import type { NotebookApi } from "./use-notebook";
import { askResearchChat } from "@/components/research-chat";
import { FilingsPanel } from "./filings-panel";
import { ChecklistPanel } from "./checklist-panel";

type Row = Record<string, any>;
/**
 * A passage the reader selected: in the report (its chapter and the paragraph or exhibit it sits in), or in a filing
 * opened in the panel's Filings tab (`filing` set; `sectionId` is then "filing-<n>").
 */
export type Highlight = { text: string; sectionId: string; paragraphIndex: number | null; exhibitKey: string | null;
  filing: { documentId: string; documentTitle: string; sectionIndex: number; sectionTitle: string } | null };

const MAX_QUOTE = 300;
/** The report chapter in the address (#report-<id>), when the report is open. */
const chapterInHash = () => { try { return decodeURIComponent(window.location.hash.slice(1)).replace(/^report-/, "") || null; } catch { return null; } };

/**
 * Reads a selection inside the report's chapter body or a filing section: the report marks its chapter, paragraphs
 * and exhibits with data attributes, and the Filings tab marks the filing and section the same way.
 */
function readHighlight(): Highlight | null {
  const selection = window.getSelection();
  const text = selection?.toString().replace(/\s+/g, " ").trim() ?? "";
  if (!selection || !text || selection.rangeCount === 0) return null;
  const node = selection.getRangeAt(0).commonAncestorContainer;
  const element = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement) as Element | null;
  const filing = element?.closest("[data-filing-section]");
  if (filing) {
    const index = Number(filing.getAttribute("data-filing-section"));
    if (!Number.isInteger(index) || index < 0) return null;
    return { text: text.slice(0, MAX_QUOTE), sectionId: `filing-${index}`, paragraphIndex: null, exhibitKey: null,
      filing: { documentId: String(filing.getAttribute("data-filing-document")), documentTitle: String(filing.getAttribute("data-filing-title") ?? ""),
        sectionIndex: index, sectionTitle: String(filing.getAttribute("data-filing-section-title") ?? "") } };
  }
  const chapter = element?.closest("[data-report-chapter]");
  if (!chapter) return null;
  const paragraph = element?.closest("[data-paragraph]");
  const exhibit = element?.closest("[data-exhibit-key]");
  return { text: text.slice(0, MAX_QUOTE), sectionId: String(chapter.getAttribute("data-report-chapter")),
    paragraphIndex: paragraph ? Number(paragraph.getAttribute("data-paragraph")) : null, exhibitKey: exhibit ? exhibit.getAttribute("data-exhibit-key") : null, filing: null };
}

/**
 * The notebook as a panel that slides in from the right on every view of a stock: jot a thought (saved to the
 * journal), or select a line in the report and keep a note on it (saved as an annotation on that chapter).
 */
export function NotebookDrawer({ api, assetId, document, runId, artifacts, notebookHref, assetName }: {
  api: NotebookApi; assetId: string; document: ReportDocument | null; runId: string | null; artifacts: Row[]; notebookHref: string; assetName: string;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"notes" | "filings" | "checklist">("notes");
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [pending, setPending] = useState<Highlight | null>(null);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [chapter, setChapter] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onSelect = () => setHighlight(readHighlight());
    const onHash = () => setChapter(chapterInHash());
    onHash();
    window.document.addEventListener("selectionchange", onSelect);
    window.addEventListener("hashchange", onHash);
    return () => { window.document.removeEventListener("selectionchange", onSelect); window.removeEventListener("hashchange", onHash); };
  }, []);
  useEffect(() => { if (open) field.current?.focus(); }, [open, pending]);
  useEffect(() => { if (!open) return; const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [open]);

  const sections = document?.sections ?? [];
  const placed = useMemo(() => document ? placeAnnotations(api.notebook.annotations, document, runId) : null, [api.notebook.annotations, document, runId]);
  const current = chapter && sections.some((s) => s.id === chapter) ? sections.find((s) => s.id === chapter)! : null;
  const chapterNotes = current && placed ? placed.bySection(current.id) : [];

  function noteHighlight() { setPending(highlight); setSaved(null); setOpen(true); }
  /** Opens the research chat with the passage attached (ResearchChat listens for the research-chat:ask event). */
  function askAbout(passage: Highlight) {
    askResearchChat({ quote: passage.text, section_id: passage.sectionId, section_title: sections.find((s) => s.id === passage.sectionId)?.title });
  }
  // The chat takes a report passage; a filing passage is noted only.
  const canAsk = Boolean(runId && document);
  const askable = (h: Highlight | null): h is Highlight => Boolean(h && !h.filing && canAsk);
  function noteFilingPassage(h: Highlight) { setPending(h); setSaved(null); setTab("notes"); }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) { api.setError("Write a note first."); return; }
    if (pending?.filing) {
      const f = pending.filing;
      const kept = await api.create("annotations", { anchor_kind: "filing", source_document_id: f.documentId, section_index: f.sectionIndex,
        section_title: f.sectionTitle.slice(0, 300) || `Section ${f.sectionIndex + 1}`, quote: pending.text, body: text });
      if (kept) { setSaved(`Kept on “${f.sectionTitle}” of ${f.documentTitle}.`); setText(""); setPending(null); }
      return;
    }
    const section = pending ? sections.find((s) => s.id === pending.sectionId) : null;
    const ok = pending && section && runId
      ? await api.create("annotations", { research_run_id: runId, section_id: section.id, section_title: section.title, section_coverage: section.coverage,
          exhibit_key: pending.exhibitKey, paragraph_index: pending.exhibitKey ? null : pending.paragraphIndex, quote: pending.text, body: text })
      : await api.create("journal", { entry_date: new Date().toISOString().slice(0, 10), research_run_id: runId, body: text, kpi_snapshot: kpiSnapshot(api.notebook.kpis, artifacts) });
    if (ok) { setSaved(pending ? `Kept on “${section?.title ?? "this chapter"}”.` : "Saved to your journal."); setText(""); setPending(null); }
  }

  return <>
    {!open && <button type="button" className={styles.tab} onClick={highlight ? noteHighlight : () => setOpen(true)} aria-expanded={false} aria-controls="notebook-drawer">
      <NotebookPen size={15} aria-hidden="true" />{highlight ? "Note this" : "Notebook"}
    </button>}
    {!open && askable(highlight) && <button type="button" className={`${styles.tab} ${styles.ask}`} onMouseDown={(e) => e.preventDefault()} onClick={() => askAbout(highlight)}>
      <MessageSquareText size={15} aria-hidden="true" />Ask about this
    </button>}
    <aside id="notebook-drawer" className={styles.drawer} data-open={open || undefined} aria-label={`Notebook for ${assetName}`} hidden={!open}>
      <header className={styles.head}>
        <h2>Notebook</h2>
        <button type="button" className={styles.close} onClick={() => setOpen(false)} aria-label="Close the notebook"><X size={16} /></button>
      </header>
      <div className={styles.tabs} role="tablist" aria-label="Notebook panel">
        <button type="button" role="tab" aria-selected={tab === "notes"} onClick={() => setTab("notes")}>Notes</button>
        <button type="button" role="tab" aria-selected={tab === "filings"} onClick={() => setTab("filings")}>Filings</button>
        <button type="button" role="tab" aria-selected={tab === "checklist"} onClick={() => setTab("checklist")}>Checklist</button>
      </div>
      <div className={styles.body}>
        {api.error && <p className={notes.error} role="alert">{api.error}</p>}
        {tab === "checklist" ? <ChecklistPanel assetId={assetId} runId={runId} compact /> : tab === "filings" ? <FilingsPanel assetId={assetId} api={api} highlight={highlight} onNote={noteFilingPassage} /> : <>
        <form className={ui.form} onSubmit={save} aria-label="Write a note">
          {pending ? <div>
            <span className={notes.label}>{pending.filing ? `On this passage of ${pending.filing.documentTitle}, “${pending.filing.sectionTitle}”` : "On this passage"}</span>
            <blockquote className={notes.quote}>{pending.text}</blockquote>
            <button type="button" className={notes.link} onClick={() => setPending(null)}>Write a general note instead</button>
            {askable(pending) && <> · <button type="button" className={notes.link} onClick={() => askAbout(pending)}>Ask about this</button></>}
          </div> : highlight && !highlight.filing ? <button type="button" className={notes.link} onClick={() => setPending(highlight)}>Note the selected passage</button> : null}
          <label className={ui.field}>{pending ? "Your note" : "A thought about this stock"}
            <textarea ref={field} rows={5} maxLength={pending ? 4000 : 8000} value={text} onChange={(e) => setText(e.target.value)} /></label>
          <div className={notes.inline}><button className={ui.primary} type="submit">Save</button>{saved && <span className={notes.meta} role="status">{saved}</span>}</div>
          {!pending && <p className={notes.meta}>Select a line in the report to keep a note on it. General notes go to your journal with today&apos;s KPI readings.</p>}
        </form>
        {current && <section aria-labelledby="drawer-chapter-notes" className={notes.entry}>
          <h3 id="drawer-chapter-notes">Notes on {current.title}</h3>
          {chapterNotes.length ? chapterNotes.map((p) => <div key={p.annotation.id}>
            {p.annotation.quote && <blockquote className={notes.quote}>{p.annotation.quote}</blockquote>}
            <p className={notes.note}>{p.annotation.body}</p>
            {p.state === "carried" && <p className={notes.meta}>{p.reason}</p>}
            <button type="button" className={notes.link} onClick={() => void api.remove("annotations", p.annotation.id)}>Delete</button>
          </div>) : <p className={notes.meta}>No notes on this chapter yet.</p>}
        </section>}
        <p className={notes.entry}><Link className={ui.textLink} href={notebookHref}>Open the full notebook</Link> <span className={notes.meta}>for your KPIs, pins and journal.</span></p>
        </>}
      </div>
    </aside>
  </>;
}
