"use client";
// Where a memo claim comes from: the cited passage, its source and a link to the document. Opened from a citation
// chip; replaces the Evidence and Sources tabs as the first way to check a claim.
import { useEffect, useRef } from "react";
import type { MemoEvidence } from "@/lib/research/reporting/research-memo";
import { safeUrl } from "@/lib/research/reporting/presentation.mjs";
import styles from "./memo.module.css";

const day = (value: string | null) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

export function SourceDrawer({ ids, active, evidence, onPick, onClose }: {
  ids: string[]; active: string; evidence: Record<string, MemoEvidence>; onPick: (id: string) => void; onClose: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const item = evidence[active];
  const url = item?.url ? safeUrl(item.url) : null;
  return <>
    <div className={styles.scrim} onClick={onClose} aria-hidden="true" />
    <aside className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="memo-source-title">
      <div className={styles.drawerHead}>
        <h2 id="memo-source-title">Where this comes from</h2>
        <button ref={close} className={styles.close} onClick={onClose} aria-label="Close">×</button>
      </div>
      {item ? <>
        {item.claim && <p className={styles.claim}>{item.claim}</p>}
        {item.quote && <blockquote className={styles.quote}>{item.quote}</blockquote>}
        <dl>
          <dt>Source</dt><dd>{item.title ?? "Untitled source"}</dd>
          {day(item.publishedAt) && <><dt>Published</dt><dd>{day(item.publishedAt)}</dd></>}
          {url && <><dt>Document</dt><dd><a href={url} target="_blank" rel="noreferrer noopener">Open the document</a></dd></>}
        </dl>
      </> : <p className={styles.claim}>This source isn&apos;t in the memo&apos;s evidence. The Audit tab lists every source of the run.</p>}
      {ids.length > 1 && <>
        <p className={styles.eyebrow}>Sources for this point ({ids.length})</p>
        <ul className={styles.sourceList}>{ids.map((id, i) => <li key={id}>
          <button aria-current={id === active ? "true" : undefined} onClick={() => onPick(id)}>{i + 1}. {evidence[id]?.title ?? "Source"}</button>
        </li>)}</ul>
      </>}
    </aside>
  </>;
}
