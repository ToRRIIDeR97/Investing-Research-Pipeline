import type { ReportArtifact } from '@/lib/research/reporting/report';
import { changeText, changeValue, type VersionChangeLog } from '@/lib/research/lineage/change-log';

/** "Changes since the prior run", from the code-computed version_change_log artifact. Renders nothing without a prior run. */
export function ChangeLogTable({ artifacts }: { artifacts: ReportArtifact[] }) {
  const log = artifacts.find(a => a.artifact_type === 'version_change_log')?.content_json as VersionChangeLog | undefined;
  if (!log) return null;
  const cutoff = log.prior_source_cutoff ? new Date(log.prior_source_cutoff).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'an unknown date';
  return <section aria-label="Changes since the prior run">
    <h3>Changes since the prior run</h3>
    <p>Compared with the run researched to {cutoff}. {log.cause === 'new_evidence'
      ? `${log.new_documents} document${log.new_documents === 1 ? '' : 's'} in this run were not in the prior run.`
      : 'No new documents: differences come from method or model changes, not new evidence.'}</p>
    {log.changes.length ? <div role="region" tabIndex={0} aria-label="Changes since the prior run table" style={{ overflowX: 'auto' }}><table>
      <thead><tr><th scope="col">Item</th><th scope="col">Prior run</th><th scope="col">This run</th><th scope="col">Change</th></tr></thead>
      <tbody>{log.changes.map(e => <tr key={e.field}><th scope="row">{e.label}{e.material ? '' : ' (minor)'}</th><td>{changeValue(e.field, e.previous)}</td><td>{changeValue(e.field, e.current)}</td><td>{changeText(e)}</td></tr>)}</tbody>
    </table></div> : <p>No tracked valuation, driver, decision or thesis field changed.</p>}
  </section>;
}
