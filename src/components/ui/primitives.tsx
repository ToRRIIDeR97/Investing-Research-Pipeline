"use client";

import type { ReactNode } from "react";
import styles from "./primitives.module.css";

/** A white rounded card. With a title, a short sentence-case `h2` heads it and `action` sits on the right. */
export function Card({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children?: ReactNode; className?: string }) {
  return <section className={className ? `${styles.card} ${className}` : styles.card}>
    {title || action ? <div className={styles.head}>{title ? <h2>{title}</h2> : <span />}{action ? <div className={styles.action}>{action}</div> : null}</div> : null}
    {children}
  </section>;
}

export type TagTone = "neutral" | "waiting" | "good" | "bad";

/** A neutral pill with a coloured status dot: colour only on the dot, never the fill. */
export function Tag({ tone = "neutral", children }: { tone?: TagTone; children: ReactNode }) {
  return <span className={styles.tag} data-tone={tone}><i className={styles.dot} aria-hidden="true" />{children}</span>;
}

/** A pill segmented toggle: a labelled group of buttons, the selected one pressed. */
export function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: readonly T[]; value: T; onChange: (value: T) => void }) {
  return <div role="group" aria-label={label} className={styles.segmented}>
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
