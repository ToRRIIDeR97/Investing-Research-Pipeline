import {artifactContent} from './data-views';
import {kpiCandidateKeys} from './dashboard-series';
import {money,percent,plainLabel,price} from './plain-english';
import {withheldValuationReason} from '../valuation/contracts';
import {isFinalDecision} from '../run-status';

/**
 * The research memo: one reading view of a run, built on the server from stored, code-computed artifacts.
 * Every screen that shows a run's value, signals or open questions reads this object, so no two places disagree.
 *
 * "Value" always means value per share today (report_facts pv_per_share). Terminal-year prices appear only as
 * labelled price targets in `valuation.cases`. Nothing here is re-derived when the valuation code stored it.
 */

type Row=Record<string,any>;
export type MemoCase='bear'|'base'|'bull';
export const MEMO_CASES:MemoCase[]=['bear','base','bull'];

export type MemoStatusKey='researching'|'needs_plan_approval'|'needs_decision'|'needs_more_work'|'decided'|'failed';
export interface MemoStatus {key:MemoStatusKey;label:string}
export type SignalStatus='near_bear'|'weaker'|'base'|'better';
export interface MemoSignal {
  label:string;note:string|null;value:number;display:string;
  bear:number;bull:number;bearDisplay:string;bullDisplay:string;
  baseLow:number|null;baseHigh:number|null;baseDisplay:string|null;
  /** Positions on a bad-to-good scale: 0 is the bear threshold, 1 the bull threshold, whatever the metric's direction. */
  position:number;baseFrom:number|null;baseTo:number|null;
  status:SignalStatus;
}
export interface MemoCaseRow {
  type:MemoCase;probability:number|null;valueToday:number|null;gap:number|null;
  targetYear:number|null;target:number|null;targetReturn:number|null;exit:string|null;
}
export interface MemoBridge {terminal:number;explicit:number;valueToday:number;terminalYear:number|null}
export interface MemoDiscount {rate:number;riskFree:number|null;beta:number|null;betaVerified:boolean;premium:number|null}
export interface MemoRisk {name:string;probability:number|null;severity:number|null;score:number|null;watch:string|null}
export interface MemoSnapshotRow {label:string;latest:number;prior:number;latestDisplay:string;priorDisplay:string;change:number|null;better:boolean|null}
export interface MemoQuestion {question:string;status:string;followUp:string|null;evidenceIds:string[]}
export interface MemoReason {headline:string;detail:string|null;
  /** The one figure the reason rests on ("16.9% CET1"), when the conclusion stored key reasons. */
  figure:string|null;evidenceIds:string[]}
export interface MemoEvidence {id:string;claim:string|null;quote:string|null;url:string|null;title:string|null;publishedAt:string|null}

export interface ResearchMemo {
  version:1;
  currency:string;
  status:MemoStatus|null;
  /** The final human review is open, so a decision can be recorded from the memo. */
  reviewOpen:boolean;
  /** A validated valuation stored after the report's. The memo keeps to the report's and says so. */
  newerValuation:{version:number;createdAt:string}|null;
  verdict:{
    price:number|null;priceVerified:boolean;priceDate:string|null;
    valuationComplete:boolean;withheldReason:string|null;
    values:Record<MemoCase,number|null>;weighted:number|null;gap:number|null;
    conclusionStatus:string|null;summary:string|null;
    confidence:{level:'low'|'moderate'|'high'|null;score:number|null;openQuestions:number};
  };
  reasons:MemoReason[];
  otherSide:string|null;
  signals:MemoSignal[];
  untestable:MemoQuestion[];
  breakers:{name:string;threshold:string|null}[];
  valuation:{cases:MemoCaseRow[];weighted:number|null;bridge:MemoBridge|null;discount:MemoDiscount|null;method:string|null}|null;
  risks:MemoRisk[];
  snapshot:{period:string;prior:string;rows:MemoSnapshotRow[]}|null;
  openQuestions:MemoQuestion[];
  evidence:Record<string,MemoEvidence>;
}

export interface MemoRunState {runStatus?:string|null;humanReviewStatus?:string|null;latestDecision?:string|null;
  /** A validated valuation stored after the one the report was built from. */
  newerValuation?:{version:number;createdAt:string}|null}

