"use client";
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {X,ArrowUp} from 'lucide-react';
import {safeUrl} from '@/lib/research/reporting/presentation.mjs';
import styles from './research-chat.module.css';
type Row=Record<string,any>;
/** A report passage attached to the next question ("Ask about this" in the notebook panel). */
export type ChatPassage={quote:string;section_id:string;section_title?:string};
/** Window event the notebook panel sends to open the chat with a passage attached. */
export const RESEARCH_CHAT_ASK='research-chat:ask';
/** Window event the chat sends after it saves an answer, so the workbench can show new scenario proposals. */
export const RESEARCH_CHAT_ANSWERED='research-chat:answered';
export function askResearchChat(passage:ChatPassage){window.dispatchEvent(new CustomEvent<ChatPassage>(RESEARCH_CHAT_ASK,{detail:passage}));}
/**
 * The research chat. `workbenchHref` turns a scenario proposal's reference ("<message>.<proposal>") into a link to
 * the Workbench tab, which applies that proposal from the stored conversation.
 */
export function ResearchChat({runId,evidence,workbenchHref}:{runId:string;evidence:Row[];workbenchHref?:(proposal:string)=>string}){
 const dialog=useRef<HTMLDialogElement>(null);const field=useRef<HTMLTextAreaElement>(null);
 const [messages,setMessages]=useState<Row[]>([]),[input,setInput]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[enabled,setEnabled]=useState(true),[passage,setPassage]=useState<ChatPassage|null>(null);
 async function load(){setError('');try{const res=await fetch(`/api/research-runs/${runId}/chat`);if(!res.ok)throw new Error('Unable to load conversation.');const data=await res.json();setMessages(data.messages);setEnabled(data.enabled);}catch(e){setError(String(e));}}
 useEffect(()=>{setMessages([]);setInput('');setPassage(null);dialog.current?.close();},[runId]);
 useEffect(()=>{
  const onAsk=(event:Event)=>{const detail=(event as CustomEvent<ChatPassage>).detail;if(!detail?.quote||!detail.section_id)return;
   setPassage({quote:String(detail.quote).slice(0,300),section_id:String(detail.section_id),section_title:detail.section_title?String(detail.section_title):undefined});
   if(!dialog.current?.open)dialog.current?.showModal();void load();window.setTimeout(()=>field.current?.focus(),0);};
  window.addEventListener(RESEARCH_CHAT_ASK,onAsk);return ()=>window.removeEventListener(RESEARCH_CHAT_ASK,onAsk);
  // load reads runId only; the listener is re-attached when the run changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[runId]);
 async function send(e:React.FormEvent){e.preventDefault();if(!input.trim()||busy)return;setBusy(true);setError('');try{const res=await fetch(`/api/research-runs/${runId}/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:input,...(passage?{passage:{quote:passage.quote,section_id:passage.section_id}}:{})})});const data=await res.json();if(!res.ok)throw new Error(data.error||'Unable to answer.');setMessages(data.messages);setInput('');setPassage(null);window.dispatchEvent(new Event(RESEARCH_CHAT_ANSWERED));}catch(e){setError(e instanceof Error?e.message:'Unable to answer.');}finally{setBusy(false);}}
 return <><button className={styles.launch} onClick={()=>{dialog.current?.showModal();void load();}}>Ask AI</button><dialog ref={dialog} className={styles.dialog} aria-label="Ask about this research"><header><div><h2>Ask about this research</h2><p>Answers use the selected run and its sources.</p></div><button aria-label="Close chat" onClick={()=>dialog.current?.close()}><X size={20}/></button></header>
  <div className={styles.messages} aria-live="polite">{!messages.length&&<p className={styles.empty}>What would you like to understand?<br/>Try “What drives the base-case valuation?”</p>}{messages.map((m,i)=><div key={i} className={styles.message} data-role={m.role}><strong>{m.role==='user'?'You':'Research assistant'}</strong>
   {m.passage?.quote&&<blockquote className={styles.quote}>{m.passage.section_title?<small>{m.passage.section_title}</small>:null}{m.passage.quote}</blockquote>}
   <p>{m.content}</p>{m.evidence_ids?.map((id:string)=>{const source=evidence.find(e=>e.id===id);const url=safeUrl(source?.url);return url?<a key={id} href={url} target="_blank" rel="noreferrer">{source?.source_title}</a>:null;})}
   {m.proposals?.map((p:Row,j:number)=><details key={j}><summary>Proposed change: {p.title}</summary><p>{p.rationale}</p><p>{p.research_question}</p><small>Review this proposal before starting new research.</small></details>)}
   {Array.isArray(m.scenario_proposals)&&m.scenario_proposals.map((p:Row,j:number)=><div key={`s${j}`} className={styles.scenario}><span>Scenario: {String(p.name)}</span><p>{String(p.rationale)}</p>{workbenchHref&&<Link href={workbenchHref(`${i}.${j}`)} onClick={()=>dialog.current?.close()}>Open in workbench</Link>}</div>)}
  </div>)}</div>
  {!enabled&&<p className={styles.notice}>AI chat is not enabled for this workspace. Your saved conversation is still available.</p>}{error&&<p role="alert" className={styles.notice}>{error}</p>}
  {passage&&<div className={styles.attached}><span>Asking about{passage.section_title?` “${passage.section_title}”`:' this passage'}</span><blockquote className={styles.quote}>{passage.quote}</blockquote><button type="button" onClick={()=>setPassage(null)}>Remove the passage</button></div>}
  <form onSubmit={send}><textarea ref={field} aria-label="Question about the research" placeholder={passage?'What would you like to know about this passage?':'Ask a question…'} value={input} onChange={e=>setInput(e.target.value)} maxLength={4000} disabled={busy||!enabled}/><button disabled={busy||!enabled||!input.trim()} aria-label="Send question">{busy?'Thinking…':<ArrowUp size={20}/>}</button></form></dialog></>;
}
