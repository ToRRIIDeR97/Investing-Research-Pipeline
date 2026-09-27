import test from 'node:test';
import assert from 'node:assert/strict';
import { createReport } from '../../../src/lib/research/reporting/report';

export const artifact = { id:'history', artifact_type:'historical_record', scope_key:'company', artifact_version:1,
  content_json:{ observations:[2024,2025].map((year,i)=>({metric_key:'deposits', fiscal_year:year, fiscal_quarter:4, value_numeric:i?2500000:0, unit:'USD', currency:'USD', reporting_basis:'gaap', periodicity:'quarterly'})) } };
export const chart = {kind:'history',title:'Deposit funding',caption:'Selected observations',artifact_id:'history',path:'observations',metric_key:'deposits',unit:'USD',currency:'USD',reporting_basis:'gaap',periodicity:'quarterly'};
export function input(visuals?: unknown[]) { return {asset_name:'Test bank',cutoff:'2026-01-01',is_test:true,required_coverage:['business'],artifacts:[artifact],evidence:[],questions:[],coverage:[{key:'business',status:'qualified',rationale:'Limited history',section_ids:['business']}],sections:[{id:'business',title:'Business',purpose:'Explain funding',coverage:['business'],artifact_ids:['history'],paragraphs:[{kind:'analysis',text:'Deposits support lending.',evidence_ids:[],artifact_ids:['history']}],counterevidence:'Deposits can leave.',implication:'Test funding costs.',gaps:[],tables:[],...(visuals?{visuals}:{})}]} as any; }
test('AC-3: valid stored-data visual survives report construction',()=>{
  const doc=createReport(input([chart])); assert.equal((doc.sections[0] as any).visuals?.[0].metric_key,'deposits');
});
test('AC-3: unknown visual artifact is rejected',()=>assert.throws(()=>createReport(input([{...chart,artifact_id:'missing'}])),/artifact/i));
test('AC-4: changing a visual invalidates the approval hash; old reports stay compatible',()=>{
  const old=createReport(input()); assert.equal(old.sections.length,1);
  const first=createReport(input([chart])); const changed=createReport(input([{...chart,title:'Changed interpretation'}]));
  assert.notEqual(first.content_hash,changed.content_hash);
});
