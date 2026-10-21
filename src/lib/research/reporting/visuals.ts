import { z } from 'zod/v4';
import type { ReportArtifact, ReportDocument } from './report';
import { resolveTable } from './tables';
import { calculateValuationSchedule } from '../valuation/schedules';
import { withheldValuationReason } from '../valuation/contracts';

const text = z.string().min(1).max(240);
const observed = { artifact_id:z.string().min(1), path:z.string(), unit:z.string().min(1), currency:z.string(), reporting_basis:z.string(), periodicity:z.string() };
// One stored series: a metric_key plus the exact segment and geography (null for consolidated).
const Line = z.object({ label:z.string().min(1).max(60), metric_key:z.string().min(1), segment:z.string().nullable(), geography:z.string().nullable() }).strict();
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
  z.object({ kind:z.literal('series'), title:text, caption:z.string().max(400), ...observed, lines:z.array(Line).min(2).max(6), stacked:z.boolean() }).strict(),
  z.object({ kind:z.literal('ratio'), title:text, caption:z.string().max(400), ...observed, numerator:Line, denominator:Line }).strict(),
  z.object({ kind:z.literal('scenarios'), title:text, caption:z.string().max(400), artifact_id:z.string().min(1), metric:z.string().min(1), unit:z.string() }).strict(),
  z.object({ kind:z.literal('valuation_bridge'), title:text, caption:z.string().max(400), artifact_id:z.string().min(1), scenario:z.enum(['bear','base','bull']) }).strict(),
]);
export type VisualSpec = z.infer<typeof ReportVisual>;
export type HistoryVisual = Extract<VisualSpec,{kind:'history'}>;
export type ChartVisual = Extract<VisualSpec,{kind:'series'|'ratio'|'scenarios'|'valuation_bridge'}>;
export const QUANTITATIVE_VISUALS: string[] = ['history','series','ratio','scenarios','valuation_bridge'];
type ObservedSpec = Extract<VisualSpec,{kind:'history'|'series'|'ratio'}>;
type Dims = { segment:string|null; geography:string|null };
const dim = (v:unknown) => v == null || v === '' ? null : String(v);

/** Stored rows of one metric at the spec's unit, currency, basis and periodicity; one row per period. */
function readObservations(spec: ObservedSpec, metricKey: string, artifacts: ReportArtifact[], cutoff?: string, dims?: Dims) {
  const data = resolveTable(spec, artifacts);
  if (!Array.isArray(data)) throw new Error('History visual path must resolve to observations');
  const want: Record<string,string> = { metric_key:metricKey, unit:spec.unit, currency:spec.currency, reporting_basis:spec.reporting_basis, periodicity:spec.periodicity };
  const rows = data.filter(r => r && Object.keys(want).every(k => String(r[k] ?? '') === want[k]) && (!dims || (dim(r.segment) === dims.segment && dim(r.geography) === dims.geography)));
  if (!dims && new Set(rows.map(r => JSON.stringify([r.segment ?? '',r.geography ?? '']))).size > 1) throw new Error('Ambiguous chart segments');
  const seen = new Set<string>();
  return rows.map(r => {
    const available=r.available_at ?? r.metadata_json?.agent_output?.available_at;
    if (cutoff && available && (!Number.isFinite(Date.parse(available)) || Date.parse(available)>Date.parse(cutoff))) throw new Error('Chart observation is invalid or beyond cutoff');
    if (!Number.isInteger(r.fiscal_year) || !Number.isInteger(r.fiscal_quarter ?? 0) || (r.fiscal_quarter ?? 0) < 0 || (r.fiscal_quarter ?? 0) > 4) throw new Error('Invalid chart period');
    const key = `${r.fiscal_year}-${r.fiscal_quarter ?? 0}`;
    if (seen.has(key)) throw new Error('Ambiguous duplicate chart period');
    seen.add(key);
    const raw = r.value_numeric;
    if (raw != null && (typeof raw !== 'number' || !Number.isFinite(raw))) throw new Error('Invalid chart value');
    return { key, period:r.fiscal_quarter ? `Q${r.fiscal_quarter} ${r.fiscal_year}` : String(r.fiscal_year), raw:raw as number|null };
  }).sort((a,b)=>a.key.localeCompare(b.key));
}
const currencyUnit = (spec: ObservedSpec) => spec.unit === spec.currency && /^[A-Z]{3}$/.test(spec.currency);
const exactValue = (raw: number|null, unit: string) => raw == null ? 'Not disclosed' : `${raw.toLocaleString('en-US',{maximumFractionDigits:12})} ${unit}`;

