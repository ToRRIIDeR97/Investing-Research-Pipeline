import {financialPeriod,label} from './presentation.mjs';
type Row=Record<string,any>;

/**
 * KPI chart series for the monitoring dashboard.
 *
 * Monitoring items are written by agents with prose labels ("GAAP as reported", "USD millions"),
 * while observations carry normalised labels ("gaap", raw "USD"). Matching compares the meaning of
 * the labels, scales every value into the KPI's display unit, and only splices equivalent metric
 * keys when they agree on the periods they share.
 */

// Equivalent observation keys. The KPI's own key always wins; aliases only fill periods it lacks.
const aliasGroups=[
  ['total_revenue','revenue','net_revenue','us_gaap_Revenues','us_gaap_RevenueFromContractWithCustomerExcludingAssessedTax'],
  ['income_from_operations','operating_income','us_gaap_OperatingIncomeLoss'],
  ['net_income','us_gaap_NetIncomeLoss'],
  ['operating_cash_flow','net_cash_provided_by_operating_activities','us_gaap_NetCashProvidedByUsedInOperatingActivities'],
  ['capex','capital_expenditures','purchases_of_property_and_equipment','us_gaap_PaymentsToAcquirePropertyPlantAndEquipment'],
];
const withoutGaap=(key:string)=>key.endsWith('_non_gaap')?key:key.replace(/_gaap$/,'');
const variants=(key:string)=>key.startsWith('us_gaap_')||key.endsWith('_non_gaap')?[key]:[key,`${key}_gaap`];

export function kpiCandidateKeys(metric:string):string[] {
  const base=withoutGaap(metric);
  const group=aliasGroups.find(g=>g.includes(base))??[];
  return [...new Set([metric,...variants(base),...group.flatMap(variants)])];
}

/** gaap | non_gaap | ifrs, or null when the label does not say ("as_reported"). */
export function basisClass(basis:unknown,metricKey=''):string|null {
  const classify=(text:string)=>/non[\s_-]*gaap|adjusted|company[\s_-]*defined|non[\s_-]*ifrs/.test(text)?'non_gaap':/gaap/.test(text)?'gaap':/ifrs/.test(text)?'ifrs':null;
  return classify(String(basis??'').toLowerCase())??classify(metricKey.toLowerCase().replace(/^us_gaap_/,''));
}

const scales:[RegExp,number][]=[[/\b(thousands?|000s)\b/,1e3],[/\b(millions?|mm|mn)\b/,1e6],[/\b(billions?|bn)\b/,1e9]];
/** Split a unit label into a comparable base and a scale ("USD_millions" → usd × 1e6). */
export function parseUnit(unit:unknown):{base:string;scale:number;currency:boolean}|null {
  let text=String(unit??'').toLowerCase().replace(/_/g,' ').trim();
  if(!text)return null;
  let scale=1;
  for(const [pattern,value] of scales)if(pattern.test(text)){scale=value;text=text.replace(pattern,' ');}
  const base=text.replace(/\b(in|of)\b/g,' ').replace(/\s+/g,' ').trim().replace(/shares\b/g,'share').replace(/^(percent|percentage)$/,'%');
  return {base,scale,currency:/^[a-z]{3}$/.test(base)};
}

const dimension=(value:unknown)=>String(value??'').replace(/^[^:]*:/,'').replace(/Member$/,'').replace(/([a-z])([A-Z])/g,'$1_$2').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
/** Same segment, or an undimensioned row whose metric key names the segment (never a consolidated series). */
function dimensionMatches(row:Row,item:Row,field:'segment'|'geography'):boolean {
  const want=dimension(item[field]),have=dimension(row[field]);
  if(!want)return !have;
  return have?have===want:`_${dimension(row.metric_key)}_`.includes(`_${want}_`);
}

const dayMs=86_400_000;
function discreteQuarter(row:Row):boolean {
  if(row.periodicity!=='quarterly'||/_ytd$/.test(row.metric_key))return false;
  if(/year[\s_-]*to[\s_-]*date|ytd/i.test(String(row.metadata_json?.agent_output?.period_type??row.metadata_json?.period_type??'')))return false;
  const start=Date.parse(row.period_start),end=Date.parse(row.period_end);
  return !(Number.isFinite(start)&&Number.isFinite(end)&&(end-start)/dayMs>100);
}

const quarterIndex=(period:string)=>Number(period.slice(0,4))*4+Number(period.at(-1))-1;
const quarterName=(index:number)=>`${Math.floor(index/4)}-Q${index%4+1}`;
const agrees=(a:number,b:number)=>Math.abs(a-b)<=Math.max(0.001*Math.max(Math.abs(a),Math.abs(b)),1e-9);

export type KpiSeries={metric:string|null;keys:string[];unit:string;points:{period:string;value:number|null}[];rows:Row[];reason:string};

