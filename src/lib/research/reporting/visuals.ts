import { z } from 'zod/v4';
import type { ReportArtifact, ReportDocument } from './report';
import { resolveTable } from './tables';

const text = z.string().min(1).max(240);
export const ReportVisual = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('organization'),title:text,caption:z.string().max(400),as_of:z.string().min(1),
    people:z.array(z.object({id:z.string().min(1),name:text,role:text,reports_to:z.string().nullable(),evidence_ids:z.array(z.string()).min(1)}).strict()).min(1).max(30)}).strict(),
  z.object({ kind:z.literal('process'), title:text, caption:z.string().max(400),
    lanes:z.array(z.object({
      nodes:z.array(z.object({label:z.string().min(1).max(60),icon:z.enum(['people','bank','document','chart','building','technology','settings'])}).strict()).min(2).max(4),
      note:z.string().max(320), relationship:z.enum(['documented','hypothesis']),
      evidence_ids:z.array(z.string()), artifact_ids:z.array(z.string()),
    }).strict()).min(1).max(3),
  }).strict(),
  z.object({ kind:z.literal('history'), title:text, caption:z.string().max(400),
    artifact_id:z.string().min(1), path:z.string(), metric_key:z.string().min(1),
    unit:z.string().min(1), currency:z.string(), reporting_basis:z.string(), periodicity:z.string(),
  }).strict(),
]);
export type VisualSpec = z.infer<typeof ReportVisual>;
export type HistoryVisual = Extract<VisualSpec,{kind:'history'}>;

/** Chart numbers are resolved here, never supplied by the model. */
export function historySeries(spec: HistoryVisual, artifacts: ReportArtifact[], cutoff?:string) {
  const data = resolveTable(spec, artifacts);
  if (!Array.isArray(data)) throw new Error('History visual path must resolve to observations');
  const rows = data.filter(r => r && ['metric_key','unit','currency','reporting_basis','periodicity'].every(k => String(r[k] ?? '') === spec[k as keyof HistoryVisual]));
  if (new Set(rows.map(r => JSON.stringify([r.segment ?? '',r.geography ?? '']))).size > 1) throw new Error('Ambiguous chart segments');
  const currency = spec.unit === spec.currency && /^[A-Z]{3}$/.test(spec.currency);
  const seen = new Set<string>();
  const points = rows.map(r => {
    const available=r.available_at ?? r.metadata_json?.agent_output?.available_at;
    if (cutoff && available && (!Number.isFinite(Date.parse(available)) || Date.parse(available)>Date.parse(cutoff))) throw new Error('Chart observation is invalid or beyond cutoff');
    if (!Number.isInteger(r.fiscal_year) || !Number.isInteger(r.fiscal_quarter ?? 0) || (r.fiscal_quarter ?? 0) < 0 || (r.fiscal_quarter ?? 0) > 4) throw new Error('Invalid chart period');
    const key = `${r.fiscal_year}-${r.fiscal_quarter ?? 0}`;
    if (seen.has(key)) throw new Error('Ambiguous duplicate chart period');
    seen.add(key);
    const raw = r.value_numeric;
    if (raw != null && (typeof raw !== 'number' || !Number.isFinite(raw))) throw new Error('Invalid chart value');
    return {key,period:r.fiscal_quarter ? `Q${r.fiscal_quarter} ${r.fiscal_year}` : String(r.fiscal_year),
      value:raw == null ? null : raw / (currency ? 1e6 : 1), exact:raw == null ? 'Not disclosed' : `${raw.toLocaleString('en-US',{maximumFractionDigits:12})} ${spec.unit}`};
  }).sort((a,b)=>a.key.localeCompare(b.key));
  if (points.filter(p=>p.value != null).length < 2) throw new Error('Chart needs at least two observed values');
  return {points,unit:currency ? `${spec.currency} millions` : spec.unit};
}

export function validateVisual(visual: VisualSpec, input: Pick<ReportDocument,'artifacts'|'evidence'|'cutoff'>) {
  if (visual.kind === 'history') { historySeries(visual,input.artifacts,input.cutoff); return; }
  if(visual.kind==='organization'){
    const people=new Map(visual.people.map(p=>[p.id,p]));if(people.size!==visual.people.length)throw new Error('Duplicate organization person');
    if(!Number.isFinite(Date.parse(visual.as_of))||Date.parse(visual.as_of)>Date.parse(input.cutoff))throw new Error('Invalid organization date');
    for(const p of visual.people){const seen=new Set([p.id]);let parent=p.reports_to;while(parent){if(!people.has(parent)||seen.has(parent))throw new Error('Unknown or cyclic reporting relationship');seen.add(parent);parent=people.get(parent)!.reports_to;}
      for(const id of p.evidence_ids){const e=input.evidence.find(e=>e.id===id);if(!e?.quote?.trim()||!/^https?:\/\//i.test(e.url)||!Number.isFinite(Date.parse(e.published_at))||Date.parse(e.published_at)>Date.parse(input.cutoff))throw new Error('Organization source unavailable');}
    }return;
  }
  for (const lane of visual.lanes) {
    if (!lane.evidence_ids.length && !lane.artifact_ids.length) throw new Error('Process lane needs supporting references');
    for (const id of lane.artifact_ids) if (!input.artifacts.some(a=>a.id===id)) throw new Error(`Unknown visual artifact ${id}`);
    for (const id of lane.evidence_ids) {
      const e=input.evidence.find(e=>e.id===id);
      if (!e || !e.quote?.trim() || !e.location?.trim() || !/^https?:\/\//i.test(e.url) || !Number.isFinite(Date.parse(e.published_at)) || Date.parse(e.published_at)>Date.parse(input.cutoff)) throw new Error(`Invalid visual evidence ${id}`);
    }
  }
}

export const VISUAL_GUIDELINES = [
  'Use organization for management when sourced names, roles and reporting relationships are available. Supply as_of and people with stable IDs, roles, reports_to and exact evidence_ids. Use reports_to null when the relationship is undisclosed. Do not infer reporting lines or board oversight from seniority. A leadership roster with unknown reporting lines is preferable to an invented hierarchy.',
  'Choose visuals only where they explain a material business mechanism or historical pattern better than prose. Most sections need none. Maximum two visuals per section. Preserve detailed analysis, counterevidence and sources.',
  'Use process for a sourced causal or business flow, with 1-3 lanes and 2-4 short nodes per lane. Use only the allowed icon names. Each lane needs supporting evidence_ids or artifact_ids. Text, order and arrows must be entailed by those sources; a valid ID alone is not proof. Mark unproven links as relationship hypothesis, not documented, and explain the uncertainty in note.',
  'Use history only for observations at an exact artifact_id/path. Select one metric_key, unit, currency, reporting_basis and periodicity from those observations. Never author numbers, points, totals, percentages or chart coordinates. Do not mix segments, currencies, bases or annual/quarterly periods. If comparable observations are insufficient, omit the visual and explain the gap.',
  'Give each visual a plain-language title and a concise caption stating what it explains and its limits. Do not turn loan-sale proceeds into revenue or deduct credit losses inside net interest income. No invented formulas, feedback loops, positive conclusions, confidence scores, paragraph counts, SQL names or internal identifiers in display text.',
  'The reader supplies the neutral Kintsugi theme, responsive layout, source access, zero-based quantitative bars and data table. Supply structured visuals only, not HTML, SVG, images, CSS or JavaScript. Preserve missing observations as missing, never zero. Full instructions and trial: docs/report-visual-guidelines.md.',
];
