"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import styles from "./page.module.css";
import { Card, Segmented } from "@/components/ui/primitives";
import { PriceChart, RunsBars, type CaseKey } from "@/components/interactive";
import { money } from "@/components/interactive/format";
import { KpiGauges } from "@/components/visuals/valuation-visuals";
import { Leadership } from "@/components/company/company";
import type { AssetSnapshot } from "@/lib/research/asset-snapshot";
import { blendValue } from "@/lib/ui/chart-math";
import type { MemoSignal, ResearchMemo } from "@/lib/research/reporting/research-memo";
import type { PricePoint } from "@/lib/market-data/price-series";
import { runBars, type RunRow } from "@/lib/research/run-bars";
import { InlineLoading } from "@/components/ui/loading";

const RANGES = ["1M", "3M", "6M", "1Y"] as const;
type Range = (typeof RANGES)[number];
type Prices = { state: "loading" } | { state: "error" } | { state: "ready"; currency: string; points: PricePoint[] };
export type OverviewRisk = { name: string; probability: number | null; severity: number | null; detail: string | null; question: ReactNode };

const CASES: CaseKey[] = ["bear", "base", "bull"];
const CASE_NAME: Record<CaseKey, string> = { bear: "Bear", base: "Base", bull: "Bull" };
/** A gap as signed percent: −32.8%, +14.0%. */
const pct = (v: number | null) => (v === null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(1)}%`);
const tone = (v: number | null) => (v === null ? undefined : v >= 0 ? "good" : "bad");
/** "2026-11-17" → "17 Nov". */
const dayMonth = (d: string | null | undefined) => {
  const t = d ? Date.parse(String(d).slice(0, 10) + "T00:00:00Z") : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : null;
};
/** The first sentence when it is short ("Decision withheld."), else null. */
const leadSentence = (s: string | null) => {
  const m = s ? /^(.{4,60}?[.!?])\s/.exec(s.trim() + " ") : null;
  return m ? m[1] : null;
};

/** The blend position that gives the report's weighted value (blendValue is linear in t), clamped to 0..1. */
export function reportBlendT(values: { bear: number | null; base: number | null; bull: number | null }, weighted: number | null): number {
  const { bear, base, bull } = values;
  if (bear === null || base === null || bull === null || weighted === null || bull === bear) return 0.5;
  const t = (weighted - 0.5 * base - 0.5 * bear) / (0.5 * (bull - bear));
  return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0.5;
}

/** A drawer with a count, opened in place (Quant "How it was built"). */
function Drawer({ title, count, warn, children, defaultOpen = false }: { title: string; count?: ReactNode; warn?: boolean; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return <div className={styles.drawer} data-open={open ? "" : undefined}>
    <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
      <ChevronRight size={15} aria-hidden="true" />{title}{count !== undefined && <span className={styles.drawerCount} data-warn={warn ? "" : undefined}>{count}</span>}
    </button>
    <div className={styles.drawerBody} inert={!open}><div><div className={styles.drawerInner}>{children}</div></div></div>
  </div>;
}

/** A chart card's footer: how to read it on the left, small stats on the right. */
function Foot({ note, stats }: { note: ReactNode; stats?: { label: string; value: ReactNode }[] }) {
  return <div className={styles.foot}>
    <p>{note}</p>
    {stats && stats.length > 0 && <dl className={styles.footStats}>{stats.map((s) => <div key={s.label}><dt>{s.label}</dt><dd>{s.value}</dd></div>)}</dl>}
  </div>;
}

const SIGNAL_WORD: Record<MemoSignal["status"], [string, "good" | "warn" | "bad"]> = {
  better: ["Better than base", "good"], base: ["In base range", "good"], weaker: ["Below base", "warn"], near_bear: ["Near bear", "bad"],
};

/** One KPI on a bear-to-bull track (bear left, bull right whichever way the metric improves), with a status word. */
function SignalRow({ s }: { s: MemoSignal }) {
  const at = (p: number) => `${4 + Math.max(0, Math.min(1, p)) * 92}%`;
  const [word, t] = SIGNAL_WORD[s.status] ?? SIGNAL_WORD.base;
  return <div className={styles.kpi}>
    <div className={styles.kpiTop}><span>{s.label}<span className={styles.state} data-tone={t}>{word}</span></span><b>{s.display}</b></div>
    <div className={styles.kpiTrack} role="img" aria-label={`${s.label} ${s.display}: ${word.toLowerCase()}; bear ${s.bearDisplay}, bull ${s.bullDisplay}`}>
      {s.baseFrom !== null && s.baseTo !== null && <span className={styles.kpiBand} style={{ left: at(s.baseFrom), width: `calc(${at(s.baseTo)} - ${at(s.baseFrom)})` }} />}
      <i style={{ left: at(0) }} /><i style={{ left: at(1) }} />
      <b style={{ left: at(s.position) }} />
    </div>
    <div className={styles.kpiScale} aria-hidden="true"><span>Bear {s.bearDisplay}</span><span>{s.baseLow !== null ? `Base ${s.baseDisplay}` : ""}</span><span>Bull {s.bullDisplay}</span></div>
  </div>;
}

/** One risk: score (likelihood × impact), name and what to watch, severity as five pips; click to see how it would show up. */
function RiskRow({ r }: { r: OverviewRisk }) {
  const [open, setOpen] = useState(false);
  const score = r.probability !== null && r.severity !== null ? r.probability * r.severity : null;
  const level = score === null ? "low" : score >= 2.5 ? "high" : score >= 1.25 ? "medium" : "low";
  return <div className={styles.risk}>
    <button type="button" className={styles.riskHead} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
      <span className={styles.riskScore} data-level={level} aria-label={`${level} risk, score ${score === null ? "unknown" : score.toFixed(1)} of 5`}>{score === null ? "—" : score.toFixed(1)}</span>
      <span className={styles.riskText}><b>{r.name}</b>{r.detail && <span>{r.detail}</span>}</span>
      <span className={styles.riskSide}>
        <span className={styles.pips} aria-label={r.severity === null ? "severity unknown" : `severity ${r.severity} of 5`}>{[1, 2, 3, 4, 5].map((i) => <i key={i} data-on={r.severity !== null && i <= Math.round(r.severity) ? "" : undefined} />)}</span>
        <small>{r.probability === null ? "—" : `${Math.round(r.probability * 100)}% likely`}</small>
      </span>
    </button>
    {open && <div className={styles.riskMore}>{r.question}</div>}
  </div>;
}

/**
 * The company overview (SoFi redesign, prototype/workshop/sofi-research-redesign.html): the decision waiting on the
 * reader, what it's worth against today's close (report value, scenario tiles, the reader's blend) beside the price,
 * the report's verdict with what would change it, then KPIs and risks, runs and leadership. Gaps use today's close;
 * the report's own price is labelled with its date. Every number is stored data.
 */
export function CompanyOverview({ assetId, snapshot, memo, runs, fallbackStatement, risks, missing, monitorNote, onOpenReport, onOpenMemo }: {
  assetId: string;
  snapshot: AssetSnapshot | null;
  memo: ResearchMemo | null;
  runs: RunRow[];
  fallbackStatement: string | null;
  risks: OverviewRisk[];
  missing: string[] | null;
  monitorNote: string | null;
  onOpenReport: () => void;
  onOpenMemo: () => void;
}) {
  const [range, setRange] = useState<Range>("6M");
  const [prices, setPrices] = useState<Prices>({ state: "loading" });
  const [selected, setSelected] = useState<CaseKey>("base");
  const [attempt, setAttempt] = useState(0);
  const [explain, setExplain] = useState(false);
  const [readAll, setReadAll] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/assets/${assetId}/prices?range=${range}`)
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(String(res.status))))
      .then((data) => { if (!cancelled) setPrices({ state: "ready", currency: String(data.currency ?? "USD"), points: Array.isArray(data.points) ? data.points : [] }); })
      .catch(() => { if (!cancelled) setPrices({ state: "error" }); });
    return () => { cancelled = true; };
  }, [assetId, range, attempt]);

  const bars = useMemo(() => runBars(runs), [runs]);
  const newest = [...runs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  const budget = newest ? Number(newest.budget_limit_usd) : NaN;

  const withheld = memo ? !memo.verdict.valuationComplete : false;
  const values = snapshot?.values ?? { bear: null, base: null, bull: null };
  const reportPrice = snapshot?.price ?? memo?.verdict.price ?? null;
  const reportDay = dayMonth(memo?.verdict.priceDate);
  // Today's close from the stored daily prices; the report's price until they load.
  const points = prices.state === "ready" ? prices.points : [];
  const live = points.length ? points[points.length - 1].close : reportPrice;
  const liveIsNewer = points.length > 0 && reportPrice !== null && Math.abs((live ?? 0) - reportPrice) > 0.005;
  const currency = snapshot?.currency ?? (prices.state === "ready" ? prices.currency : "USD");
  const hasValue = !withheld && values.base != null;
  const headline = snapshot?.weighted ?? memo?.verdict.weighted ?? values.base ?? null;
  const headlineIsWeighted = (snapshot?.weighted ?? memo?.verdict.weighted ?? null) !== null;
  const gapToday = (v: number | null) => (v === null || !live ? null : v / live - 1);
  const statement = memo?.verdict.summary ?? fallbackStatement;
  const probs = snapshot?.probabilities;
  const canBlend = hasValue && values.bear != null && values.bull != null;
  const t0 = reportBlendT(values, headlineIsWeighted ? headline : null);
  const [t, setT] = useState(t0);
  const atReport = Math.abs(t - t0) < 0.005;
  const blend = atReport && headlineIsWeighted ? headline : blendValue(values, t);
  const caseValue = values[selected] ?? values.base;
  const extent = [live, ...CASES.map((k) => values[k])].filter((v): v is number => v !== null && Number.isFinite(v));
  const lo = Math.min(...extent), hi = Math.max(...extent), span = hi - lo || 1;
  const at = (v: number) => ((v - lo) / span) * 100;

  // The decision strip: a run waiting at the final review, from the memo.
  const waiting = memo?.reviewOpen ? bars.runs.find((r) => r.current) ?? null : null;
  const openQs = memo?.openQuestions ?? [];
  const lead = leadSentence(statement);
  const breakers = memo?.breakers ?? [];
  const signals = memo?.signals ?? [];
  const sortedRisks = [...risks].sort((a, b) => ((b.probability ?? 0) * (b.severity ?? 0)) - ((a.probability ?? 0) * (a.severity ?? 0)));
  const bullGap = gapToday(values.bull);

  return <div className={styles.overview}>
    {memo?.reviewOpen && <section className={styles.decision} data-open={checksOpen ? "" : undefined} aria-label="Decision waiting">
      <span className={styles.decisionBadge}>Needs your decision</span>
      <div className={styles.decisionText}>
        <strong>{lead ? `${lead} ` : ""}{headline !== null && live ? `Report value ${money(headline, currency)} against ${money(live, currency)} today.` : "The report is ready for your review."}</strong>
        <span>{waiting ? `${waiting.label} · ${money(waiting.cost, "USD")}` : "Latest run"}{openQs.length > 0 && <> · <button type="button" aria-expanded={checksOpen} onClick={() => setChecksOpen((o) => !o)}>{openQs.length} open question{openQs.length === 1 ? "" : "s"}</button></>}</span>
      </div>
      <button type="button" className={styles.decisionGo} onClick={onOpenMemo}>Review and decide</button>
      <div className={styles.decisionChecks} inert={!checksOpen}><div><ul>{openQs.slice(0, 6).map((q) => <li key={q.question}>{q.question}</li>)}</ul>
        {openQs.length > 6 && <p>{openQs.length - 6} more in the memo.</p>}</div></div>
    </section>}

    <div className={styles.overviewRow}>
      <Card title="What it's worth" className={`${styles.worthCard} ${styles.fill}`}
        action={hasValue && headlineIsWeighted && probs && CASES.every((k) => probs[k] !== null) ? <button type="button" className={styles.explainBtn} aria-expanded={explain} onClick={() => setExplain((e) => !e)}>How {money(headline as number, currency)} is made</button> : undefined}>
        {withheld ? <><p className={styles.withheld}>Value withheld</p>{memo?.verdict.withheldReason && <p className={styles.quiet}>{memo.verdict.withheldReason}</p>}</>
          : !hasValue ? <p className={styles.quiet}>No valuation saved for this run yet.</p>
          : <>
            <div>
              <div className={styles.headline}>{money(headline as number, currency)}</div>
              <p className={styles.headlineSub}>{headlineIsWeighted ? "Report's weighted value" : "Base value"} · <b data-tone={tone(gapToday(headline))}>{pct(gapToday(headline))}</b> vs {live ? money(live, currency) : "the price"} today</p>
            </div>
            {explain && probs && <p className={styles.explainBox}>The report weighs its three cases: {CASES.map((k) => `${CASE_NAME[k].toLowerCase()} ${money(values[k] as number, currency)} at ${Math.round((probs[k] as number) * 100)}%`).join(", ")}, which comes to {money(headline as number, currency)} a share.</p>}
            {values.bear != null && values.bull != null && <div className={styles.cases} role="group" aria-label="Scenario">
              {CASES.map((k) => {
                const v = values[k] as number, g = gapToday(v);
                const from = live ? Math.min(at(live), at(v)) : 0, to = live ? Math.max(at(live), at(v)) : at(v);
                return <button type="button" key={k} className={styles.caseTile} data-case={k} aria-pressed={selected === k} onClick={() => setSelected(k)}
                  aria-label={`${CASE_NAME[k]} case ${money(v, currency)}, ${pct(g)} versus today`}>
                  <span className={styles.caseName}>{CASE_NAME[k]}</span>
                  <span className={styles.caseRow}><span className={styles.caseGap} data-tone={tone(g)}>{pct(g)}</span><span className={styles.caseValue}>{money(v, currency)}</span></span>
                  <span className={styles.caseMeter}><span style={{ left: `${from}%`, width: `${Math.max(3, to - from)}%` }} />{live && <i style={{ left: `${at(live)}%` }} />}</span>
                  <span className={styles.pocket} aria-hidden="true">
                    <span><small>Weight</small>{probs?.[k] != null ? `${Math.round((probs[k] as number) * 100)}%` : "—"}</span>
                    <span><small>vs report price</small>{pct(snapshot?.gap[k] ?? null)}</span>
                  </span>
                </button>;
              })}
            </div>}
            {canBlend && blend !== null && <div className={styles.blend}>
              <div className={styles.blendRow}><span>Your blend</span><span><b>{money(blend, currency)}</b> <em data-tone={tone(gapToday(blend))}>{pct(gapToday(blend))}</em></span></div>
              <input type="range" min={0} max={1000} value={Math.round(t * 1000)} aria-label="Blend from cautious to hopeful" aria-valuetext={`Your blend ${money(blend, currency)}`}
                onChange={(e) => setT(Number(e.target.value) / 1000)} />
              <div className={styles.blendScale}><span>Cautious</span><span>{atReport && headlineIsWeighted ? "Report's weighting" : <button type="button" onClick={() => setT(t0)}>Back to the report&apos;s weighting</button>}</span><span>Hopeful</span></div>
            </div>}
            <Foot note={bullGap === null ? "Values a share in each case, discounted to today." : bullGap < 0 ? `Even the bull case is ${pct(-bullGap).replace("+", "")} below today's price.` : `The bull case is ${pct(bullGap)} against today's price.`}
              stats={reportPrice !== null ? [{ label: "Report price", value: `${money(reportPrice, currency)}${reportDay ? ` · ${reportDay}` : ""}` }] : undefined} />
          </>}
      </Card>
      <Card className={`${styles.priceCard} ${styles.fill}`}>
        {prices.state === "loading" ? <><h2 className={styles.cardTitle}>Price</h2><InlineLoading label="Loading prices" lines={3} /></>
          : prices.state === "error" ? <>
            <div className={styles.priceHead}><h2 className={styles.cardTitle}>Price</h2><Segmented label="Price range" options={RANGES} value={range} onChange={setRange} /></div>
            <p className={styles.quiet} role="alert">Prices couldn&apos;t be loaded. <button type="button" className={styles.link} onClick={() => setAttempt((n) => n + 1)}>Try again</button></p>
          </>
          : <>{prices.points.length > 0 && <h2 className="sr-only">Price</h2>}<PriceChart points={prices.points} currency={prices.currency} ranges={RANGES} range={range} onRange={setRange}
            valueLine={hasValue && caseValue != null ? { label: `${CASE_NAME[values[selected] != null ? selected : "base"]} value`, value: caseValue } : null} /></>}
        {prices.state === "ready" && prices.points.length > 1 && <Foot note={`Daily closes. The dashed line is the ${CASE_NAME[values[selected] != null ? selected : "base"].toLowerCase()} value; pick a case to move it.`}
          stats={[
            { label: `${range} high`, value: money(Math.max(...prices.points.map((p) => p.close)), prices.currency) },
            ...(liveIsNewer && reportPrice !== null ? [{ label: "Report price", value: money(reportPrice, prices.currency) }] : []),
          ]} />}
      </Card>
    </div>

    <Card title="The report says" action={<button type="button" className={styles.link} onClick={onOpenReport}>Full report</button>} className={styles.reportCard}>
      {statement ? <>
        <p className={styles.say} data-clamp={readAll ? undefined : ""}>{statement}</p>
        {statement.length > 240 && <button type="button" className={styles.link} onClick={() => setReadAll((r) => !r)}>{readAll ? "Show less" : "Read more"}</button>}
      </> : <p className={styles.quiet}>The report gives no conclusion to quote yet.</p>}
      {breakers.length > 0 && <div className={styles.breakers}>
        <h3>What would change the view</h3>
        {breakers.slice(0, 3).map((b) => <div key={b.name} className={styles.breaker}><b>{b.name}</b>{b.threshold && <span>{b.threshold}</span>}</div>)}
      </div>}
      {breakers.length > 3 && <Drawer title="More conditions" count={`+${breakers.length - 3}`}>
        {breakers.slice(3).map((b) => <div key={b.name} className={styles.breaker}><b>{b.name}</b>{b.threshold && <span>{b.threshold}</span>}</div>)}
      </Drawer>}
      {memo?.otherSide && <Drawer title="The other side" count="the bull rebuttal"><p>{memo.otherSide}</p></Drawer>}
      {missing && missing.length > 0 && <Drawer title="Research incomplete" count={`${missing.length} missing`} warn><ul>{missing.map((m) => <li key={m}>{m}</li>)}</ul></Drawer>}
    </Card>

    {(signals.length || snapshot?.kpis.length || risks.length) ? <div className={styles.overviewRow}>
      {signals.length > 0 ? <Card title="KPIs to watch" className={`${styles.half} ${styles.fill}`}>
        <div className={styles.kpiLegend} aria-hidden="true"><span><i data-k="band" />Base range</span><span><i data-k="tick" />Bear and bull triggers</span><span><i data-k="now" />Today</span></div>
        <div>{signals.slice(0, 6).map((s) => <SignalRow key={s.label} s={s} />)}</div>
        {signals.length > 6 && <Drawer title="More KPIs" count={`+${signals.length - 6}`}>{signals.slice(6).map((s) => <SignalRow key={s.label} s={s} />)}</Drawer>}
      </Card> : snapshot && snapshot.kpis.length > 0 ? <Card title="KPIs to watch" className={`${styles.half} ${styles.fill}`}><KpiGauges kpis={snapshot.kpis} /></Card> : null}
      {risks.length > 0 && <Card title="Risks" action={<span className={styles.quietSmall}>score = likelihood × impact, out of 5</span>} className={`${styles.half} ${styles.fill}`}>
        <div>{sortedRisks.slice(0, 5).map((r, i) => <RiskRow key={`${r.name}-${i}`} r={r} />)}</div>
        {sortedRisks.length > 5 && <Drawer title="More risks" count={`+${sortedRisks.length - 5}`}>{sortedRisks.slice(5).map((r, i) => <RiskRow key={`${r.name}-more-${i}`} r={r} />)}</Drawer>}
      </Card>}
    </div> : null}

    <div className={styles.overviewRow}>
      <Card className={`${styles.half} ${styles.fill}`}>
        <h2 className="sr-only">Research runs</h2>
        <RunsBars runs={bars.runs} budget={Number.isFinite(budget) && budget > 0 ? budget : null} />
        {monitorNote && <p className={styles.footnote}>{monitorNote}</p>}
      </Card>
      <Card title="Leadership" className={`${styles.half} ${styles.fill}`}>
        <Leadership subject={{ asset_id: assetId }} compact />
        <Foot note="Names and photos from Wikipedia and Wikimedia Commons; display only, not research evidence." />
      </Card>
    </div>
  </div>;
}