const num=(v:unknown):number|null=>{
  if(typeof v==='number'&&Number.isFinite(v))return v;
  if(typeof v==='string'&&v.trim()&&Number.isFinite(Number(v)))return Number(v);
  return null;
};
const text=(v:unknown):string|null=>typeof v==='string'&&v.trim()?v.trim():null;
const round=(v:number|null,places=2)=>v==null?null:Math.round(v*10**places)/10**places;
const ids=(v:unknown):string[]=>Array.isArray(v)?v.filter((x):x is string=>typeof x==='string'):[];

/** One status vocabulary for a run: cards, the asset hero and the memo all use it. */
export function memoStatus(state:MemoRunState):MemoStatus|null {
  const run=String(state.runStatus??'').toLowerCase();
  const decision=String(state.latestDecision??'').toLowerCase();
  if(!run)return null;
  // A final decision (approved, watchlist, reject) settles the run, the same rule as runStatusWord.
  if(isFinalDecision(decision))return {key:'decided',label:'Decided'};
  if(['failed','cancelled','canceled'].includes(run))return {key:'failed',label:'Stopped'};
  // The run's own needs_more_work means the pipeline stopped it. A needs_more_work decision is a reviewer's send-back:
  // the run redrafts or waits again, so the run status and the human-review gate decide, not the decision.
  if(run==='needs_more_work')return {key:'needs_more_work',label:'Stopped'};
  if(state.humanReviewStatus==='waiting_for_human')return {key:'needs_decision',label:'Needs your decision'};
  // Waiting at a gate other than the final review: the research plan.
  if(run==='waiting_for_human')return state.humanReviewStatus==null?{key:'needs_decision',label:'Needs your decision'}:{key:'needs_plan_approval',label:'Needs plan approval'};
  if(['completed','approved'].includes(run))return {key:'decided',label:'Decided'};
  return {key:'researching',label:'Researching'};
}

/**
 * Model prose as reader prose, mechanically: amounts written in thousands become millions or billions
 * ("240,989 thousand" → "241.0 million"). Wording is otherwise untouched.
 */
export function tidyProse(input:string):string {
  return input.replace(/(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?) thousand\b/g,(_,digits:string)=>{
    const value=Number(digits.replace(/,/g,''))*1e3;
    if(!Number.isFinite(value))return `${digits} thousand`;
    const a=Math.abs(value);
    return a>=1e9?`${(value/1e9).toFixed(2)} billion`:a>=1e6?`${(value/1e6).toFixed(1)} million`:`${Math.round(value).toLocaleString('en-US')}`;
  });
}

