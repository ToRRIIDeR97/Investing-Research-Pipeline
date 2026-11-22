"use client";
import { useMemo, useState, type FormEvent } from "react";
import ui from "@/components/research-ui.module.css";
import styles from "./notebook.module.css";
import { ExhibitTile } from "@/components/report/exhibit-tile";
import { EXHIBITS } from "@/lib/research/reporting/exhibits";
import { METRICS } from "@/lib/research/reporting/metric-catalogue";
import { researchObservations } from "@/lib/research/reporting/data-views";
import { valuationSummary } from "@/lib/research/reporting/valuation-summary";
import { label } from "@/lib/research/reporting/presentation.mjs";
import type { ReportDocument } from "@/lib/research/reporting/report";
import { kpiReading, kpiSnapshot, pinViews, placeAnnotations, type KpiReading } from "@/lib/research/notebook/readings";
import type { NotebookApi } from "./use-notebook";

type Row = Record<string, any>;
const statusText = { healthy: "Healthy", caution: "Caution", danger: "In danger" } as const;
const today = () => new Date().toISOString().slice(0, 10);
const num = (text: string) => text.trim() === "" ? null : Number.isFinite(Number(text)) ? Number(text) : NaN;

function Status({ status }: { status: KpiReading["status"] }) {
  return status ? <span className={styles.pill} data-status={status}>{statusText[status]}</span> : <span className={styles.meta}>No line set</span>;
}

/**
 * The operator's notebook for one asset: their KPIs, pinned report exhibits and metrics, journal and report notes.
 * Every value is drawn from the latest run's stored artifacts in code; the notebook stores only references and text.
 */
export function InvestingNotebook({ api, artifacts, document, runId, runDate, reportHref }: {
  api: NotebookApi; artifacts: Row[]; document: ReportDocument | null; runId: string | null; runDate: string | null; reportHref: (sectionId: string) => string;
}) {
  const { notebook, loaded, error } = api;
  const observations = useMemo(() => researchObservations(artifacts), [artifacts]);
  const readings = useMemo(() => notebook.kpis.map((k) => kpiReading(k, observations)), [notebook.kpis, observations]);
  if (!loaded && !error) return <p className={ui.muted} role="status">Loading your notebook…</p>;
  return <div className={styles.stack}>
    <p className={ui.muted}>{runDate ? `Values are drawn from the latest research run (${runDate}). Your notes and lines are kept across runs.` : "No research run yet: values appear once a run completes."}</p>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={ui.grid}>
      <div className={`${ui.s7} ${styles.stack}`}>
        <KpiPanel api={api} readings={readings} observations={observations} />
        <PinPanel api={api} artifacts={artifacts} />
      </div>
      <div className={`${ui.s5} ${styles.stack}`}>
        <JournalPanel api={api} artifacts={artifacts} readings={readings} runId={runId} />
        <NotesPanel api={api} document={document} runId={runId} reportHref={reportHref} />
      </div>
    </div>
  </div>;
}

