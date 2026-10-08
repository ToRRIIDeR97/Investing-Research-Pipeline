import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractFilingStatements,statementObservations,filingCoverage} from '../src/lib/research/history/filing-statements';
import {buildHistoricalRecord} from '../src/lib/research/history/normalizer';
import {HistoricalObservation} from '../src/lib/research/history/contracts';
import {recentByMetric} from '../src/lib/research/handlers/operating-model';

const id='00000000-0000-4000-8000-000000000001';
const source={id,url:'https://www.sec.gov/example',published_at:'2026-01-29',period_end:'2025-12-31',metadata_json:{form:'10-K'}};
const member=(dimension:string,value:string)=>`<xbrldi:explicitMember dimension="${dimension}">${value}</xbrldi:explicitMember>`;
const context=(key:string,members='')=>`<xbrli:context id="${key}"><xbrli:entity>${members?`<xbrli:segment>${members}</xbrli:segment>`:''}</xbrli:entity><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context>`;
const fact=(ctx:string,name:string,value:string)=>`<ix:nonFraction id="${ctx}-${name}" name="${name}" contextRef="${ctx}" unitRef="usd" scale="6" format="ixt:num-dot-decimal">${value}</ix:nonFraction>`;
const SEG='us-gaap:StatementBusinessSegmentsAxis';
const html=`<ix:nonNumeric name="dei:DocumentFiscalYearFocus">2025</ix:nonNumeric><ix:nonNumeric name="dei:DocumentFiscalPeriodFocus">FY</ix:nonNumeric><ix:nonNumeric name="dei:DocumentPeriodEndDate">2025-12-31</ix:nonNumeric><xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
${context('y')}${context('foa',member(SEG,'meta:FamilyOfAppsMember'))}${context('rl',member(SEG,'meta:RealityLabsMember'))}${context('foa-ads',member('srt:ProductOrServiceAxis','us-gaap:AdvertisingMember')+member(SEG,'meta:FamilyOfAppsMember'))}
<h2>Consolidated Statements of Income</h2><table><tr><td>Revenue</td><td>${fact('y','us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax','200,966')}</td></tr><tr><td>Income from operations</td><td>${fact('y','us-gaap:OperatingIncomeLoss','83,276')}</td></tr></table>
<p>Note 16. Segment and Geographical Information</p><table>
<tr><td>Advertising</td><td>${fact('foa-ads','us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax','196,175')}</td></tr>
<tr><td>Family of Apps revenue</td><td>${fact('foa','us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax','198,759')}</td></tr>
<tr><td>Family of Apps goodwill</td><td>${fact('foa','us-gaap:Goodwill','23,028')}</td></tr>
<tr><td>Family of Apps income from operations</td><td>${fact('foa','us-gaap:OperatingIncomeLoss','102,469')}</td></tr>
<tr><td>Reality Labs revenue</td><td>${fact('rl','us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax','2,207')}</td></tr>
<tr><td>Reality Labs loss from operations</td><td>${fact('rl','us-gaap:OperatingIncomeLoss','(19,193)')}</td></tr>
<tr><td>Unparsed</td><td><ix:nonFraction name="us-gaap:Revenues" contextRef="missing" unitRef="usd">x</ix:nonFraction></td></tr></table>`;

test('segment note revenue and operating income become segment observations without affecting statement coverage',()=>{
 const tables=extractFilingStatements(html,source);
 assert.deepEqual(tables.map(t=>t.statement),['income','segment']);
 assert.deepEqual(filingCoverage(tables,[source])[0].missing,['balance','cashflow']);
 assert.equal(filingCoverage(tables,[source])[0].unresolved_facts,0);
 const observations=statementObservations(tables).map(o=>HistoricalObservation.parse(o));
 const segment=(metric:string,name:string)=>observations.find(o=>o.metric_key===metric&&o.segment===name&&o.periodicity==='annual')?.value_numeric;
 assert.equal(segment('revenue','meta:FamilyOfAppsMember'),198_759_000_000);
 assert.equal(segment('revenue','meta:RealityLabsMember'),2_207_000_000);
 assert.equal(segment('us_gaap_OperatingIncomeLoss','meta:RealityLabsMember'),-19_193_000_000);
 // Multi-axis (segment x product) and non-income segment facts are not segment totals.
 assert.ok(!observations.some(o=>/AdvertisingMember/.test(o.segment||'')||o.metric_key==='us_gaap_Goodwill'));
 assert.ok(observations.filter(o=>o.segment).every(o=>o.metadata_json.statement==='segment'&&o.metadata_json.metric_category==='income_statement'));
 assert.equal(observations.find(o=>o.metric_key==='revenue'&&!o.segment)?.value_numeric,200_966_000_000);
});

test('consolidated TTM ignores segment rows and the operating model gets segment history by member',()=>{
 const row=(quarter:number,value:number,segment:string|null=null)=>HistoricalObservation.parse({metric_key:'revenue',value_numeric:value,fiscal_year:2025,fiscal_quarter:quarter,periodicity:'quarterly',unit:'USD',currency:'USD',reporting_basis:'gaap',metric_type:'reported',segment,metadata_json:segment?{statement:'segment'}:{}});
 const observations=[1,2,3,4].flatMap(q=>[row(q,100),row(q,90,'meta:FamilyOfAppsMember'),row(q,10,'meta:RealityLabsMember')]);
 const record=buildHistoricalRecord({asset_id:id,observations,requiredMetricKeys:['revenue'],endFiscalYear:2025,endFiscalQuarter:4});
 assert.deepEqual(record.ttm_series.map(o=>o.value_numeric),[400]);
 const history=recentByMetric(observations.filter(o=>o.segment==='meta:RealityLabsMember'),8);
 assert.deepEqual(history.revenue.map(r=>[r.period,r.value]),[['2025Q1',10],['2025Q2',10],['2025Q3',10],['2025Q4',10]]);
 const annual={...row(4,40,'meta:RealityLabsMember'),periodicity:'annual',fiscal_quarter:null};
 assert.equal(recentByMetric([annual,row(4,10)],8).revenue.at(-1)?.period,'FY2025');
});
