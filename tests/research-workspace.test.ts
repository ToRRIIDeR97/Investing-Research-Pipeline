import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractFilingStatements,statementObservations,filingCoverage} from '../src/lib/research/history/filing-statements';
import {financialRatios,researchObservations,readerSections} from '../src/lib/research/reporting/data-views';
import {calculateValuationSchedule,validateMethodInputs,ValuationMethodInput} from '../src/lib/research/valuation/schedules';
import {buildHistoricalRecord} from '../src/lib/research/history/normalizer';
import {reconcileAnnualToQuarters} from '../src/lib/research/history/reconciliation';
import {HistoricalObservation} from '../src/lib/research/history/contracts';
import {validateVisual} from '../src/lib/research/reporting/visuals';

const id='00000000-0000-4000-8000-000000000001';
const source={id,url:'https://www.sec.gov/example',published_at:'2025-02-01',period_end:'2024-12-31',metadata_json:{form:'10-K'}};
const context=(key:string,start:string,end:string)=>`<xbrli:context id="${key}"><xbrli:period>${start?`<xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate>`:`<xbrli:instant>${end}</xbrli:instant>`}</xbrli:period></xbrli:context>`;
const fact=(ctx:string,name:string,value:string)=>`<ix:nonFraction id="${ctx}-${name}" name="${name}" contextRef="${ctx}" unitRef="usd" scale="3" format="ixt:numdotdecimal">${value}</ix:nonFraction>`;
test('filing capture keeps custom rows, annual values, nil cells and derives Q4 only for additive facts',()=>{
 const html=`<ix:nonNumeric name="dei:DocumentFiscalYearFocus">2024</ix:nonNumeric><ix:nonNumeric name="dei:DocumentFiscalPeriodFocus">FY</ix:nonNumeric><ix:nonNumeric name="dei:DocumentPeriodEndDate">2024-12-31</ix:nonNumeric><xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>${context('y','2024-01-01','2024-12-31')}${context('q3','2024-01-01','2024-09-30')}<h2>Consolidated Statements of Cash Flows</h2><table><tr><td>Custom line</td><td>${fact('y','issuer:CustomFunding','1,000')}</td><td>${fact('q3','issuer:CustomFunding','700')}</td></tr><tr><td>Missing</td><td><ix:nonFraction name="issuer:Missing" contextRef="y" unitRef="usd" xsi:nil="true"></ix:nonFraction></td></tr></table>`;
 const tables=extractFilingStatements(html,source),rows=statementObservations(tables);
 assert.equal(tables.length,1);assert.equal(tables[0].rows.length,2);
 assert.equal(rows.find(r=>r.metric_key==='issuer_CustomFunding'&&r.periodicity==='annual')?.value_numeric,1_000_000);
 const q4=rows.find(r=>r.metric_key==='issuer_CustomFunding'&&r.periodicity==='quarterly');
 assert.equal(q4?.value_numeric,300_000);assert.equal(q4?.period_start,'2024-10-01');assert.equal(q4?.fiscal_quarter,4);assert.ok(q4?.metadata_json.prior_source_document_id);
 assert.equal(rows.find(r=>r.metric_key==='issuer_Missing')?.value_numeric,null);
 assert.deepEqual(filingCoverage(tables,[source])[0].missing,['income','balance']);
});
const row=(metric_key:string,value_numeric:number,quarter=1,year=2025)=>({metric_key,value_numeric,fiscal_year:year,fiscal_quarter:quarter,periodicity:'quarterly',unit:'USD',currency:'USD',reporting_basis:'gaap',metric_type:'reported',metadata_json:{},segment:null,geography:null});
test('cash snapshots inside a cash-flow statement are not summed as cash flows',()=>{
 const ends=['2024-03-31','2024-06-30','2024-09-30','2024-12-31'];
 const html=`<ix:nonNumeric name="dei:DocumentFiscalYearFocus">2024</ix:nonNumeric><ix:nonNumeric name="dei:DocumentFiscalPeriodFocus">FY</ix:nonNumeric><ix:nonNumeric name="dei:DocumentPeriodEndDate">2024-12-31</ix:nonNumeric><xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>${ends.map((end,i)=>context(`q${i+1}`,'',end)).join('')}<h2>Consolidated Statements of Cash Flows</h2><table><tr><td>Cash at period end</td>${ends.map((_,i)=>`<td>${fact(`q${i+1}`,'us-gaap:CashAndCashEquivalentsAtCarryingValue',String(100+i))}</td>`).join('')}</tr></table>`;
 const observations=statementObservations(extractFilingStatements(html,source)).map(o=>HistoricalObservation.parse(o));
 assert.equal(observations.length,5);
 assert.ok(observations.every(o=>o.metadata_json.metric_category==='balance_sheet'));
 const record=buildHistoricalRecord({asset_id:id,observations,requiredMetricKeys:['us_gaap_CashAndCashEquivalentsAtCarryingValue'],endFiscalYear:2024,endFiscalQuarter:4});
 assert.equal(record.ttm_series.length,0);
 assert.deepEqual(reconcileAnnualToQuarters(observations),[]);
});
test('non-calendar filing dates retain fiscal periods and later filings retain revision provenance',()=>{
 const html=(amount:string)=>`<ix:nonNumeric name="dei:DocumentFiscalYearFocus">2024</ix:nonNumeric><ix:nonNumeric name="dei:DocumentFiscalPeriodFocus">FY</ix:nonNumeric><ix:nonNumeric name="dei:DocumentPeriodEndDate">September 28, 2024</ix:nonNumeric><xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>${context('end','','2024-09-28')}<h2>Consolidated Statements of Financial Position</h2><table><tr><td>Total assets</td><td>${fact('end','us-gaap:Assets',amount)}</td></tr></table>`;
 const original=extractFilingStatements(html('1,000'),{...source,published_at:'2024-11-01'});
 const amended=extractFilingStatements(html('1,100'),{...source,id:'00000000-0000-4000-8000-000000000002',published_at:'2025-01-01'});
 assert.equal(original[0].period_end,'2024-09-28');assert.equal(original[0].statement,'balance');
 const values=statementObservations([...original,...amended]);
 assert.equal(values.length,2);assert.equal(values.find(v=>v.periodicity==='quarterly')?.fiscal_quarter,4);
 assert.equal(values[0].fiscal_year,2024);assert.equal(values[0].value_numeric,1_100_000);assert.equal(values[0].restatement_version,1);
 assert.equal(values[0].source_document_id,amended[0].source_document_id);
});
test('ratios align units, use average equity and never turn missing inputs into zero',()=>{
 const rows=[row('net_revenue',100),row('net_income',10),row('stockholders_equity',120),row('stockholders_equity',80,4,2024)];
 const ratios=financialRatios(rows,'quarterly');
 assert.equal(ratios.find(r=>r.metric_key==='net_income_margin')?.value_numeric,10);
 assert.equal(ratios.find(r=>r.metric_key==='roe')?.value_numeric,40);
 assert.equal(ratios.find(r=>r.metric_key==='gross_margin')?.value_numeric,null);
 assert.equal(financialRatios([...rows,{...row('net_income',4),unit:'EUR',currency:'EUR'}],'quarterly').find(r=>r.metric_key==='net_income_margin')?.value_numeric,null);
});
test('annual observations survive normalization, while stocks are never summed across quarters',()=>{
 const annual={...row('total_assets',100,4,2024),periodicity:'annual',fiscal_quarter:null};
 const observations=[annual,...[1,2,3,4].map(q=>row('total_assets',100,q,2024))].map(o=>HistoricalObservation.parse(o));
 const record=buildHistoricalRecord({asset_id:id,observations,requiredMetricKeys:['total_assets'],endFiscalYear:2024,endFiscalQuarter:4});
 assert.equal(record.observations.filter(o=>o.periodicity==='annual').length,1);assert.equal(record.ttm_series.length,0);assert.deepEqual(reconcileAnnualToQuarters(observations),[]);
});
test('filed observations replace matching legacy values without replacing other bases',()=>{
 const filed=row('net_income',10),legacy=row('net_income',8);
 const rows=researchObservations([{artifact_type:'financial_statement_set',content_json:{observations:[filed]}},{artifact_type:'historical_record',content_json:{observations:[legacy,{...legacy,reporting_basis:'adjusted'}]}}]);
 assert.equal(rows.length,2);assert.equal(rows[0].value_numeric,10);
});
const model:ValuationMethodInput={method:'fcfe',method_name:'Equity DCF',scenario_type:'base',rationale:'Test',currency:'USD',cash_flow_label:'FCFE',discount_rate:0.1,years:[{fiscal_year:2026,cash_flow:100},{fiscal_year:2027,cash_flow:110}],terminal:{type:'perpetuity',growth_rate:0.02},equity_bridge:0,equity_bridge_explanation:'Equity cash flows',diluted_shares:100,source_notes:['Test assumptions']};
test('valuation schedules compute discounting, terminal value and per-share value',()=>{
 const result=calculateValuationSchedule(model);
 assert.ok(Math.abs(result.terminal_value-1402.5)<1e-8);
 assert.ok(Math.abs(result.value_per_share-13.40909090909)<1e-8);
 assert.throws(()=>calculateValuationSchedule({...model,terminal:{type:'perpetuity',growth_rate:0.1}}),/below/);
 assert.throws(()=>calculateValuationSchedule({...model,equity_bridge:-100}),/net debt/);
 assert.throws(()=>validateMethodInputs([model]),/Bear, Base and Bull/);
 validateMethodInputs(['bear','base','bull'].map(s=>({...model,scenario_type:s as 'base'})));
});
test('report reader combines valuation chapters and removes standalone history and limitations',()=>{
 const sections=['business','reported_history_ttm','scenario_architecture','valuation_residual_income_nav_reverse','downside_permanent_impairment','evidence_quality_and_conventions','monitoring'].map(id=>({id,title:id,coverage:[],paragraphs:[],tables:[],gaps:[],counterevidence:'',implication:''}));
 assert.deepEqual(readerSections(sections as any).map(s=>s.id),['business','valuation','monitoring']);
});
test('organization charts reject invented IDs, cycles and sources after the cutoff',()=>{
 const visual={kind:'organization' as const,title:'Leadership',caption:'',as_of:'2025-01-01',people:[{id:'a',name:'A',role:'CEO',reports_to:null,evidence_ids:['e']}]};
 const input:any={artifacts:[],evidence:[{id:'e',quote:'A is CEO',url:'https://example.com',published_at:'2025-01-01'}],cutoff:'2025-02-01'};
 validateVisual(visual,input);
 assert.throws(()=>validateVisual({...visual,people:[{...visual.people[0],reports_to:'a'}]},input),/cyclic/);
 assert.throws(()=>validateVisual(visual,{...input,evidence:[{...input.evidence[0],published_at:'invalid'}]}),/unavailable/);
});
