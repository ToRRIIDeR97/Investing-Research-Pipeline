import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import type {Sql,ResearchRunContext} from '../run-context';
import {saveReportArtifact} from '../reporting/store';
import {extractFilingStatements,filingCoverage,statementObservations,reconcileFiledBalances,type FilingSource,type FilingTable} from './filing-statements';
import {HistoricalObservation} from './contracts';
import {needsStatementRepair,repairStatements,type ModuleWriter,type RepairFiling} from '../repair/statement-repair';

/**
 * Capture primary statements from the run's stored filings. With a module writer, filings the
 * deterministic parser cannot complete go to the repair specialist; its attempts are saved.
 */
export async function captureFilingStatements(sql:Sql,ctx:Pick<ResearchRunContext,'runId'|'assetId'|'assetSlug'|'cutoffAt'>,options:{writeModule?:ModuleWriter}={}) {
  const rows=await sql`SELECT d.id,d.url,d.published_at,d.period_end::text AS period_end,d.storage_path,d.metadata_json FROM source_documents d JOIN research_run_sources r ON r.source_document_id=d.id WHERE r.research_run_id=${ctx.runId} AND d.metadata_json->>'form' IN ('10-Q','10-K','10-Q/A','10-K/A') AND d.published_at<=${ctx.cutoffAt.toISOString()} ORDER BY d.published_at DESC`;
  const sources=rows.map(r=>({...r,published_at:new Date(r.published_at).toISOString(),period_end:String(r.period_end??'')})) as unknown as (FilingSource&{storage_path:string})[];
  const filings:RepairFiling[]=[];const failures:string[]=[];
  const root=resolve(process.cwd(),'storage','sources');
  for(const source of sources){try{const path=resolve(process.cwd(),source.storage_path);if(!path.startsWith(root+sep))throw new Error('Source path outside stored corpus');filings.push({source,html:await readFile(path,'utf8')});}catch{failures.push(source.id);}}
  let tables:FilingTable[]=filings.flatMap(f=>extractFilingStatements(f.html,f.source));
  let repair:{status:string;attempts:number;last_errors:string[]}|undefined;
  if(options.writeModule&&needsStatementRepair({failures,coverage:filingCoverage(tables,sources)})){
    const result=await repairStatements({filings,writeModule:options.writeModule});
    await saveReportArtifact(sql,ctx,'statement_repair',`${ctx.assetSlug}-statement-repair`,{artifact_type:'statement_repair',status:result.status,
      attempts:result.attempts,repaired_document_ids:result.repaired_document_ids,source_cutoff:ctx.cutoffAt.toISOString()});
    if(result.status==='repaired')tables=result.tables;
    repair={status:result.status,attempts:result.attempts.length,last_errors:result.attempts.at(-1)?.errors||[]};
  }
  const content={artifact_type:'financial_statement_set',tables,observations:statementObservations(tables).map(o=>HistoricalObservation.parse(o)),coverage:filingCoverage(tables,sources),reconciliation:reconcileFiledBalances(tables),failures,source_cutoff:ctx.cutoffAt.toISOString(),capture_method:'filing-inline-xbrl-v2',...(repair?{repair}:{})};
  if(sources.length)await saveReportArtifact(sql,ctx,'financial_statement_set',`${ctx.assetSlug}-financial-statements`,content);
  return content;
}
