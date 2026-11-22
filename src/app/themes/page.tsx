"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ui from "@/components/research-ui.module.css";
import { CompanyLogo } from "@/components/company/company";
import styles from "./themes.module.css";

type Theme = { id: string; theme: string; status: string; created_at: string; shortlist: { ticker: string; title?: string }[]; error: string | null };
const OBJECTIVES = [["growth", "Growth"], ["quality", "Quality (margins)"], ["value", "Value (earnings yield)"], ["balance_sheet", "Balance sheet (debt payback)"]] as const;
const ROLES = [["supplier", "Suppliers (picks and shovels)"], ["operator", "Operators"], ["other", "Other"]] as const;

/** Theme research: describe a theme and your objectives; past themes with their shortlists. */
export default function ThemesPage() {
  const router = useRouter();
  const [themes, setThemes] = useState<Theme[]>([]);
  const [theme, setTheme] = useState("");
  const [horizon, setHorizon] = useState(15);
  const [roles, setRoles] = useState<string[]>(["supplier"]);
  const [minExposure, setMinExposure] = useState(50);
  const [usOnly, setUsOnly] = useState(true);
  const [objectives, setObjectives] = useState<Record<string, number>>({ growth: 1, quality: 0.5, value: 0.5, balance_sheet: 0.5 });
  const [tickers, setTickers] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { fetch("/api/themes", { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject(new Error())).then(setThemes).catch(() => setError("Unable to load past themes.")); }, []);

  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const list = tickers.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
      const res = await fetch("/api/themes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        theme, horizon_years: horizon, roles, min_exposure: minExposure / 100, us_only: usOnly,
        objectives: { growth: objectives.growth, quality: objectives.quality, value: objectives.value, balance_sheet: objectives.balance_sheet }, ...(list.length ? { tickers: list } : {}) }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const field = body?.details?.fieldErrors ? Object.values(body.details.fieldErrors as Record<string, string[]>).flat()[0] : undefined;
        throw new Error(body?.details?.formErrors?.[0] ?? field ?? body?.error ?? "Unable to create the theme.");
      }
      router.push(`/themes/${body.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to create the theme."); } finally { setBusy(false); }
  }

  return <div className={ui.page}>
    <header className={ui.heading}><div className={ui.titleGroup}><h1>Theme research</h1>
      <span className={ui.muted}>A demand driver, candidates from independent sources counted for agreement, exclusions with reasons, a scorecard and a shortlist of four</span></div></header>
    {error && <p role="alert" className={ui.error}>{error}</p>}
    <div className={ui.grid}>
      <section className={`${ui.tile} ${ui.s7}`} aria-labelledby="theme-new">
        <div className={ui.tileHead}><h2 id="theme-new">New theme</h2></div>
        <form onSubmit={create} className={`${ui.form} ${ui.tileBody}`}>
          <label className={ui.field}>Theme<input required minLength={3} maxLength={200} placeholder="The future of electricity" value={theme} onChange={(e) => setTheme(e.target.value)} /></label>
          <div className={styles.row}>
            <label className={ui.field}>Horizon (years)<input type="number" min={3} max={30} value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} /></label>
            <label className={ui.field}>Minimum exposure (%)<input type="number" min={0} max={100} value={minExposure} onChange={(e) => setMinExposure(Number(e.target.value))} /></label>
          </div>
          <fieldset className={styles.fieldset}><legend>Roles</legend>
            {ROLES.map(([key, label]) => <label key={key} className={styles.check}><input type="checkbox" checked={roles.includes(key)}
              onChange={(e) => setRoles((r) => e.target.checked ? [...r, key] : r.filter((x) => x !== key))} />{label}</label>)}
          </fieldset>
          <label className={styles.check}><input type="checkbox" checked={usOnly} onChange={(e) => setUsOnly(e.target.checked)} />US-listed stocks only</label>
          <fieldset className={styles.fieldset}><legend>Objectives (weights)</legend>
            {OBJECTIVES.map(([key, label]) => <label key={key} className={styles.slider}><span>{label}</span>
              <input type="range" min={0} max={1} step={0.25} value={objectives[key]} onChange={(e) => setObjectives((o) => ({ ...o, [key]: Number(e.target.value) }))} />
              <span className={ui.mono}>{objectives[key].toFixed(2)}</span></label>)}
          </fieldset>
          <label className={ui.field}>Your tickers (optional, e.g. an ETF&apos;s holdings)<textarea rows={2} placeholder="PWR, HUBB, ETN" value={tickers} onChange={(e) => setTickers(e.target.value)} /></label>
          <div><button className={ui.primary} disabled={busy || !roles.length}>{busy ? "Creating…" : "Create theme"}</button></div>
          <p className={ui.muted}>Running a theme makes a few model calls (within a budget) and reads SEC data; nothing is bought or traded.</p>
        </form>
      </section>
      <section className={`${ui.tile} ${ui.s5}`} aria-labelledby="theme-past">
        <div className={ui.tileHead}><h2 id="theme-past">Past themes</h2><span className={ui.muted}>{themes.length}</span></div>
        {themes.length ? <div className={ui.list}>{themes.map((t) => <Link key={t.id} href={`/themes/${t.id}`} className={ui.row}>
          <div><div className={ui.rowTitle}>{t.theme}</div><div className={ui.rowMeta}>{t.status}{t.shortlist.length ? ` · ${t.shortlist.map((s) => s.ticker).join(", ")}` : ""} · {t.created_at.slice(0, 10)}</div></div>
          {t.shortlist.length > 0 && <div className={styles.logoStack} aria-hidden="true">{t.shortlist.slice(0, 4).map((s) => <CompanyLogo key={s.ticker} subject={{ name: s.title || s.ticker, ticker: s.ticker, kind: "equity" }} name={s.title || s.ticker} ticker={s.ticker} size={30} shape="round" />)}</div>}
        </Link>)}</div> : <p className={ui.empty}>No themes yet.</p>}
      </section>
    </div>
  </div>;
}
