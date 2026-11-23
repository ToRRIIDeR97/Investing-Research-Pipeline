"use client";

import { useState } from "react";
import { C, SERIES } from "@/components/ui/palette";
import { donutSegments } from "@/lib/ui/chart-math";
import styles from "./interactive.module.css";

export type FindingsGroup = { title: string; serious: number; counts: Partial<Record<string, number>> };

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];
const SHORT: Record<string, string> = { critical: "critical", high: "high", medium: "med", low: "low" };
const R = 70, CIRC = 2 * Math.PI * R;

/** Serious findings by group as a donut; hovering, focusing or pressing a row highlights its arc. */
export function FindingsDonut({ groups }: { groups: readonly FindingsGroup[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  if (!groups.length) return <div className={styles.block}><p className={styles.empty}>No findings</p></div>;

  const total = groups.reduce((sum, g) => sum + Math.max(0, g.serious), 0);
  const segments = donutSegments(groups.map((g) => g.serious), groups.length > 1 ? 0.012 : 0);
  const active = hover ?? pinned;
  const colour = (i: number) => SERIES[Math.min(i, SERIES.length - 1)];

  return <div className={styles.donutWrap}>
    <div className={styles.donut}>
      <svg viewBox="0 0 190 190" aria-hidden="true" focusable="false">
        <circle cx="95" cy="95" r={R} fill="none" stroke={C.lineSoft} strokeWidth="22" />
        <g transform="rotate(-90 95 95)">
          {segments.map((s, i) => s.length > 0 ? <circle key={i} cx="95" cy="95" r={R} fill="none" stroke={colour(i)}
            strokeWidth={active === i ? 28 : 22} opacity={active === null || active === i ? 1 : 0.25} className={styles.segment}
            strokeDasharray={`${(s.length * CIRC).toFixed(2)} ${CIRC.toFixed(2)}`} strokeDashoffset={(-s.start * CIRC).toFixed(2)} /> : null)}
        </g>
      </svg>
      <div className={styles.donutCentre}><strong data-big="">{total}</strong><span>serious</span></div>
    </div>
    <ul className={styles.groups}>
      {groups.map((group, i) => <li key={`${group.title}-${i}`}>
        <button type="button" className={styles.groupRow} aria-pressed={pinned === i ? "true" : "false"} data-active={active === i ? "true" : undefined}
          onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
          onClick={() => setPinned((p) => (p === i ? null : i))}>
          <i className={styles.swatch} style={{ background: colour(i) }} aria-hidden="true" />
          <span className={styles.groupTitle}>{group.title}</span>
          <span className={styles.chips}>
            {Object.entries(group.counts).filter((entry): entry is [string, number] => (entry[1] ?? 0) > 0)
              .sort(([a], [b]) => rank(a) - rank(b))
              .map(([severity, count]) => <span key={severity} className={styles.chip} data-severity={severity}>{count} {SHORT[severity] ?? severity}</span>)}
          </span>
        </button>
      </li>)}
    </ul>
  </div>;
}

function rank(severity: string): number {
  const i = SEVERITY_ORDER.indexOf(severity);
  return i === -1 ? SEVERITY_ORDER.length : i;
}
