import type { AgentOutputFormat } from '../agent-harness/types';
import { taskInputFingerprint } from './artifact-packets';
import { validateArtifactCitationIds } from './sources/artifact-evidence';

export type SavedReportArtifact = { artifact_type: string; content_json: unknown };
export class ReportReviewRequiredError extends Error {}
export type ReportComposition = {
  executive_summary: string;
  section_order: number[];
  transitions: Array<{ before_section: number; text: string }>;
  closing_assessment: string;
  disclosures: string[];
  artifact_refs: string[];
  input_fingerprint?: string;
};

const string = { type: 'string', minLength: 1, maxLength: 3000 };
export const REPORT_COMPOSITION_CONTRACT: AgentOutputFormat = {
  requiredKeys: ['executive_summary', 'section_order', 'transitions', 'closing_assessment', 'disclosures', 'artifact_refs'],
  schema: {
    type: 'object', additionalProperties: false,
    required: ['executive_summary', 'section_order', 'transitions', 'closing_assessment', 'disclosures', 'artifact_refs'],
    properties: {
      executive_summary: string, closing_assessment: string,
      section_order: { type: 'array', minItems: 25, maxItems: 25, items: { type: 'number', minimum: 1, maximum: 25 } },
      transitions: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false,
        required: ['before_section', 'text'], properties: { before_section: { type: 'number', minimum: 2, maximum: 25 }, text: string } } },
      disclosures: { type: 'array', items: string, maxItems: 12 },
      artifact_refs: { type: 'array', minItems: 1, items: { type: 'string' } },
    },
  },
};

const REVIEW_TYPES = new Set(['pass_fail', 'review_summary', 'quality_score', 'findings', 'recommendations', 'review_verdict', 'synthetic_report']);
export function reportInputs(artifacts: SavedReportArtifact[]) {
  return artifacts.filter((artifact) => !REVIEW_TYPES.has(artifact.artifact_type) && artifact.artifact_type !== 'report_composition')
    .sort((a, b) => a.artifact_type.localeCompare(b.artifact_type));
}

export function reportSnapshotFingerprint(artifacts: SavedReportArtifact[]) {
  return taskInputFingerprint(artifacts.filter((artifact) => artifact.artifact_type !== 'synthetic_report')
    .sort((a, b) => a.artifact_type.localeCompare(b.artifact_type)));
}

/** A bounded handoff, with explicit truncation and a hash of the full source output. */
export function artifactHandoff(artifact: SavedReportArtifact) {
  const facts: string[] = [];
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) value.forEach((entry, index) => visit(entry, `${path}.${index}`));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, entry]) => visit(entry, `${path}.${key}`));
    else if (typeof value === 'string' && value.length > 30 && !/claim_ids|uuid|artifact_type/.test(path)) facts.push(`${path}: ${value}`);
  };
  visit(artifact.content_json, artifact.artifact_type);
  const all = facts.join('\n');
  return { artifact_ref: artifact.artifact_type, input_hash: taskInputFingerprint(artifact.content_json),
    summary: all.slice(0, 1800), summary_truncated: all.length > 1800,
    evidence_claim_ids: validateArtifactCitationIds(artifact.content_json, []).citedIds };
}

export function reportNumericValues(artifacts: SavedReportArtifact[]) {
  const values: Record<string, number> = {};
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) value.forEach((entry, index) => visit(entry, `${path}.${index}`));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, entry]) => visit(entry, `${path}.${key}`));
    else if (typeof value === 'number' && Number.isFinite(value)) values[path] = value;
  };
  for (const artifact of artifacts.filter((row) => ['valuation_scenario_set', 'expected_return_matrix', 'confidence_assessment'].includes(row.artifact_type))) visit(artifact.content_json, artifact.artifact_type);
  return values;
}

export function validateReportComposition(value: unknown, artifacts: SavedReportArtifact[]) {
  const composition = value as ReportComposition;
  const errors: Array<{ path: string; message: string }> = [];
  if (!Array.isArray(composition?.section_order) || composition.section_order.length !== 25 || new Set(composition.section_order).size !== 25
    || composition.section_order.some((key) => !Number.isInteger(key) || key < 1 || key > 25)) errors.push({ path: 'section_order', message: 'Include each report section exactly once' });
  const allowed = new Set(artifacts.map((row) => row.artifact_type));
  if (composition?.transitions?.some((row) => !Number.isInteger(row.before_section) || row.before_section < 2 || row.before_section > 25)) errors.push({ path: 'transitions', message: 'Transitions must reference a valid section number' });
  if (composition?.section_order?.[0] !== 1 || composition?.section_order?.at(-2) !== 24 || composition?.section_order?.at(-1) !== 25) errors.push({ path: 'section_order', message: 'Keep the executive conclusion first and human decision and limitations last' });
  if (!composition?.artifact_refs?.length || composition.artifact_refs.some((ref) => !allowed.has(ref))) errors.push({ path: 'artifact_refs', message: 'Only accepted artifact references are allowed' });
  const values = reportNumericValues(artifacts);
  for (const text of [composition?.executive_summary, composition?.closing_assessment, ...(composition?.transitions || []).map((row) => row.text), ...(composition?.disclosures || [])]) {
    if (typeof text !== 'string') { errors.push({ path: 'text', message: 'Report prose must be text' }); continue; }
    const withoutRefs = text.replace(/\{\{value:([^}]+)\}\}/g, (_match, key) => {
      if (!(key in values)) errors.push({ path: 'text', message: `Unknown numeric reference: ${key}` });
      return '';
    });
    if (/\d|\{\{|<[^>]+>|^\s*#/m.test(withoutRefs)) errors.push({ path: 'text', message: 'Use saved value references for numbers; prose cannot contain HTML or section headings' });
  }
  return errors;
}

export function renderComposedReport(markdown: string, composition: ReportComposition, values: Record<string, number>) {
  const prose = (text: string) => text.replace(/\{\{value:([^}]+)\}\}/g, (_match, key) => {
    if (!(key in values)) throw new Error(`Unknown report value: ${key}`);
    return String(values[key]);
  });
  const blocks = markdown.split(/(?=^## \d+\. )/m);
  const preamble = blocks.shift() || '';
  const sections = new Map(blocks.map((block) => [Number(/^## (\d+)\./.exec(block)?.[1]), block]));
  if (sections.size !== 25 || new Set(composition.section_order).size !== 25) throw new Error('Report composition cannot omit a required section');
  return preamble + composition.section_order.map((key, index) => {
    const block = sections.get(key);
    if (!block) throw new Error(`Missing report section ${key}`);
    const transition = composition.transitions.filter((row) => row.before_section === key).map((row) => prose(row.text)).join('\n\n');
    const introduction = key === 1 ? prose(composition.executive_summary) : transition;
    const closing = key === 25 ? `\n\n${prose(composition.closing_assessment)}\n\n${composition.disclosures.map((text) => `- ${prose(text)}`).join('\n')}` : '';
    return block.replace(/^## \d+\. ([^\n]+)\n/, `## ${index + 1}. $1\n\n${introduction}\n`) + closing;
  }).join('\n\n');
}
