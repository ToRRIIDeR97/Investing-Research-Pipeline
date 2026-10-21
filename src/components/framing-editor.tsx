"use client";

import { useEffect, useState } from "react";
import ui from "@/components/research-ui.module.css";
import { businessArchetypes, archetypeOverlays } from "@/lib/research/archetypes/registry";

type Row = Record<string, any>;
export interface FramingEdits { framing?: Row; archetypes?: string[]; overlays?: string[] }

const lines = (value: string) => value.split("\n").map(line => line.trim()).filter(Boolean);
const cells = (line: string, count: number) => { const parts = line.split("|").map(part => part.trim()); return Array.from({ length: count }, (_, i) => parts[i] ?? ""); };
const join = (rows: Row[] | undefined, keys: string[]) => (rows ?? []).map(row => keys.map(key => row[key] ?? "").join(" | ")).join("\n");

/** Text form of the framing: one line per list item, cells separated by "|". */
function toText(framing: Row | null) {
  return {
    central_question: framing?.central_question ?? "", decisive_insight_hypothesis: framing?.decisive_insight_hypothesis ?? "",
    what_investor_owns: framing?.what_investor_owns ?? "",
    engines: join(framing?.engines, ["name", "role", "value_treatment"]),
    key_questions: join(framing?.key_questions, ["id", "question", "why_it_decides_value", "falsifier"]),
    named_peers: join(framing?.named_peers, ["name", "ticker", "why"]),
    priority_documents: (framing?.priority_documents ?? []).join("\n"), management_axes: (framing?.management_axes ?? []).join("\n"),
  };
}
function fromText(text: ReturnType<typeof toText>, original: Row | null): Row {
  return { ...original, central_question: text.central_question.trim(), decisive_insight_hypothesis: text.decisive_insight_hypothesis.trim(),
    what_investor_owns: text.what_investor_owns.trim(),
    engines: lines(text.engines).map(line => { const [name, role, value_treatment] = cells(line, 3); return { name, role: role || "unclear", value_treatment }; }),
    key_questions: lines(text.key_questions).map(line => { const [id, question, why_it_decides_value, falsifier] = cells(line, 4); return { id, question, why_it_decides_value, falsifier }; }),
    named_peers: lines(text.named_peers).map(line => { const [name, ticker, why] = cells(line, 3); return { name, ticker, why: why || "Named competitor" }; }),
    priority_documents: lines(text.priority_documents), management_axes: lines(text.management_axes),
    archetypes: original?.archetypes ?? [], overlays: original?.overlays ?? [] };
}

/**
 * The plan gate's first block: the drafted framing, editable before approval, the archetypes as checkboxes, and the
 * feedback already given. The server validates every edit; `onChange` reports only fields the reviewer changed.
 */
export function FramingEditor({ plan, disabled, onChange }: { plan: Row; disabled: boolean; onChange: (edits: FramingEdits) => void }) {
  const framing: Row | null = plan.framing ?? null;
  const [text, setText] = useState(() => toText(framing));
  const [archetypes, setArchetypes] = useState<string[]>(plan.composed_archetypes ?? []);
  const [overlays, setOverlays] = useState<string[]>(plan.overlays ?? []);
  const original = JSON.stringify(toText(framing));
  useEffect(() => {
    const edits: FramingEdits = {};
    if (framing && JSON.stringify(text) !== original) edits.framing = fromText(text, framing);
    if (JSON.stringify(archetypes) !== JSON.stringify(plan.composed_archetypes ?? []) || JSON.stringify(overlays) !== JSON.stringify(plan.overlays ?? [])) {
      edits.archetypes = archetypes; edits.overlays = overlays;
    }
    onChange(edits);
    // onChange is a setter from the parent; framing and plan come from the same render as `original`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, archetypes, overlays]);
  const field = (key: keyof typeof text, label: string, rows: number, hint?: string) =>
    <label className={ui.field}>{label}{hint && <span className={ui.muted}>{hint}</span>}<textarea rows={rows} value={text[key]} disabled={disabled}
      onChange={event => setText({ ...text, [key]: event.target.value })} /></label>;
  const toggle = (list: string[], set: (next: string[]) => void, key: string) => set(list.includes(key) ? list.filter(k => k !== key) : [...list, key]);
  const feedback: Row[] = Array.isArray(plan.plan_feedback) ? plan.plan_feedback : [];
  return <section className={ui.section} aria-label="Research framing">
    <div className={ui.sectionHead}><h2>Framing</h2><span className={ui.muted}>{framing ? (plan.framing_source === "reviewer" ? "Edited by reviewer" : "Drafted; hypotheses until you approve") : "No framing drafted"}</span></div>
    {framing ? <div className={ui.form}>
      {field("central_question", "Central question", 2)}
      {field("decisive_insight_hypothesis", "Decisive insight to test", 2)}
      {field("what_investor_owns", "What the investor owns", 3)}
      {field("engines", "Engines", 3, "One per line: name | earner, burner, growth_investment, option or unclear | how it is valued")}
      {field("key_questions", "Key questions", 5, "One per line: id | question | why it decides value | falsifier")}
      {field("named_peers", "Named peers", 3, "One per line: name | ticker (empty if private) | why")}
      <div className={ui.formGrid}>{field("priority_documents", "Priority documents", 3)}{field("management_axes", "Management axes", 3)}</div>
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
