"use client";
import { useCallback, useEffect, useState } from "react";
import { Download, ExternalLink } from "lucide-react";
import ui from "@/components/research-ui.module.css";
import notes from "./notebook.module.css";
import styles from "./notebook-drawer.module.css";
import { safeUrl } from "@/lib/research/reporting/presentation.mjs";
import { filingNotes } from "@/lib/research/notebook/readings";
import type { NotebookApi } from "./use-notebook";
import type { Highlight } from "./notebook-drawer";

type Filing = { id: string; form: string; title: string; url: string | null; published_at: string | null; period_end: string | null; has_text: boolean };
type Outline = { filing: Omit<Filing, "has_text">; has_text: boolean; truncated: boolean; total_chars: number;
  sections: { index: number; title: string; chars: number; preview: string }[] };

const day = (iso: string | null) => iso ? iso.slice(0, 10) : "undated";
const size = (chars: number) => chars >= 1_000_000 ? `${(chars / 1_000_000).toFixed(1)}M chars` : chars >= 1_000 ? `${Math.round(chars / 1_000)}k chars` : `${chars} chars`;
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : `Request failed (${res.status})`);
  return body as T;
}

/**
 * The notebook panel's Filings tab: the asset's stored filings from the last two years, each opened as a compressed
 * outline (section titles, sizes, previews); a section expands to its full text, where a selected passage can be
 * noted. Text is rendered as plain text only. The view marks the filing and section with data attributes, which the
 * panel's selection reader uses as it uses the report's.
 */
export function FilingsPanel({ assetId, api, highlight, onNote }: {
  assetId: string; api: NotebookApi; highlight: Highlight | null; onNote: (highlight: Highlight) => void;
}) {
  const [filings, setFilings] = useState<Filing[] | null>(null);
  const [outline, setOutline] = useState<Outline | null>(null);
  const [texts, setTexts] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const base = `/api/assets/${assetId}/filings`;

  useEffect(() => {
    let live = true;
    getJson<Filing[]>(base).then((list) => { if (live) setFilings(list); }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [base]);

  const open = useCallback(async (filing: Filing) => {
    setError(null); setTexts({});
    try { setOutline(await getJson<Outline>(`${base}/${filing.id}`)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [base]);

  async function expand(index: number) {
    if (!outline) return;
    if (index in texts) { setTexts((t) => { const next = { ...t }; delete next[index]; return next; }); return; }
    try {
      const section = await getJson<{ text: string }>(`${base}/${outline.filing.id}?section=${index}`);
      setTexts((t) => ({ ...t, [index]: section.text }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  if (error && !outline) return <p className={notes.error} role="alert">{error}</p>;
  if (!filings) return <p className={notes.meta} role="status">Loading filings…</p>;

  if (!outline) return <section aria-label="Filings">
    {filings.length ? <div className={ui.list}>{filings.map((f) => <button key={f.id} type="button" className={ui.row} onClick={() => void open(f)}>
      <div><div className={ui.rowTitle}>{f.form} · {day(f.published_at)}</div><div className={ui.rowMeta}>{f.title}{f.has_text ? "" : " · text not stored"}</div></div>
    </button>)}</div> : <p className={notes.meta}>No 10-K, 10-Q, 20-F, 40-F, 6-K or 8-K filings from the last two years are stored for this stock. A research run collects them.</p>}
  </section>;

  const doc = outline.filing, original = safeUrl(doc.url);
  const docNotes = filingNotes(api.notebook.annotations, doc.id);
  const selected = highlight?.filing && highlight.filing.documentId === doc.id ? highlight : null;
  return <section aria-label={`${doc.form} ${day(doc.published_at)}`} className={notes.stack}>
    <div>
      <button type="button" className={notes.link} onClick={() => { setOutline(null); setTexts({}); setError(null); }}>All filings</button>
      <h3 className={styles.filingTitle}>{doc.form} · {day(doc.published_at)}</h3>
      <p className={notes.meta}>{doc.title} · {outline.sections.length} sections · {size(outline.total_chars)}{outline.truncated ? " (shortened)" : ""}</p>
      <div className={notes.inline}>
        {outline.has_text && <a className={ui.secondary} href={`${base}/${doc.id}/text`} download><Download size={14} aria-hidden="true" />Download text</a>}
        {original && <a className={ui.secondary} href={original} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} aria-hidden="true" />Original</a>}
      </div>
    </div>
    {error && <p className={notes.error} role="alert">{error}</p>}
    {selected && <div className={styles.selection}>
      <blockquote className={notes.quote}>{selected.text}</blockquote>
      <button type="button" className={ui.primary} onMouseDown={(e) => e.preventDefault()} onClick={() => onNote(selected)}>Note the selected passage</button>
    </div>}
    {!outline.has_text && <p className={notes.meta}>This filing&apos;s text is not stored yet; open the original.</p>}
    <ol className={styles.sections}>{outline.sections.map((s) => <li key={s.index}>
      <button type="button" className={styles.sectionHead} aria-expanded={s.index in texts} onClick={() => void expand(s.index)}>
        <span>{s.title}</span><span className={notes.meta}>{size(s.chars)}</span>
      </button>
      {s.index in texts
        ? <div className={styles.filingText} data-filing-document={doc.id} data-filing-title={`${doc.form} ${day(doc.published_at)}`}
            data-filing-section={s.index} data-filing-section-title={s.title}>{texts[s.index]}</div>
        : <p className={notes.meta}>{s.preview}</p>}
    </li>)}</ol>
    <div className={notes.entry}>
      <h3>Notes on this filing</h3>
      {docNotes.length ? docNotes.map((n) => <div key={n.id}>
        <span className={notes.label}>{n.section_title}</span>
        {n.quote && <blockquote className={notes.quote}>{n.quote}</blockquote>}
        <p className={notes.note}>{n.body}</p>
        <button type="button" className={notes.link} onClick={() => void api.remove("annotations", n.id)}>Delete</button>
      </div>) : <p className={notes.meta}>Open a section and select a passage to keep a note on it.</p>}
    </div>
  </section>;
}
