import postgres from 'postgres';
import {captureFilingStatements} from '../src/lib/research/history/filing-store';

async function main(){
  const runId=process.argv[2];
  if(!runId||!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(runId))throw new Error('Usage: tsx scripts/capture-filing-statements.ts RUN_ID');
  const sql=postgres(process.env.DATABASE_URL!);
  try{
    const [run]=await sql`SELECT r.asset_id,r.status,r.source_cutoff_at,a.slug FROM research_runs r JOIN assets a ON a.id=r.asset_id WHERE r.id=${runId}`;
    if(!run)throw new Error('Run not found');
    const report=async()=>{const [r]=await sql`SELECT content_json->>'content_hash' AS hash FROM research_artifacts WHERE research_run_id=${runId} AND artifact_type='report_document' ORDER BY artifact_version DESC LIMIT 1`;return r?.hash;};
    const before=await report();
    const captured=await captureFilingStatements(sql,{runId,assetId:run.asset_id,assetSlug:run.slug,cutoffAt:new Date(run.source_cutoff_at)});
    const [after]=await sql`SELECT status FROM research_runs WHERE id=${runId}`;
    if(before!==await report()||run.status!==after.status)throw new Error('Unexpected report or workflow change');
    console.log(JSON.stringify({filings:captured.coverage.length,tables:captured.tables.length,quarterly:captured.observations.filter(o=>o.periodicity==='quarterly').length,annual:captured.observations.filter(o=>o.periodicity==='annual').length,incomplete:captured.coverage.filter(c=>c.status==='incomplete'),balanceChecks:captured.reconciliation.length,mismatches:captured.reconciliation.filter(c=>c.status!=='passed'),failures:captured.failures,reportAndWorkflowUnchanged:true},null,2));
  }finally{await sql.end();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
