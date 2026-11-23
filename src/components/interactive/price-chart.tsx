"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { BigNumber, Segmented } from "@/components/ui/primitives";
import { C } from "@/components/ui/palette";
import { cursorStep, formatGap, nearestIndex } from "@/lib/ui/chart-math";
import { seriesChange, type PricePoint } from "@/lib/market-data/price-series";
import { fullDay, money, shortDay } from "./format";
import styles from "./interactive.module.css";

const HEIGHT = 220;
const PAD = { left: 8, right: 64, top: 14, bottom: 26 };
const SERVER_WIDTH = 640;
const STEP_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export type PriceChartProps<R extends string = string> = {
  points: readonly PricePoint[];
  currency: string;
  valueLine?: { label: string; value: number } | null;
  ranges?: readonly R[];
  range?: R;
  onRange?: (range: R) => void;
  title?: string;
};

/**
 * Stored closes as a line you can scrub: pointer or arrow keys move a cursor and the big number shows that day's
 * close. Draws only the points it is given; never interpolates or invents a price.
 */
export function PriceChart<R extends string = string>({ points, currency, valueLine, ranges, range, onRange, title = "Price" }: PriceChartProps<R>) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(SERVER_WIDTH);
  const [rawCursor, setCursor] = useState<number | null>(null);
  const n = points.length;
  const cursor = rawCursor !== null && rawCursor < n ? rawCursor : null; // a cursor past a shorter new series is dropped

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { const w = Math.round(entry.contentRect.width); if (w > 0) setWidth(w); });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const picker = ranges && range !== undefined && onRange ? <Segmented label="Price range" options={ranges} value={range} onChange={onRange} /> : null;
  const shown = n ? points[cursor ?? n - 1] : null;
  const change = n >= 2 ? seriesChange(points.slice(0, (cursor ?? n - 1) + 1)) : null;

  const head = <div className={styles.chartHead}>
    {shown ? <div>
      <BigNumber label={title} value={money(shown.close, currency)} />
      <p className={styles.change}>
        {change !== null ? <span data-tone={change > 0 ? "good" : change < 0 ? "bad" : "neutral"}>{change !== 0 ? <span aria-hidden="true">{change > 0 ? "▲" : "▼"} </span> : null}{formatGap(change)}</span> : null}
        <span className={styles.quiet}>{cursor !== null ? shortDay(shown.day) : `Close ${shortDay(shown.day)}`}</span>
      </p>
      <span className={styles.srOnly} aria-live="polite">{cursor !== null ? `${money(shown.close, currency)} on ${fullDay(shown.day)}${change !== null ? `, ${formatGap(change)}` : ""}` : ""}</span>
    </div> : <h2 className={styles.title}>{title}</h2>}
    {picker}
  </div>;

  if (!n) return <div className={styles.block} ref={box}>{head}<p className={styles.empty}>No price history yet</p></div>;
  if (n === 1) return <div className={styles.block} ref={box}>{head}<p className={styles.empty}>Not enough history for a chart</p></div>;

  const closes = points.map((p) => p.close);
  const lineValue = valueLine && Number.isFinite(valueLine.value) ? valueLine.value : null;
  let lo = Math.min(...closes, ...(lineValue !== null ? [lineValue] : []));
  let hi = Math.max(...closes, ...(lineValue !== null ? [lineValue] : []));
  const flat = hi === lo;
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
  lo -= pad; hi += pad;
  const left = PAD.left, right = Math.max(left + 40, width - PAD.right), top = PAD.top, bottom = HEIGHT - PAD.bottom;
  const x = (i: number) => left + (i / (n - 1)) * (right - left);
  const y = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.close).toFixed(1)}`).join(" ");
  const area = `M${x(0).toFixed(1)},${bottom} L${line.split(" ").join(" L")} L${x(n - 1).toFixed(1)},${bottom} Z`;
  // A flat series has one value, so one tick; otherwise the low, middle and high of the data.
  const ticks = flat ? [lo + pad] : [lo + pad, (lo + hi) / 2, hi - pad];
  const first = points[0], last = points[n - 1];

  const move = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / (rect.width || 1)) * width;
    setCursor(nearestIndex(px, n, left, right));
  };
  const key = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === "Escape") { setCursor(null); return; }
    if (!STEP_KEYS.has(event.key)) return;
    event.preventDefault();
    setCursor(cursorStep(cursor ?? n - 1, event.key, n));
  };

  return <div className={styles.block} ref={box}>
    {head}
    <div className={styles.plot}>
      <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" tabIndex={0} className={styles.svg}
        aria-label={`Daily close from ${money(first.close, currency)} on ${shortDay(first.day)} to ${money(last.close, currency)} on ${shortDay(last.day)}. Use the arrow keys to read each day.`}
        onPointerMove={move} onPointerDown={move} onPointerLeave={() => setCursor(null)} onKeyDown={key} onBlur={() => setCursor(null)}>
        {ticks.map((t, i) => <g key={i}>
          <line x1={left} x2={right} y1={y(t)} y2={y(t)} stroke={C.lineSoft} />
          <text x={right + 8} y={y(t) + 4} fontSize="11" fill={C.ink3}>{money(t, currency)}</text>
        </g>)}
        <path d={area} fill={C.soft} opacity="0.8" />
        <polyline points={line} fill="none" stroke={C.ink} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {lineValue !== null && valueLine ? <g>
          <line x1={left} x2={right} y1={y(lineValue)} y2={y(lineValue)} stroke={C.navy} strokeWidth="1.5" strokeDasharray="5 5" />
          <rect x={right + 2} y={y(lineValue) - 10} width={PAD.right - 4} height="20" rx="10" fill={C.navy} />
          <text x={right + PAD.right / 2} y={y(lineValue) + 4} fontSize="11" fontWeight="600" fill={C.tile} textAnchor="middle">{money(lineValue, currency)}</text>
          <title>{`${valueLine.label} ${money(lineValue, currency)}`}</title>
        </g> : null}
        {cursor !== null ? <g pointerEvents="none">
          <line x1={x(cursor)} x2={x(cursor)} y1={top} y2={bottom} stroke={C.ink4} strokeDasharray="3 3" />
          <circle cx={x(cursor)} cy={y(points[cursor].close)} r="4.5" fill={C.ink} stroke={C.tile} strokeWidth="2" />
        </g> : <circle cx={x(n - 1)} cy={y(last.close)} r="4" fill={C.ink} />}
        <text x={left} y={HEIGHT - 6} fontSize="11" fill={C.ink3}>{shortDay(first.day)}</text>
        <text x={right} y={HEIGHT - 6} fontSize="11" fill={C.ink3} textAnchor="end">{shortDay(last.day)}</text>
      </svg>
    </div>
    {valueLine && lineValue !== null ? <p className={styles.legend}><i className={styles.dash} aria-hidden="true" />{valueLine.label} {money(lineValue, currency)}</p> : null}
  </div>;
}
