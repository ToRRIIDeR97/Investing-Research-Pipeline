import ui from "@/components/research-ui.module.css";
import { reviewGate } from "@/lib/research/reporting/depth";

type Row = Record<string, any>;
const SEVERITIES = ["critical", "high", "medium", "low"];
const label = (value: unknown) => String(value ?? "").replace(/_/g, " ");
const text = (finding: Row) => String(finding.issue ?? finding.message ?? finding.description ?? finding.summary ?? "");

/** The AI review the human gate decides on: verdicts, what blocks a position, depth checks and findings by severity. */
export function ReviewFindings({ review }: { review: Row | null }) {
  if (!review) return <section className={ui.section}><div className={ui.sectionHead}><h2>AI review</h2></div><p className={ui.empty}>No AI review is stored for this report version.</p></section>;
  const gate = reviewGate(review);
  const findings: Row[] = Array.isArray(review.findings) ? review.findings : [];
  const checks: Row[] = Array.isArray(review.depth_checks) ? review.depth_checks : [];
  const bySeverity = SEVERITIES.map(severity => [severity, findings.filter(f => String(f.severity ?? "").toLowerCase() === severity)] as const)
    .filter(([, list]) => list.length);
  const other = findings.filter(f => !SEVERITIES.includes(String(f.severity ?? "").toLowerCase()));
  const verdict = String(review.effective_verdict ?? review.review_verdict ?? "");
  return <section className={ui.section}>
    <div className={ui.sectionHead}><h2>AI review</h2><span className={ui.status} data-status={verdict === "pass" ? "pass" : verdict === "fail" ? "fail" : "needs_more_work"}>{label(verdict)}</span></div>
    <dl className={ui.metadata}>
      <div><dt>Reviewer verdict</dt><dd>{label(review.model_verdict ?? review.review_verdict)}</dd></div>
      <div><dt>Verdict for a position</dt><dd>{label(review.effective_verdict ?? review.review_verdict)}</dd></div>
      <div><dt>Open high or critical findings</dt><dd>{gate.open_severe}</dd></div>
      <div><dt>Depth checks missing</dt><dd>{checks.length ? `${checks.filter(c => c.status === "missing").length} of ${checks.length}` : "Not checked"}</dd></div>
    </dl>
    {gate.blocking.length > 0 && <div className={ui.sectionBody}><p className={ui.error} role="status">Position approval is blocked: {gate.blocking.join("; ")}.</p></div>}
    {review.review_summary && <p className="mt-4 text-sm leading-7 text-[#515d70]">{String(review.review_summary)}</p>}
    {checks.length > 0 && <details className="mt-6"><summary>Depth checks</summary><div className={ui.table}><table><thead><tr><th>Check</th><th>Status</th><th>Section</th><th>Why</th></tr></thead><tbody>
      {checks.map(c => <tr key={c.id}><td>{c.label ?? c.id}{c.critical ? " (decision-critical)" : ""}</td><td>{label(c.status)}{c.code_note ? ` (code: ${c.code_note})` : ""}</td><td>{c.section_id || "-"}</td><td>{c.why}</td></tr>)}
    </tbody></table></div></details>}
    {[...bySeverity, ...(other.length ? [["other", other] as const] : [])].map(([severity, list]) =>
      <details key={severity} className="mt-4" open={severity === "critical" || severity === "high"}><summary>{label(severity)} findings ({list.length})</summary>
        <div className={ui.table}><table><thead><tr><th>Section</th><th>Category</th><th>Issue</th><th>Repair</th></tr></thead><tbody>
          {list.map((f, i) => <tr key={i}><td>{f.section_id || "-"}</td><td>{label(f.category)}</td><td>{text(f)}</td><td>{String(f.repair ?? "")}</td></tr>)}
        </tbody></table></div></details>)}
  </section>;
}
