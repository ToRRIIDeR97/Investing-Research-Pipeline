import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import type {Sql,ResearchRunContext} from '../run-context';
import {saveReportArtifact} from '../reporting/store';
import {extractFilingStatements,filingCoverage,statementObservations,reconcileFiledBalances,type FilingSource,type FilingTable} from './filing-statements';
import {HistoricalObservation} from './contracts';
import {needsStatementRepair,repairStatements,type ModuleWriter,type RepairFiling} from '../repair/statement-repair';
import {extractHeadcount,filingPlainText,headcountObservations,type FiscalPeriod,type HeadcountSource} from './headcount';
import {extractReleaseStatements,depositaryRatioFromText} from './press-release';

/**
 * Capture primary statements from the run's stored filings. With a module writer, filings the
 * deterministic parser cannot complete go to the repair specialist; its attempts are saved.
 */
export async function captureFilingStatements(sql:Sql,ctx:Pick<ResearchRunContext,'runId'|'assetId'|'assetSlug'|'cutoffAt'>,options:{writeModule?:ModuleWriter}={}) {
  // Annual reports of foreign issuers (20-F, 40-F) carry inline XBRL like 10-Ks; their quarters come from 6-K releases below.
  const rows=await sql`SELECT d.id,d.url,d.published_at,d.period_end::text AS period_end,d.storage_path,d.metadata_json FROM source_documents d JOIN research_run_sources r ON r.source_document_id=d.id WHERE r.research_run_id=${ctx.runId} AND d.metadata_json->>'form' IN ('10-Q','10-K','10-Q/A','10-K/A','20-F','20-F/A','40-F','40-F/A') AND d.published_at<=${ctx.cutoffAt.toISOString()} ORDER BY d.published_at DESC`;
  const sources=rows.map(r=>({...r,published_at:new Date(r.published_at).toISOString(),period_end:String(r.period_end??'')})) as unknown as (FilingSource&{storage_path:string})[];
  const filings:RepairFiling[]=[];const failures:string[]=[];
  const root=resolve(process.cwd(),'storage','sources');
  for(const source of sources){try{const path=resolve(process.cwd(),source.storage_path);if(!path.startsWith(root+sep))throw new Error('Source path outside stored corpus');filings.push({source,html:await readFile(path,'utf8')});}catch{failures.push(source.id);}}
  let tables:FilingTable[]=filings.flatMap(f=>extractFilingStatements(f.html,f.source));
  const releases=await captureReleaseStatements(sql,ctx,sources);
  let repair:{status:string;attempts:number;last_errors:string[]}|undefined;
  if(options.writeModule&&needsStatementRepair({failures,coverage:filingCoverage(tables,sources)})){
    const result=await repairStatements({filings,writeModule:options.writeModule});
    await saveReportArtifact(sql,ctx,'statement_repair',`${ctx.assetSlug}-statement-repair`,{artifact_type:'statement_repair',status:result.status,
      attempts:result.attempts,repaired_document_ids:result.repaired_document_ids,source_cutoff:ctx.cutoffAt.toISOString()});
    if(result.status==='repaired')tables=result.tables;
    repair={status:result.status,attempts:result.attempts.length,last_errors:result.attempts.at(-1)?.errors||[]};
  }
  const headcount=await captureHeadcount(sql,ctx,filings,tables);
  const allTables=[...tables,...releases.tables];
  const observations=[...statementObservations(allTables),...headcount.observations].map(o=>HistoricalObservation.parse(o));
  // A release can omit a line the filed balance sheet has (a small mezzanine balance), so its balance checks are
  // reported as unconfirmed, never as a filed-statement mismatch.
  const reconciliation=[...reconcileFiledBalances(tables),...reconcileFiledBalances(releases.tables).map(r=>r.status==='mismatch'?{...r,status:'unconfirmed' as const,note:'Earnings release table, not a filed statement'}:r)];
  const foreign=sources.some(s=>/^(20|40)-F/.test(String(s.metadata_json.form)))||releases.documents.length>0;
  // Ordinary shares per ADS: the newest release that states it, else the annual report's cover.
  const annualFiling=filings.find(f=>/^(20|40)-F/.test(String(f.source.metadata_json.form)));
  const annualRatio=!releases.depositary&&annualFiling?depositaryRatioFromText(annualFiling.html):null;
  const depositary=releases.depositary??(annualRatio&&annualFiling?{value:annualRatio,source_document_id:annualFiling.source.id,source_url:annualFiling.source.url}:null);
  const content={artifact_type:'financial_statement_set',tables:allTables,observations,headcount_unplaced:headcount.unplaced,
    coverage:[...filingCoverage(tables,sources),...releases.coverage],reconciliation,failures,source_cutoff:ctx.cutoffAt.toISOString(),
    capture_method:releases.tables.length?'filing-inline-xbrl-v2+release-tables-v1':'filing-inline-xbrl-v2',
    ...(foreign?{quarter_coverage:quarterCoverage(observations),depositary_ratio:depositary}:{}),...(repair?{repair}:{})};
  if(sources.length||releases.documents.length)await saveReportArtifact(sql,ctx,'financial_statement_set',`${ctx.assetSlug}-financial-statements`,content);
  return content;
}

