import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadSubmissionFilings,selectResearchFilings} from '../src/lib/research/sources/corpus';
import {extractFilingStatements,statementObservations} from '../src/lib/research/history/filing-statements';
import {HistoricalObservation} from '../src/lib/research/history/contracts';

type Row={form:string;filingDate:string;accessionNumber:string;primaryDocument?:string};
const columns=(rows:Row[])=>({form:rows.map(r=>r.form),filingDate:rows.map(r=>r.filingDate),accessionNumber:rows.map(r=>r.accessionNumber),
  reportDate:rows.map(()=>''),primaryDocument:rows.map(r=>r.primaryDocument||'doc.htm'),primaryDocDescription:rows.map(()=>''),items:rows.map(()=>'')});
let n=0;const row=(form:string,filingDate:string):Row=>({form,filingDate,accessionNumber:`0001326801-00-${String(++n).padStart(6,'0')}`});
// Quarterly cadence: a 10-K in late January, 10-Qs in April, July and October.
const periodic=(from:number,to:number)=>Array.from({length:to-from+1},(_,i)=>to-i).flatMap(y=>[
  row('10-Q',`${y}-10-28`),row('10-Q',`${y}-07-28`),row('10-Q',`${y}-04-28`),row('10-K',`${y}-01-30`)]);
// META-like: Form 4 traffic fills `recent`, which reaches back only to mid-2024.
const recentRows=[...periodic(2025,2026).filter(r=>r.filingDate<='2026-10-07'),row('10-Q','2024-10-30'),row('10-Q','2024-08-01'),
  ...Array.from({length:30},(_,i)=>row('4',`2024-${String(12-(i%6)).padStart(2,'0')}-1${i%9}`)),row('4','2024-06-18')].sort((a,b)=>b.filingDate.localeCompare(a.filingDate));
const page001=[row('4','2024-06-16'),...periodic(2017,2024).filter(r=>r.filingDate<'2024-06-16')];
const submissions={filings:{recent:columns(recentRows),files:[
  {name:'CIK0001326801-submissions-001.json',filingCount:page001.length,filingFrom:'2017-01-30',filingTo:'2024-06-16'},
  {name:'CIK0001326801-submissions-002.json',filingCount:10,filingFrom:'2005-05-06',filingTo:'2016-12-31'},
]}};
const mockFetch=(pages:Record<string,unknown>,calls:{url:string;agent:string}[]=[])=>(async(url:string|URL|Request,init?:RequestInit)=>{
  calls.push({url:String(url),agent:String((init?.headers as Record<string,string>)?.['User-Agent']||'')});
  const name=String(url).split('/').pop()!;
  return name in pages?new Response(JSON.stringify(pages[name]),{status:200}):new Response('not found',{status:404});
}) as typeof fetch;

test('older 10-Ks and 10-Qs are selected from filings.files pages when recent does not reach the window',async()=>{
  const calls:{url:string;agent:string}[]=[];
  // Page 001 repeats the newest recent filing; the duplicate accession must not be selected twice.
  const page={...columns([recentRows.at(-1)!,...page001])};
  const rows=await loadSubmissionFilings(submissions,'2021-10-10','2026-10-10',mockFetch({'CIK0001326801-submissions-001.json':page},calls));
  // Only the page overlapping the window is fetched, with the SEC User-Agent; page 002 ends before the window.
  assert.deepEqual(calls.map(c=>c.url),['https://data.sec.gov/submissions/CIK0001326801-submissions-001.json']);
  assert.match(calls[0].agent,/^ResearchOS\/\S+ \S+@\S+$/);
  assert.equal(new Set(rows.map(r=>r.accessionNumber)).size,rows.length);
  const selected=selectResearchFilings(rows,'2021-10-10','2026-10-10');
  const annual=selected.filter(f=>f.form==='10-K').map(f=>f.filingDate);
  assert.deepEqual(annual,['2026-01-30','2025-01-30','2024-01-30','2023-01-30','2022-01-30']);
  // Every 10-Q inside the 20 quarters ending at the newest periodic filing (2026-07-28 back to 2021-10-28).
  assert.equal(selected.filter(f=>f.form==='10-Q').length,15);
  assert.ok(selected.filter(f=>f.form==='10-Q').every((f,i,a)=>i===0||a[i-1].filingDate!>=f.filingDate!));
  // Without the pages, recent alone gives only the two newest 10-Ks: the original bug.
  const recentOnly=selectResearchFilings(await loadSubmissionFilings({filings:{recent:columns(recentRows)}},'2021-10-10','2026-10-10',mockFetch({})),'2021-10-10','2026-10-10');
  assert.equal(recentOnly.filter(f=>f.form==='10-K').length,2);
});

test('no older page is fetched when recent already reaches the window, and unsafe page names are ignored',async()=>{
  const calls:{url:string;agent:string}[]=[];
  await loadSubmissionFilings(submissions,'2025-01-01','2026-10-10',mockFetch({},calls));
  assert.equal(calls.length,0);
  const unsafe={filings:{recent:columns(recentRows),files:[{name:'../../api/other.json',filingFrom:'2017-01-01',filingTo:'2024-06-16'}]}};
  await loadSubmissionFilings(unsafe,'2021-10-10','2026-10-10',mockFetch({},calls));
  assert.equal(calls.length,0);
});

