"use client";
// The Model tab: how the value is reached (the memo's valuation), the year-end price targets labelled as future
// prices, the other valuation checks in reader terms, and the workbench. Replaces the Valuation tab's raw signal table,
// cheapness chart and scenario JSON.
import { useEffect } from "react";
import type { AssetSnapshot } from "@/lib/research/asset-snapshot";
import type { ResearchMemo } from "@/lib/research/reporting/research-memo";
import { percent, plainLabel, price } from "@/lib/research/reporting/plain-english";
import { words } from "@/lib/research/reporting/audit-format";
import { PriceFan } from "@/components/visuals/valuation-visuals";
import { ValuationWorkbench } from "@/components/workbench/valuation-workbench";
import { MemoValuation } from "./research-memo";
import styles from "./memo.module.css";

type Row = Record<string, any>;
const num = (v: unknown) => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
/** A check's reading: its stored text unless that is just a raw number, which is rounded like the value. */
const reading = (text: unknown, value: number | null) => {
  const n = typeof text === "string" && text.trim() ? num(text.trim()) : null;
  const v = n ?? value;
  if (typeof text === "string" && text.trim() && n == null) return text;
  return v == null ? "—" : Math.abs(v) < 1000 ? v.toFixed(2) : Math.round(v).toLocaleString("en-US");
};

export function ModelView({ memo, snapshot, runId, signals, focus, proposalRef }: {
  memo: ResearchMemo | null; snapshot: AssetSnapshot | null; runId: string; signals: Row[]; focus: "valuation" | "workbench"; proposalRef: string | null;
}) {
  useEffect(() => {
    if (focus === "workbench") document.getElementById("model-workbench")?.scrollIntoView({ block: "start" });
  }, [focus]);
  const c = memo?.currency ?? snapshot?.currency ?? "USD";
  const targets = (snapshot?.targets ?? []).filter((t) => t.bear != null || t.base != null || t.bull != null);
  const price0 = memo?.verdict.price ?? snapshot?.price ?? null;
  const checks = signals.filter((s) => s.signal_name || s.signal_key);

  return <div className={styles.body}>
    <section className={styles.block} aria-labelledby="model-value-title">
      <p className={styles.eyebrow}>Valuation</p>
      <h2 id="model-value-title">{memo?.valuation?.method ?? "How the value is reached"}</h2>
      {memo ? <MemoValuation memo={memo} /> : <p className={styles.lede}>This run has no stored valuation summary yet.</p>}
    </section>

    {targets.length > 0 && <section className={styles.block} aria-labelledby="model-targets-title">
      <p className={styles.eyebrow}>Price targets</p>
      <h2 id="model-targets-title">Where each case puts the price at each year end</h2>
      <p className={styles.lede}>Future prices along each case&apos;s path, not today&apos;s value. Value today is in the table above.</p>
      {snapshot && <PriceFan snapshot={snapshot} />}
      <table className={styles.table}>
        <thead><tr><th scope="col">Year end</th><th scope="col">Bear</th><th scope="col">Base</th><th scope="col">Bull</th>{price0 != null && <th scope="col">Base vs {price(price0, c, true)}</th>}</tr></thead>
        <tbody>{targets.map((t) => {
          const gap = t.base != null && price0 ? t.base / price0 - 1 : null;
          return <tr key={t.year}><td>{t.year}</td><td>{price(t.bear, c, true)}</td><td>{price(t.base, c, true)}</td><td>{price(t.bull, c, true)}</td>
            {price0 != null && <td className={gap == null ? undefined : gap < 0 ? styles.down : styles.up}>{gap == null ? "—" : `${gap > 0 ? "+" : ""}${percent(gap, 0)}`}</td>}</tr>;
        })}</tbody>
      </table>
    </section>}

    {checks.length > 0 && <section className={styles.block} aria-labelledby="model-checks-title">
      <p className={styles.eyebrow}>Other valuation checks</p>
      <h2 id="model-checks-title">What other lenses say</h2>
      <p className={styles.lede}>Each check scores cheapness from 0 (expensive) to 1 (cheap).</p>
      <table className={styles.table}>
        <thead><tr><th scope="col">Check</th><th scope="col">Lens</th><th scope="col">Reading</th><th scope="col">Cheapness</th><th scope="col">Call</th><th scope="col">Confidence</th></tr></thead>
        <tbody>{checks.map((s, i) => {
          const value = num(s.current_value), score = num(s.cheapness_score), confidence = num(s.confidence);
          return <tr key={s.id ?? i}>
            <td>{plainLabel(s.signal_key ?? s.signal_name)}</td>
            <td>{words(s.lens_family)}</td>
            <td>{reading(s.current_value_text, value)}</td>
            <td>{score == null ? "—" : score.toFixed(2)}</td>
            <td>{words(s.signal)}</td>
            <td>{confidence == null ? "—" : percent(confidence > 1 ? confidence / 100 : confidence, 0)}</td>
          </tr>;
        })}</tbody>
      </table>
    </section>}

    <section id="model-workbench" className={styles.block} aria-labelledby="model-workbench-title" style={{ scrollMarginTop: 80 }}>
      <p className={styles.eyebrow}>Workbench</p>
      <h2 id="model-workbench-title">Change the assumptions</h2>
      <p className={styles.lede}>Recomputes this run&apos;s stored valuation in code with your own inputs. Named scenarios are saved with the run; the report keeps its own numbers.</p>
      <ValuationWorkbench key={runId} runId={runId} proposalRef={proposalRef} />
    </section>
  </div>;
}
