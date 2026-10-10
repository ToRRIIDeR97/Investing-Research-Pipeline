import { load } from 'cheerio';
import { METRICS } from './sec-companyfacts';

export type FilingSource = { id:string; url:string; published_at:string; period_end:string; metadata_json:Record<string,any> };
export type FilingFact = { concept:string; value:number|null; text:string; unit:string; start:string|null; end:string; dimensions:string; locator:string; scale:number; fiscal_year:number|null; fiscal_quarter:number|null; periodicity:'quarterly'|'annual'|'ytd'|'instant' };
/** 'segment' tables hold only facts for one reportable segment (the segment note); they never count toward statement coverage. */
export type StatementKind = 'income'|'balance'|'cashflow'|'equity'|'segment';
export type FilingTable = { statement:StatementKind; identified_by:'heading'|'xbrl_tags'|'repair'; title:string; source_document_id:string; source_url:string; accession:string; filed:string; form:string; period_end:string; fiscal_year:number; fiscal_quarter:number; table_index:number; rows:{cells:{text:string; colspan:number; rowspan:number; facts:FilingFact[]}[]}[]; warnings:string[] };
/** A table summary given to the repair specialist's module; it never contains values. */
export type StatementCandidate = { table_index:number; preceding_text:string[]; concepts:string[]; fact_count:number; row_labels:string[]; identified_as:StatementKind|null };
const clean=(s:string)=>s.replace(/\s+/g,' ').trim();
// Issuer prefixes may use a dash ("Inc. - Interim Condensed Consolidated ...").
const STATEMENT_HEADING=/^(?:.{0,150}?(?:Inc\.?|TABLE OF CONTENTS)\s*(?:[-–—:]\s*)?)?(?:(?:Interim|Unaudited|Condensed)\s+){0,3}Consolidated\s+(?:Interim\s+)?(balance sheets|statements? of)/i;
const STATEMENT_TYPE=/consolidated\s+(?:interim\s+)?(?:balance sheets|statements? of\s+(?:operations|income|earnings|financial condition|financial position|cash flows|changes in.{0,25}equity|stockholders.{0,10}equity|shareholders.{0,10}equity|comprehensive income))/i;
// Non-dimensional us-gaap tags that together identify a primary statement without its heading.
const FINGERPRINTS:Record<'balance'|'income'|'cashflow',string[][]>={
  balance:[['Assets'],['Liabilities','LiabilitiesAndStockholdersEquity'],['StockholdersEquity','StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']],
  income:[['Revenues','RevenueFromContractWithCustomerExcludingAssessedTax','RevenueFromContractWithCustomerIncludingAssessedTax','RevenuesNetOfInterestExpense','SalesRevenueNet'],['NetIncomeLoss'],['EarningsPerShareBasic','EarningsPerShareBasicAndDiluted']],
  cashflow:['Operating','Investing','Financing'].map(k=>[`NetCashProvidedByUsedIn${k}Activities`,`NetCashProvidedByUsedIn${k}ActivitiesContinuingOperations`]),
};

// Segment-note facts kept as segment observations: revenue and operating income per reportable segment.
const SEGMENT_CONCEPTS=new Set([...METRICS.filter(m=>m.key==='revenue'||m.key==='net_revenue').flatMap(m=>m.concepts),'OperatingIncomeLoss'].map(c=>`us-gaap:${c}`));
type Contexts=Map<string,{start:string|null;end:string;dimensions:string;segmentMember:string|null}>;
function parseFiling(html:string){
  const $=load(html); const contexts:Contexts=new Map();
  $('xbrli\\:context').each((_,el)=>{const c=$(el);const members=c.find('xbrldi\\:explicitmember, xbrldi\\:typedmember').toArray();
    // Only a context whose sole dimension is the business-segment axis is a whole reportable segment.
    const segmentMember=members.length===1&&$(members[0]).attr('dimension')==='us-gaap:StatementBusinessSegmentsAxis'&&members[0].tagName?.toLowerCase()==='xbrldi:explicitmember'?clean($(members[0]).text()):null;
    contexts.set(c.attr('id')!,{start:c.find('xbrli\\:startdate').text()||null,end:c.find('xbrli\\:enddate, xbrli\\:instant').text(),dimensions:clean(c.find('xbrli\\:segment, xbrli\\:scenario').text()),segmentMember});});
  return {$,contexts,tables:$('table').toArray()};
}

