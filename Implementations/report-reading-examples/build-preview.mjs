import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const snapshot=JSON.parse(readFileSync(resolve(root,'storage/sofi-live-2026-09-25/snapshot.json'),'utf8'));
const report=snapshot.artifacts.filter(a=>a.artifact_type==='report_document').at(-1)?.content_json;
if(!report)throw Error('Saved SOFI report is missing. This script does not generate research.');
const data={};
const sections=report.sections.map(section=>({...section,tables:section.tables.map(table=>{
 const key=`${table.artifact_id}:${table.path}`;
 if(!(key in data)){
  const artifact=report.artifacts.find(a=>a.id===table.artifact_id);if(!artifact)throw Error('Referenced exhibit is missing');
  let value=artifact.content_json;
  for(const part of table.path?table.path.split('.'):[]){if(['__proto__','constructor','prototype'].includes(part)||!Object.hasOwn(value,part))throw Error('Invalid exhibit reference');value=value[part];}
  data[key]=value;
 }
 return {...table,key};
})}));
const payload={asset_name:report.asset_name,cutoff:report.cutoff,conclusion_status:report.conclusion_status,
 content_hash:report.content_hash,sections,questions:report.questions,coverage:report.coverage,evidence:report.evidence,data};
const serialized=JSON.stringify(payload);
writeFileSync(resolve(root,'public/report-layouts/report-data.json'),serialized);
writeFileSync(resolve(root,'Implementations/report-reading-examples/content-proof.json'),JSON.stringify({
 report_hash:report.content_hash,preview_data_sha256:createHash('sha256').update(serialized).digest('hex'),
 sections:sections.length,paragraphs:sections.reduce((n,s)=>n+s.paragraphs.length,0),
 referenced_exhibits:sections.reduce((n,s)=>n+s.tables.length,0),unique_exhibits:Object.keys(data).length,
 all_paragraphs_preserved:sections.every((s,i)=>JSON.stringify(s.paragraphs)===JSON.stringify(report.sections[i].paragraphs)),
 note:'Presentation-only snapshot of the existing paid report. Original source data and report remain unchanged.'
},null,2));
console.log(`Built ${sections.length} chapters and ${Object.keys(data).length} unique exhibits from the saved report.`);
