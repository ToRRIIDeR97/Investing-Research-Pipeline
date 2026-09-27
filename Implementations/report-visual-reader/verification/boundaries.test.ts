import test from 'node:test';
import assert from 'node:assert/strict';
import { createReport } from '../../../src/lib/research/reporting/report';

function make(visual: unknown, rows: any[] = []) { return {asset_name:'Other business',cutoff:'2026-01-01',is_test:false,required_coverage:[],coverage:[],questions:[],evidence:[],artifacts:[{id:'a',artifact_type:'history',scope_key:'one',artifact_version:1,content_json:{observations:rows}}],sections:[{id:'s',title:'Other business',purpose:'Explain',coverage:[],artifact_ids:['a'],paragraphs:[{kind:'analysis',text:'Limited evidence.',evidence_ids:[],artifact_ids:[]}],counterevidence:'Unknown',implication:'Investigate',gaps:[],tables:[],visuals:[visual]}]} as any; }
const spec={kind:'history',title:'Observed revenue',caption:'Historical',artifact_id:'a',path:'observations',metric_key:'revenue',unit:'EUR',currency:'EUR',reporting_basis:'gaap',periodicity:'quarterly'};
const row={metric_key:'revenue',unit:'EUR',currency:'EUR',reporting_basis:'gaap',periodicity:'quarterly',fiscal_year:2025,fiscal_quarter:1,value_numeric:12};
test('AC-3: unsafe paths and model-authored chart values are rejected',()=>{
  assert.throws(()=>createReport(make({...spec,path:'constructor.prototype'})),/path/i);
  assert.throws(()=>createReport(make({...spec,values:[12,99]},[row,{...row,fiscal_quarter:2}])),/values|unrecognized/i);
});
test('AC-3: ambiguous observations and unsupported process lanes fail closed',()=>{
  assert.throws(()=>createReport(make(spec,[row,{...row,value_numeric:18}])),/ambiguous|duplicate/i);
  assert.throws(()=>createReport(make({kind:'process',title:'Assumed economics',caption:'',lanes:[{nodes:[{label:'A',icon:'people'},{label:'B',icon:'bank'}],note:'',relationship:'documented',evidence_ids:[],artifact_ids:[]}]})),/support|reference/i);
});
