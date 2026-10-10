import type {ReportSection} from './contracts';
type Row=Record<string,any>;
export function artifactContent(artifacts:Row[],type:string):Row {
  const a=artifacts.filter(a=>(a.artifact_type??a.type)===type).sort((a,b)=>(b.artifact_version??0)-(a.artifact_version??0))[0];
  return a?.content_json??a?.content??{};
}
export function researchObservations(artifacts:Row[]):Row[] {
  const filed=artifactContent(artifacts,'financial_statement_set').observations??[];
  const historical=artifactContent(artifacts,'historical_record').observations??[];
  const market=artifactContent(artifacts,'market_price_history').observations??[];
  const signature=(r:Row)=>JSON.stringify([r.metric_key,r.periodicity,r.fiscal_year,r.fiscal_quarter,r.unit,r.currency,r.reporting_basis,r.segment??'',r.geography??'']);
  const keys=new Set(filed.map(signature));const rows=[...filed,...historical.filter((r:Row)=>!keys.has(signature(r)))];
  const all=new Set(rows.map(signature));return [...rows,...market.filter((r:Row)=>!all.has(signature(r)))];
}
/** Period-end share price and market cap rows (from market_price_history) for the Metrics view. */
export function marketMetrics(observations:Row[],frequency:string):Row[] {
  return observations.filter(r=>r.periodicity===frequency&&r.metadata_json?.metric_category==='market_data'&&['period_end_share_price','market_cap'].includes(r.metric_key));
}
/** The Financials metric catalogue (39 metrics) replaces the earlier six-ratio table. */
export {METRICS,METRIC_GROUPS,MetricBook,evaluateMetric,metricCatalogue,observedPeriods} from './metric-catalogue';
export function kpiMetricKey(item:Row,observations:Row[]):string|null {
  if(item.metric_key)return item.metric_key;
  if(item.kpi==='Diluted shares'&&observations.some(r=>r.metric_key==='us_gaap_WeightedAverageNumberOfDilutedSharesOutstanding'))return 'us_gaap_WeightedAverageNumberOfDilutedSharesOutstanding';
  // Legacy reports explicitly name metric keys in source_role; do not fuzzy-match financial definitions.
  const keys=[...new Set(observations.map(r=>r.metric_key as string))];
  const matches=keys.filter(k=>String(item.source_role??'').split(/[^a-zA-Z0-9_]+/).includes(k));
  if(matches.length===1)return matches[0];
  const exact=keys.filter(k=>k.replaceAll('_',' ').toLowerCase()===String(item.kpi).toLowerCase());return exact.length===1?exact[0]:null;
}
export function readerSections(sections:ReportSection[]):ReportSection[] {
  const hidden=new Set(['reported_history_ttm','evidence_quality_and_conventions']);
  const merge=new Set(['scenario_architecture','valuation_residual_income_nav_reverse','downside_permanent_impairment']);
  const parts=sections.filter(s=>merge.has(s.id));let inserted=false;
  return sections.flatMap(s=>{
    if(hidden.has(s.id))return [];
    if(!merge.has(s.id))return [s];
    if(inserted)return [];inserted=true;
    return [{...s,id:'valuation',title:'Valuation',coverage:[...new Set(parts.flatMap(p=>p.coverage))],paragraphs:parts.flatMap(p=>p.paragraphs),counterevidence:parts.map(p=>p.counterevidence).join('\n\n'),implication:parts.map(p=>p.implication).join('\n\n'),gaps:[...new Set(parts.flatMap(p=>p.gaps))],tables:[...new Map(parts.flatMap(p=>p.tables).map(t=>[`${t.artifact_id}:${t.path}`,t])).values()],visuals:parts.flatMap(p=>p.visuals??[])}];
  });
}
export function readerSectionId(id:string){return ['scenario_architecture','valuation_residual_income_nav_reverse','downside_permanent_impairment'].includes(id)?'valuation':id;}