/** Chart numbers are resolved here, never supplied by the model. */
export function historySeries(spec: HistoryVisual, artifacts: ReportArtifact[], cutoff?:string) {
  const currency = currencyUnit(spec);
  const points = readObservations(spec, spec.metric_key, artifacts, cutoff).map(({key,period,raw}) =>
    ({key,period,value:raw == null ? null : raw / (currency ? 1e6 : 1), exact:exactValue(raw, spec.unit)}));
  if (points.filter(p=>p.value != null).length < 2) throw new Error('Chart needs at least two observed values');
  return {points,unit:currency ? `${spec.currency} millions` : spec.unit};
}

/**
 * A chart built by code from stored artifacts: one row per period or category, one value per series.
 * exact keeps stored precision for the data table and the Markdown export. A waterfall step is drawn from base to base + |value|.
 */
export type ChartPoint = { key:string; period:string; values:(number|null)[]; exact:string[]; base?:number; total?:boolean };
export type BuiltVisual = { display:'lines'|'stacked'|'bars'|'waterfall'; category:string; labels:string[]; columns:string[]; unit:string; points:ChartPoint[]; reference?:{label:string;value:number}; notes:string[] };
const scenarioTypes = ['bear','base','bull'] as const;
const scenarioLabels = ['Bear','Base','Bull'];
const finite = (v:unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const percent = (v:number) => `${(v*100).toLocaleString('en-US',{maximumFractionDigits:2})}%`;
const DRIVERS = ['revenue_growth','operating_margin','capex_to_revenue','da_to_revenue','tax_rate','nwc_to_revenue_change'];
const observedPeriods = (points: ChartPoint[]) => points.filter(p => p.values.some(v => v != null)).length;

function lineSeries(spec: Extract<VisualSpec,{kind:'series'}>, artifacts: ReportArtifact[], cutoff?: string): BuiltVisual {
  const ids = spec.lines.map(l => JSON.stringify([l.metric_key, dim(l.segment), dim(l.geography)]));
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate chart series');
  const scale = currencyUnit(spec) ? 1e6 : 1;
  if (spec.stacked) {
    if (new Set(spec.lines.map(l => l.metric_key)).size > 1 || spec.lines.some(l => !dim(l.segment) && !dim(l.geography))) throw new Error('A stacked chart shows segments or regions of one metric, without the consolidated total');
    // Segments stacked on regions would count the same revenue twice.
    if (new Set(spec.lines.map(l => `${dim(l.segment) ? 's' : ''}${dim(l.geography) ? 'g' : ''}`)).size > 1) throw new Error('A stacked chart stacks either segments or regions, not both');
  }
  const lines = spec.lines.map(l => {
    const rows = readObservations(spec, l.metric_key, artifacts, cutoff, { segment:dim(l.segment), geography:dim(l.geography) });
    if (!rows.some(r => r.raw != null)) throw new Error(`Chart series ${l.label} has no stored observations`);
    return new Map(rows.map(r => [r.key, r]));
  });
  if (spec.stacked && lines.some(m => [...m.values()].some(r => r.raw != null && r.raw < 0))) throw new Error('A stacked chart cannot show negative values');
  const keys = [...new Set(lines.flatMap(m => [...m.keys()]))].sort();
  const points = keys.map(key => ({ key, period:lines.find(m => m.has(key))!.get(key)!.period,
    values:lines.map(m => { const raw = m.get(key)?.raw; return raw == null ? null : raw / scale; }),
    exact:lines.map(m => exactValue(m.get(key)?.raw ?? null, spec.unit)) }));
  if (observedPeriods(points) < 2) throw new Error('Chart needs at least two observed periods');
  const labels = spec.lines.map(l => l.label);
  return { display:spec.stacked ? 'stacked' : 'lines', category:'Period', labels, columns:labels, unit:scale > 1 ? `${spec.currency} millions` : spec.unit, points, notes:[] };
}

/** A margin or other ratio, divided here from two stored series with the same unit and periods. */
function ratioSeries(spec: Extract<VisualSpec,{kind:'ratio'}>, artifacts: ReportArtifact[], cutoff?: string): BuiltVisual {
  const read = (l: z.infer<typeof Line>) => new Map(readObservations(spec, l.metric_key, artifacts, cutoff, { segment:dim(l.segment), geography:dim(l.geography) }).map(r => [r.key, r]));
  if (spec.numerator.metric_key === spec.denominator.metric_key && dim(spec.numerator.segment) === dim(spec.denominator.segment) && dim(spec.numerator.geography) === dim(spec.denominator.geography)) throw new Error('Ratio needs two different series');
  const top = read(spec.numerator), bottom = read(spec.denominator);
  const points = [...top.keys()].filter(k => bottom.has(k)).sort().map(key => {
    const n = top.get(key)!.raw, d = bottom.get(key)!.raw;
    // A zero or negative base has no meaningful ratio; it stays missing.
    const value = n != null && d != null && d > 0 ? n / d : null;
    return { key, period:top.get(key)!.period, values:[value == null ? null : value * 100],
      exact:[value == null ? 'Not available' : percent(value), exactValue(n, spec.unit), exactValue(d, spec.unit)] };
  });
  if (observedPeriods(points) < 2) throw new Error('Ratio needs at least two periods with both values');
  return { display:'lines', category:'Period', labels:[spec.title], columns:[spec.title, spec.numerator.label, spec.denominator.label], unit:'%', points,
    notes:[`Calculated as ${spec.numerator.label} divided by ${spec.denominator.label} for each period.`] };
}

function storedArtifact(id: string, artifacts: ReportArtifact[], types: string[]) {
  const artifact = artifacts.find(a => a.id === id);
  if (!artifact) throw new Error(`Unknown visual artifact ${id}`);
  if (!types.includes(artifact.artifact_type)) throw new Error(`This chart reads ${types.join(' or ')}`);
  if (withheldValuationReason(artifact.content_json)) throw new Error('The valuation is withheld');
  return artifact;
}

/** One scenario's valuation, recalculated from its stored inputs; FCFF first, as on the valuation page. */
function scenarioValuation(c: Record<string,any>, scenario: typeof scenarioTypes[number]) {
  const inputs: any[] = (Array.isArray(c.method_inputs) ? c.method_inputs : []).filter(m => m?.scenario_type === scenario);
  const input = inputs.find(m => m.method === 'fcff') ?? inputs[0];
  if (!input) throw new Error(`No ${scenario} valuation schedule`);
  return calculateValuationSchedule(input);
}

/** Bear, base and bull side by side: value per share from the valuation set, or a yearly driver or statement line from the operating set. */
function scenarioSeries(spec: Extract<VisualSpec,{kind:'scenarios'}>, artifacts: ReportArtifact[]): BuiltVisual {
  const artifact = storedArtifact(spec.artifact_id, artifacts, ['valuation_scenario_set','operating_scenario_set']);
  const c = artifact.content_json;
  if (artifact.artifact_type === 'valuation_scenario_set') {
    if (spec.metric !== 'value_per_share') throw new Error('Valuation scenario charts show value_per_share');
    // Today's value per share, recalculated from the stored method inputs like the bridge and the report text.
    // The terminal_anchor fields are end-of-horizon price targets, not today's value, so they are not charted here.
    const calcs = scenarioTypes.map(t => scenarioValuation(c, t));
    const currency = calcs[0].currency;
    if (calcs.some(x => x.currency !== currency)) throw new Error('Valuation scenarios use different currencies');
    const price = c.current_market_price;
    const methods = [...new Set(calcs.map(x => x.method_name))];
    return { display:'bars', category:'Scenario', labels:['Value per share today'], columns:['Value per share today'], unit:`${currency} per share`,
      points:scenarioTypes.map((t,i) => ({ key:t, period:scenarioLabels[i], values:[calcs[i].value_per_share], exact:[`${calcs[i].value_per_share.toLocaleString('en-US',{maximumFractionDigits:2})} ${currency}`] })),
      ...(finite(price) && price > 0 ? { reference:{ label:'Current price', value:price } } : {}),
      notes:[`Value per share today from ${methods.length === 1 ? `the ${methods[0]}` : calcs.map((x,i) => `${scenarioLabels[i]}: ${x.method_name}`).join('; ')}.${finite(price) && price > 0 ? ` The line marks the stored market price of ${price.toLocaleString('en-US',{maximumFractionDigits:2})} ${currency}.` : ''}`] };
  }
  const scenarios: Record<string,any>[] = Array.isArray(c.scenarios) ? c.scenarios : [];
  const ratio = DRIVERS.includes(spec.metric);
  if (!ratio && !spec.unit.trim()) throw new Error('A statement line chart needs its unit');
  const yearly = scenarioTypes.map(t => {
    const s = scenarios.find(s => s.scenario_type === t);
    if (!s) throw new Error(`Operating scenarios lack ${t}`);
    const statements = s.resulting_financial_statements_json?.years ?? s.resulting_financial_statements_json ?? {};
    const entries: [number, unknown][] = ratio ? (s.yearly_drivers ?? []).map((d: any) => [d.fiscal_year, d[spec.metric]])
      : Object.entries(statements).map(([year, row]: [string, any]) => [Number(year), row?.[spec.metric]]);
    return new Map(entries.filter(([y, v]) => Number.isInteger(y) && finite(v)) as [number, number][]);
  });
  if (yearly.some(m => !m.size)) throw new Error(`Every scenario needs ${spec.metric} values`);
  const years = [...new Set(yearly.flatMap(m => [...m.keys()]))].sort((a,b) => a-b);
  const points = years.map(y => ({ key:String(y), period:`FY${y}`,
    values:yearly.map(m => { const v = m.get(y); return v == null ? null : ratio ? v * 100 : v; }),
    exact:yearly.map(m => { const v = m.get(y); return v == null ? 'Not modelled' : ratio ? percent(v) : `${v.toLocaleString('en-US',{maximumFractionDigits:1})} ${spec.unit}`; }) }));
  if (points.length < 2) throw new Error('Scenario chart needs at least two forecast years');
  return { display:'lines', category:'Year', labels:scenarioLabels, columns:scenarioLabels, unit:ratio ? '%' : spec.unit, points, notes:[] };
}

/** Today's value, recalculated here from the stored valuation inputs: discounted cash flows and terminal value, then the equity bridge. */
function valuationBridge(spec: Extract<VisualSpec,{kind:'valuation_bridge'}>, artifacts: ReportArtifact[]): BuiltVisual {
  const calc = scenarioValuation(storedArtifact(spec.artifact_id, artifacts, ['valuation_scenario_set']).content_json, spec.scenario);
  const cash = calc.years.reduce((n, y) => n + y.present_value, 0);
  const money = (v: number) => `${v.toLocaleString('en-US',{maximumFractionDigits:1})} ${calc.currency} millions`;
  const steps: { label:string; value:number; total?:boolean }[] = [
    { label:'Forecast cash flows, discounted', value:cash },
    { label:'Terminal value, discounted', value:calc.terminal_present_value },
    ...(calc.method === 'fcff' ? [{ label:'Enterprise value', value:cash + calc.terminal_present_value, total:true },
      { label:calc.equity_bridge < 0 ? 'Net debt and leases' : 'Net cash', value:calc.equity_bridge }] : []),
    { label:'Equity value', value:calc.equity_value, total:true },
  ];
  let running = 0;
  const points = steps.map((s, i) => {
    const start = s.total ? 0 : running;
    running = s.total ? s.value : running + s.value;
    return { key:String(i), period:s.label, values:[s.value], base:Math.min(start, start + s.value), exact:[money(s.value)], total:!!s.total };
  });
  return { display:'waterfall', category:'Step', labels:['Value'], columns:['Value'], unit:`${calc.currency} millions`, points,
    notes:[`${scenarioLabels[scenarioTypes.indexOf(spec.scenario)]} case, ${calc.method_name}, discounted at ${percent(calc.discount_rate)} a year.`,
      `Equity value divided by ${calc.diluted_shares.toLocaleString('en-US',{maximumFractionDigits:1})} million diluted shares gives ${calc.value_per_share.toLocaleString('en-US',{maximumFractionDigits:2})} ${calc.currency} a share today.`] };
}

/** Every number of a series, ratio, scenario or bridge chart comes from here. */
export function buildVisual(visual: ChartVisual, artifacts: ReportArtifact[], cutoff?: string): BuiltVisual {
  if (visual.kind === 'series') return lineSeries(visual, artifacts, cutoff);
  if (visual.kind === 'ratio') return ratioSeries(visual, artifacts, cutoff);
  if (visual.kind === 'scenarios') return scenarioSeries(visual, artifacts);
  return valuationBridge(visual, artifacts);
}

export function validateVisual(visual: VisualSpec, input: Pick<ReportDocument,'artifacts'|'evidence'|'cutoff'>) {
  if (visual.kind === 'history') { historySeries(visual,input.artifacts,input.cutoff); return; }
  if (visual.kind !== 'organization' && visual.kind !== 'process') { buildVisual(visual,input.artifacts,input.cutoff); return; }
  if(visual.kind==='organization'){
    const people=new Map(visual.people.map(p=>[p.id,p]));if(people.size!==visual.people.length)throw new Error('Duplicate organization person');
    if(!Number.isFinite(Date.parse(visual.as_of))||Date.parse(visual.as_of)>Date.parse(input.cutoff))throw new Error('Invalid organization date');
    for(const p of visual.people){const seen=new Set([p.id]);let parent=p.reports_to;while(parent){if(!people.has(parent)||seen.has(parent))throw new Error('Unknown or cyclic reporting relationship');seen.add(parent);parent=people.get(parent)!.reports_to;}
      for(const id of p.evidence_ids){const e=input.evidence.find(e=>e.id===id);if(!e?.quote?.trim()||!/^https?:\/\//i.test(e.url)||(e.published_at!==null&&!(Date.parse(e.published_at)<=Date.parse(input.cutoff))))throw new Error('Organization source unavailable');}
    }return;
  }
  for (const lane of visual.lanes) {
    if (!lane.evidence_ids.length && !lane.artifact_ids.length) throw new Error('Process lane needs supporting references');
    for (const id of lane.artifact_ids) if (!input.artifacts.some(a=>a.id===id)) throw new Error(`Unknown visual artifact ${id}`);
    for (const id of lane.evidence_ids) {
      const e=input.evidence.find(e=>e.id===id);
      if (!e || !e.quote?.trim() || !e.location?.trim() || !/^https?:\/\//i.test(e.url) || (e.published_at !== null && !(Date.parse(e.published_at) <= Date.parse(input.cutoff)))) throw new Error(`Invalid visual evidence ${id}`);
    }
  }
}

export const VISUAL_GUIDELINES = [
  'Use organization for management when sourced names, roles and reporting relationships are available. Supply as_of and people with stable IDs, roles, reports_to and exact evidence_ids. Use reports_to null when the relationship is undisclosed. Do not infer reporting lines or board oversight from seniority. A leadership roster with unknown reporting lines is preferable to an invented hierarchy.',
  'A quantitative chapter (history, business and segments, operating scenarios, valuation) carries the chart named in section_plan.chart_plan when stored data supports it. If it does not, omit the chart and state in gaps which data is missing. Other chapters use a visual only where it explains a material mechanism or pattern better than prose. Maximum two visuals per section. Preserve detailed analysis, counterevidence and sources.',
  'Use series for two to six comparable observation series at one artifact_id/path, unit, currency, reporting_basis and periodicity, each line naming its metric_key, exact segment and geography (null for consolidated) and a short label. Set stacked true only for segments or regions of one metric that add to a whole (a segment mix), never with the consolidated total or negative values. Use ratio for a margin or other ratio: name numerator and denominator series in the same unit and periods; code divides them. Never supply the ratio itself.',
  'Use scenarios to compare bear, base and bull from a stored scenario artifact: metric value_per_share on valuation_scenario_set (value per share today, from the stored method inputs), or on operating_scenario_set a yearly driver (revenue_growth, operating_margin, capex_to_revenue) or a resulting statement line key with its unit (for example revenue in USD millions). Use valuation_bridge with a valuation_scenario_set artifact_id and one scenario; code recalculates discounted cash flows, terminal value, equity bridge and value per share from its stored inputs.',
  'Use process for a sourced causal or business flow, with 1-3 lanes and 2-4 short nodes per lane. Use only the allowed icon names. Each lane needs supporting evidence_ids or artifact_ids. Text, order and arrows must be entailed by those sources; a valid ID alone is not proof. Mark unproven links as relationship hypothesis, not documented, and explain the uncertainty in note.',
  'Use history for one series of observations at an exact artifact_id/path. Select one metric_key, unit, currency, reporting_basis and periodicity from those observations. Never author numbers, points, totals, percentages or chart coordinates. Do not mix segments, currencies, bases or annual/quarterly periods. If comparable observations are insufficient, omit the visual and explain the gap.',
  'Give each visual a plain-language title and a concise caption stating what it explains and its limits. Do not turn loan-sale proceeds into revenue or deduct credit losses inside net interest income. No invented formulas, feedback loops, positive conclusions, confidence scores, paragraph counts, SQL names or internal identifiers in display text.',
  'The reader supplies the neutral Kintsugi theme, responsive layout, source access, zero-based quantitative bars and data table. Supply structured visuals only, not HTML, SVG, images, CSS or JavaScript. Preserve missing observations as missing, never zero. Full instructions and trial: docs/report-visual-guidelines.md.',
];
