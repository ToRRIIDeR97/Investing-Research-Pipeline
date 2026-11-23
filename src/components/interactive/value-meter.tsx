"use client";

import { C } from "@/components/ui/palette";
import { formatGap, gapPct, type CaseValues } from "@/lib/ui/chart-math";
import { money } from "./format";
import styles from "./interactive.module.css";

export type CaseKey = keyof CaseValues;
export const CASE_LABELS: Record<CaseKey, string> = { bear: "Bear", base: "Base", bull: "Bull" };

const R = 126, CX = 150, CY = 158;
const point = (f: number) => { const a = Math.PI * (1 - f); return { x: CX + R * Math.cos(a), y: CY - R * Math.sin(a) }; };
const TRACK = `M${CX - R} ${CY} A${R} ${R} 0 0 1 ${CX + R} ${CY}`;

/**
 * How far the selected case's value sits from the price, as a navy arc on a half-circle meter: the price is the top
 * of the arc, nothing is the left end, twice the price the right end. The number in the middle is the gap.
 */
export function ValueMeter({ price, values, selected, currency = "USD" }: { price: number | null | undefined; values: CaseValues; selected: CaseKey; currency?: string }) {
  const value = values[selected];
  const gap = gapPct(value, price);
  if (gap === null || value === null || price === null || price === undefined) {
    return <div className={styles.block}><p className={styles.empty}>No price to compare</p></div>;
  }
  const f = Math.min(1, Math.max(0, value / price / 2));
  const end = point(f);
  const arc = f > 0 ? `M${CX - R} ${CY} A${R} ${R} 0 0 1 ${end.x.toFixed(1)} ${end.y.toFixed(1)}` : null;
  const tickIn = point(0.5), words = gap < 0 ? "below" : "above";
  const label = `${CASE_LABELS[selected]} case ${money(value, currency)}, ${formatGap(gap).replace(/^[+−]/, "")} ${words} the ${money(price, currency)} price`;

  return <div className={styles.meter} role="img" aria-label={label}>
    <svg viewBox="0 0 300 170" aria-hidden="true" focusable="false">
      <path d={TRACK} stroke={C.lineSoft} strokeWidth="22" fill="none" strokeLinecap="round" />
      {arc ? <path d={arc} stroke={C.navy} strokeWidth="22" fill="none" strokeLinecap="round" className={styles.arc} /> : null}
      <line x1={tickIn.x} x2={tickIn.x} y1={tickIn.y - 18} y2={tickIn.y + 18} stroke={C.caution} strokeWidth="3" strokeLinecap="round" />
    </svg>
    <div className={styles.meterText}>
      <strong data-big="">{formatGap(gap)}</strong>
      <span>{words} the price</span>
    </div>
  </div>;
}
