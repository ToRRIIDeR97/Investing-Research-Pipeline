"use client";
/**
 * "How it was built" on the Quant Value tab (workshop prototype/workshop/how-it-was-built.html, variant H3): how much
 * each valuation metric counts, as one bar, then Inputs, Assumptions and Caveats as drawers with counts.
 */
import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/primitives";
import type { QuantSnapshot } from "@/lib/api/quant";
import { fieldLabel, weightSegments } from "./engine-note";
import styles from "./quant.module.css";

const rate = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`);
const fy = (d: string) => `FY${d.slice(0, 4)}`;
function Drawer({ id, title, count, warn, open, onToggle, children }: {
  id: string; title: string; count: ReactNode; warn?: boolean; open: boolean; onToggle: () => void; children: ReactNode;
}) {
  return <div className={styles.drawer} data-open={open ? "" : undefined}>
    <button type="button" aria-expanded={open} aria-controls={`built-${id}`} onClick={onToggle}>
      <ChevronRight size={15} aria-hidden="true" />{title}<span className={styles.drawerCount} data-warn={warn ? "" : undefined}>{count}</span>
    </button>
    <div className={styles.drawerBody} id={`built-${id}`} inert={!open}><div><div className={styles.drawerInner}>{children}</div></div></div>
  </div>;
}

export function HowItWasBuilt({ s }: { s: QuantSnapshot }) {
  const v = s.value!;
  const d = v.dcf;
  const [open, setOpen] = useState<Set<string>>(() => new Set(["inputs"]));
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const segments = weightSegments(v.engine_result.metric_weights as Record<string, number> | undefined);
  const flags = [...v.engine_result.quality_flags, ...v.engine_result.structural_flags];
  const f = s.fundamentals;
  const years = f?.years.length ? [...f.years].sort() : [];
  const assumptions: [string, string][] = [
    ["Base cash flow", d.dcf_base_cf_label],
    ["Discount rate", rate(d.discount_rate)],
    ["Terminal growth", rate(d.terminal_growth_rate)],
    ["Base growth", rate(d.growth_rate_base)],
    ["Operating leverage", d.operating_leverage_trend],
  ];
  const caveats = flags.length + s.notes.length;
  return <Card title="How it was built">
    {segments.length > 0 && <>
      <div className={styles.weights} role="img" aria-label={`Metric weights: ${segments.map((x) => `${x.metric} ${x.pct}%`).join(", ")}`}>
        {/* Navy steps lighter with each metric; text flips to ink on the light ones. */}
        {segments.map((x, i) => <span key={x.metric} title={`${x.metric}: ${x.pct}%`} data-light={i >= 3 ? "" : undefined}
          style={{ flexGrow: x.pct, background: `color-mix(in srgb, var(--navy) ${Math.max(22, 100 - i * 20)}%, var(--tile))` }}>{x.pct >= 8 ? `${x.pct}%` : ""}</span>)}
      </div>
      <div className={styles.weightKey} aria-hidden="true"><span>Metric weights</span>
        {segments.map((x, i) => <span key={x.metric}><i style={{ background: `color-mix(in srgb, var(--navy) ${Math.max(22, 100 - i * 20)}%, var(--tile))` }} />{x.metric}</span>)}
      </div>
    </>}
    <Drawer id="inputs" title="Inputs" open={open.has("inputs")} onToggle={() => toggle("inputs")}
      count={f ? `${years.length} year${years.length === 1 ? "" : "s"}${f.missing.length ? ` · ${f.missing.length} gap${f.missing.length === 1 ? "" : "s"}` : ""}` : "—"}>
      {f ? <>
        <p className={styles.caption}>{f.origin === "xbrl_warehouse" ? "XBRL warehouse" : "SEC companyfacts"}, {years.length > 1 ? `${fy(years[0])} to ${fy(years[years.length - 1])}` : years.map(fy).join("")} ({f.currency}); daily closes for prices.</p>
        {f.missing.length > 0 && <div className={styles.gaps}><span>Not reported</span>{f.missing.map((m) => <s key={m}>{fieldLabel(m)}</s>)}</div>}
      </> : <p className={styles.caption}>No filing data was loaded.</p>}
    </Drawer>
    <Drawer id="assumptions" title="Assumptions" count={assumptions.length} open={open.has("assumptions")} onToggle={() => toggle("assumptions")}>
      <dl className={styles.assumptions}>{assumptions.map(([k, val]) => <div key={k}><dt>{k}</dt><dd>{val}</dd></div>)}</dl>
    </Drawer>
    <Drawer id="caveats" title="Caveats" count={flags.length ? `${flags.length} to know` : caveats} warn={flags.length > 0} open={open.has("caveats")} onToggle={() => toggle("caveats")}>
      {flags.map((x) => <p key={x} className={styles.callout}><b aria-hidden="true">!</b>{x}</p>)}
      {s.notes.map((n) => <p key={n} className={styles.caption}>{n}</p>)}
      {!caveats && <p className={styles.caption}>Nothing to flag.</p>}
    </Drawer>
  </Card>;
}
