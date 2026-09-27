import { load } from 'cheerio';
import { METRICS } from './sec-companyfacts';

export type FilingSource = { id:string; url:string; published_at:string; period_end:string; metadata_json:Record<string,any> };
export type FilingFact = { concept:string; value:number|null; text:string; unit:string; start:string|null; end:string; dimensions:string; locator:string; scale:number; fiscal_year:number|null; fiscal_quarter:number|null; periodicity:'quarterly'|'annual'|'ytd'|'instant' };
export type FilingTable = { statement:'income'|'balance'|'cashflow'|'equity'; title:string; source_document_id:string; source_url:string; accession:string; filed:string; form:string; period_end:string; fiscal_year:number; fiscal_quarter:number; table_index:number; rows:{cells:{text:string; colspan:number; rowspan:number; facts:FilingFact[]}[]}[]; warnings:string[] };
const clean=(s:string)=>s.replace(/\s+/g,' ').trim();

/** Extract the actual primary tables, including custom tags, headings and comparative columns. */
export function extractFilingStatements(html:string, source:FilingSource):FilingTable[] {
  const $=load(html); const contexts=new Map<string,{start:string|null;end:string;dimensions:string}>();
  $('xbrli\\:context').each((_,el)=>{const c=$(el);contexts.set(c.attr('id')!,{start:c.find('xbrli\\:startdate').text()||null,end:c.find('xbrli\\:enddate, xbrli\\:instant').text(),dimensions:clean(c.find('xbrli\\:segment, xbrli\\:scenario').text())});});
  const units=new Map<string,string>();
  $('xbrli\\:unit').each((_,el)=>{const u=$(el);const num=u.find('xbrli\\:unitnumerator').text();const den=u.find('xbrli\\:unitdenominator').text();units.set(u.attr('id')!,clean(num?`${num}/${den}`:u.text()).replace(/iso4217:|xbrli:/g,''));});
  const dei=(name:string)=>$('ix\\:nonnumeric').filter((_,e)=>$(e).attr('name')===`dei:${name}`).first().text();
  const focusYear=Number(dei('DocumentFiscalYearFocus'));const focusQuarter=dei('DocumentFiscalPeriodFocus')==='FY'?4:Number(dei('DocumentFiscalPeriodFocus').replace('Q',''));
  const reportedEnd=dei('DocumentPeriodEndDate');
  const focusEnd=/^\d{4}-\d{2}-\d{2}$/.test(reportedEnd)?reportedEnd:reportedEnd&&Number.isFinite(Date.parse(`${reportedEnd} UTC`))?new Date(Date.parse(`${reportedEnd} UTC`)).toISOString().slice(0,10):source.period_end?.slice(0,10);
  const form=source.metadata_json.form||'';
  const tables:FilingTable[]=[];
  $('table').each((tableIndex,el)=>{
    const table=$(el);if(!table.find('ix\\:nonfraction').length)return;
    let heading=table.find('caption').text();let node=table;
    for(let depth=0;depth<3&&!heading;depth++,node=node.parent()) {
      const previous=node.prevAll().slice(0,6).toArray();
      for(const prev of previous){if($(prev).is('table')||$(prev).find('table').length)break; const text=clean($(prev).text());heading=text+' '+heading;if(/^(?:.{0,150}?(?:Inc\.?|TABLE OF CONTENTS)\s*)?(?:Unaudited\s+)?(?:Condensed\s+)?Consolidated\s+(balance sheets|statements of)/i.test(text))break;}
      if(!/^(?:.{0,150}?(?:Inc\.?|TABLE OF CONTENTS)\s*)?(?:Unaudited\s+)?(?:Condensed\s+)?Consolidated\s+(balance sheets|statements of)/i.test(heading))heading='';
    }
    if(!heading&&tables.at(-1)?.statement==='equity'&&tables.at(-1)!.table_index===tableIndex-1&&table.find('[name="us-gaap:CommonStockSharesOutstanding"]').length)heading=tables.at(-1)!.title;
    const match=/consolidated\s+(?:balance sheets|statements of\s+(?:operations|income|earnings|financial condition|financial position|cash flows|changes in.{0,25}equity|stockholders.{0,10}equity|shareholders.{0,10}equity|comprehensive income))/i.exec(heading);
    if(!match)return;
    const statement=/balance sheets|financial condition|financial position/i.test(match[0])?'balance':/cash flows/i.test(match[0])?'cashflow':/equity/i.test(match[0])?'equity':'income';
    const warnings:string[]=[];
    const rows=table.find('tr').filter((_,tr)=>$(tr).closest('table')[0]===el).toArray().map(tr=>({cells:$(tr).children('td,th').toArray().map(cell=>({
      text:clean($(cell).text()),colspan:Math.max(1,Number($(cell).attr('colspan')||1)),rowspan:Math.max(1,Number($(cell).attr('rowspan')||1)),
      facts:$(cell).find('ix\\:nonfraction').toArray().map(f=>{
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
    tables.push({statement,title:clean(heading),source_document_id:source.id,source_url:source.url,accession:source.metadata_json.accessionNumber||'',filed:source.published_at.slice(0,10),form,period_end:focusEnd||source.period_end?.slice(0,10),fiscal_year:focusYear,fiscal_quarter:focusQuarter,table_index:tableIndex,rows,warnings:[...new Set(warnings)]});
  });
  return tables;
}

export function filingCoverage(tables:FilingTable[], sources:FilingSource[]) {
  return sources.map(source=>{const found=tables.filter(t=>t.source_document_id===source.id);const missing=['income','balance','cashflow'].filter(s=>!found.some(t=>t.statement===s));return {source_document_id:source.id,form:source.metadata_json.form,period_end:source.period_end,missing,table_count:found.length,unresolved_facts:found.reduce((n,t)=>n+t.warnings.length,0),status:missing.length||found.some(t=>t.warnings.length)?'incomplete':'extracted'};});
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
  const observations:Record<string,any>[]=[];
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
    const base={metric_key:metric,value_numeric:f.value,unit:f.unit,currency:/^[A-Z]{3}$/.test(f.unit)?f.unit:null,segment:f.dimensions||null,fiscal_year:f.fiscal_year,fiscal_quarter:f.fiscal_quarter,period_start:f.start,period_end:f.end,reporting_basis:'gaap',metric_type:'reported',source_document_id:table.source_document_id,available_at:table.filed,confidence:1,restatement_version:revision,comparability_status:'comparable',metadata_json:{metric_category:f.periodicity==='instant'?'balance_sheet':{income:'income_statement',balance:'balance_sheet',cashflow:'cash_flow'}[table.statement as 'income'],dimensions:f.dimensions||null,statement_label:label,statement_order:order,concept:f.concept,source_url:table.source_url,source_locator:f.locator,statement:table.statement}};
    if(f.periodicity==='quarterly'||f.periodicity==='annual')observations.push({...base,periodicity:f.periodicity,fiscal_quarter:f.periodicity==='annual'?null:f.fiscal_quarter});
    if(f.periodicity==='instant'){
      observations.push({...base,periodicity:'quarterly'});
      if(f.fiscal_quarter===4)observations.push({...base,periodicity:'annual',fiscal_quarter:null});
    }
    if((f.periodicity==='ytd'||f.periodicity==='annual')&&f.value!==null&&f.fiscal_quarter!>1&&/^[A-Z]{3}$/.test(f.unit)) {
      const prior=[...selected.values()].filter(c=>c.fact.concept===f.concept&&c.fact.unit===f.unit&&c.fact.dimensions===f.dimensions&&c.fact.start===f.start&&c.fact.fiscal_year===f.fiscal_year&&c.fact.fiscal_quarter===f.fiscal_quarter!-1&&c.fact.value!==null&&c.table.filed<=table.filed).sort((a,b)=>b.table.filed.localeCompare(a.table.filed))[0];
      const direct=[...selected.values()].some(c=>c.fact.concept===f.concept&&c.fact.unit===f.unit&&c.fact.dimensions===f.dimensions&&c.fact.end===f.end&&c.fact.periodicity==='quarterly');
      if(prior&&!direct)observations.push({...base,periodicity:'quarterly',period_start:new Date(Date.parse(prior.fact.end)+86400000).toISOString().slice(0,10),value_numeric:f.value-prior.fact.value!,metric_type:'calculated',formula_or_adjustment:`Standalone quarter = ${f.value} − ${prior.fact.value}; reported cumulative periods ending ${f.end} and ${prior.fact.end}.`,metadata_json:{...base.metadata_json,prior_source_document_id:prior.table.source_document_id,prior_source_url:prior.table.source_url,prior_source_locator:prior.fact.locator}});
    }
  }
  return observations;
}