/** First sentence and the rest. Decimals ("14.28") and initials don't end a sentence. */
export function splitLead(paragraph:string):{lead:string;rest:string} {
  const m=/^(.+?[.!?])\s+(?=[A-Z“"(])/.exec(paragraph);
  return m?{lead:m[1].trim(),rest:paragraph.slice(m[0].length).trim()}:{lead:paragraph.trim(),rest:''};
}

/** The rest of a paragraph cut at a sentence boundary near `max` characters. */
function firstSentences(rest:string,max=260):string|null {
  if(!rest)return null;
  let out='';let remaining=rest;
  while(remaining){const {lead,rest:next}=splitLead(remaining);if(out&&(out+' '+lead).length>max)break;out=out?`${out} ${lead}`:lead;remaining=next;if(out.length>=max)break;}
  return out||null;
}

/** How many units one figure stands for when the KPI unit names a scale: "USD thousands" is 1e3. */
const unitScale=(u:string)=>/\bthousands?\b/.test(u)?1e3:/\bmillions?\b/.test(u)?1e6:/\bbillions?\b/.test(u)?1e9:1;

/**
 * "1.30bn to 1.36bn", "14.5% to 17%", "-9000 to 0", "0% to 8%", "9 to 10 billion dollars" in the KPI's own unit (a
 * "USD thousands" KPI gets thousands). Null for one value, or when the two numbers mix a percent with an amount
 * ("Above 9.5 billion dollars with CET1 ratio above 12%").
 */
export function parseBaseRange(range:unknown,unit:unknown):[number,number]|null {
  const raw=text(range);if(!raw)return null;
  const u=String(unit??'').toLowerCase();
  const scale=unitScale(u);
  // A digit inside a word ("CET1", "Q4") is not a figure.
  const hits=[...raw.matchAll(/(?<![A-Za-z\d.])(-?\d+(?:\.\d+)?)\s*(bn|billion|b|million|m|k|%)?/gi)].map(m=>({v:Number(m[1]),suffix:(m[2]??'').toLowerCase()})).filter(h=>Number.isFinite(h.v));
  if(hits.length<2)return null;
  const [a,b]=hits;
  if((a.suffix==='%')!==(b.suffix==='%')&&(a.suffix||b.suffix))return null;
  const value=({v,suffix}:{v:number;suffix:string})=>{
    if(suffix==='%')return /ratio|decimal/.test(u)?v/100:v;
    const amount=suffix==='bn'||suffix==='b'||suffix==='billion'?v*1e9:suffix==='m'||suffix==='million'?v*1e6:suffix==='k'?v*1e3:null;
    return amount===null?v:amount/scale;
  };
  // A unit-less figure next to a scaled one ("9 to 10 billion") takes the same scale.
  const sa=a.suffix||b.suffix,sb=b.suffix||a.suffix;
  const x=value({v:a.v,suffix:sa}),y=value({v:b.v,suffix:sb});
  return [Math.min(x,y),Math.max(x,y)];
}

/** A KPI level as reader text in its unit: 16.9%, 1.30bn, −$8.8B, 7.6%. */
export function formatLevel(value:number,unit:unknown):string {
  const u=String(unit??'').toLowerCase();
  const trim=(n:number,p:number)=>String(Number(n.toFixed(p)));
  if(/percent|^%$|pct/.test(u))return `${trim(value,2)}%`;
  if(/ratio|decimal/.test(u))return Math.abs(value)<=1.5?`${trim(value*100,1)}%`:`${trim(value,2)}x`;
  const code=u.replace(/\b(thousands?|millions?|billions?)\b/,'').trim();
  if(/\bthousands?\b/.test(u)&&/^[a-z]{3}$/.test(code))return money(value*1e3,code.toUpperCase());
  if(/\bmillions?\b/.test(u)&&/^[a-z]{3}$/.test(code))return money(value*1e6,code.toUpperCase());
  if(/\bbillions?\b/.test(u)&&/^[a-z]{3}$/.test(code))return money(value*1e9,code.toUpperCase());
  const a=Math.abs(value);
  if(a>=1e9)return `${(value/1e9).toFixed(2)}bn`;
  if(a>=1e6)return `${(value/1e6).toFixed(1)}m`;
  if(a>=1e4)return `${(value/1e3).toFixed(1)}k`;
  return trim(value,2);
}

const clamp01=(v:number)=>Math.max(0,Math.min(1,v));
/** Position on the bad-to-good scale: bear threshold 0, bull threshold 1. */
export const signalPosition=(value:number,bear:number,bull:number)=>bull===bear?0.5:clamp01((value-bear)/(bull-bear));

function signals(items:Row[]):MemoSignal[] {
  return items.flatMap(item=>{
    const value=num(item?.current_level),bear=num(item?.bear_threshold),bull=num(item?.bull_threshold);
    const label=text(item?.kpi);
    if(value==null||bear==null||bull==null||bear===bull||!label)return [];
    const unit=item.unit;
    const range=parseBaseRange(item.base_range,unit);
    const position=signalPosition(value,bear,bull);
    const [from,to]=range?[signalPosition(range[0],bear,bull),signalPosition(range[1],bear,bull)].sort((a,b)=>a-b):[null,null];
    let status:SignalStatus='base';
    if(position<0.15)status='near_bear';
    else if(from!=null&&to!=null){if(position<from-1e-9)status='weaker';else if(position>to+1e-9)status='better';}
    else if(position>=1)status='better';
    const fmt=(v:number)=>formatLevel(v,unit);
    return [{label,note:text(item.definition),value,display:fmt(value),bear,bull,bearDisplay:fmt(bear),bullDisplay:fmt(bull),
      baseLow:range?.[0]??null,baseHigh:range?.[1]??null,baseDisplay:range?`${fmt(range[0])}–${fmt(range[1])}`:text(item.base_range),
      position:round(position,4)!,baseFrom:round(from,4),baseTo:round(to,4),status}];
  });
}

/** Exit valuation in words: "9x net_income_2030" → "9× net income in 2030". */
export function exitText(terminal:unknown):string|null {
  const raw=text(terminal);if(!raw)return null;
  const m=/^([\d.]+)\s*x\s+([a-z_]+?)_(\d{4})$/i.exec(raw);
  if(m)return `${m[1]}× ${plainLabel(m[2]).toLowerCase()} in ${m[3]}`;
  return plainLabel(raw);
}

function caseTable(facts:Row|null):{rows:MemoCaseRow[];columnsFound:boolean} {
  const columns:unknown[]=Array.isArray(facts?.cases?.columns)?facts!.cases.columns:[];
  const rows:unknown[][]=Array.isArray(facts?.cases?.rows)?facts!.cases.rows:[];
  const at=(name:string)=>columns.indexOf(name);
  const get=(row:unknown[],name:string)=>at(name)>=0?row[at(name)]:undefined;
  const out:MemoCaseRow[]=[];
  for(const row of rows){
    const type=String(get(row,'case')??'') as MemoCase;
    if(!MEMO_CASES.includes(type))continue;
    out.push({type,probability:num(get(row,'probability')),valueToday:round(num(get(row,'pv_per_share'))),gap:round(num(get(row,'return_to_pv')),4),
      targetYear:num(get(row,'terminal_year')),target:round(num(get(row,'terminal_price_target'))),targetReturn:round(num(get(row,'undiscounted_return_to_terminal')),4),
      exit:exitText(get(row,'terminal'))});
  }
  out.sort((a,b)=>MEMO_CASES.indexOf(a.type)-MEMO_CASES.indexOf(b.type));
  return {rows:out,columnsFound:at('case')>=0};
}

/** Base-case bridge from the stored schedule; null unless terminal + explicit reproduce value today within a cent. */
function bridge(valuation:Row,valueToday:number|null):MemoBridge|null {
  const schedules:Row[]=Array.isArray(valuation.method_schedules)?valuation.method_schedules:[];
  const s=schedules.find(x=>x?.scenario_type==='base'&&x?.method===valuation.methods?.[0])??schedules.find(x=>x?.scenario_type==='base');
  const shares=num(s?.diluted_shares),tv=num(s?.terminal_present_value),ex=num(s?.explicit_present_value),bridgeItems=num(s?.equity_bridge)??0;
  if(!s||!shares||tv==null||ex==null||valueToday==null||bridgeItems!==0)return null;
  const terminal=tv/shares,explicit=ex/shares;
  if(Math.abs(terminal+explicit-valueToday)>0.01)return null;
  return {terminal:round(terminal)!,explicit:round(explicit)!,valueToday:round(valueToday)!,terminalYear:num(valuation.terminal_year)};
}

function discount(valuation:Row):MemoDiscount|null {
  const c=valuation.cost_of_capital_inputs??{};
  const rate=num(c.capm_cost_of_equity?.rate);
  if(rate==null)return null;
  return {rate,riskFree:num(valuation.risk_free_rate?.rate),beta:round(num(c.beta?.value)),betaVerified:c.beta?.verified===true,premium:num(c.equity_risk_premium?.rate)};
}

const SNAPSHOT_METRICS:[string,string,boolean][]=[
  ['total_revenue','Revenue',true],['net_interest_income','Net interest income',true],['income_from_operations','Operating income',true],
  ['net_income','Net income',true],['operating_cash_flow','Cash from operations',true],
];
/** Metric keys the memo's snapshot reads, so the server can filter a large statement set before loading it. */
export const SNAPSHOT_METRIC_KEYS:string[]=[...new Set(SNAPSHOT_METRICS.flatMap(([key])=>kpiCandidateKeys(key)))];

const quarterName=(year:number,quarter:number)=>`Q${quarter} ${year}`;
function snapshot(observations:Row[],currency:string):ResearchMemo['snapshot'] {
  const rows=observations.filter(r=>r?.periodicity==='quarterly'&&!r.segment&&!r.geography&&num(r.value_numeric)!=null&&num(r.fiscal_year)!=null&&num(r.fiscal_quarter)!=null);
  const forKey=(key:string)=>{const keys=kpiCandidateKeys(key);return rows.filter(r=>keys.includes(r.metric_key));};
  const anchor=forKey('total_revenue');
  const pool=anchor.length?anchor:rows;
  if(!pool.length)return null;
  const latest=pool.reduce((a,b)=>Number(b.fiscal_year)*10+Number(b.fiscal_quarter)>Number(a.fiscal_year)*10+Number(a.fiscal_quarter)?b:a);
  const year=Number(latest.fiscal_year),quarter=Number(latest.fiscal_quarter);
  const out:MemoSnapshotRow[]=[];
  for(const [key,label,higherBetter] of SNAPSHOT_METRICS){
    const series=forKey(key);
    const pick=(y:number)=>series.find(r=>Number(r.fiscal_year)===y&&Number(r.fiscal_quarter)===quarter);
    const now=pick(year),then=pick(year-1);
    if(!now||!then)continue;
    const a=Number(now.value_numeric),b=Number(then.value_numeric);
    const change=b>0&&a>0?round(a/b-1,4):null;
    out.push({label,latest:a,prior:b,latestDisplay:money(a,currency),priorDisplay:money(b,currency),change,better:a===b?null:(a>b)===higherBetter});
  }
  return out.length?{period:quarterName(year,quarter),prior:quarterName(year-1,quarter),rows:out}:null;
}

function conclusionSection(document:Row|null):Row|null {
  const sections:Row[]=Array.isArray(document?.sections)?document!.sections:[];
  return sections.find(s=>Array.isArray(s?.coverage)&&s.coverage.includes('conclusion'))??null;
}

/**
 * The memo's reasons. A conclusion written under the key-reasons contract stores them (`key_reasons`: headline,
 * explanation, figure, evidence ids), and those are used as written. Older reports fall back to the lead sentence of
 * the conclusion's evidence-bearing fact or analysis paragraphs, after its opening paragraph, at most three.
 */
function reasons(section:Row|null):MemoReason[] {
  const stored:Row[]=Array.isArray(section?.key_reasons)?section!.key_reasons:[];
  const written=stored.filter(r=>text(r?.headline)).slice(0,3).map(r=>{
    const explanation=text(r.explanation),figure=text(r.figure);
    return {headline:tidyProse(String(r.headline)),detail:explanation?tidyProse(explanation):null,figure:figure?tidyProse(figure):null,evidenceIds:ids(r.evidence_ids)};
  });
  if(written.length)return written;
  const paragraphs:Row[]=Array.isArray(section?.paragraphs)?section!.paragraphs:[];
  return paragraphs.slice(1).filter(p=>['fact','analysis'].includes(p?.kind)&&ids(p.evidence_ids).length&&text(p.text))
    .slice(0,3).map(p=>{const {lead,rest}=splitLead(tidyProse(String(p.text)));return {headline:lead,detail:firstSentences(rest),figure:null,evidenceIds:ids(p.evidence_ids)};});
}

function questions(register:Row):MemoQuestion[] {
  const list:Row[]=Array.isArray(register.questions)?register.questions:[];
  return list.filter(q=>text(q?.question)).map(q=>({question:tidyProse(String(q.question)),status:String(q.status??'open'),followUp:text(q.follow_up),evidenceIds:ids(q.evidence_ids)}));
}

function confidenceLevel(score:number|null):'low'|'moderate'|'high'|null {
  if(score==null)return null;
  return score<0.4?'low':score<0.7?'moderate':'high';
}

export function buildResearchMemo(artifacts:Row[],document:Row|null,state:MemoRunState={}):ResearchMemo|null {
  const facts=artifactContent(artifacts,'report_facts') as Row;
  const valuation=artifactContent(artifacts,'valuation_scenario_set') as Row;
  const hasFacts=Object.keys(facts).length>0,hasValuation=Object.keys(valuation).length>0;
  const section=conclusionSection(document);
  if(!hasFacts&&!hasValuation&&!section)return null;

  const currency=String(facts.currency??valuation.method_schedules?.[0]?.currency??'USD');
  const price=num(facts.market_price)??num(valuation.current_market_price);
  const source=valuation.current_market_price_source??{};
  const withheldReason=withheldValuationReason(valuation)??(hasFacts&&facts.valuation_status!=null&&facts.valuation_status!=='complete'?text(facts.withheld_reason)??'The valuation was withheld.':null);
  const complete=!withheldReason&&(hasFacts?facts.valuation_status==null||facts.valuation_status==='complete':hasValuation);

  const table=caseTable(complete&&hasFacts?facts:null);
  const values:Record<MemoCase,number|null>={bear:null,base:null,bull:null};
  const probabilities:Record<MemoCase,number|null>={bear:null,base:null,bull:null};
  let weighted:number|null=null;
  if(complete){
    if(table.rows.length){for(const r of table.rows){values[r.type]=r.valueToday;probabilities[r.type]=r.probability;}weighted=round(num(facts.weighted?.pv_per_share));}
    else if(hasValuation){for(const t of MEMO_CASES){values[t]=round(num(valuation[`value_today_${t}`]));probabilities[t]=num(valuation[`probability_${t}`]);}weighted=round(num(valuation.weighted_value_today));}
  }
  const gap=values.base!=null&&price?round(values.base/price-1,4):null;

  const confidenceScore=num(artifactContent(artifacts,'confidence_assessment').valuation);
  const allQuestions=questions(artifactContent(artifacts,'question_register'));
  const open=allQuestions.filter(q=>q.status!=='answered');
  const blocked=allQuestions.filter(q=>q.status==='blocked');

  const caseRows:MemoCaseRow[]=complete?(table.rows.length?table.rows:MEMO_CASES.map(t=>({type:t,probability:probabilities[t],valueToday:values[t],gap:values[t]!=null&&price?round(values[t]!/price-1,4):null,
    targetYear:num(valuation.terminal_year),target:round(num(valuation[`terminal_anchor_${t}`])),targetReturn:null,exit:null}))):[];
  const methods:unknown[]=Array.isArray(valuation.methods)?valuation.methods:[];

  const risks:MemoRisk[]=((artifactContent(artifacts,'risk_register').risks??[]) as Row[]).filter(r=>text(r?.risk_name)).map(r=>{
    const p=num(r.probability),s=num(r.severity);
    return {name:String(r.risk_name),probability:p,severity:s,score:p!=null&&s!=null?round(p*s,2):null,watch:text(r.leading_indicator)};
  }).sort((a,b)=>(b.score??-1)-(a.score??-1)).slice(0,4);

  const breakers=((artifactContent(artifacts,'thesis_breakers').breakers??[]) as Row[]).filter(b=>text(b?.name)).map(b=>({name:String(b.name),threshold:text(b.threshold)}));

  const memoReasons=reasons(section);
  const cited=new Set([...memoReasons.flatMap(r=>r.evidenceIds),...open.flatMap(q=>q.evidenceIds)]);
  const evidence:Record<string,MemoEvidence>={};
  for(const e of (Array.isArray(document?.evidence)?document!.evidence:[]) as Row[]){
    if(!e?.id||!cited.has(e.id))continue;
    evidence[e.id]={id:e.id,claim:text(e.claim_text),quote:text(e.quote),url:text(e.url),title:text(e.source_title),publishedAt:text(e.published_at)};
  }

  return {
    version:1,
    currency,
    status:memoStatus(state),
    reviewOpen:state.humanReviewStatus==='waiting_for_human',
    newerValuation:state.newerValuation??null,
    verdict:{
      price,priceVerified:source.verified===true,priceDate:text(source.trading_date),
      valuationComplete:complete,withheldReason,values,weighted,gap,
      conclusionStatus:text(document?.conclusion_status),
      summary:text(section?.implication)?tidyProse(String(section!.implication)):null,
      confidence:{level:confidenceLevel(confidenceScore),score:confidenceScore,openQuestions:open.length},
    },
    reasons:memoReasons,
    otherSide:text(section?.counterevidence)?tidyProse(String(section!.counterevidence)):null,
    signals:signals((artifactContent(artifacts,'monitoring_dashboard').items??[]) as Row[]),
    untestable:blocked,
    breakers,
    valuation:complete&&caseRows.length?{cases:caseRows,weighted,bridge:bridge(valuation,values.base),discount:discount(valuation),method:methods.length?plainLabel(methods[0]):null}:null,
    risks,
    snapshot:snapshot((artifactContent(artifacts,'financial_statement_set').observations??[]) as Row[],currency),
    openQuestions:[...blocked,...open.filter(q=>q.status!=='blocked')],
    evidence,
  };
}

/** The verdict in one sentence, built from the numbers (never from model prose). */
export function verdictLine(memo: ResearchMemo): string {
  const v = memo.verdict, c = memo.currency;
  if (!v.valuationComplete) return "The valuation was withheld, so there is no value per share to compare with the price.";
  const { base, bull } = v.values;
  if (base == null) return "No value per share was stored for this run.";
  if (v.price == null) return `The base case values a share at ${price(base, c, true)} today. No market price was captured to compare.`;
  const at = `At ${price(v.price, c, true)}`;
  if (bull != null && bull < v.price) return `${at}, the price is above even the bull case (${price(bull, c, true)}).`;
  const gap = base / v.price - 1;
  if (Math.abs(gap) < 0.05) return `${at}, the price is close to the base-case value of ${price(base, c, true)}.`;
  return `${at}, the base-case value of ${price(base, c, true)} is ${percent(Math.abs(gap), 0)} ${gap < 0 ? "below" : "above"} the price.`;
}