function KpiPanel({ api, readings, observations }: { api: NotebookApi; readings: KpiReading[]; observations: Row[] }) {
  const reported = useMemo(() => [...new Set(observations.filter((o) => o.periodicity === "quarterly" && !o.segment).map((o) => String(o.metric_key)))]
    // Named KPI keys only; raw XBRL concepts (us_gaap_Revenues, sofi_LoanFees) are reachable through the Financials metrics.
    .filter((k) => !/^[a-z]+_[A-Z]/.test(k)).sort().slice(0, 120), [observations]);
  const [form, setForm] = useState({ label: "", metric_key: "metric:operating_margin", bear: "", bull: "" });
  async function add(event: FormEvent) {
    event.preventDefault();
    const bear = num(form.bear), bull = num(form.bull);
    if (Number.isNaN(bear) || Number.isNaN(bull)) { api.setError("Lines must be numbers."); return; }
    const metricName = form.metric_key.startsWith("metric:") ? METRICS.find((m) => m.key === form.metric_key.slice(7))?.name : label(form.metric_key);
    if (await api.create("kpis", { label: form.label.trim() || metricName || form.metric_key, metric_key: form.metric_key, bear_line: bear, bull_line: bull }))
      setForm({ ...form, label: "", bear: "", bull: "" });
  }
  return <section className={ui.tile} aria-labelledby="nb-kpis">
    <header className={ui.tileHead}><h2 id="nb-kpis">My KPIs</h2><span className={ui.muted}>{readings.length} tracked</span></header>
    <div className={ui.tileBody}>
      {readings.length ? <div className={ui.table}><table>
        <thead><tr><th scope="col">KPI</th><th scope="col" className={styles.num}>Latest</th><th scope="col">Status</th><th scope="col" className={styles.num}>Danger line</th><th scope="col" className={styles.num}>Target</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{readings.map((r) => <tr key={r.kpi.id}>
          <th scope="row">{r.name}<div className={styles.meta}>{r.period ?? "No reading"}{r.unit ? ` · ${r.unit}` : ""}</div></th>
          <td className={styles.num}>{r.display}</td>
          <td><Status status={r.status} /><div className={styles.meta}>{r.reason}</div></td>
          <td className={styles.num}>{r.kpi.bear_line ?? "—"}</td><td className={styles.num}>{r.kpi.bull_line ?? "—"}</td>
          <td><button className={styles.link} onClick={() => void api.remove("kpis", r.kpi.id)} aria-label={`Stop tracking ${r.name}`}>Remove</button></td>
        </tr>)}</tbody>
      </table></div> : <p className={ui.muted}>Pick the KPIs that matter to your thesis and set your own danger and target lines. monitor:check also scores them when a new filing arrives.</p>}
      <form className={styles.inline} onSubmit={add} aria-label="Track a KPI" style={{ marginTop: 12 }}>
        <label className={`${ui.field} ${styles.grow}`}>Metric<select value={form.metric_key} onChange={(e) => setForm({ ...form, metric_key: e.target.value })}>
          <optgroup label="Financials metrics">{METRICS.map((m) => <option key={m.key} value={`metric:${m.key}`}>{m.name}</option>)}</optgroup>
          {reported.length > 0 && <optgroup label="Reported lines">{reported.map((k) => <option key={k} value={k}>{label(k)}</option>)}</optgroup>}
        </select></label>
        <label className={`${ui.field} ${styles.grow}`}>Name (optional)<input value={form.label} maxLength={120} onChange={(e) => setForm({ ...form, label: e.target.value })} /></label>
        <label className={`${ui.field} ${styles.small}`}>Danger line<input inputMode="decimal" value={form.bear} onChange={(e) => setForm({ ...form, bear: e.target.value })} placeholder="e.g. 30" /></label>
        <label className={`${ui.field} ${styles.small}`}>Target<input inputMode="decimal" value={form.bull} onChange={(e) => setForm({ ...form, bull: e.target.value })} placeholder="e.g. 40" /></label>
        <button className={ui.primary} type="submit">Track KPI</button>
      </form>
      <p className={styles.meta}>Lines use the KPI&apos;s unit: percent for margins and ratios, currency millions for amounts.</p>
    </div>
  </section>;
}

function PinPanel({ api, artifacts }: { api: NotebookApi; artifacts: Row[] }) {
  const views = useMemo(() => pinViews(api.notebook.pins, artifacts), [api.notebook.pins, artifacts]);
  const [choice, setChoice] = useState(`exhibit:${EXHIBITS[0].key}`);
  const [frequency, setFrequency] = useState<"quarterly" | "annual">("quarterly");
  async function add(event: FormEvent) {
    event.preventDefault();
    const [kind, key] = choice.split(":");
    await api.create("pins", kind === "exhibit" ? { kind, ref_key: key } : { kind, ref_key: key, frequency });
  }
  return <section className={ui.tile} aria-labelledby="nb-pins">
    <header className={ui.tileHead}><h2 id="nb-pins">Pinboard</h2><span className={ui.muted}>{views.length} pinned</span></header>
    <div className={ui.tileBody}>
      <form className={styles.inline} onSubmit={add} aria-label="Pin a table or metric">
        <label className={`${ui.field} ${styles.grow}`}>Table, chart or metric<select value={choice} onChange={(e) => setChoice(e.target.value)}>
          <optgroup label="Report tables and charts">{EXHIBITS.map((e) => <option key={e.key} value={`exhibit:${e.key}`}>{e.title}</option>)}</optgroup>
          <optgroup label="Financials metrics">{METRICS.map((m) => <option key={m.key} value={`metric:${m.key}`}>{m.name}</option>)}</optgroup>
        </select></label>
        {choice.startsWith("metric:") && <label className={`${ui.field} ${styles.small}`}>Periods<select value={frequency} onChange={(e) => setFrequency(e.target.value as "quarterly" | "annual")}>
          <option value="quarterly">Quarterly</option><option value="annual">Annual</option></select></label>}
        <button className={ui.primary} type="submit">Pin</button>
      </form>
      {!views.length && <p className={ui.muted}>Pin any report table, chart or Financials metric. Pins redraw from each new run.</p>}
    </div>
    {views.map((v) => <div key={v.pin.id} className={ui.tileBody} data-pin={v.pin.id}>
      {v.kind === "exhibit" ? <ExhibitTile exhibit={v.exhibit} id={`pin-${v.pin.id}`} />
        : v.kind === "metric" ? <section className={ui.tile} aria-label={v.title}><header className={ui.tileHead}><h3>{v.title}</h3><span className={ui.muted}>{v.series.unit}</span></header>
          <div className={ui.table}><table><thead><tr>{v.series.points.map((p) => <th key={p.period} scope="col" className={styles.num}>{p.period}</th>)}</tr></thead>
            <tbody><tr>{v.series.points.map((p) => <td key={p.period} className={styles.num}>{p.display}</td>)}</tr></tbody></table></div>
          <p className={styles.meta} style={{ padding: "0 14px 10px" }}>{v.series.formula}</p></section>
        : <p className={ui.muted}><strong>{v.title}</strong>: {v.reason}</p>}
      <PinNote api={api} id={v.pin.id} note={v.pin.note} title={v.title} />
    </div>)}
  </section>;
}

