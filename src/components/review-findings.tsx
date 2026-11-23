import styles from "@/app/review/review.module.css";
import { Tag, type TagTone } from "@/components/ui/primitives";
import { SEVERITY_LABEL, SEVERITY_ORDER, groupFindingsByChapter, plainIdentifiers, verdictWords, type Severity } from "@/lib/review/review-view";

type Row = Record<string, any>;
const tone: Record<Severity, TagTone> = { critical: "bad", high: "bad", medium: "waiting", low: "neutral", other: "neutral" };
const CHECK_STATUS: Record<string, [string, TagTone]> = { met: ["Met", "good"], partial: ["Partly met", "waiting"], missing: ["Missing", "waiting"],
  data_unavailable: ["No data to check", "neutral"], not_applicable: ["Not applicable", "neutral"] };
const checkStatus = (c: Row): [string, TagTone] => c.status === "missing" && c.critical ? ["Missing", "bad"] : CHECK_STATUS[String(c.status)] ?? [verdictWords(c.status), "neutral"];

/**
 * The AI review's findings, grouped by report chapter (collapsed; most severe first), then its depth checks and summary.
 * What the gate allows is decided by reviewGate and the review route; the page explains it beside this list.
 */
export function ReviewFindings({ review, sections }: { review: Row | null; sections: { id: string; title: string }[] }) {
  if (!review) return <p className={styles.empty}>No AI review is stored for this version of the report.</p>;
  const groups = groupFindingsByChapter(review, sections);
  const checks: Row[] = Array.isArray(review.depth_checks) ? review.depth_checks : [];
  const missing = checks.filter((c) => c.status === "missing").length;
  return <div className={styles.findingsList} id="ai-review-findings">
    {groups.map((g) => <details key={g.id || "report"} className={styles.group}>
      <summary><span className={styles.groupTitle}>{g.title}</span><span className={styles.counts}>
        {SEVERITY_ORDER.filter((s) => g.counts[s]).map((s) => <span key={s} className={styles.count} data-severity={s}>{g.counts[s]} {SEVERITY_LABEL[s].toLowerCase()}</span>)}
      </span></summary>
      <ol className={styles.findings}>{g.findings.map((f, i) => <li key={i}>
        <div className={styles.findingHead}><Tag tone={tone[f.severity]}>{SEVERITY_LABEL[f.severity]}</Tag>{f.category && <span>{f.category}</span>}</div>
        <p>{f.issue}</p>
        {f.repair && <p className={styles.fix}><strong>Suggested fix:</strong> {f.repair}</p>}
      </li>)}</ol>
    </details>)}
    {checks.length > 0 && <details className={styles.group}>
      <summary><span className={styles.groupTitle}>Depth checks</span><span className={styles.counts}><span className={styles.count}>{missing} missing of {checks.length}</span></span></summary>
      <ul className={styles.findings}>{checks.map((c) => <li key={c.id}>
        <div className={styles.findingHead}><Tag tone={checkStatus(c)[1]}>{checkStatus(c)[0]}</Tag><span>{c.label ?? verdictWords(c.id)}{c.critical ? " (decision-critical)" : ""}</span></div>
        {c.why && <p>{plainIdentifiers(String(c.why))}</p>}
      </li>)}</ul>
    </details>}
    {review.review_summary && <details className={styles.group}><summary><span className={styles.groupTitle}>The reviewer&apos;s summary</span></summary>
      <p className={styles.summaryText}>{plainIdentifiers(String(review.review_summary))}</p></details>}
  </div>;
}
