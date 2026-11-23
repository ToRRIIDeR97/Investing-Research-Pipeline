"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import ui from "@/components/research-ui.module.css";
import notes from "./notebook.module.css";
import styles from "./checklist.module.css";
import { Tag } from "@/components/ui/primitives";
import { MEASURES, MEASURE_KEYS, type ChecklistItem, type ItemResult, type MeasureKey } from "@/lib/research/checklist";

type Stored = { id: string; name: string; items: ChecklistItem[]; is_default: boolean };
type Evaluation = { id: string; research_run_id: string | null; checklist_id: string | null; checklist: { name: string }; results: ItemResult[];
  score: number; max: number; percent: number | null; unknown: number; judged_by: "model" | "none"; judgement_note: string; created_at: string };

const statusText = { met: "Met", not_met: "Not met", unknown: "Unknown" } as const;
async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init, ...(init?.body ? { headers: { "content-type": "application/json" } } : {}) });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const field = body?.details?.fieldErrors ? Object.values(body.details.fieldErrors as Record<string, string[]>).flat()[0] : undefined;
    throw new Error(body?.details?.formErrors?.[0] ?? field ?? (typeof body?.error === "string" ? body.error : `Request failed (${res.status})`));
  }
  return body as T;
}

/**
 * Investment checklists for one stock: pick a checklist, evaluate it on the run on screen (measures by code,
 * judgements by one model call when model calls are on), read the score and each item's result, and edit checklists.
 * Every text is rendered as plain text.
 */
