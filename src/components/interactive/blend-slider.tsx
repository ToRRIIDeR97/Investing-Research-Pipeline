"use client";

import { useId, useState } from "react";
import { BigNumber } from "@/components/ui/primitives";
import { blendValue, formatGap, gapPct, type CaseValues } from "@/lib/ui/chart-math";
import { money } from "./format";
import styles from "./interactive.module.css";

/**
 * "Your blend": move between cautious (towards bear) and hopeful (towards bull) around the base case. It is the
 * reader's own mix, shown against the price and, when given, the report's weighted value; it is never labelled as
 * the report's number.
 */
export function BlendSlider({ values, price, reportWeighted, currency = "USD" }: { values: CaseValues; price: number | null | undefined; reportWeighted?: number | null; currency?: string }) {
  const id = useId();
  const [t, setT] = useState(0.5);
  const value = blendValue(values, t);
  if (value === null) return <div className={styles.block}><p className={styles.empty}>Needs bear, base and bull values to blend.</p></div>;

  const gap = gapPct(value, price);
  const lowest = blendValue(values, 0)!, highest = blendValue(values, 1)!;
  const report = reportWeighted !== null && reportWeighted !== undefined && Number.isFinite(reportWeighted) ? reportWeighted : null;
  const hasPrice = price !== null && price !== undefined && price > 0;
  const marks = [lowest, highest, value, ...(report !== null ? [report] : []), ...(hasPrice ? [price] : [])];
  const lo = Math.min(...marks), hi = Math.max(...marks);
  const at = (v: number) => `${hi === lo ? 50 : ((v - lo) / (hi - lo)) * 100}%`;
  const note = hasPrice && highest < price ? "Even fully hopeful, it stays below the price."
    : hasPrice && lowest > price ? "Even fully cautious, it stays above the price." : null;

  return <div className={styles.block}>
    <BigNumber label="Your blend" value={money(value, currency)} />
    {gap !== null ? <p className={styles.change}><span className={styles.quiet}>{formatGap(gap)} vs price</span></p> : null}
    <div className={styles.slider}>
      <input id={id} type="range" min={0} max={100} step={1} value={Math.round(t * 100)} aria-label="Blend from cautious to hopeful"
        aria-valuetext={`Your blend ${money(value, currency)}`} onChange={(event) => setT(Number(event.target.value) / 100)} />
      <div className={styles.sliderEnds} aria-hidden="true"><span>Cautious</span><span>Hopeful</span></div>
    </div>
    <div className={styles.pins}>
      <div className={styles.pinTrack} aria-hidden="true" />
      <span className={styles.pin} data-kind="you" style={{ left: at(value) }}><i aria-hidden="true" />You {money(value, currency)}</span>
      {report !== null ? <span className={styles.pin} data-kind="report" style={{ left: at(report) }}><i aria-hidden="true" />Report {money(report, currency)}</span> : null}
      {hasPrice ? <span className={styles.pin} data-kind="price" style={{ left: at(price) }}><i aria-hidden="true" />Price {money(price, currency)}</span> : null}
    </div>
    {note ? <p className={styles.note}>{note}</p> : null}
  </div>;
}