test('a failed submissions page fails loudly instead of silently shortening history',async()=>{
  await assert.rejects(loadSubmissionFilings(submissions,'2021-10-10','2026-10-10',mockFetch({})),/submissions page CIK0001326801-submissions-001\.json failed: 404/);
});

// A 10-K whose cash-flow statement covers three years and opens with the prior year-end cash balance.
const tenK=(incomeYears:number[])=>{
  const ctx=(id:string,start:string|null,end:string)=>`<xbrli:context id="${id}"><xbrli:entity></xbrli:entity><xbrli:period>${start?`<xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate>`:`<xbrli:instant>${end}</xbrli:instant>`}</xbrli:period></xbrli:context>`;
  const fact=(c:string,name:string,value:string,unit='usd')=>`<ix:nonFraction id="${c}-${name}" name="${name}" contextRef="${c}" unitRef="${unit}" scale="6" format="ixt:num-dot-decimal">${value}</ix:nonFraction>`;
  const years=[2023,2024,2025];
  return `<ix:nonNumeric name="dei:DocumentFiscalYearFocus">2025</ix:nonNumeric><ix:nonNumeric name="dei:DocumentFiscalPeriodFocus">FY</ix:nonNumeric><ix:nonNumeric name="dei:DocumentPeriodEndDate">2025-12-31</ix:nonNumeric>
<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
${[2022,...years].map(y=>ctx(`i${y}`,null,`${y}-12-31`)+ctx(`d${y}`,`${y}-01-01`,`${y}-12-31`)).join('')}
<h2>Consolidated Statements of Income</h2><table>${incomeYears.map(y=>`<tr><td>Revenue</td><td>${fact(`d${y}`,'us-gaap:Revenues','100')}</td></tr>`).join('')}</table>
<h2>Consolidated Statements of Cash Flows</h2><table>
${years.map(y=>`<tr><td>Net cash provided by operating activities</td><td>${fact(`d${y}`,'us-gaap:NetCashProvidedByUsedInOperatingActivities','50')}</td></tr>`).join('')}
${[2022,...years].map(y=>`<tr><td>Cash, cash equivalents, and restricted cash</td><td>${fact(`i${y}`,'us-gaap:CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',String(y-2000))}</td></tr>`).join('')}
</table>`;
};
const source={id:'00000000-0000-4000-8000-000000000002',url:'https://www.sec.gov/example',published_at:'2026-01-29',period_end:'2025-12-31',metadata_json:{form:'10-K'}};

test('a lone beginning-of-period cash instant does not create an otherwise-empty fiscal-year column',()=>{
  const observations=statementObservations(extractFilingStatements(tenK([2023,2024,2025]),source)).map(o=>HistoricalObservation.parse(o));
  assert.deepEqual([...new Set(observations.filter(o=>o.periodicity==='annual').map(o=>o.fiscal_year))].sort(),[2023,2024,2025]);
  assert.ok(!observations.some(o=>o.fiscal_year===2022));
  // Year-end balances for years that have other data are kept.
  const cash=(year:number)=>observations.find(o=>o.metric_key==='us_gaap_CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'&&o.periodicity==='annual'&&o.fiscal_year===year)?.value_numeric;
  assert.equal(cash(2023),23_000_000);
  assert.equal(cash(2025),25_000_000);
});

test('an opening balance is kept when another statement populates that fiscal year',()=>{
  const observations=statementObservations(extractFilingStatements(tenK([2022,2023,2024,2025]),source));
  assert.equal(observations.find(o=>o.metric_key==='us_gaap_CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'&&o.periodicity==='annual'&&o.fiscal_year===2022)?.value_numeric,22_000_000);
});

test('Q4 diluted weighted-average shares are not derived as annual minus nine-month year to date',()=>{
  const doc=(fp:string,end:string,value:string)=>`<ix:nonNumeric name="dei:DocumentFiscalYearFocus">2025</ix:nonNumeric><ix:nonNumeric name="dei:DocumentFiscalPeriodFocus">${fp}</ix:nonNumeric><ix:nonNumeric name="dei:DocumentPeriodEndDate">${end}</ix:nonNumeric>
<xbrli:unit id="shares"><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unit><xbrli:context id="p"><xbrli:entity></xbrli:entity><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period></xbrli:context>
<h2>Consolidated Statements of Income</h2><table><tr><td>Diluted</td><td><ix:nonFraction id="s" name="us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding" contextRef="p" unitRef="shares" scale="6" format="ixt:num-dot-decimal">${value}</ix:nonFraction></td></tr></table>`;
  const tables=[...extractFilingStatements(doc('Q3','2025-09-30','2,600'),{...source,published_at:'2025-10-30',period_end:'2025-09-30',metadata_json:{form:'10-Q'}}),
    ...extractFilingStatements(doc('FY','2025-12-31','2,590'),source)];
  const shares=statementObservations(tables).filter(o=>o.metric_key==='us_gaap_WeightedAverageNumberOfDilutedSharesOutstanding');
  assert.deepEqual(shares.map(o=>[o.periodicity,o.fiscal_quarter]),[['annual',null]]);
});
