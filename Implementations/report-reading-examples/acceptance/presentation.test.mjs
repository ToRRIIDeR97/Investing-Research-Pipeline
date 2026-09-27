import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
async function api(){assert.ok(existsSync('public/report-layouts/presentation.mjs'),'AC-1: presentation module exists');return import('../../../public/report-layouts/presentation.mjs');}
test('AC-1: financial names and record values are written for readers',async()=>{
 const p=await api();assert.equal(p.label('loan_loss_reserve'),'Loan loss reserve');
 assert.equal(p.label('net_interest_income'),'Net interest income');assert.equal(p.label('gaap'),'GAAP');
 const result=p.readerValue({artifact_type:'record',source_document_id:'69a19ea1-4437-4437-8437-9be59b84cf34',metadata_json:{private:true},loan_loss_reserve:0,reason:'net_interest_income increased',assumptions:['deposit_funding','credit_losses']});
 assert.deepEqual(Object.keys(result),['Loan loss reserve','Reason','Assumptions']);
 assert.equal(result['Loan loss reserve'],'0');assert.equal(result.Reason,'Net interest income increased');
 assert.deepEqual(result.Assumptions,['Deposit funding','Credit losses']);
});
test('AC-2: history has readable series, all periods, explicit units and actual zero',async()=>{
 const p=await api();const rows=[{metric_key:'loan_loss_reserve',fiscal_year:2025,fiscal_quarter:1,value_numeric:12345678,unit:'USD',currency:'USD'}, {metric_key:'loan_loss_reserve',fiscal_year:2025,fiscal_quarter:2,value_numeric:0,unit:'USD',currency:'USD'}];
 const h=p.historyMatrix(rows);assert.deepEqual(h.periods,['Q1 2025','Q2 2025']);assert.equal(h.rows[0].name,'Loan loss reserve');assert.equal(h.rows[0].unit,'USD millions');assert.deepEqual(h.rows[0].values,['12.346','0']);assert.equal(h.observationCount,2);
});