/** Nearest non-blank sibling texts, in document order, stopping at a table that holds text. */
function precedingText($:ReturnType<typeof load>, el:any):string[] {
  const texts:string[]=[];let node=$(el);
  for(let depth=0;depth<3;depth++,node=node.parent()) {
    // Blank paragraphs and empty layout spacer tables sit between some issuers' headings and statements.
    let seen=0;
    for(const prev of node.prevAll().toArray()){const text=clean($(prev).text());if(!text)continue;if(++seen>6)return texts.reverse();
      if(($(prev).is('table')?[prev]:$(prev).find('table').toArray()).some(t=>clean($(t).text())))return texts.reverse();
      texts.push(text);if(STATEMENT_HEADING.test(text))return texts.reverse();}
  }
  return texts.reverse();
}

function headingFor($:ReturnType<typeof load>, el:any):string {
  const caption=$(el).find('caption').text();if(caption)return caption;
  const texts=precedingText($,el);const start=texts.findIndex(t=>STATEMENT_HEADING.test(t));
  return start<0?'':texts.slice(start).join(' ');
}

function fingerprint($:ReturnType<typeof load>, el:any, contexts:Contexts):'balance'|'income'|'cashflow'|null {
  const names=new Set($(el).find('ix\\:nonfraction').toArray().filter(f=>{const c=contexts.get($(f).attr('contextref')||'');return c&&!c.dimensions;})
    .map(f=>String($(f).attr('name')||'')).filter(n=>n.startsWith('us-gaap:')).map(n=>n.slice(8)));
  return (Object.keys(FINGERPRINTS) as ('balance'|'income'|'cashflow')[]).find(k=>FINGERPRINTS[k].every(group=>group.some(n=>names.has(n))))||null;
}

/**
 * Extract the actual primary tables, including custom tags, headings and comparative columns.
 * Headings identify statements first; tags fill statements still missing; overrides come
 * only from a validated repair module.
 */
