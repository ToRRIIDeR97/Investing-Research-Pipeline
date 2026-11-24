"use client";

import type { ReactNode } from "react";
import { SlideLayers, useSlidingIndicator } from "./sliding";
import styles from "./primitives.module.css";

/**
 * A white rounded card. With a title, a short sentence-case `h2` heads it and `action` sits on the right. `flush` drops
 * the body padding for content that brings its own (rows, tables, tile bodies from research-ui.module.css); `titleId`
 * sets the heading's id for `aria-labelledby`. Other section attributes (aria-label, aria-labelledby) pass through.
 */
export function Card({ title, action, children, className, flush, titleId, ...rest }: {
  title?: ReactNode; action?: ReactNode; children?: ReactNode; className?: string; flush?: boolean; titleId?: string;
  "aria-label"?: string; "aria-labelledby"?: string;
}) {
  return <section className={className ? `${styles.card} ${className}` : styles.card} data-flush={flush ? "" : undefined} {...rest}>
    {title || action ? <div className={styles.head}>{title ? <h2 id={titleId}>{title}</h2> : <span />}{action ? <div className={styles.action}>{action}</div> : null}</div> : null}
    {children}
  </section>;
}

export type TagTone = "neutral" | "waiting" | "good" | "bad";

/** A neutral pill with a coloured status dot: colour only on the dot, never the fill. */
export function Tag({ tone = "neutral", children }: { tone?: TagTone; children: ReactNode }) {
  return <span className={styles.tag} data-tone={tone}><i className={styles.dot} aria-hidden="true" />{children}</span>;
}

/** A pill segmented toggle: a labelled group of buttons, the selected one pressed. Its pill slides and can be dragged. */
export function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: readonly T[]; value: T; onChange: (value: T) => void }) {
  const bar = useSlidingIndicator<HTMLDivElement>();
  return <div ref={bar} role="group" aria-label={label} className={styles.segmented}>
    <SlideLayers />
    {options.map((option) => <button type="button" key={option} aria-pressed={option === value ? "true" : "false"} onClick={() => onChange(option)}>{option}</button>)}
  </div>;
}

/** A big display-face number with an optional short label above it. */
export function BigNumber({ value, label }: { value: ReactNode; label?: ReactNode }) {
  return <div className={styles.big}>
    {label ? <span className={styles.bigLabel}>{label}</span> : null}
    <strong data-big="" className={styles.bigValue}>{value}</strong>
  </div>;
}
