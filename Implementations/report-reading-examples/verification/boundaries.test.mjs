import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
async function api(){assert.ok(existsSync('public/report-layouts/presentation.mjs'),'AC-1: presentation module exists');return import('../../../public/report-layouts/presentation.mjs');}
test('AC-2: duplicate and incompatible observations cannot be silently lost',async()=>{
 const p=await api();const base={metric_key:'credit_losses',fiscal_year:2024,fiscal_quarter:4,unit:'USD',currency:'USD'};
 const h=p.historyMatrix([{...base,value_numeric:-3500000},{...base,value_numeric:1000000},{...base,fiscal_quarter:3,value_numeric:null},{...base,unit:'percent',currency:null,value_numeric:2.5}]);
 assert.equal(h.rows.length,2);assert.deepEqual(h.rows[0].values,['Not disclosed','−3.5 / 1']);assert.equal(h.observationCount,4);
 assert.ok(h.rows.some(r=>r.unit==='Percent'&&r.values.includes('2.5')));
});
test('AC-1/5: nesting remains readable, false differs from missing, and links are safe',async()=>{
 const p=await api();assert.deepEqual(p.readerValue({balance_sheet:{source_id:'opaque',dilution_omitted:false,per_share_value:null},evidence_claim_ids:['secret-reference']}),{'Balance sheet':{'Dilution omitted':'No','Per share value':'Not disclosed'}});
 assert.equal(p.safeUrl('javascript:alert(1)'),null);assert.equal(p.safeUrl('https://example.com/filing'),'https://example.com/filing');
 assert.equal(p.readerText('loan_loss_reserve and source 69a19ea1-4437-4437-8437-9be59b84cf34'),'Loan loss reserve and source [reference]');
});
