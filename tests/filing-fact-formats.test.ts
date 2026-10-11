import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractFilingStatements,filingCoverage} from '../src/lib/research/history/filing-statements';

const source={id:'00000000-0000-4000-8000-000000000011',url:'https://www.sec.gov/example',published_at:'2022-03-01',period_end:'2021-12-31',metadata_json:{form:'10-K'}};
const fact=(name:string,format:string,text:string,unit='shares')=>`<ix:nonFraction id="${name}" name="us-gaap:${name}" contextRef="i" unitRef="${unit}" scale="0" format="${format}">${text}</ix:nonFraction>`;

test('zero formats are 0 whatever the text, and numwordsen counts resolve',()=>{
 const html=`<ix:nonNumeric name="dei:DocumentFiscalYearFocus">2021</ix:nonNumeric><ix:nonNumeric name="dei:DocumentFiscalPeriodFocus">FY</ix:nonNumeric><ix:nonNumeric name="dei:DocumentPeriodEndDate">2021-12-31</ix:nonNumeric>
<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit><xbrli:unit id="shares"><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unit>
<xbrli:context id="i"><xbrli:period><xbrli:instant>2021-12-31</xbrli:instant></xbrli:period></xbrli:context>
<h2>Consolidated Balance Sheets</h2><table>
<tr><td>Total assets</td><td>${fact('Assets','ixt:num-dot-decimal','1,000','usd')}</td></tr>
<tr><td>Preferred stock, no shares issued</td><td>${fact('PreferredStockSharesIssued','ixt:fixed-zero','no')}</td></tr>
<tr><td>Treasury shares, none</td><td>${fact('TreasuryStockShares','ixt:fixed-zero','None')}</td></tr>
<tr><td>Class B shares issued</td><td>${fact('CommonStockSharesIssued','ixt-sec:numwordsen','none')}</td></tr>
<tr><td>Classes of stock</td><td>${fact('NumberOfClassesOfStock','ixt-sec:numwordsen','Two')}</td></tr>
<tr><td>Other</td><td>${fact('OtherShares','ixt:zerodash','—')}</td></tr>
</table>`;
 const tables=extractFilingStatements(html,source);
 assert.equal(tables.length,1);
 const values=Object.fromEntries(tables[0].rows.flatMap(r=>r.cells.flatMap(c=>c.facts)).map(f=>[f.concept.split(':')[1],f.value]));
 assert.deepEqual(values,{Assets:1000,PreferredStockSharesIssued:0,TreasuryStockShares:0,CommonStockSharesIssued:0,NumberOfClassesOfStock:2,OtherShares:0});
 assert.deepEqual(tables[0].warnings,[]);
 assert.equal(filingCoverage(tables,[source])[0].unresolved_facts,0);
});

test('an unknown word under numwordsen is still reported as unresolved',()=>{
 const html=`<ix:nonNumeric name="dei:DocumentFiscalYearFocus">2021</ix:nonNumeric><ix:nonNumeric name="dei:DocumentFiscalPeriodFocus">FY</ix:nonNumeric><ix:nonNumeric name="dei:DocumentPeriodEndDate">2021-12-31</ix:nonNumeric>
<xbrli:unit id="shares"><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unit><xbrli:context id="i"><xbrli:period><xbrli:instant>2021-12-31</xbrli:instant></xbrli:period></xbrli:context>
<h2>Consolidated Balance Sheets</h2><table><tr><td>Shares</td><td>${fact('CommonStockSharesIssued','ixt-sec:numwordsen','several')}</td></tr></table>`;
 const [table]=extractFilingStatements(html,source);
 assert.equal(table.rows[0].cells[1].facts[0].value,null);
 assert.equal(table.warnings.length,1);
});