/** Standalone quarters with consolidated revenue: the count foreign-issuer completeness is judged on. */
export function quarterCoverage(observations:Record<string,any>[]) {
  const quarters=[...new Set(observations.filter(o=>o.periodicity==='quarterly'&&!o.segment&&o.metadata_json?.metric_category==='income_statement'
    &&['revenue','net_revenue','contract_revenue'].includes(o.metric_key)).map(o=>String(o.period_end)))].sort();
  return {quarters:quarters.length,first:quarters[0]??null,last:quarters.at(-1)??null,minimum:MIN_FOREIGN_QUARTERS};
}
export const MIN_FOREIGN_QUARTERS=12;

/**
 * Statement tables from the run's stored 6-K results releases (Ex-99.1), read with the bounded release parser. The
 * fiscal year end comes from the issuer's annual report period; the reporting currency from each table's first column.
 */
async function captureReleaseStatements(sql:Sql,ctx:Pick<ResearchRunContext,'runId'|'cutoffAt'>,annual:FilingSource[]) {
  const rows=await sql`SELECT d.id,d.url,d.published_at,d.period_end::text AS period_end,d.storage_path,d.metadata_json FROM source_documents d JOIN research_run_sources r ON r.source_document_id=d.id WHERE r.research_run_id=${ctx.runId} AND d.metadata_json->>'form'='6-K' AND d.metadata_json->>'semanticRole'='earnings_release' AND d.metadata_json->>'attachmentType'='earnings_exhibit' AND d.published_at<=${ctx.cutoffAt.toISOString()} ORDER BY d.published_at DESC`;
  const annualEnd=annual.find(s=>/^(20|40)-F/.test(String(s.metadata_json.form))&&s.period_end)?.period_end;
  const yearEndMonth=annualEnd?Number(annualEnd.slice(5,7)):12;
  const root=resolve(process.cwd(),'storage','sources');
  const tables:FilingTable[]=[];const coverage:Record<string,unknown>[]=[];const documents:string[]=[];
  let depositary:{value:number;source_document_id:string;source_url:string}|null=null;
  for(const r of rows){
    const source={...r,id:String(r.id),url:String(r.url??''),published_at:new Date(r.published_at).toISOString(),period_end:String(r.period_end??''),metadata_json:r.metadata_json} as FilingSource;
    try{const path=resolve(process.cwd(),String(r.storage_path));if(!path.startsWith(root+sep))continue;
      const html=await readFile(path,'utf8');
      const found=extractReleaseStatements(html,source,{yearEndMonth});
      tables.push(...found);documents.push(source.id);
      if(!depositary){const ratio=depositaryRatioFromText(html);if(ratio)depositary={value:ratio,source_document_id:source.id,source_url:source.url};}
      const missing=['income','balance','cashflow'].filter(s=>!found.some(t=>t.statement===s));
      // A release need not carry every statement; it counts toward quarter coverage, not statement completeness.
      coverage.push({source_document_id:source.id,form:'6-K',period_end:found[0]?.period_end??null,missing,table_count:found.length,unresolved_facts:0,status:'release'});
    }catch{/* an unreadable release is skipped; quarter coverage shows the gap */}
  }
  return {tables,coverage,documents,depositary};
}

/**
 * Total headcount from the run's periodic filings and 8-Ks (earnings releases), placed on the
 * fiscal calendar of the captured statements. Unreadable 8-Ks are skipped: headcount is optional.
 * No model fallback yet; see the TODO in ./headcount.
 */
async function captureHeadcount(sql:Sql,ctx:Pick<ResearchRunContext,'runId'|'cutoffAt'>,periodic:RepairFiling[],tables:FilingTable[]) {
  const rows=await sql`SELECT d.id,d.url,d.published_at,d.storage_path,d.metadata_json->>'form' AS form FROM source_documents d JOIN research_run_sources r ON r.source_document_id=d.id WHERE r.research_run_id=${ctx.runId} AND d.metadata_json->>'form' IN ('8-K','8-K/A') AND d.published_at<=${ctx.cutoffAt.toISOString()} ORDER BY d.published_at DESC`;
  const root=resolve(process.cwd(),'storage','sources');
  const documents:{source:HeadcountSource;html:string}[]=periodic.map(f=>({source:{id:f.source.id,url:f.source.url,published_at:f.source.published_at,form:f.source.metadata_json.form||''},html:f.html}));
  for(const r of rows){try{const path=resolve(process.cwd(),String(r.storage_path));if(!path.startsWith(root+sep))continue;documents.push({source:{id:String(r.id),url:String(r.url??''),published_at:new Date(r.published_at).toISOString(),form:String(r.form)},html:await readFile(path,'utf8')});}catch{/* skip unreadable release */}}
  const periods=new Map<string,FiscalPeriod>();
  for(const t of tables)for(const row of t.rows)for(const cell of row.cells)for(const f of cell.facts)
    if(f.end&&f.fiscal_year!==null&&f.fiscal_quarter!==null&&!periods.has(f.end))periods.set(f.end,{end:f.end,fiscal_year:f.fiscal_year,fiscal_quarter:f.fiscal_quarter});
  return headcountObservations(documents.map(d=>({source:d.source,findings:extractHeadcount(filingPlainText(d.html))})),[...periods.values()]);
}
