import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { historySeries } from '../../../src/lib/research/reporting/visuals';
import { sectionVisuals, TRIAL_REPORT_HASH } from '../../../src/lib/research/reporting/visual-trial';
import { historyMatrix,readerValue,pricePath,label } from '../../../src/lib/research/reporting/presentation.mjs';

test('AC-2: readable financial data preserve missing versus zero, precision and labels',()=>{
  const rows=[{metric_key:'loan_loss_reserve',unit:'USD',currency:'USD',reporting_basis:'gaap',fiscal_year:2026,fiscal_quarter:1,value_numeric:0},{metric_key:'loan_loss_reserve',unit:'USD',currency:'USD',reporting_basis:'gaap',fiscal_year:2026,fiscal_quarter:2,value_numeric:56459000},{metric_key:'deposits',unit:'USD',currency:'USD',fiscal_year:2026,fiscal_quarter:3,value_numeric:1}];
  const matrix=historyMatrix(rows);const reserve=matrix.rows.find(r=>r.name==='Loan loss reserve')!;
  assert.deepEqual(reserve.values,['0','56.459','Not disclosed']);assert.equal(reserve.exact[1],'56,459,000 USD');
  assert.deepEqual(readerValue({confidence:.3,artifact_id:'private-id',loan_loss_reserve:0,nested:{metric_key:'net_interest_income'}}),{'Loan loss reserve':'0',Nested:{Measure:'Net interest income'}});
  assert.equal(label('loan_loss_reserve'),'Loan loss reserve');
  assert.equal(pricePath([{fiscal_year:2027,scenario_type:'bear',price_target:0}]).rows[0][1],'$0.00');
});
test('AC-5: the actual saved SoFi trial resolves sources and stored values; unrelated reports get no trial',()=>{
  const saved=JSON.parse(readFileSync('public/report-layouts/report-data.json','utf8'));
  const byId=new Map<string,any>();
  for(const [key,value] of Object.entries(saved.data)){
    const [id,path]=key.split(':');let artifact=byId.get(id);
    if(!artifact){artifact={id,artifact_type:'saved_artifact',content_json:{}};byId.set(id,artifact);}
    if(!path){artifact.content_json=value;continue;}
    const parts=path.split('.');let dest=artifact.content_json;
    for(const part of parts.slice(0,-1))dest=dest[part]??={};dest[parts.at(-1)!]=value;
  }
  const doc={...saved,artifacts:[...byId.values()]};const before=JSON.stringify(doc);
  assert.equal(doc.content_hash,TRIAL_REPORT_HASH);
  const flow=sectionVisuals(doc,'business_processes_customer_decisions');assert.equal(flow.length,1);assert.equal(flow[0].kind,'process');
  if(flow[0].kind==='process'){assert.equal(flow[0].lanes.length,3);assert.ok(flow[0].lanes.every(l=>l.evidence_ids.length));}
  const chart=sectionVisuals(doc,'funding_liquidity_capital_constraints')[0];assert.equal(chart.kind,'history');
  if(chart.kind==='history'){const series=historySeries(chart,doc.artifacts);assert.ok(series.points.length>4);assert.equal(series.points.at(-1)?.value,45543.16);assert.equal(series.points.at(-1)?.exact,'45,543,160,000 USD');}
  assert.equal(sectionVisuals({...doc,content_hash:'another-report'},'business_processes_customer_decisions').length,0);
  assert.equal(JSON.stringify(doc),before);
});
test('AC-3: mixed segments fail, missing observations stay missing, future observations fail',()=>{
  const chart:any={kind:'history',title:'Revenue',caption:'',artifact_id:'a',path:'observations',metric_key:'revenue',unit:'EUR',currency:'EUR',reporting_basis:'gaap',periodicity:'quarterly'};
  const row={metric_key:'revenue',unit:'EUR',currency:'EUR',reporting_basis:'gaap',periodicity:'quarterly',fiscal_year:2025,fiscal_quarter:1,value_numeric:0};
  const artifacts:any=[{id:'a',content_json:{observations:[row,{...row,fiscal_quarter:2,value_numeric:null},{...row,fiscal_quarter:3,value_numeric:5000000}]}}];
  assert.deepEqual(historySeries(chart,artifacts).points.map(p=>p.value),[0,null,5]);
  artifacts[0].content_json.observations[2].segment='another';assert.throws(()=>historySeries(chart,artifacts),/segments/i);
  delete artifacts[0].content_json.observations[2].segment;artifacts[0].content_json.observations[2].available_at='2027-01-01';assert.throws(()=>historySeries(chart,artifacts,'2026-01-01'),/cutoff/i);
});
