"use client";
/**
 * Loading states (workshop prototype/workshop/quant-intl-round, variant L1): a skeleton shaped like the page being
 * loaded, and for slow work a step card floating over it. Skeletons appear only after 300 ms, so fast loads don't
 * flash. Every state is a live region with a plain sentence for screen readers; the shimmer is decoration.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import styles from "./loading.module.css";

/** True once `ms` have passed since mount. */
function useDelay(ms: number): boolean {
  const [shown, setShown] = useState(ms <= 0);
  useEffect(() => {
    if (ms <= 0) return;
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return shown;
}

/** One shimmering block. */
export function Skeleton({ w, h = 14, r, className, style }: { w?: number | string; h?: number | string; r?: number; className?: string; style?: CSSProperties }) {
  return <span aria-hidden="true" className={`${styles.sk}${className ? ` ${className}` : ""}`} style={{ width: w ?? "100%", height: h, borderRadius: r, ...style }} />;
}

export type SkeletonShape = "cards" | "list" | "detail" | "report" | "quant" | "panel";

function Shape({ shape }: { shape: SkeletonShape }) {
  switch (shape) {
    case "cards":
      return <div className={styles.cards}>{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className={styles.cardBox}>
        <div className={styles.head}><Skeleton w={44} h={44} r={12} /><div className={styles.lines}><Skeleton w="70%" /><Skeleton w="40%" h={10} /></div></div>
        <Skeleton h={8} r={99} /><Skeleton w="55%" h={10} />
      </div>)}</div>;
    case "list":
      return <div className={styles.cardBox}>{[0, 1, 2, 3, 4].map((i) => <div key={i} className={styles.listRow}><Skeleton w={32} h={32} r={10} /><div className={styles.lines}><Skeleton w={`${60 - i * 6}%`} /><Skeleton w="30%" h={10} /></div><Skeleton w={64} h={22} r={99} /></div>)}</div>;
    case "detail":
      return <div className={styles.detail}>
        <div className={styles.head}><Skeleton w={64} h={64} r={16} /><div className={styles.lines}><Skeleton w="40%" h={24} /><Skeleton w="25%" h={12} /></div></div>
        <div className={styles.cols}><div className={styles.cardBox}><Skeleton h={110} r={14} /><Skeleton w="80%" /><Skeleton w="60%" /></div><div className={styles.cardBox}><Skeleton h={60} r={14} /><Skeleton w="70%" /><Skeleton w="50%" /></div></div>
        <div className={styles.cardBox}><Skeleton h={180} r={14} /></div>
      </div>;
    case "report":
      return <div className={styles.detail}>
        <div className={styles.cardBox}><Skeleton w="30%" h={24} /><Skeleton w="85%" /><Skeleton w="75%" /><Skeleton w="60%" /></div>
        <div className={styles.tiles}>{[0, 1, 2].map((i) => <div key={i} className={styles.cardBox}><Skeleton w="40%" h={10} /><Skeleton w="55%" h={26} /><Skeleton h={8} r={99} /></div>)}</div>
        <div className={styles.cardBox}><Skeleton h={200} r={14} /></div>
      </div>;
    case "quant":
      return <div className={styles.quant}>
        <div className={styles.cardBox}><div className={styles.head}><Skeleton w={44} h={44} r={12} /><div className={styles.lines}><Skeleton w="80%" /><Skeleton w="50%" h={10} /></div></div>
          <Skeleton w="60%" h={28} /><Skeleton h={46} r={10} /><Skeleton h={110} r={14} /><Skeleton h={70} r={10} /></div>
        <div className={styles.detail}><Skeleton h={62} r={18} /><div className={styles.tiles}>{[0, 1, 2].map((i) => <Skeleton key={i} h={104} r={16} />)}</div><Skeleton h={220} r={18} /></div>
      </div>;
    case "panel":
    default:
      return <div className={styles.cardBox}><Skeleton w="35%" h={16} /><Skeleton w="90%" /><Skeleton w="80%" /><Skeleton w="65%" /></div>;
  }
}

/**
 * A page or section loading: the skeleton of `shape`, after 300 ms. `label` is the sentence screen readers hear
 * ("Loading your research"). Children (a step card) float over the skeleton.
 */
export function PageLoading({ shape = "panel", label, delayMs = 300, children }: { shape?: SkeletonShape; label: string; delayMs?: number; children?: ReactNode }) {
  const shown = useDelay(delayMs);
  return <div className={styles.loading} role="status" aria-live="polite" aria-busy="true">
    <span className={styles.srOnly}>{label}</span>
    {shown && <><Shape shape={shape} />{children && <div className={styles.float}>{children}</div>}</>}
  </div>;
}

/** A one-line loading state inside a card ("Loading prices"), as a skeleton line with the sentence for readers. */
export function InlineLoading({ label, lines = 2 }: { label: string; lines?: number }) {
  return <div className={styles.inline} role="status" aria-live="polite" aria-busy="true">
    <span className={styles.srOnly}>{label}</span>
    {Array.from({ length: lines }, (_, i) => <Skeleton key={i} w={`${85 - i * 20}%`} />)}
  </div>;
}

export type LoadingStep = { label: string; /** Typical seconds this step takes. */ seconds: number };

/**
 * Steps for slow work. One request does all of it, so the steps advance on typical timings, and the last step stays
 * current until the work is done: the card never claims to be finished early.
 */
export function StepProgress({ title, subtitle, steps, badge, startedAt }: { title: ReactNode; subtitle?: ReactNode; steps: LoadingStep[]; badge?: ReactNode; startedAt?: number }) {
  const [start] = useState(() => startedAt ?? Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  const elapsed = (now - start) / 1000;
  let current = steps.length - 1;
  for (let i = 0, at = 0; i < steps.length; i++) { at += steps[i].seconds; if (elapsed < at) { current = i; break; } }
  return <div className={styles.steps}>
    <div className={styles.stepsHead}>{badge}<div><strong>{title}</strong>{subtitle && <span>{subtitle}</span>}</div></div>
    <ol>
      {steps.map((s, i) => {
        const state = i < current ? "done" : i === current ? "now" : "todo";
        return <li key={s.label} data-state={state} aria-current={state === "now" ? "step" : undefined}>
          <span className={styles.mark} aria-hidden="true">{state === "done" ? "✓" : ""}</span>
          <span>{s.label}</span>
          <span className={styles.srOnly}>{state === "done" ? " (done)" : state === "now" ? " (in progress)" : ""}</span>
        </li>;
      })}
    </ol>
    <p className={styles.elapsed} aria-hidden="true">{Math.floor(elapsed)} s</p>
  </div>;
}
