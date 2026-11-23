"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import ui from "@/components/research-ui.module.css";
import styles from "./workbench.module.css";
import { CASES, DRIVER_FIELDS, SET_FIELDS, draftChange, draftFromChange, draftFromInputs, type Draft, type WorkbenchInputs } from "@/lib/research/valuation/workbench-draft";
import type { WhatIfResult, WorkbenchChange } from "@/lib/research/valuation/whatif";
import { RESEARCH_CHAT_ANSWERED } from "@/components/research-chat";
import { Card, Tag } from "@/components/ui/primitives";

type Case = (typeof CASES)[number];
type Summary = Pick<WhatIfResult, "value_today" | "return_today" | "anchors" | "probabilities">;
type Scenario = { id: string; name: string; rationale: string; source: "user" | "assistant"; change: WorkbenchChange; result: Summary; created_at: string };
type Source = { pinned_to_report?: boolean; newer_valuation?: { version: number; createdAt: string } | null };
type Workbench = Source & ({ available: true; inputs: WorkbenchInputs; baseline: WhatIfResult; scenarios: Scenario[] } | { available: false; reason: string; scenarios: Scenario[] });
type Proposal = { ref: string; name: string; rationale: string; change: WorkbenchChange };
type Origin = { source: "user" | "assistant"; name: string; rationale: string } | null;

const ROWS: (Case | "weighted")[] = ["bear", "base", "bull", "weighted"];
const caseLabel = (c: string) => c === "weighted" ? "Probability-weighted" : c.charAt(0).toUpperCase() + c.slice(1);
const fieldLabel: Record<string, string> = { discount_rate: "Discount rate %", terminal_growth: "Terminal growth %", ronic: "RONIC %", fade_years: "Fade years",
  revenue_growth: "Revenue growth %", operating_margin: "Operating margin %" };