function PinNote({ api, id, note, title }: { api: NotebookApi; id: string; note: string; title: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note);
  if (!editing) return <div>
    {note && <p className={styles.note}>{note}</p>}
    <button className={styles.link} onClick={() => { setText(note); setEditing(true); }}>{note ? "Edit note" : "Add a note"}</button>{" · "}
    <button className={styles.link} onClick={() => void api.remove("pins", id)} aria-label={`Unpin ${title}`}>Unpin</button>
  </div>;
  return <form onSubmit={async (e) => { e.preventDefault(); if (await api.update("pins", id, { note: text })) setEditing(false); }}>
    <label className={ui.field}>Note on {title}<textarea rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} /></label>
    <div className={styles.inline} style={{ marginTop: 6 }}><button className={ui.primary} type="submit">Save</button><button className={ui.secondary} type="button" onClick={() => setEditing(false)}>Cancel</button></div>
  </form>;
}

function JournalPanel({ api, artifacts, readings, runId }: { api: NotebookApi; artifacts: Row[]; readings: KpiReading[]; runId: string | null }) {
  const summary = useMemo(() => { try { return valuationSummary(artifacts as any, { conclusionStatus: "qualified" }); } catch { return null; } }, [artifacts]);
  const [form, setForm] = useState({ entry_date: today(), thesis: "", change_my_mind: "", body: "", price: "" });
  const now = new Map(readings.map((r) => [r.kpi.id, r]));
  async function add(event: FormEvent) {
    event.preventDefault();
    const price = num(form.price || (summary?.price != null ? String(summary.price) : ""));
    if (Number.isNaN(price)) { api.setError("Price must be a number."); return; }
    const ok = await api.create("journal", { entry_date: form.entry_date, research_run_id: runId, thesis: form.thesis, change_my_mind: form.change_my_mind,
      body: form.body, price, currency: price != null ? (summary?.currency ?? "USD") : null, kpi_snapshot: kpiSnapshot(api.notebook.kpis, artifacts) });
    if (ok) setForm({ entry_date: today(), thesis: "", change_my_mind: "", body: "", price: "" });
  }
  const entries = [...api.notebook.journal].reverse();
  return <section className={ui.tile} aria-labelledby="nb-journal">
    <header className={ui.tileHead}><h2 id="nb-journal">Thesis journal</h2><span className={ui.muted}>{entries.length} entries</span></header>
    <div className={ui.tileBody}>
      <form className={ui.form} onSubmit={add} aria-label="Write a journal entry">
        <div className={ui.formGrid}>
          <label className={ui.field}>Date<input type="date" value={form.entry_date} onChange={(e) => setForm({ ...form, entry_date: e.target.value })} required /></label>
          <label className={ui.field}>Price{summary?.currency ? ` (${summary.currency})` : ""}<input inputMode="decimal" value={form.price} placeholder={summary?.price != null ? String(summary.price) : ""} onChange={(e) => setForm({ ...form, price: e.target.value })} /></label>
        </div>
        <label className={ui.field}>Thesis<textarea rows={3} maxLength={4000} value={form.thesis} onChange={(e) => setForm({ ...form, thesis: e.target.value })} /></label>
        <label className={ui.field}>What would change my mind<textarea rows={2} maxLength={4000} value={form.change_my_mind} onChange={(e) => setForm({ ...form, change_my_mind: e.target.value })} /></label>
        <label className={ui.field}>Notes<textarea rows={3} maxLength={8000} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></label>
        <div><button className={ui.primary} type="submit">Save entry</button> <span className={styles.meta}>Saves your KPI readings with it.</span></div>
      </form>
    </div>
    {entries.length > 0 && <div className={ui.tileBody}>{entries.map((e) => <article key={e.id} className={styles.entry}>
      <h3>{e.entry_date}{e.price != null ? ` · ${e.currency ?? ""} ${e.price.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : ""}</h3>
      {e.thesis && <><span className={styles.label}>Thesis</span><p className={styles.note}>{e.thesis}</p></>}
      {e.change_my_mind && <><span className={styles.label}>What would change my mind</span><p className={styles.note}>{e.change_my_mind}</p></>}
      {e.body && <><span className={styles.label}>Notes</span><p className={styles.note}>{e.body}</p></>}
      {e.kpi_snapshot.length > 0 && <div className={ui.table} style={{ marginTop: 8 }}><table>
        <caption className="sr-only">KPIs then and now</caption>
        <thead><tr><th scope="col">KPI</th><th scope="col" className={styles.num}>Then</th><th scope="col" className={styles.num}>Now</th></tr></thead>
        <tbody>{e.kpi_snapshot.map((s, i) => { const current = s.kpi_id ? now.get(s.kpi_id) : undefined;
          return <tr key={i}><th scope="row">{s.label}</th><td className={styles.num}>{s.display}{s.period ? <div className={styles.meta}>{s.period}</div> : null}</td>
            <td className={styles.num}>{current ? <>{current.display}{current.period ? <div className={styles.meta}>{current.period}</div> : null}</> : <span className={styles.meta}>No longer tracked</span>}</td></tr>; })}</tbody>
      </table></div>}
      <button className={styles.link} onClick={() => { if (window.confirm("Delete this journal entry?")) void api.remove("journal", e.id); }}>Delete entry</button>
    </article>)}</div>}
  </section>;
}

function NotesPanel({ api, document, runId, reportHref }: { api: NotebookApi; document: ReportDocument | null; runId: string | null; reportHref: (sectionId: string) => string }) {
  const placed = useMemo(() => document ? placeAnnotations(api.notebook.annotations, document, runId) : null, [api.notebook.annotations, document, runId]);
  const sections = document?.sections ?? [];
  return <section className={ui.tile} aria-labelledby="nb-notes">
    <header className={ui.tileHead}><h2 id="nb-notes">Report notes</h2><span className={ui.muted}>{api.notebook.annotations.length} notes</span></header>
    <div className={ui.tileBody}>
      {!api.notebook.annotations.length && <p className={ui.muted}>Add notes from any chapter of the report. They follow their chapter or exhibit to newer runs.</p>}
      {placed && sections.map((s) => { const notes = placed.bySection(s.id); return notes.length ? <div key={s.id} className={styles.entry}>
        <h3><a className={ui.textLink} href={reportHref(s.id)}>{s.title}</a></h3>
        {notes.map((p) => <div key={p.annotation.id}><p className={styles.note}>{p.annotation.body}</p>{p.state === "carried" && <p className={styles.meta}>{p.reason}</p>}</div>)}
      </div> : null; })}
      {placed && placed.unattached.length > 0 && <div className={styles.entry}><h3>Unattached</h3>
        {placed.unattached.map((p) => <div key={p.annotation.id}>
          <p className={styles.note}>{p.annotation.body}</p>
          <p className={styles.meta}>From “{p.annotation.section_title || p.annotation.section_id}”. {p.reason}</p>
          <button className={styles.link} onClick={() => void api.remove("annotations", p.annotation.id)}>Delete note</button>
        </div>)}</div>}
      {!document && api.notebook.annotations.length > 0 && api.notebook.annotations.map((a) => <p key={a.id} className={styles.note}>{a.body}</p>)}
    </div>
  </section>;
}