export function ChecklistPanel({ assetId, runId, compact = false }: { assetId: string; runId: string | null; compact?: boolean }) {
  const [checklists, setChecklists] = useState<Stored[] | null>(null);
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Stored | "new" | null>(null);

  async function load() {
    try {
      const [lists, evals] = await Promise.all([call<Stored[]>("/api/checklists"), call<Evaluation[]>(`/api/assets/${assetId}/checklist-evaluations`)]);
      setChecklists(lists); setEvaluations(evals);
      setSelected((s) => s && lists.some((l) => l.id === s) ? s : lists[0]?.id ?? "");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => {
    let live = true;
    Promise.all([call<Stored[]>("/api/checklists"), call<Evaluation[]>(`/api/assets/${assetId}/checklist-evaluations`)]).then(([lists, evals]) => {
      if (!live) return;
      setChecklists(lists); setEvaluations(evals); setSelected(lists[0]?.id ?? "");
    }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [assetId]);

  const current = checklists?.find((c) => c.id === selected) ?? null;
  const latest = useMemo(() => evaluations.find((e) => e.checklist_id === selected && (!runId || e.research_run_id === runId))
    ?? evaluations.find((e) => e.checklist_id === selected) ?? null, [evaluations, selected, runId]);

  async function evaluate() {
    if (!current) return;
    setBusy(true); setError(null);
    try {
      const done = await call<Evaluation>(`/api/assets/${assetId}/checklist-evaluations`, { method: "POST",
        body: JSON.stringify({ checklist_id: current.id, ...(runId ? { research_run_id: runId } : {}) }) });
      setEvaluations((list) => [done, ...list]);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function remove(list: Stored) {
    if (!window.confirm(`Delete the checklist “${list.name}”? Past evaluations keep their copy.`)) return;
    try { await call(`/api/checklists/${list.id}`, { method: "DELETE" }); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  if (!checklists) return error ? <p className={notes.error} role="alert">{error}</p> : <p className={notes.meta} role="status">Loading checklists…</p>;
  if (editing) return <ChecklistEditor initial={editing === "new" ? null : editing} onCancel={() => setEditing(null)}
    onSaved={async (saved) => { setEditing(null); await load(); setSelected(saved.id); }} />;

  return <div className={notes.stack}>
    {error && <p className={notes.error} role="alert">{error}</p>}
    <div className={notes.inline}>
      <label className={`${ui.field} ${notes.grow}`}>Checklist
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {checklists.map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_default ? " (default)" : ""}</option>)}
        </select></label>
      <button type="button" className={ui.primary} onClick={() => void evaluate()} disabled={busy || !current}>{busy ? "Evaluating…" : "Evaluate"}</button>
    </div>
    <div className={notes.inline}>
      {current && <button type="button" className={notes.link} onClick={() => setEditing(current)}>Edit this checklist</button>}
      <button type="button" className={notes.link} onClick={() => setEditing("new")}>New checklist</button>
      {current && !current.is_default && <button type="button" className={notes.link} onClick={() => void remove(current)}>Delete</button>}
    </div>
    {latest ? <EvaluationView evaluation={latest} compact={compact} /> : <p className={notes.meta}>Not evaluated on this stock yet. Measured items come from the run&apos;s stored figures; judged items from one model call when model calls are on.</p>}
  </div>;
}

function EvaluationView({ evaluation, compact }: { evaluation: Evaluation; compact: boolean }) {
  return <div className={notes.stack}>
    <div className={styles.score} aria-label="Score">
      <strong>{evaluation.percent === null ? "—" : `${evaluation.percent}%`}</strong>
      <span className={notes.meta}>{evaluation.score} of {evaluation.max} evaluated weight met · {evaluation.unknown} not evaluated · {evaluation.created_at.slice(0, 10)}</span>
    </div>
    {evaluation.judgement_note && <p className={notes.meta}>{evaluation.judgement_note}</p>}
    <ol className={styles.items}>{evaluation.results.map((r) => <li key={r.id} className={styles.item}>
      <div className={styles.itemHead}>
        <Tag tone={r.status === "met" ? "good" : r.status === "not_met" ? "bad" : "waiting"}>{statusText[r.status]}</Tag>
        <span className={styles.itemLabel}>{r.label}</span>
        <span className={notes.meta}>{r.kind === "measure" ? r.display : "Judged"} · weight {r.weight}</span>
      </div>
      {!compact || r.status !== "met" ? <p className={notes.note}>{r.reason}</p> : null}
      {r.evidence.length > 0 && <ul className={styles.evidence}>{r.evidence.map((e) => <li key={e.id}>{e.source_title || e.id}{e.claim_text ? `: ${e.claim_text}` : ""}</li>)}</ul>}
    </li>)}</ol>
  </div>;
}

type DraftItem = { id: string; label: string; weight: number; kind: "measure" | "judgement"; measure: MeasureKey; op: ">=" | "<="; threshold: string; question: string };
const toDraft = (i: ChecklistItem): DraftItem => ({ id: i.id, label: i.label, weight: i.weight, kind: i.kind,
  measure: i.kind === "measure" ? i.measure : "revenue_yoy_median", op: i.kind === "measure" ? i.op : ">=",
  threshold: i.kind === "measure" ? String(i.threshold) : "", question: i.kind === "judgement" ? i.question : "" });
const fromDraft = (d: DraftItem) => d.kind === "measure"
  ? { id: d.id, label: d.label, weight: d.weight, kind: "measure", measure: d.measure, op: d.op, threshold: Number(d.threshold) }
  : { id: d.id, label: d.label, weight: d.weight, kind: "judgement", question: d.question };

function ChecklistEditor({ initial, onCancel, onSaved }: { initial: Stored | null; onCancel: () => void; onSaved: (saved: Stored) => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [items, setItems] = useState<DraftItem[]>(initial?.items.map(toDraft) ?? []);
  const [error, setError] = useState<string | null>(null);
  const set = (index: number, patch: Partial<DraftItem>) => setItems((list) => list.map((d, i) => i === index ? { ...d, ...patch } : d));
  function add(kind: DraftItem["kind"]) {
    const used = new Set(items.map((i) => i.id));
    let n = items.length + 1;
    while (used.has(`item_${n}`)) n += 1;
    setItems((list) => [...list, { id: `item_${n}`, label: "", weight: 2, kind, measure: "revenue_yoy_median", op: ">=", threshold: "", question: "" }]);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const body = JSON.stringify({ name, items: items.map(fromDraft) });
      onSaved(await call<Stored>(initial ? `/api/checklists/${initial.id}` : "/api/checklists", { method: initial ? "PATCH" : "POST", body }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  return <form className={ui.form} onSubmit={save} aria-label={initial ? `Edit ${initial.name}` : "New checklist"}>
    {error && <p className={notes.error} role="alert">{error}</p>}
    <label className={ui.field}>Name<input value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} /></label>
    <ol className={styles.items}>{items.map((d, i) => <li key={i} className={styles.item}>
      <div className={notes.inline}>
        <label className={`${ui.field} ${notes.grow}`}>Item<input value={d.label} maxLength={200} required onChange={(e) => set(i, { label: e.target.value })} /></label>
        <label className={`${ui.field} ${notes.small}`}>Weight<select value={d.weight} onChange={(e) => set(i, { weight: Number(e.target.value) })}>
          {[1, 2, 3].map((w) => <option key={w} value={w}>{w}</option>)}</select></label>
      </div>
      {d.kind === "measure" ? <div className={notes.inline}>
        <label className={`${ui.field} ${notes.grow}`}>Measure<select value={d.measure} onChange={(e) => set(i, { measure: e.target.value as MeasureKey })}>
          {MEASURE_KEYS.map((k) => <option key={k} value={k}>{MEASURES[k].label} ({MEASURES[k].unit})</option>)}</select></label>
        <label className={`${ui.field} ${notes.small}`}>Rule<select value={d.op} onChange={(e) => set(i, { op: e.target.value as DraftItem["op"] })}>
          <option value=">=">at least</option><option value="<=">at most</option></select></label>
        <label className={`${ui.field} ${notes.small}`}>Threshold<input inputMode="decimal" value={d.threshold} required onChange={(e) => set(i, { threshold: e.target.value })} /></label>
      </div> : <label className={ui.field}>Question for the model<textarea rows={2} maxLength={500} value={d.question} required onChange={(e) => set(i, { question: e.target.value })} /></label>}
      <button type="button" className={notes.link} onClick={() => setItems((list) => list.filter((_, j) => j !== i))}>Remove item</button>
    </li>)}</ol>
    <div className={notes.inline}>
      <button type="button" className={ui.secondary} onClick={() => add("measure")} disabled={items.length >= 30}>Add a measured item</button>
      <button type="button" className={ui.secondary} onClick={() => add("judgement")} disabled={items.length >= 30}>Add a judged item</button>
    </div>
    <div className={notes.inline}><button type="submit" className={ui.primary}>Save checklist</button><button type="button" className={notes.link} onClick={onCancel}>Cancel</button></div>
  </form>;
}