export function extractFilingStatements(html:string, source:FilingSource, overrides:Record<number,StatementKind>={}):FilingTable[] {
  const {$,contexts,tables:elements}=parseFiling(html);
  const units=new Map<string,string>();
  $('xbrli\\:unit').each((_,el)=>{const u=$(el);const num=u.find('xbrli\\:unitnumerator').text();const den=u.find('xbrli\\:unitdenominator').text();units.set(u.attr('id')!,clean(num?`${num}/${den}`:u.text()).replace(/iso4217:|xbrli:/g,''));});
  const dei=(name:string)=>$('ix\\:nonnumeric').filter((_,e)=>$(e).attr('name')===`dei:${name}`).first().text();
  const focusYear=Number(dei('DocumentFiscalYearFocus'));const focusQuarter=dei('DocumentFiscalPeriodFocus')==='FY'?4:Number(dei('DocumentFiscalPeriodFocus').replace('Q',''));
  const reportedEnd=dei('DocumentPeriodEndDate');
  const focusEnd=/^\d{4}-\d{2}-\d{2}$/.test(reportedEnd)?reportedEnd:reportedEnd&&Number.isFinite(Date.parse(`${reportedEnd} UTC`))?new Date(Date.parse(`${reportedEnd} UTC`)).toISOString().slice(0,10):source.period_end?.slice(0,10);
  const form=source.metadata_json.form||'';
  const tables:FilingTable[]=[];const unlabelled:number[]=[];
  const build=(tableIndex:number,statement:StatementKind,title:string,identified_by:FilingTable['identified_by'],keep:(fact:any)=>boolean=()=>true):FilingTable=>{
    const el=elements[tableIndex];const warnings:string[]=[];
    const rows=$(el).find('tr').filter((_,tr)=>$(tr).closest('table')[0]===el).toArray().map(tr=>({cells:$(tr).children('td,th').toArray().map(cell=>({
      text:clean($(cell).text()),colspan:Math.max(1,Number($(cell).attr('colspan')||1)),rowspan:Math.max(1,Number($(cell).attr('rowspan')||1)),
      facts:$(cell).find('ix\\:nonfraction').toArray().filter(keep).map(f=>{
        const fact=$(f),context=contexts.get(fact.attr('contextref')||'');const text=clean(fact.text());const format=(fact.attr('format')||'').split(':').pop()?.toLowerCase();
        const supported=!format||['num-dot-decimal','numdotdecimal','zerodash','zero-dash','numdash','fixed-zero'].includes(format);
        const raw=/^[—–-]$/.test(text)?0:Number(text.replace(/[,\s()$%−]/g,'').replace(/^\+/,''));
        const scale=Number(fact.attr('scale')||0);const sign=fact.attr('sign')==='-'||/^\(/.test(text)||text.startsWith('−')?-1:1;
        const value=supported&&text!==''&&fact.attr('xsi:nil')!=='true'&&Number.isFinite(raw)&&Number.isFinite(scale)?raw*sign*10**scale:null;
        if(!context||!supported||(value===null&&fact.attr('xsi:nil')!=='true'))warnings.push(`Unresolved fact ${fact.attr('name')} at ${fact.attr('id')||tableIndex}`);
        const start=context?.start||null,end=context?.end||'';const days=start?(Date.parse(end)-Date.parse(start))/86400000+1:0;
        const periodicity=start?(days>=330&&days<=380?'annual':days>=70&&days<=110?'quarterly':'ytd'):'instant';
        const delta=(Date.parse(focusEnd)-Date.parse(end))/86400000/91.3125;const qIndex=focusYear*4+focusQuarter-1-Math.round(delta);
        const validFiscal=Number.isFinite(delta)&&Number.isInteger(focusYear)&&focusYear>1900&&focusQuarter>=1&&focusQuarter<=4;
        return {concept:fact.attr('name')||'',value:Number.isFinite(value)?value:null,text,unit:units.get(fact.attr('unitref')||'')||fact.attr('unitref')||'',start,end,dimensions:context?.dimensions||'',locator:fact.attr('id')||'',scale,
          fiscal_year:validFiscal?Math.floor(qIndex/4):null,fiscal_quarter:validFiscal?qIndex%4+1:null,periodicity} as FilingFact;
      })
    }))}));
    return {statement,identified_by,title:clean(title),source_document_id:source.id,source_url:source.url,accession:source.metadata_json.accessionNumber||'',filed:source.published_at.slice(0,10),form,period_end:focusEnd||source.period_end?.slice(0,10),fiscal_year:focusYear,fiscal_quarter:focusQuarter,table_index:tableIndex,rows,warnings:[...new Set(warnings)]};
  };
  elements.forEach((el,tableIndex)=>{
    const table=$(el);if(!table.find('ix\\:nonfraction').length)return;
    if(overrides[tableIndex]){tables.push(build(tableIndex,overrides[tableIndex],`Located by repair module as ${overrides[tableIndex]}`,'repair'));return;}
    let heading=headingFor($,el);
    if(!heading&&tables.at(-1)?.statement==='equity'&&tables.at(-1)!.table_index===tableIndex-1&&table.find('[name="us-gaap:CommonStockSharesOutstanding"]').length)heading=tables.at(-1)!.title;
    const match=STATEMENT_TYPE.exec(heading);
    if(!match){unlabelled.push(tableIndex);return;}
    const statement=/balance sheets|financial condition|financial position/i.test(match[0])?'balance':/cash flows/i.test(match[0])?'cashflow':/equity/i.test(match[0])?'equity':'income';
    tables.push(build(tableIndex,statement,heading,'heading'));
  });
  for(const statement of Object.keys(FINGERPRINTS) as ('balance'|'income'|'cashflow')[]) {
    if(tables.some(t=>t.statement===statement))continue;
    const hit=unlabelled.find(i=>fingerprint($,elements[i],contexts)===statement);
    if(hit!==undefined)tables.push(build(hit,statement,`Identified by XBRL tags as ${statement}`,'xbrl_tags'));
  }
  // Segment revenue and operating income live in the segment note, not the primary statements.
  const isSegmentFact=(f:any)=>SEGMENT_CONCEPTS.has(String($(f).attr('name')||''))&&!!contexts.get($(f).attr('contextref')||'')?.segmentMember;
  elements.forEach((el,tableIndex)=>{
    if(tables.some(t=>t.table_index===tableIndex)||!$(el).find('ix\\:nonfraction').toArray().some(isSegmentFact))return;
    tables.push(build(tableIndex,'segment','Reportable segment facts identified by XBRL segment axis','xbrl_tags',isSegmentFact));
  });
  return tables.sort((a,b)=>a.table_index-b.table_index);
}

/** Describe every fact-bearing table so a repair module can locate statements without values. */
export function statementCandidates(html:string, identified:FilingTable[]):StatementCandidate[] {
  const {$,tables:elements}=parseFiling(html);
  return elements.flatMap((el,table_index)=>{
    const facts=$(el).find('ix\\:nonfraction').toArray();if(!facts.length)return [];
    const row_labels=$(el).find('tr').toArray().map(tr=>clean($(tr).children('td,th').first().text())).filter(Boolean).slice(0,15);
    return [{table_index,preceding_text:precedingText($,el).map(t=>t.slice(0,200)),concepts:[...new Set(facts.map(f=>String($(f).attr('name')||'')))].slice(0,60),
      fact_count:facts.length,row_labels,identified_as:identified.find(t=>t.table_index===table_index)?.statement??null}];
  });
}

export function filingCoverage(tables:FilingTable[], sources:FilingSource[]) {
  return sources.map(source=>{const found=tables.filter(t=>t.source_document_id===source.id&&t.statement!=='segment');const missing=['income','balance','cashflow'].filter(s=>!found.some(t=>t.statement===s));return {source_document_id:source.id,form:source.metadata_json.form,period_end:source.period_end,missing,table_count:found.length,unresolved_facts:found.reduce((n,t)=>n+t.warnings.length,0),status:missing.length||found.some(t=>t.warnings.length)?'incomplete':'extracted'};});
}

export function reconcileFiledBalances(tables:FilingTable[]) {
  return tables.filter(t=>t.statement==='balance').flatMap(table=>{
    const facts=table.rows.flatMap(r=>r.cells.flatMap(c=>c.facts)).filter(f=>!f.dimensions&&f.value!==null);
    return [...new Set(facts.map(f=>f.end))].flatMap(end=>{
      const get=(concept:string)=>facts.find(f=>f.end===end&&f.concept===`us-gaap:${concept}`);
      const assets=get('Assets'),liabilities=get('Liabilities'),equity=get('StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest')??get('StockholdersEquity');
      if(!assets||!liabilities||!equity||assets.unit!==liabilities.unit||assets.unit!==equity.unit)return [];
      const temporary=get('TemporaryEquityCarryingAmountAttributableToParent');
      if(temporary&&temporary.unit!==assets.unit)return [];
      const difference=assets.value!-liabilities.value!-equity.value!-(temporary?.value??0);
      return [{source_document_id:table.source_document_id,period_end:end,check:temporary?'assets = liabilities + temporary equity + equity':'assets = liabilities + equity',difference,unit:assets.unit,status:Math.abs(difference)<=Math.max(1,Math.abs(assets.value!)*1e-6)?'passed':'mismatch'}];
    });
  });
}

/** Keep reported values separate; derive additive standalone quarters only from compatible YTD facts. */
export function statementObservations(tables:FilingTable[]) {
  const observations:Record<string,any>[]=[];const openingBalances=new Set<Record<string,any>>();
  const candidates=tables.flatMap(table=>table.rows.flatMap((row,order)=>row.cells.flatMap(cell=>cell.facts.map(fact=>({fact,table,order:table.table_index*1000+order,label:row.cells.find(c=>c.text&&!c.facts.length)?.text||fact.concept})))));
  const selected=new Map<string,typeof candidates[number]&{revision:number}>();
  for(const c of [...candidates].sort((a,b)=>a.table.filed.localeCompare(b.table.filed))) {
    const f=c.fact;if(c.table.statement==='equity'||!f.end||f.fiscal_year===null)continue;
    const identity=JSON.stringify([f.concept,f.unit,f.dimensions,f.start,f.end]);
    const prior=selected.get(identity);
    // A fact repeated in the cash-flow reconciliation is the same observation.
    // Prefer its primary statement when both copies come from the same filing.
    const category=METRICS.find(m=>(m.concepts as readonly string[]).includes(f.concept.split(':')[1]))?.category;
    if(prior?.table.filed===c.table.filed&&((category==='income_statement'&&prior.table.statement==='income')||(category==='balance_sheet'&&prior.table.statement==='balance')))continue;
    selected.set(identity,{...c,revision:(prior?.revision??0)+(prior&&f.value!==prior.fact.value?1:0)});
  }
  for(const {fact:f,table,order,label,revision} of selected.values()) {
    const key=f.concept.startsWith('us-gaap:')?METRICS.find(m=>(m.concepts as readonly string[]).includes(f.concept.split(':')[1]))?.key:undefined;
    const metric=key==='revenue'&&candidates.some(c=>c.fact.concept==='us-gaap:RevenuesNetOfInterestExpense')?'contract_revenue':key||f.concept.replace(/[^a-zA-Z0-9_]/g,'_');
    const base={metric_key:metric,value_numeric:f.value,unit:f.unit,currency:/^[A-Z]{3}$/.test(f.unit)?f.unit:null,segment:f.dimensions||null,fiscal_year:f.fiscal_year,fiscal_quarter:f.fiscal_quarter,period_start:f.start,period_end:f.end,reporting_basis:'gaap',metric_type:'reported',source_document_id:table.source_document_id,available_at:table.filed,confidence:1,restatement_version:revision,comparability_status:'comparable',metadata_json:{metric_category:f.periodicity==='instant'?'balance_sheet':{income:'income_statement',segment:'income_statement',balance:'balance_sheet',cashflow:'cash_flow'}[table.statement as 'income'],dimensions:f.dimensions||null,statement_label:label,statement_order:order,concept:f.concept,source_url:table.source_url,source_locator:f.locator,statement:table.statement}};
    if(f.periodicity==='quarterly'||f.periodicity==='annual')observations.push({...base,periodicity:f.periodicity,fiscal_quarter:f.periodicity==='annual'?null:f.fiscal_quarter});
    if(f.periodicity==='instant'){
      const instants=[{...base,periodicity:'quarterly'},...(f.fiscal_quarter===4?[{...base,periodicity:'annual',fiscal_quarter:null}]:[])];
      observations.push(...instants);
      if(isOpeningBalance(f,table))instants.forEach(o=>openingBalances.add(o));
    }
    if((f.periodicity==='ytd'||f.periodicity==='annual')&&f.value!==null&&f.fiscal_quarter!>1&&/^[A-Z]{3}$/.test(f.unit)) {
      const prior=[...selected.values()].filter(c=>c.fact.concept===f.concept&&c.fact.unit===f.unit&&c.fact.dimensions===f.dimensions&&c.fact.start===f.start&&c.fact.fiscal_year===f.fiscal_year&&c.fact.fiscal_quarter===f.fiscal_quarter!-1&&c.fact.value!==null&&c.table.filed<=table.filed).sort((a,b)=>b.table.filed.localeCompare(a.table.filed))[0];
      const direct=[...selected.values()].some(c=>c.fact.concept===f.concept&&c.fact.unit===f.unit&&c.fact.dimensions===f.dimensions&&c.fact.end===f.end&&c.fact.periodicity==='quarterly');
      if(prior&&!direct)observations.push({...base,periodicity:'quarterly',period_start:new Date(Date.parse(prior.fact.end)+86400000).toISOString().slice(0,10),value_numeric:f.value-prior.fact.value!,metric_type:'calculated',formula_or_adjustment:`Standalone quarter = ${f.value} − ${prior.fact.value}; reported cumulative periods ending ${f.end} and ${prior.fact.end}.`,metadata_json:{...base.metadata_json,prior_source_document_id:prior.table.source_document_id,prior_source_url:prior.table.source_url,prior_source_locator:prior.fact.locator}});
    }
  }
  // An opening balance (the instant before a cash-flow statement's earliest period) is kept only
  // for a period other observations already populate; on its own it would add an empty column.
  const periodKey=(o:Record<string,any>)=>JSON.stringify([o.periodicity,o.fiscal_year,o.fiscal_quarter]);
  const covered=new Set(observations.filter(o=>!openingBalances.has(o)).map(periodKey));
  return latestFiledObservations(observations.filter(o=>!openingBalances.has(o)||covered.has(periodKey(o))));
}

/** A cash-flow instant that ends no period in its table and falls the day before one starts. */
function isOpeningBalance(f:FilingFact, table:FilingTable) {
  if(table.statement!=='cashflow')return false;
  const durations=table.rows.flatMap(r=>r.cells.flatMap(c=>c.facts)).filter(x=>x.start);
  const next=Date.parse(f.end)+86400000;
  return Number.isFinite(next)&&!durations.some(x=>x.end===f.end)&&durations.some(x=>x.start===new Date(next).toISOString().slice(0,10));
}

/**
 * Issuers recast earlier periods, sometimes under a different tag that maps to the same metric.
 * Keep one observation per metric and period: the latest filing wins; within one filing a
 * reported value beats a derived one and the metric's documented concept order breaks ties.
 */
function latestFiledObservations(observations:Record<string,any>[]) {
  const conceptRank=(o:Record<string,any>)=>{const short=String(o.metadata_json.concept).split(':')[1];const rank=METRICS.find(m=>(m.concepts as readonly string[]).includes(short))?.concepts.indexOf(short as never);return rank===undefined||rank<0?99:rank;};
  const preferred=(a:Record<string,any>,b:Record<string,any>)=>a.available_at!==b.available_at?a.available_at>b.available_at:
    a.metric_type!==b.metric_type?a.metric_type==='reported':conceptRank(a)<conceptRank(b);
  const groups=new Map<string,Record<string,any>[]>();
  for(const o of observations){const key=JSON.stringify([o.metric_key,o.periodicity,o.fiscal_year,o.fiscal_quarter,o.unit,o.segment??'',o.reporting_basis]);(groups.get(key)||groups.set(key,[]).get(key)!).push(o);}
  return [...groups.values()].map(group=>{
    const winner=group.reduce((best,o)=>preferred(o,best)?o:best);
    const superseded=group.filter(o=>o!==winner&&o.available_at<winner.available_at&&o.value_numeric!==winner.value_numeric).length;
    return superseded?{...winner,restatement_version:winner.restatement_version+superseded}:winner;
  });
}
