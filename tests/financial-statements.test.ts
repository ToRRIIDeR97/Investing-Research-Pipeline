import test from 'node:test';
import assert from 'node:assert/strict';
import { financialStatements, financialWindow, financialSeries, historyMatrix } from '../src/lib/research/reporting/presentation.mjs';

const row = (quarter:number,value:number|null=quarter) => ({metric_key:'net_revenue',periodicity:'quarterly',fiscal_year:2026,fiscal_quarter:quarter,value_numeric:value,unit:'USD',currency:'USD',reporting_basis:'gaap'});

test('Financial windows share chronology, recover from bad endpoints and never include TTM',()=>{
  const rows=[...Array.from({length:4},(_,i)=>({...row(i+1),fiscal_year:2025})),row(1),row(2),{...row(3),periodicity:'ttm'}];
  const latest=financialWindow(rows);
  assert.deepEqual(latest.periods,['2025-Q2','2025-Q3','2025-Q4','2026-Q1','2026-Q2']);
  assert.deepEqual(financialWindow(rows,'quarterly','bad'),latest);
  assert.equal(latest.earlier,'2025-Q1');
  assert.deepEqual(financialWindow(rows,'quarterly',latest.earlier!).periods,['2025-Q1']);
  assert.equal(financialWindow(rows,'quarterly','2025-Q1').later,'2026-Q2');
  assert.deepEqual(financialWindow(rows,'annual').periods,[]);
});

test('Financial charts preserve negative values, zero and missing periods and reject ambiguity',()=>{
  const periods=['2026-Q1','2026-Q2','2026-Q3','2026-Q4'];
  const rows=[row(1,0),row(3,-4000000),row(4,null)];
  const series=financialSeries(rows,'net_revenue',periods);
  assert.equal(series.reason,'');
  assert.deepEqual(series.points.map(p=>p.value),[0,null,-4,null]);
  assert.match(financialSeries([...rows,row(1)],'net_revenue',periods).reason,/Multiple observations/);
  assert.match(financialSeries([...rows,{...row(2),currency:'EUR',unit:'EUR'}],'net_revenue',periods).reason,/Multiple reporting/);
  assert.match(financialSeries(rows.map(r=>({...r,segment:'consumer'})),'net_revenue',periods).reason,/No consolidated/);
  assert.match(financialSeries([row(1)],'net_revenue',periods).reason,/At least two/);
});

test('Table provenance retains duplicate observations in order for source dialogs',()=>{
  const rows=[{...row(1),source_document_id:'a'}, {...row(1,8),source_document_id:'b'}];
  const matrix=historyMatrix(rows);
  assert.deepEqual(matrix.rows[0].observations[0],rows);
  assert.equal(matrix.rows[0].metric_key,'net_revenue');
});

test('Annual rows use year headings even when a source retains its fiscal quarter',()=>{
  const rows=[{...row(4,1000000),periodicity:'annual'}];
  assert.deepEqual(financialWindow(rows,'annual').periods,['2026']);
  assert.deepEqual(historyMatrix(rows).periods,['2026']);
  assert.equal(historyMatrix(rows).rows[0].values[0],'1');
  const unknown={...row(1),metric_key:'custom',metadata_json:{metric_category:'constructor'}};
  assert.deepEqual(financialStatements([unknown]).other,[unknown]);
});
