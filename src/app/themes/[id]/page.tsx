"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import ui from "@/components/research-ui.module.css";
import { CompanyLogo } from "@/components/company/company";
import styles from "../themes.module.css";
import type { ThemeResult } from "@/lib/research/themes/pipeline";

type Theme = { id: string; theme: string; status: string; request: Record<string, any>; result: ThemeResult | null; error: string | null; cost_usd: number;
  created_at: string; completed_at: string | null };
const pct = (n: number | null | undefined, digits = 0) => n === null || n === undefined ? "—" : `${(n * 100).toFixed(digits)}%`;
const num = (n: number | null | undefined, digits = 1) => n === null || n === undefined ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: digits });
const millions = (n: number | null | undefined) => n === null || n === undefined ? "—" : `${(n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })}M`;

/** One theme: run it, then read the framing, candidates with source agreement, exclusions, scorecard, shortlist and ownership options. */
export default function ThemePage() {
  const id = String(useParams().id);
  const [theme, setTheme] = useState<Theme | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/themes/${id}`, { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? "Unable to load the theme.");
    return body as Theme;
  }, [id]);
  useEffect(() => { let live = true; load().then((t) => { if (live) setTheme(t); }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)); }); return () => { live = false; }; }, [load]);

  async function run() {
    setRunning(true); setError("");
    try {
      const res = await fetch(`/api/themes/${id}/run`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (body?.id) setTheme(body as Theme);
      if (!res.ok && !body?.id) throw new Error(body?.error ?? "Unable to run the theme.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setRunning(false); }
  }

  if (!theme) return <div className={ui.page}>{error ? <p role="alert" className={ui.error}>{error}</p> : <p className={ui.muted} role="status">Loading the theme…</p>}</div>;
  const r = theme.result, req = theme.request;
  return <div className={ui.page}>
    <header className={ui.heading}><div className={ui.titleGroup}><h1>{theme.theme}</h1>
      <span className={ui.muted}>{req.horizon_years}-year horizon · {(req.roles as string[]).join(", ")} · minimum exposure {pct(req.min_exposure)} · {req.us_only ? "US-listed only" : "any listing"}</span></div>
      <div className={ui.headActions}><Link href="/themes" className={ui.secondary}>All themes</Link>
        <button type="button" className={ui.primary} onClick={() => void run()} disabled={running || theme.status === "running"}>{running || theme.status === "running" ? "Researching…" : r ? "Run again" : "Run theme research"}</button></div>
    </header>
    {error && <p role="alert" className={ui.error}>{error}</p>}
    {theme.error && <p role="alert" className={ui.error}>{theme.error}</p>}
    {!r ? <section className={ui.tile}><p className={ui.empty}>{theme.status === "running" ? "Research is running." : "Not run yet. Running makes a few model calls within the theme budget and reads SEC data."}</p></section> : <>
      <section className={ui.tile} aria-labelledby="t-shortlist">
        <div className={ui.tileHead}><h2 id="t-shortlist">Shortlist</h2><span className={ui.muted}>Ranked by your objectives · model cost ${theme.cost_usd.toFixed(4)}</span></div>
        <div className={styles.shortlist}>{r.shortlist.length ? r.shortlist.map((s, i) => <div key={s.ticker} className={styles.pick}>
          <div className={styles.pickHead}><CompanyLogo subject={{ name: s.title, ticker: s.ticker, kind: "equity" }} name={s.title} ticker={s.ticker} size={44} /><span className={styles.rank}>#{i + 1}</span></div>
          <strong>{s.ticker}</strong><span>{s.title}</span><span className={ui.muted}>Score {s.score}</span>
          <Link className={ui.textLink} href={`/research/new?ticker=${encodeURIComponent(s.ticker)}&name=${encodeURIComponent(s.title)}`}>Start research</Link>
        </div>) : <p className={ui.empty}>No candidate could be scored.</p>}</div>
        <div className={ui.tileBody}><h3>Ways to own the theme</h3><ul>{r.ownership.map((o) => <li key={o.kind}><strong>{o.title}.</strong> {o.text}</li>)}</ul>
          {r.notes.map((n, i) => <p key={i} className={styles.note}>{n}</p>)}</div>
      </section>

      <div className={ui.grid}>
        <section className={`${ui.tile} ${ui.s5}`} aria-labelledby="t-framing">
          <div className={ui.tileHead}><h2 id="t-framing">Framing</h2><span className={ui.muted}>{r.framing.label}</span></div>
          <div className={ui.tileBody}>
            <p><strong>Demand driver.</strong> {r.framing.demand_driver}</p>
            <ul>{r.framing.components.map((c, i) => <li key={i}><strong>{c.name}:</strong> {c.why}</li>)}</ul>
            <p><strong>Over the horizon.</strong> {r.framing.horizon_view}</p>
            <p><strong>Exposure to want.</strong> {r.framing.exposure_wanted}</p>
            {r.framing.sources.length > 0 && <p className={styles.note}>Sources to read (named by the model): {r.framing.sources.join("; ")}</p>}
            <p className={styles.note}>{r.method}</p>
          </div>
        </section>
        <section className={`${ui.tile} ${ui.s7}`} aria-labelledby="t-sources">
          <div className={ui.tileHead}><h2 id="t-sources">Sources</h2><span className={ui.muted}>{r.sources.length}</span></div>
          <div className={ui.list}>{r.sources.map((s) => <div key={s.source} className={ui.row}><div>
            <div className={ui.rowTitle}>{s.label}</div><div className={ui.rowMeta}>{s.tickers.length} tickers{s.note ? ` · ${s.note}` : ""}</div></div></div>)}</div>
        </section>
      </div>

      <section className={`${ui.tile} ${ui.section}`} aria-labelledby="t-candidates">
        <div className={ui.tileHead}><h2 id="t-candidates">Candidates and source agreement</h2><span className={ui.muted}>Exposure and role are model estimates</span></div>
        <div className={ui.table}><table><thead><tr><th>Ticker</th><th>Company</th><th className={ui.num}>Sources</th><th>Named by</th><th>Role</th><th className={ui.num}>Exposure</th><th>Status</th></tr></thead>
          <tbody>{r.candidates.map((c) => <tr key={c.ticker}><td><span className="inline-flex items-center gap-2"><CompanyLogo subject={{ name: c.name, ticker: c.ticker, kind: "equity" }} name={c.name} ticker={c.ticker} size={26} /><span className={ui.mono}>{c.ticker}</span></span></td><td>{c.name}<div className={styles.note}>{c.reasons[0] ?? ""}</div></td>
            <td className={ui.num}>{c.count}</td><td>{c.sources.map((s) => <span key={s} className={styles.pill}>{s}</span>)}</td><td>{c.role ?? "—"}</td>
            <td className={ui.num}>{pct(c.exposure)}</td><td>{c.status}{c.flags.length ? ` (${c.flags.join("; ")})` : ""}</td></tr>)}</tbody></table></div>
      </section>

      <section className={`${ui.tile} ${ui.section}`} aria-labelledby="t-excluded">
        <div className={ui.tileHead}><h2 id="t-excluded">Exclusions</h2><span className={ui.muted}>{r.excluded.length}</span></div>
        {r.excluded.length ? <div className={ui.list}>{r.excluded.map((e) => <div key={e.ticker} className={ui.row}><div><div className={ui.rowTitle}>{e.ticker}</div><div className={ui.rowMeta}>{e.reason}</div></div></div>)}</div>
          : <p className={ui.empty}>Nothing was excluded.</p>}
      </section>

      <section className={`${ui.tile} ${ui.section}`} aria-labelledby="t-scorecard">
        <div className={ui.tileHead}><h2 id="t-scorecard">Scorecard</h2><span className={ui.muted}>From SEC companyfacts (10-K), computed in code</span></div>
        <div className={ui.table}><table><thead><tr><th>Ticker</th><th>FY end</th><th className={ui.num}>Revenue</th><th className={ui.num}>Growth 1y</th><th className={ui.num}>CAGR 5y</th>
          <th className={ui.num}>Op. margin</th><th className={ui.num}>Net debt</th><th className={ui.num}>FCF</th><th className={ui.num}>Payback (yrs)</th><th className={ui.num}>P/E</th><th className={ui.num}>Score</th></tr></thead>
          <tbody>{r.scorecard.map((s) => { const rank = r.ranked.find((x) => x.ticker === s.ticker); return <tr key={s.ticker}>
            <td className={ui.mono}>{s.ticker}</td>{s.error ? <td colSpan={10}>{s.error}</td> : <>
            <td>{s.fiscal_year_end ?? "—"}</td><td className={ui.num}>{millions(s.revenue)}</td><td className={ui.num}>{pct(s.revenue_growth_1y, 1)}</td><td className={ui.num}>{pct(s.revenue_cagr_5y, 1)}</td>
            <td className={ui.num}>{pct(s.operating_margin, 1)}</td><td className={ui.num}>{millions(s.net_debt)}</td><td className={ui.num}>{millions(s.fcf)}</td>
            <td className={ui.num}>{num(s.payback_years)}</td><td className={ui.num}>{num(s.pe_ttm)}</td><td className={ui.num}>{rank ? rank.score : "—"}</td></>}</tr>; })}</tbody></table></div>
      </section>
    </>}
  </div>;
}
