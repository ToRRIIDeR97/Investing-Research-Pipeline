"use client";
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import ui from '@/components/research-ui.module.css';
export default function NewResearchPage(){
 const [assets,setAssets]=useState<{id:string;canonical_name:string;slug:string}[]>([]);const [name,setName]=useState('');const [ticker,setTicker]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);const router=useRouter();
 useEffect(()=>{fetch('/api/assets').then(r=>{if(!r.ok)throw new Error();return r.json();}).then(setAssets).catch(()=>setError('Unable to load assets. Reload to try again.'));},[]);
 async function add(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{const response=await fetch('/api/assets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({canonical_name:name.trim(),slug:ticker.trim().toLowerCase(),asset_kind:'equity'})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Unable to add company.');router.push(`/assets/${data.id}/run?new=1`);}catch(e){setError(e instanceof Error?e.message:'Unable to add company.');}finally{setBusy(false);}}
 return <div className={ui.page}><header className={ui.heading}><h1>Start research</h1></header><p className={ui.muted}>Choose a company, then set your research question, budget and cutoff.</p><section className={ui.section}><h2>Existing companies</h2>{assets.map(a=><Link className={ui.row} key={a.id} href={`/assets/${a.id}/run?new=1`}>{a.canonical_name}<span>Start →</span></Link>)}</section><section className={ui.section}><h2>Add a listed company</h2><form onSubmit={add} className="research-form"><label>Company name<input required maxLength={500} value={name} onChange={e=>setName(e.target.value)}/></label><label>Ticker<input required pattern="[A-Za-z0-9-]+" maxLength={30} placeholder="SOFI" value={ticker} onChange={e=>setTicker(e.target.value)}/></label><button className={ui.primary} disabled={busy}>{busy?'Adding company…':'Continue'}</button></form></section>{error&&<p role="alert" className={ui.error}>{error}</p>}</div>;
}
