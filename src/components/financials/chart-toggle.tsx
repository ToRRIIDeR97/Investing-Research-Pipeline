"use client";

import type { MouseEvent } from 'react';
import styles from './financials.module.css';

/** The per-row chart button. `color` is set while the row is on the chart. */
export function ChartToggle({ name, color, disabled, reason, hint, icon = 'bars', onToggle }: {
  name: string; color: string | null; disabled?: boolean; reason?: string | null; hint?: string; icon?: 'bars' | 'line';
  onToggle: (additive: boolean, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const on = color !== null;
  const title = disabled ? reason ?? undefined : on ? `Remove ${name} from the chart` : reason ? `${hint ?? 'Chart this row'} (${reason.toLowerCase()})` : hint ?? 'Chart this row';
  return <button type="button" className={styles.rowChart} aria-pressed={on} disabled={disabled} title={title}
    aria-label={disabled ? `${name}: ${reason}` : `${on ? 'Remove' : 'Chart'} ${name}`}
    style={on ? { background: color, borderColor: color, color: '#fff' } : undefined}
    onClick={(e) => onToggle(e.shiftKey, e)}>
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {icon === 'bars'
        ? <path d="M2 13h12M4 11V7M8 11V4M12 11V8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        : <path d="M2 12l3.5-4 3 2.5L14 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />}
    </svg>
  </button>;
}
