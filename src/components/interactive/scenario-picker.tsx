"use client";

import { formatGap, gapPct, type CaseValues } from "@/lib/ui/chart-math";
import { money } from "./format";
import { CASE_LABELS, type CaseKey } from "./value-meter";
import styles from "./interactive.module.css";

const CASES: CaseKey[] = ["bear", "base", "bull"];

/** Bear, base and bull as three toggle cards: value and its gap to the price. A missing value shows "—". */
export function ScenarioPicker({ values, price, selected, onSelect, currency = "USD" }: {
  values: CaseValues; price: number | null | undefined; selected: CaseKey; onSelect: (key: CaseKey) => void; currency?: string;
}) {
  return <div className={styles.scenarios} role="group" aria-label="Scenario">
    {CASES.map((key) => {
      const value = values[key];
      const gap = gapPct(value, price);
      return <button type="button" key={key} aria-pressed={key === selected ? "true" : "false"} onClick={() => onSelect(key)} className={styles.scenario}>
        <span className={styles.scenarioName}>{CASE_LABELS[key]}</span>
        <strong>{value === null ? "—" : money(value, currency)}</strong>
        <span className={styles.gap} data-tone={gap === null ? "neutral" : gap < 0 ? "bad" : gap > 0 ? "good" : "neutral"}>{value === null ? "—" : formatGap(gap)}</span>
      </button>;
    })}
  </div>;
}