export function kpiSeries(item:Row,observations:Row[],metric:string|null,maxQuarters=8):KpiSeries {
  const empty=(reason:string,unit=String(item.unit??'')):KpiSeries=>({metric,keys:[],unit,points:[],rows:[],reason});
  if(!metric)return empty('No captured metric is linked to this KPI.');
  const candidates=kpiCandidateKeys(metric);
  const itemBasis=basisClass(item.reporting_basis);
  const pool=observations.filter(r=>candidates.includes(r.metric_key)&&discreteQuarter(r)&&financialPeriod(r));
  const usable=pool.filter(r=>dimensionMatches(r,item,'segment')&&dimensionMatches(r,item,'geography')
    &&(!itemBasis||!basisClass(r.reporting_basis,r.metric_key)||basisClass(r.reporting_basis,r.metric_key)===itemBasis)&&parseUnit(r.unit));
  if(!usable.length)return empty(pool.length?'Captured quarterly observations use a different segment or reporting basis.':'No discrete quarterly observations were captured for this KPI.');

  // Display unit: the KPI's own unit; otherwise the primary series' unit, with currency shown in millions.
  const first=usable.find(r=>r.metric_key===metric)??usable[0];
  const declared=parseUnit(item.unit),fallback=parseUnit(first.unit)!;
  const display=declared??(fallback.currency?{...fallback,scale:1e6}:fallback);
  const unit=declared?String(item.unit):display.currency?`${display.base.toUpperCase()} millions`:label(first.unit);
  const comparable=usable.filter(r=>parseUnit(r.unit)!.base===display.base);
  if(!comparable.length)return empty(`Captured observations are not in ${unit}.`,unit);

  // One value per period per key; a key that disagrees with itself for a period is ambiguous and dropped.
  const byKey=new Map<string,Map<string,{value:number|null;row:Row}>>();
  for(const r of comparable){
    const period=financialPeriod(r)!,raw=Number(r.value_numeric);
    const value=r.value_numeric!=null&&Number.isFinite(raw)?raw*parseUnit(r.unit)!.scale/display.scale:null;
    const series=byKey.get(r.metric_key)??new Map();byKey.set(r.metric_key,series);
    const seen=series.get(period);
    if(!seen||seen.value===null)series.set(period,{value,row:r});
    else if(value!==null&&!agrees(seen.value,value))series.set(period,{value:NaN,row:r});
  }
  const chosen=new Map<string,{value:number|null;row:Row}>();const keys:string[]=[];let ambiguous=false;
  for(const key of candidates){
    const series=byKey.get(key);if(!series)continue;
    if([...series.values()].some(p=>Number.isNaN(p.value))){ambiguous=true;continue;}
    // Splice an alias only when it matches the series already chosen on every shared period.
    const conflict=[...series].some(([p,v])=>chosen.get(p)?.value!=null&&v.value!=null&&!agrees(chosen.get(p)!.value!,v.value));
    if(conflict)continue;
    keys.push(key);
    for(const [p,v] of series)if(chosen.get(p)?.value==null)chosen.set(p,v);
  }
  if(!chosen.size)return empty(ambiguous?'Multiple conflicting observations for a period.':'Captured observations disagree across equivalent measures.',unit);

  const filled=[...chosen].filter(([,v])=>v.value!==null).map(([p])=>quarterIndex(p));
  const last=filled.length?Math.max(...filled):Math.max(...[...chosen.keys()].map(quarterIndex));
  const window=Array.from({length:maxQuarters},(_,i)=>quarterName(last-maxQuarters+1+i));
  const start=window.findIndex(p=>chosen.get(p)?.value!=null);
  const points=(start<0?[]:window.slice(start)).map(period=>({period,value:chosen.get(period)?.value??null}));
  const rows=points.map(p=>chosen.get(p.period)?.row).filter((r):r is Row=>!!r);
  const reason=points.filter(p=>p.value!==null).length<2?'At least two quarterly observations are needed for a chart.':'';
  return {metric,keys,unit,points,rows,reason};
}

/**
 * Annual forecast tables. Agents write money in USD millions by convention, but raw amounts appear
 * too (and raw share counts are required beside *_millions). No single company line reaches
 * 10 trillion in millions, so values at or above 1e7 are raw and are converted to millions.
 */
const RAW_THRESHOLD=1e7;
export function forecastUnit(key:string,group:string,currency='USD'):{unit:string;scale:(value:number)=>number} {
  const asIs=(value:number)=>value,millions=(value:number)=>Math.abs(value)>=RAW_THRESHOLD?value/1e6:value;
  if(group==='per_share_values'||/per_share|(^|_)eps($|_)/.test(key))return {unit:`${currency}/share`,scale:asIs};
  if(/margin|ratio|(^|_)rate($|_)/.test(key))return {unit:'%',scale:(value:number)=>Math.abs(value)<=1?value*100:value};
  if(/shares/.test(key))return {unit:'million shares',scale:key.endsWith('_millions')?asIs:(value:number)=>Math.abs(value)>=1e5?value/1e6:value};
  return {unit:`${currency} millions`,scale:/millions/.test(key)?asIs:millions};
}
export function forecastTableRows(projections:Row[],group:string,currency='USD'):(string|number|null)[][] {
  const keys=[...new Set(projections.flatMap(p=>Object.keys(p[group]??{})))]
    .filter(k=>!k.endsWith('_millions')||!projections.some(p=>Object.hasOwn(p[group]??{},k.replace(/_millions$/,''))));
  return keys.map(k=>{
    const {unit,scale}=forecastUnit(k,group,currency);
    return [`${label(k)} (${unit})`,...projections.map(p=>{const v=p[group]?.[k];return typeof v==='number'&&Number.isFinite(v)?scale(v):null;})];
  });
}
