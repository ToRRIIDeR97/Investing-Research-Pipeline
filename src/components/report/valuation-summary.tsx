"use client";
import {useMemo,useState,type ReactNode} from 'react';
import {scenarioNames,scenarioTypes,valuationSummary,type ScenarioType} from '@/lib/research/reporting/valuation-summary';
import {moneyMillions,price} from '@/lib/research/reporting/plain-english';
import styles from './report-panels.module.css';
type Row=Record<string,any>;

const glyphs:Record<ScenarioType,string>={bear:'▼',base:'●',bull:'▲'};
const currencyNames:Record<string,string>={USD:'US dollars',EUR:'Euros',GBP:'Pounds sterling',JPY:'Japanese yen'};
const signed=(r:number)=>`${r<0?'−':'+'}${Math.abs(Math.round(r*100))}%`;
const tone=(r:number|null)=>r==null?undefined:r<0?styles.down:styles.up;

function Item({title,open=false,children}:{title:string;open?:boolean;children:ReactNode}) {
  return <details open={open}><summary><svg className={styles.chev} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5L7.5 6 4 9.5" stroke="#515d70" strokeWidth="1.6" fill="none" strokeLinecap="round"/></svg><span>{title}</span></summary>{children}</details>;
}

export function ValuationSummaryView({artifacts,conclusionStatus}:{artifacts:Row[];conclusionStatus?:string}) {
  const s=useMemo(()=>valuationSummary(artifacts,{conclusionStatus}),[artifacts,conclusionStatus]);
  const [pick,setPick]=useState<ScenarioType>('base');
  if(!s)return <p className={styles.muted}>No valuation has been saved for this run yet.</p>;
  const c=s.currency;
  const calc=s.calculations.find(x=>x.type===pick)??s.calculations.find(x=>x.type==='base')??s.calculations[0];
  const r=s.weightedReturn;
  return <div className={`${styles.embedded} ${styles.valuation}`}>
    {s.weighted!=null&&<section aria-label="Valuation summary" className={styles.hero}>
      <p className={styles.heroValue}>{price(s.weighted,c)}</p>
      <p className={styles.heroLine}>
        {['per share',s.terminalYear?` by ${s.terminalYear}`:''].join('')}
        {r!=null&&s.price!=null&&<> · <b className={tone(r)}>{Math.abs(r)<0.005?'in line with':`${Math.abs(Math.round(r*100))}% ${r<0?'below':'above'}`}</b> today’s {price(s.price,c)}{!s.priceVerified&&<span className={styles.muted}> (unverified)</span>}</>}
        {s.notFinal&&<> · <span className={styles.pending}>not final</span></>}
      </p>
      {!!s.scenarios.length&&<div className={styles.cases} role="list">{s.scenarios.map(x=><div role="listitem" key={x.type}>
        <div className={styles.caseName} data-case={x.type}><span aria-hidden="true">{glyphs[x.type]}</span> {scenarioNames[x.type]} {x.probability!=null&&<span>· {Math.round(x.probability*100)}%</span>}</div>
        <div className={styles.caseValue}>{price(x.value,c)}{x.return!=null&&<small className={tone(x.return)}>{signed(x.return)}</small>}</div>
      </div>)}</div>}
    </section>}
    {!!s.reasons.length&&<ol className={styles.reasons} aria-label="What drives the value">{s.reasons.map((x,i)=><li key={i}><span aria-hidden="true">{i+1}</span><span><b>{x.title}</b> <span>{x.text}</span></span></li>)}</ol>}
    <div className={styles.accordion}>
      {calc&&<Item title="How the value is calculated" open>
        <div className={styles.panel}>
          {s.calculations.length>1&&<span className={styles.switch} role="group" aria-label="Scenario">{s.calculations.map(x=><button type="button" key={x.type} aria-pressed={x.type===calc.type} onClick={()=>setPick(x.type)}>{scenarioNames[x.type]}</button>)}</span>}
          {!!calc.rows.length&&<table className={styles.numbers}>
            <thead><tr><th scope="col">{currencyNames[c.toUpperCase()]??c}</th>{calc.years.map(y=><th scope="col" key={y}>{y}</th>)}</tr></thead>
            <tbody>{calc.rows.map(row=><tr key={row.label} className={row.strong?styles.strong:undefined}><th scope="row">{row.label}</th>{row.values.map((v,i)=><td key={i} className={v!=null&&v<0?styles.negative:undefined}>{moneyMillions(v,c)}</td>)}</tr>)}</tbody>
          </table>}
          {!!calc.steps.length&&<ol className={styles.steps}>{calc.steps.map((step,i)=><li key={i}>{step.text}: <b>{step.value}</b>.</li>)}</ol>}
          {calc.note&&<p className={styles.note}>{calc.note}</p>}
        </div>
      </Item>}
      {!!s.assumptions.length&&<Item title={`Key assumptions${s.terminalYear?` for ${s.terminalYear}`:''}`}>
        <div className={styles.panel}>
          <table className={styles.numbers}>
            <thead><tr><th scope="col"><span className={styles.srOnly}>Assumption</span></th>{scenarioTypes.map(t=><th scope="col" key={t} data-case={t}>{glyphs[t]} {scenarioNames[t]}</th>)}</tr></thead>
            <tbody>{s.assumptions.map(a=>{const same=a.values.every(v=>v!=null&&v===a.values[0]);
              return <tr key={a.label}><th scope="row">{a.label}</th>{same?<td colSpan={3}>{a.values[0]} in all three</td>:a.values.map((v,i)=><td key={i}>{v??'–'}</td>)}</tr>;})}</tbody>
          </table>
          {s.method&&<p className={styles.muted}>Method: {s.method}.</p>}
        </div>
      </Item>}
      {s.notFinal&&!!s.issues.length&&<Item title="Why it’s not final"><ul className={styles.issues}>{s.issues.map((x,i)=><li key={i}>{x}</li>)}</ul></Item>}
      {(!!s.notes.length||!!s.omitted.length)&&<Item title="Sources and analyst notes">
        <div className={`${styles.panel} ${styles.notes}`}>
          {s.notes.map(n=><div key={n.type}>
            <h4>{scenarioNames[n.type]} case{n.method?` · ${n.method}`:''}</h4>
            {n.rationale&&<p>{n.rationale}</p>}
            {!!n.sourceNotes.length&&<ul>{n.sourceNotes.map((x,i)=><li key={i}>{x}</li>)}</ul>}
            {n.bridge&&<p>{n.bridge}</p>}
            {!!n.assumptions.length&&<table className={styles.numbers}><thead><tr><th scope="col">Year</th><th scope="col">Assumption</th><th scope="col">Value</th><th scope="col">Note</th></tr></thead>
              <tbody>{n.assumptions.map((a,i)=><tr key={i}><th scope="row">{a.year}</th><td>{a.label}</td><td>{a.value}</td><td>{a.note}</td></tr>)}</tbody></table>}
          </div>)}
          {!!s.omitted.length&&<><h4>Methods not used</h4><ul>{s.omitted.map((m,i)=><li key={i}><b>{m.method}.</b> {m.reason}</li>)}</ul></>}
        </div>
      </Item>}
    </div>
  </div>;
}
