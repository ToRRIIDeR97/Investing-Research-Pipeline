"use client";

import { useState } from "react";
import { money, wholeOrCents } from "./format";
import styles from "./interactive.module.css";

export type RunBar = { id: string; label: string; outcome: string; cost: number; current?: boolean; detail?: string };

/** Every run as a bar of its real cost, with a dashed budget line when a budget is given; press a bar to read it. */
export function RunsBars({ runs, budget }: { runs: readonly RunBar[]; budget?: number | null }) {
  const [selected, setSelected] = useState<number | null>(null);
  if (!runs.length) return <div className={styles.block}><p className={styles.empty}>No runs yet</p></div>;

  const cost = (r: RunBar) => (Number.isFinite(r.cost) && r.cost > 0 ? r.cost : 0);
  const total = runs.reduce((sum, r) => sum + cost(r), 0);
  const cap = budget !== null && budget !== undefined && Number.isFinite(budget) && budget > 0 ? budget : null;
  const scale = Math.max(...runs.map(cost), cap ?? 0) || 1;
  const currentIndex = runs.findIndex((r) => r.current);
  const shown = runs[Math.min(selected ?? (currentIndex >= 0 ? currentIndex : runs.length - 1), runs.length - 1)];

  return <div className={styles.block}>
    <div className={styles.runsHead}><h3>Runs</h3><span className={styles.quiet}>{money(total)} total</span></div>
    <div className={styles.bars}>
      {cap !== null ? <div className={styles.capLayer}><div className={styles.cap} style={{ bottom: `${(cap / scale) * 100}%` }}><span>{wholeOrCents(cap)} cap</span></div></div> : null}
      {runs.map((run, i) => <button type="button" key={run.id} className={styles.bar} aria-label={`${run.label}, ${run.outcome}, ${money(cost(run))}`}
        aria-pressed={shown.id === run.id ? "true" : "false"} data-current={run.current ? "true" : undefined} onClick={() => setSelected(i)}>
        <span className={styles.barFill} style={{ height: `${Math.max(2, (cost(run) / scale) * 100)}%` }} />
        <span className={styles.barLabel}>{run.label}</span>
      </button>)}
    </div>
    <p className={styles.runDetail} aria-live="polite">
      <span><strong>{shown.label}</strong> · {shown.outcome}{shown.detail ? <><br /><span className={styles.quiet}>{shown.detail}</span></> : null}</span>
      <strong>{money(cost(shown))}</strong>
    </p>
  </div>;
}
