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
const aliases:Record<string,string[]>={revenue:['net_revenue','revenue','us_gaap_Revenues','us_gaap_RevenueFromContractWithCustomerExcludingAssessedTax'],gross_profit:['gross_profit','us_gaap_GrossProfit'],sga:['sga','selling_general_administrative','us_gaap_SellingGeneralAndAdministrativeExpense'],net_income:['net_income'],equity:['stockholders_equity'],assets:['total_assets'],selling:['us_gaap_SellingAndMarketingExpense'],administrative:['us_gaap_GeneralAndAdministrativeExpense'],nopat:['nopat'],invested_capital:['invested_capital']};
export function financialRatios(observations:Row[],frequency:string):Row[] {
  const source=observations.filter(r=>r.periodicity===frequency&&!r.segment&&!r.geography);
  const bank=source.some(r=>r.metric_key==='net_interest_income')&&source.some(r=>r.metric_key==='deposits');
  const periods=[...new Map(source.map(r=>[`${r.fiscal_year}-${r.fiscal_quarter??0}`,r])).values()];
  const definitions=[['net_income_margin','Net income margin','net_income','revenue',false],['gross_margin','Gross margin','gross_profit','revenue',false],['sga_margin','SG&A margin','sga','revenue',false],['roe','Return on equity','net_income','equity',true],['roa','Return on assets','net_income','assets',true],['roic','Return on invested capital','nopat','invested_capital',true]] as const;
  return periods.flatMap(period=>definitions.map(([key,name,numerator,denominator,average])=>{
    const get=(metric:string,year=period.fiscal_year,quarter=period.fiscal_quarter):Row|null=>{
      for(const alias of aliases[metric]){const matches=source.filter(r=>r.metric_key===alias&&r.fiscal_year===year&&(r.fiscal_quarter??0)===(quarter??0)&&Number.isFinite(r.value_numeric));if(matches.length)return matches.length===1?matches[0]:null;}
      if(metric==='sga'){const selling=get('selling',year,quarter),admin=get('administrative',year,quarter);if(selling&&admin&&selling.unit===admin.unit&&selling.currency===admin.currency&&selling.reporting_basis===admin.reporting_basis)return {...selling,metric_key:'sga',value_numeric:selling.value_numeric+admin.value_numeric,metadata_json:{statement_label:'SG&A (sales and marketing + general and administrative)',inputs:[selling,admin]}};}
      return null;
    };
    const n=get(numerator),d=get(denominator);const pq=frequency==='annual'?null:period.fiscal_quarter===1?4:period.fiscal_quarter-1;
    const py=frequency==='annual'||period.fiscal_quarter===1?period.fiscal_year-1:period.fiscal_year;
    const previous=average?get(denominator,py,pq):null;const inputs=[n,d,...(average?[previous]:[])];
    const compatible=!(bank&&key==='roic')&&inputs.every(r=>r&&r.currency===n?.currency&&r.unit===n?.unit&&r.reporting_basis===n?.reporting_basis&&/^[A-Z]{3}$/.test(r.unit));
    const divisor=average?(Number(d?.value_numeric)+Number(previous?.value_numeric))/2:d?.value_numeric;
    const factor=average&&frequency==='quarterly'?4:1;
    const formula=`${name} = ${n?.metadata_json?.inputs?n.metadata_json.statement_label:numerator.replaceAll('_',' ')} / ${average?'average beginning and ending ':''}${denominator.replaceAll('_',' ')} × ${factor*100}${factor===4?' (quarterly annualized)':''}`;
    return {metric_key:key,fiscal_year:period.fiscal_year,fiscal_quarter:period.fiscal_quarter,periodicity:frequency,unit:'%',reporting_basis:'calculated',metric_type:'calculated',value_numeric:compatible&&divisor>0?n!.value_numeric/divisor*factor*100:null,
      formula_or_adjustment:formula,metadata_json:{statement_label:name,inputs:inputs.filter(Boolean).flatMap(r=>r?.metadata_json?.inputs??[r]),missing_reason:bank&&key==='roic'?'Not applicable to the consolidated banking business: deposits are operating funding. Use return on equity.':!compatible?`Requires comparable ${numerator.replaceAll('_',' ')} and ${average?'beginning and ending ':''}${denominator.replaceAll('_',' ')}.`:divisor<=0?'Not meaningful with a nonpositive denominator.':null}};
  }));
}
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