/** A valuation stored after the report's: the workbench says so and keeps to the report's valuation. */
function NewerValuation({ source }: { source: Source }) {
  const newer = source.newer_valuation;
  if (!newer) return null;
  const day = new Date(newer.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return <p className={ui.muted} role="note" data-newer-valuation>A newer valuation (version {newer.version}, stored {day}) exists, but this run&apos;s report was built on an earlier one. The workbench and the report both use the report&apos;s valuation; regenerate the report to use the newer one.</p>;
}
const money = (n: number | null | undefined, currency: string) => n == null ? "—" : `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
const percent = (n: number | null | undefined, signed = true) => n == null ? "—" : `${signed && n > 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const delta = (now: number | null | undefined, then: number | null | undefined) => now == null || then == null ? "—" : `${now - then > 0 ? "+" : ""}${(now - then).toFixed(2)}`;
const isEmpty = (change: WorkbenchChange) => !change.sets && !change.drivers && !change.probabilities;

async function readJson(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : "The workbench could not do that.");
  return body;
}

/** Proposals the chat made for this run, newest first, each referenced as "<message index>.<proposal index>". */
function chatProposals(messages: Record<string, any>[]): Proposal[] {
  return messages.flatMap((m, i) => Array.isArray(m?.scenario_proposals) ? m.scenario_proposals.map((p: Record<string, any>, j: number) =>
    ({ ref: `${i}.${j}`, name: String(p?.name ?? ""), rationale: String(p?.rationale ?? ""), change: (p?.change ?? {}) as WorkbenchChange })) : []).reverse();
}

/**
 * The valuation workbench: edit the valuation sets, each case's yearly growth and margin, and the case weights; the
 * server recomputes the stored valuation in code (no model call) and the results compare with the stored values.
 * Named scenarios are saved per run; the chat's scenario proposals apply with one click.
 */
export function ValuationWorkbench({ runId, proposalRef }: { runId: string; proposalRef: string | null }) {
  const [workbench, setWorkbench] = useState<Workbench | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [computeProblem, setComputeProblem] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [origin, setOrigin] = useState<Origin>(null);
  const [name, setName] = useState("");
  const [rationale, setRationale] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [appliedRef, setAppliedRef] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    try {
      const [bench, chat] = await Promise.all([fetch(`/api/research-runs/${runId}/workbench`).then(readJson), fetch(`/api/research-runs/${runId}/chat`).then(readJson).catch(() => ({ messages: [] }))]);
      setLoadError(null);
      setWorkbench(bench as Workbench);
      setProposals(chatProposals(Array.isArray(chat.messages) ? chat.messages : []));
      // A (re)load resets the form, so a linked proposal is applied again on top of it.
      if (bench.available) { setDraft(draftFromInputs(bench.inputs)); setResult(bench.baseline); setAppliedRef(null); }
    } catch (error) { setLoadError(error instanceof Error ? error.message : "The workbench could not load."); }
  }, [runId]);
  useEffect(() => { void load(); }, [load]);
  // A new chat answer may carry new proposals: the chat announces each answer it saves.
  useEffect(() => {
    const refresh = () => void fetch(`/api/research-runs/${runId}/chat`).then(readJson)
      .then((chat) => setProposals(chatProposals(Array.isArray(chat.messages) ? chat.messages : []))).catch(() => undefined);
    window.addEventListener(RESEARCH_CHAT_ANSWERED, refresh);
    return () => window.removeEventListener(RESEARCH_CHAT_ANSWERED, refresh);
  }, [runId]);

  const inputs = workbench?.available ? workbench.inputs : null;
  const pending = useMemo(() => inputs ? draftChange(inputs, draft) : null, [inputs, draft]);
  const unchanged = !pending || (pending.change !== null && isEmpty(pending.change));
  // A draft that is not a number is reported as typed; a change the engine refuses, by the server's reason.
  const problem = pending?.error ?? (unchanged ? null : computeProblem);

  // Recompute shortly after each edit; only the latest request's answer is shown.
  useEffect(() => {
    if (!pending || pending.change === null || isEmpty(pending.change)) return;
    const change = pending.change;
    const id = ++request.current;
    const timer = window.setTimeout(async () => {
      setComputing(true);
      try {
        const res = await fetch(`/api/research-runs/${runId}/workbench`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ change }) });
        const body = await readJson(res);
        if (id === request.current) { setResult(body as WhatIfResult); setComputeProblem(null); }
      } catch (error) { if (id === request.current) setComputeProblem(error instanceof Error ? error.message : "The change could not be computed."); }
      finally { if (id === request.current) setComputing(false); }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [pending, runId]);

  function apply(change: WorkbenchChange, from: Origin) {
    if (!inputs) return;
    setDraft(draftFromChange(inputs, change));
    setOrigin(from);
    setName(from?.name ?? "");
    setRationale(from?.rationale ?? "");
    setStatus(from ? `Applied “${from.name}”.` : null);
  }

  // A chat link ("Open in workbench") names one proposal; it is applied once, when the workbench and the
  // conversation have loaded (state adjusted during render, as React recommends for a changed prop).
  const linked = inputs && proposalRef && appliedRef !== proposalRef ? proposals.find((p) => p.ref === proposalRef) : undefined;
  if (linked && proposalRef) {
    setAppliedRef(proposalRef);
    apply(linked.change, { source: "assistant", name: linked.name, rationale: linked.rationale });
  }

  function edit(key: string, value: string) { setDraft((d) => ({ ...d, [key]: value })); setStatus(null); }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!pending || pending.error !== null) { setStatus(pending?.error ?? "Nothing to save."); return; }
    try {
      const res = await fetch(`/api/research-runs/${runId}/workbench/scenarios`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, rationale, source: origin?.source ?? "user", change: pending.change }) });
      const saved = await readJson(res) as Scenario;
      setWorkbench((w) => w ? { ...w, scenarios: [...w.scenarios, saved] } : w);
      setStatus(`Saved “${saved.name}”.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "The scenario could not be saved."); }
  }

  async function remove(scenario: Scenario) {
    try {
      const res = await fetch(`/api/research-runs/${runId}/workbench/scenarios/${scenario.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) await readJson(res);
      setWorkbench((w) => w ? { ...w, scenarios: w.scenarios.filter((s) => s.id !== scenario.id) } : w);
    } catch (error) { setStatus(error instanceof Error ? error.message : "The scenario could not be deleted."); }
  }

  if (loadError) return <Card flush><div className={ui.tileBody}><p role="alert">{loadError}</p><button type="button" className={ui.secondary} onClick={() => void load()}>Try again</button></div></Card>;
  if (!workbench) return <p className={ui.empty} role="status">Loading the workbench…</p>;
  if (!workbench.available) return <Card flush aria-labelledby="wb-unavailable" title="Workbench" titleId="wb-unavailable">
    <div className={ui.tileBody}><p>{workbench.reason}</p><NewerValuation source={workbench} /></div>
  </Card>;

  const baseline = workbench.baseline, shown = unchanged ? baseline : result ?? baseline, currency = baseline.currency;
  const years = (c: Case) => workbench.inputs.drivers[c] ?? [];
  const sum = CASES.reduce((total, c) => total + (Number(draft[`prob.${c}`]) || 0), 0);

  return <div className={ui.grid}>
    <Card flush className={ui.s12} aria-labelledby="wb-results" title="Results" titleId="wb-results"
      action={<span role="status"><Tag tone={unchanged ? "neutral" : computing ? "waiting" : "good"}>{unchanged ? (workbench.pinned_to_report ? "Report's valuation" : "Stored valuation") : computing ? "Recomputing" : "Your what-if"}</Tag></span>}>
      {problem && <p className={styles.problem} role="alert">{problem}</p>}
      {workbench.newer_valuation && <div className={styles.inset}><NewerValuation source={workbench} /></div>}
      <div className={ui.table}><table>
        <thead><tr><th>Case</th><th className={styles.num}>Weight</th><th className={styles.num}>Value today</th><th className={styles.num}>Return vs {money(shown.price, currency)}</th>
          <th className={styles.num}>Change vs stored</th><th className={styles.num}>Terminal-year anchor</th></tr></thead>
        <tbody>{ROWS.map((row) => <tr key={row} data-row={row}>
          <th scope="row">{caseLabel(row)}</th>
          <td className={styles.num}>{row === "weighted" ? "" : percent(shown.probabilities[row], false)}</td>
          <td className={styles.num}>{money(shown.value_today[row], currency)}</td>
          <td className={styles.num}>{percent(shown.return_today[row])}</td>
          <td className={styles.num}>{delta(shown.value_today[row], baseline.value_today[row])}</td>
          <td className={styles.num}>{money(shown.anchors[row], currency)}</td>
        </tr>)}</tbody>
      </table></div>
      {shown.flags.length ? <div className={ui.tileBody}><span className={styles.label}>Sanity flags</span><ul>{shown.flags.map((f, i) => <li key={i}>{f}</li>)}</ul></div> : null}
    </Card>

    <Card flush className={ui.s7} aria-labelledby="wb-sets" title="Valuation sets" titleId="wb-sets"
      action={<span className={styles.count}>Terminal FY{shown.terminal_year ?? "—"}</span>}>
      <div className={ui.table}><table>
        <thead><tr><th>Set</th>{SET_FIELDS.map((f) => <th key={f}>{fieldLabel[f]}</th>)}</tr></thead>
        <tbody>{workbench.inputs.sets.map((set) => <tr key={set.set}>
          <th scope="row">{caseLabel(set.set)}</th>
          {SET_FIELDS.map((f) => <td key={f}><input className={styles.cell} inputMode="decimal" aria-label={`${caseLabel(set.set)} set ${fieldLabel[f]}`}
            value={draft[`set.${set.set}.${f}`] ?? ""} onChange={(e) => edit(`set.${set.set}.${f}`, e.target.value)} /></td>)}
        </tr>)}</tbody>
      </table></div>
    </Card>

    <Card flush className={ui.s5} aria-labelledby="wb-probabilities" title="Case weights" titleId="wb-probabilities"
      action={<span className={`${styles.count} ${Math.abs(sum - 100) > 0.1 ? styles.off : ""}`}>Total {Number(sum.toFixed(2))}%</span>}>
      <div className={`${ui.tileBody} ${styles.row}`}>{CASES.map((c) => <label key={c} className={ui.field}>{caseLabel(c)} %
        <input inputMode="decimal" value={draft[`prob.${c}`] ?? ""} onChange={(e) => edit(`prob.${c}`, e.target.value)} /></label>)}</div>
    </Card>

    {CASES.map((c) => <Card flush key={c} className={ui.s4} aria-labelledby={`wb-drivers-${c}`} title={`${caseLabel(c)} drivers`} titleId={`wb-drivers-${c}`}>
      <div className={ui.table}><table>
        <thead><tr><th>Year</th>{DRIVER_FIELDS.map((f) => <th key={f}>{fieldLabel[f]}</th>)}</tr></thead>
        <tbody>{years(c).map((y) => <tr key={y.fiscal_year}>
          <th scope="row">FY{y.fiscal_year}</th>
          {DRIVER_FIELDS.map((f) => <td key={f}><input className={styles.cell} inputMode="decimal" aria-label={`${caseLabel(c)} FY${y.fiscal_year} ${fieldLabel[f]}`}
            value={draft[`driver.${c}.${y.fiscal_year}.${f}`] ?? ""} onChange={(e) => edit(`driver.${c}.${y.fiscal_year}.${f}`, e.target.value)} /></td>)}
        </tr>)}</tbody>
      </table></div>
    </Card>)}

    <Card flush className={ui.s6} aria-labelledby="wb-saved" title="Saved scenarios" titleId="wb-saved"
      action={<span className={styles.count}>{workbench.scenarios.length}</span>}>
      <form className={`${ui.tileBody} ${ui.form}`} onSubmit={save} aria-label="Save this scenario">
        <label className={ui.field}>Name<input value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} /></label>
        <label className={ui.field}>Why (optional)<textarea rows={2} maxLength={1000} value={rationale} onChange={(e) => setRationale(e.target.value)} /></label>
        <div className={styles.row}><button className={ui.primary} type="submit" disabled={!name.trim() || Boolean(problem) || computing}>Save scenario</button>
          <button className={ui.secondary} type="button" onClick={() => apply({}, null)}>Reset to stored</button>
          {status && <span className={ui.muted} role="status">{status}</span>}</div>
      </form>
      {workbench.scenarios.length ? <div className={ui.list}>{workbench.scenarios.map((s) => <div key={s.id} className={ui.row}>
        <div><div className={ui.rowTitle}>{s.name}{s.source === "assistant" ? <span className={styles.tag}><Tag>From the assistant</Tag></span> : null}</div>
          <div className={ui.rowMeta}>Weighted {money(s.result.value_today.weighted, currency)} ({percent(s.result.return_today.weighted)}){s.rationale ? ` · ${s.rationale}` : ""}</div></div>
        <div className={styles.row}><button type="button" className={ui.secondary} onClick={() => apply(s.change, { source: s.source, name: s.name, rationale: s.rationale })}>Load</button>
          <button type="button" className={ui.secondary} onClick={() => void remove(s)} aria-label={`Delete ${s.name}`}>Delete</button></div>
      </div>)}</div> : <p className={ui.empty}>No saved scenarios yet.</p>}
    </Card>

    <Card flush className={ui.s6} aria-labelledby="wb-suggested" title="Assistant's what-ifs" titleId="wb-suggested"
      action={<span className={styles.count}>{proposals.length}</span>}>
      {proposals.length ? <div className={ui.list}>{proposals.map((p) => <div key={p.ref} className={`${ui.row} ${p.ref === proposalRef ? styles.active : ""}`}>
        <div><div className={ui.rowTitle}>{p.name}</div><div className={ui.rowMeta}>{p.rationale}</div></div>
        <button type="button" className={ui.secondary} onClick={() => apply(p.change, { source: "assistant", name: p.name, rationale: p.rationale })}>Apply</button>
      </div>)}</div> : <p className={ui.empty}>Ask the assistant a what-if question (for example “What if margins compress?”) and its proposals appear here.</p>}
    </Card>
  </div>;
}
