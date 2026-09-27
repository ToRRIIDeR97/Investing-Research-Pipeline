import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {readerValue,readerText,exhibitTitle,historyMatrix} from '../../../public/report-layouts/presentation.mjs';

test('AC-1/2/4: actual saved SOFI data retains all content and readable exhibits',()=>{
 const raw=readFileSync('public/report-layouts/report-data.json','utf8');
 const report=JSON.parse(raw),proof=JSON.parse(readFileSync('Implementations/report-reading-examples/content-proof.json','utf8'));
 assert.equal(createHash('sha256').update(raw).digest('hex'),proof.preview_data_sha256);
 assert.equal(report.sections.length,16);assert.equal(report.sections.reduce((n,s)=>n+s.paragraphs.length,0),216);
 assert.equal(report.sections.reduce((n,s)=>n+s.tables.length,0),98);assert.equal(report.questions.length,14);
 for(const section of report.sections){
  for(const paragraph of section.paragraphs)assert.ok(!/\b[a-z]+_[a-z_]+\b/.test(readerText(paragraph.text)));
  for(const table of section.tables){
   assert.ok(Object.hasOwn(report.data,table.key));assert.ok(!exhibitTitle(table).includes('_'));
   const content=JSON.stringify(readerValue(report.data[table.key]));
   assert.ok(!/artifact_type|metadata_json|source_document_id|evidence_claim_ids/.test(content));
  }
 }
 const history=Object.entries(report.data).find(([key])=>key.endsWith(':observations'))[1];
 const matrix=historyMatrix(history),reserve=matrix.rows.find(r=>r.name==='Loan loss reserve');
 assert.equal(matrix.observationCount,306);assert.equal(reserve.values[matrix.periods.indexOf('Q2 2026')],'56.459');
});
