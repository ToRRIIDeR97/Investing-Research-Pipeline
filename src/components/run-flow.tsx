import { FLOW_STEPS, RUN_DEPTHS, formatEstimate, type FeedItem, type PhaseProgress, type RunEstimate } from "@/lib/research/run-flow";
import styles from "./run-flow.module.css";

/** The five steps of starting and following a run; earlier steps read done, the current one is marked for screen readers. */
export function FlowStepper({ current }: { current: number }) {
  return <ol className={styles.stepper} aria-label="Research steps">
    {FLOW_STEPS.map((step, index) => {
      const state = index < current ? "done" : index === current ? "current" : "next";
      return <li key={step.key} data-state={state} aria-current={index === current ? "step" : undefined}>
        <span className={styles.stepDot} aria-hidden="true">{index < current ? "✓" : index + 1}</span>{step.label}
      </li>;
    })}
  </ol>;
}

const PHASE_WORD: Record<PhaseProgress["state"], string> = { done: "Done", active: "In progress", waiting: "Waiting for you", failed: "Stopped", pending: "Not started" };

/** The pipeline as five phases, each with its share of stages done; the two human gates sit on Frame and Decide. */
export function PhaseTrack({ phases }: { phases: readonly PhaseProgress[] }) {
  return <ol className={styles.track} aria-label="Research phases">
    {phases.map((phase) => <li key={phase.key} data-state={phase.state}>
      <div className={styles.phaseHead}><strong>{phase.label}</strong><span>{phase.total ? `${phase.done} of ${phase.total}` : "—"}</span></div>
      <div className={styles.phaseBar} aria-hidden="true"><i style={{ width: `${phase.total ? (phase.done / phase.total) * 100 : 0}%` }} /></div>
      <span className={styles.phaseMeta}>{PHASE_WORD[phase.state]} · {phase.blurb}</span>
      {phase.gate && <span className={styles.gate} data-gate={phase.gate}>{phase.gate === "plan" ? "You approve the plan" : "You review the report"}</span>}
    </li>)}
  </ol>;
}

const clock = (at: string | null) => at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

/** What the run has done, in plain words, newest first. */
export function RunFeed({ items }: { items: readonly FeedItem[] }) {
  if (!items.length) return <p className={styles.empty}>Nothing has happened yet. The first step starts when a worker picks up the run.</p>;
  return <ul className={styles.feed}>
    {items.map((item, index) => <li key={`${index}-${item.text}`} data-now={item.now ? "" : undefined}>
      <time dateTime={item.at ?? undefined}>{item.now ? "Now" : clock(item.at)}</time><span>{item.text}</span>
    </li>)}
  </ul>;
}

/** The run types as cards: what each does differently and what past runs of it cost and took. */
export function DepthPicker({ value, onChange, estimates, disabled }: { value: string; onChange: (value: string) => void; estimates: Record<string, RunEstimate>; disabled?: boolean }) {
  return <fieldset className={styles.depths} disabled={disabled}>
    <legend>How deep?</legend>
    {RUN_DEPTHS.map((depth) => <label key={depth.value} className={styles.depth} data-on={value === depth.value ? "" : undefined}>
      <input type="radio" name="run-depth" value={depth.value} checked={value === depth.value} onChange={() => onChange(depth.value)} />
      <strong>{depth.label}</strong>
      <span>{depth.detail}</span>
      <em>{formatEstimate(estimates[depth.value])}</em>
    </label>)}
  </fieldset>;
}
