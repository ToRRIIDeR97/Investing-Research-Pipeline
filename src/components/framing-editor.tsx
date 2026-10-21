"use client";

import { useEffect, useState } from "react";
import ui from "@/components/research-ui.module.css";
import { businessArchetypes, archetypeOverlays } from "@/lib/research/archetypes/registry";

type Row = Record<string, any>;
export interface FramingEdits { framing?: Row; archetypes?: string[]; overlays?: string[] }

const ENGINE_ROLES = ["earner", "burner", "growth_investment", "option", "unclear"];
/** The list fields edited as rows of inputs, one input per field, so no separator can collide with the text. */
const LISTS: { key: "engines" | "key_questions" | "named_peers"; label: string; fields: { key: string; label: string; options?: string[] }[]; blank: Row }[] = [
  { key: "engines", label: "Engines", blank: { name: "", role: "unclear", value_treatment: "" },
    fields: [{ key: "name", label: "Engine" }, { key: "role", label: "Role", options: ENGINE_ROLES }, { key: "value_treatment", label: "How it is valued" }] },
  { key: "key_questions", label: "Key questions", blank: { id: "", question: "", why_it_decides_value: "", falsifier: "" },
    fields: [{ key: "id", label: "Id" }, { key: "question", label: "Question" }, { key: "why_it_decides_value", label: "Why it decides value" }, { key: "falsifier", label: "Falsifier" }] },
  { key: "named_peers", label: "Named peers", blank: { name: "", ticker: "", why: "" },
    fields: [{ key: "name", label: "Peer" }, { key: "ticker", label: "Ticker (empty if private)" }, { key: "why", label: "Why" }] },
];
const TEXTS: { key: string; label: string; rows: number }[] = [
  { key: "central_question", label: "Central question", rows: 2 },
  { key: "decisive_insight_hypothesis", label: "Decisive insight to test", rows: 2 },
  { key: "what_investor_owns", label: "What the investor owns", rows: 3 },
];
const STRING_LISTS: { key: "priority_documents" | "management_axes"; label: string }[] = [
  { key: "priority_documents", label: "Priority documents (one per line)" }, { key: "management_axes", label: "Management axes (one per line)" },
];

/**
 * The plan gate's first block: the drafted framing as structured fields, the archetypes as checkboxes, and the
 * feedback already given. The server validates every edit; `onChange` reports only what the reviewer changed.
 */
export function FramingEditor({ plan, disabled, onChange }: { plan: Row; disabled: boolean; onChange: (edits: FramingEdits) => void }) {
  const original: Row | null = plan.framing ?? null;
  const [framing, setFraming] = useState<Row | null>(original);
  const [archetypes, setArchetypes] = useState<string[]>(plan.composed_archetypes ?? []);
  const [overlays, setOverlays] = useState<string[]>(plan.overlays ?? []);
  useEffect(() => {
    const edits: FramingEdits = {};
    if (framing && JSON.stringify(framing) !== JSON.stringify(original)) edits.framing = framing;
    if (JSON.stringify(archetypes) !== JSON.stringify(plan.composed_archetypes ?? []) || JSON.stringify(overlays) !== JSON.stringify(plan.overlays ?? [])) {
      edits.archetypes = archetypes; edits.overlays = overlays;
    }
    onChange(edits);
    // onChange is a setter from the parent; original and plan come from the same render as the state they seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framing, archetypes, overlays]);
  const set = (key: string, value: unknown) => setFraming({ ...framing, [key]: value });
  const setItem = (list: string, index: number, field: string, value: string) =>
    set(list, (framing?.[list] ?? []).map((item: Row, i: number) => i === index ? { ...item, [field]: value } : item));
  const toggle = (list: string[], update: (next: string[]) => void, key: string) => update(list.includes(key) ? list.filter(k => k !== key) : [...list, key]);
  const feedback: Row[] = Array.isArray(plan.plan_feedback) ? plan.plan_feedback : [];
  return <section className={ui.section} aria-label="Research framing">
    <div className={ui.sectionHead}><h2>Framing</h2><span className={ui.muted}>{original ? (plan.framing_source === "reviewer" ? "Edited by reviewer" : "Drafted; hypotheses until you approve") : "No framing drafted"}</span></div>
    {framing ? <div className={ui.form}>
      {TEXTS.map(t => <label key={t.key} className={ui.field}>{t.label}<textarea rows={t.rows} value={framing[t.key] ?? ""} disabled={disabled} onChange={e => set(t.key, e.target.value)} /></label>)}
      {LISTS.map(list => <fieldset key={list.key} className={ui.field}><legend>{list.label}</legend>
        {(framing[list.key] ?? []).map((item: Row, i: number) => <div key={i} className={ui.formGrid}>
          {list.fields.map(f => <label key={f.key} className={ui.field}>{f.label}{f.options
            ? <select value={item[f.key] ?? ""} disabled={disabled} onChange={e => setItem(list.key, i, f.key, e.target.value)}>{f.options.map(o => <option key={o} value={o}>{o.replace(/_/g, " ")}</option>)}</select>
            : <input value={item[f.key] ?? ""} disabled={disabled} onChange={e => setItem(list.key, i, f.key, e.target.value)} />}</label>)}
          <button type="button" className={ui.textLink} disabled={disabled} onClick={() => set(list.key, (framing[list.key] ?? []).filter((_: Row, j: number) => j !== i))}>Remove</button>
        </div>)}
        <button type="button" className={ui.textLink} disabled={disabled} onClick={() => set(list.key, [...(framing[list.key] ?? []), { ...list.blank }])}>Add</button>
      </fieldset>)}
      <div className={ui.formGrid}>{STRING_LISTS.map(l => <label key={l.key} className={ui.field}>{l.label}<textarea rows={3} disabled={disabled}
        value={(framing[l.key] ?? []).join("\n")} onChange={e => set(l.key, e.target.value.split("\n").map(s => s.trim()).filter(Boolean))} /></label>)}</div>
    </div> : <p className={ui.notice}>This plan has no framing. Request changes to draft one.</p>}
    <details className="mt-6"><summary>Archetypes ({archetypes.join(", ") || "none"})</summary><div className={`${ui.formGrid} ${ui.sectionBody}`}>
      {businessArchetypes.map(a => <label key={a.key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={archetypes.includes(a.key)} disabled={disabled} onChange={() => toggle(archetypes, setArchetypes, a.key)} />{a.name}</label>)}
      {archetypeOverlays.map(o => <label key={o.key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={overlays.includes(o.key)} disabled={disabled} onChange={() => toggle(overlays, setOverlays, o.key)} />{o.name} (overlay)</label>)}
    </div></details>
    {feedback.length > 0 && <details className="mt-4"><summary>Earlier feedback ({feedback.length})</summary><ul className={ui.sectionBody}>
      {feedback.map((f, i) => <li key={i} className="mb-2 text-sm"><span className={ui.muted}>{new Date(f.requested_at).toLocaleString()}: </span>{f.notes}</li>)}
    </ul></details>}
  </section>;
}
