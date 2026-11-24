"use client";
/**
 * The Quant page (Implementations/quant-page, layout Q2): a summary rail and Value / Trend tabs over one snapshot.
 * Built by code from SEC facts and stored prices; no model calls. Separate from Research, with links across.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Card, Segmented, Tag } from "@/components/ui/primitives";
import ui from "@/components/research-ui.module.css";
import type { QuantSnapshot } from "@/lib/api/quant";
import { MultipleBand, PriceVolumeChart, RebasedChart, STAGE_FILL, Sparkline, StageStrip, ValueBuild, ValuePathChart, VcpDepths, type Case } from "./quant-charts";
import { C } from "@/components/ui/palette";
import { caseMeter, gradeTone } from "./tones";
import { explainEngine, parseEngineNote } from "./engine-note";
import { HowItWasBuilt } from "./how-built";
import { CompanyLogo } from "@/components/company/company";
import styles from "./quant.module.css";

export type QuantTab = "value" | "trend";
/** The tab named by `?tab=`: "trend" (any case) opens Trend; anything else, or nothing, opens Value. */
export function parseQuantTab(raw: string | null | undefined): QuantTab {
  return raw?.trim().toLowerCase() === "trend" ? "trend" : "value";
}
const pct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(digits)}%`);
const rate = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`);
/** Two decimals in text (chart labels round to whole dollars above $100); negatives as −$x. */
const money = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`);
const weeks = (n: number) => `${n} week${n === 1 ? "" : "s"}`;

export function researchHref(s: QuantSnapshot): string {
  return s.research ? `/assets/${s.research.asset_id}/view` : `/research/new?ticker=${encodeURIComponent(s.ticker)}&name=${encodeURIComponent(s.name)}`;
}

/** Share of trend conditions met as a tone: two thirds or more good, a third or more caution, else bad. */
function trendTone(passed: number, evaluated: number): "good" | "caution" | "bad" | undefined {
  if (!evaluated) return undefined;
  const r = passed / evaluated;
  return r >= 2 / 3 ? "good" : r >= 1 / 3 ? "caution" : "bad";
}

/**
 * The first card of each tab: what the numbers below are built from, as a badge, a line, and a few figures. With an
 * `explain` sentence the badge is a button: clicking it grows its navy across the whole card and shows that one plain
 * sentence in place of the line and figures. Clicking it again, pressing Escape or clicking elsewhere closes it.
 */
function ContextStrip({ label, badge, title, line, figures, explain }: { label: string; badge: string; title: string; line: string; figures: { label: string; value: string }[]; explain?: string | null }) {
  const id = `ctx-${label.replace(/\W+/g, "-").toLowerCase()}`;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", esc); };
  }, [open]);
  return <section ref={box} className={styles.context} aria-label={label} data-open={open ? "" : undefined}>
    {explain && <span className={styles.contextFill} aria-hidden="true" />}
    {explain ? <button type="button" className={styles.contextBadge} aria-expanded={open} aria-controls={id}
      title={open ? "Hide explanation" : "What does this mean?"} onClick={() => setOpen((o) => !o)}>{badge}</button>
      : <span className={styles.contextBadge}>{badge}</span>}
    <div className={styles.contextText}><strong>{title}</strong><span>{line}</span></div>
    {figures.length > 0 && <dl className={styles.contextFigures}>{figures.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>}
    {explain && <p className={styles.contextExplain} id={id} aria-hidden={!open}>{explain}</p>}
  </section>;
}

function Rail({ s }: { s: QuantSnapshot }) {
  const v = s.value, t = s.trend;
  const pulse = v?.pulse_score ?? null;
  return <aside className={styles.rail} aria-label={`${s.name} summary`}>
    <div className={styles.who}>
      <CompanyLogo subject={s.research ? { asset_id: s.research.asset_id } : { name: s.name, ticker: s.ticker, kind: "equity" }} name={s.name} ticker={s.ticker} size={52} />
      <h1>{s.name}</h1>
      <div className={styles.whoMeta}><Tag>{s.ticker}</Tag><span className={styles.sub}>{[s.sector !== "Unknown" ? s.sector : null, s.industry !== "Unknown" ? s.industry : s.sic_description].filter(Boolean).join(" · ")}</span></div>
    </div>
    <div className={styles.priceBlock}><span className={styles.price}>{money(s.price)}</span><span className={styles.sub}>close {s.as_of}</span></div>
    <Sparkline points={t.charts.sparkline} />
    {v ? <>
      <div className={styles.grades}>
        {/* One grade: PQ-Grade weighs the value gap together with the upside/downside balance (PulseGrade is the gap alone). */}
        <div className={styles.grade} data-grade={gradeTone(v.pq_grade.grade)}>
          <span>PQ-Grade</span>
          <div className={styles.gradeRow}><b>{v.pq_grade.grade}</b><span className={styles.gradeLabel}>{v.pq_grade.label}</span></div>
          <span className={styles.gradeHow}>Value gap and upside versus downside, weighed by confidence</span>
        </div>
      </div>
      <div>
        <span className={styles.sub}>PulseScore <b className={styles.pulse} data-tone={pulse === null ? undefined : pulse > 0.25 ? "good" : pulse < -0.25 ? "bad" : undefined}>{pulse === null ? "unavailable" : `${pulse > 0 ? "+" : ""}${pulse.toFixed(2)}`}</b></span>
        <div className={styles.gauge} role="img" aria-label={pulse === null ? "PulseScore unavailable" : `PulseScore ${pulse.toFixed(2)} on a scale from −3 (overvalued) to +3 (undervalued)`}>
          <span className={styles.gaugeMid} />{pulse !== null && <span className={styles.gaugePin} style={{ left: `${((Math.max(-3, Math.min(3, pulse)) + 3) / 6) * 100}%` }} />}
        </div>
        <div className={styles.gaugeScale}><span>−3 over</span><span>fair</span><span>+3 under</span></div>
      </div>
    </> : <p className={styles.unavailable}>PragValue unavailable: {s.value_reason}</p>}
    <dl className={styles.facts}>
      <div><dt>Trend</dt><dd><i className={styles.dot} data-tone={trendTone(t.conditions.passed, t.conditions.evaluated)} aria-hidden="true" />{t.conditions.score_label}</dd></div>
      <div><dt>Stage</dt><dd>{t.stage && <i className={styles.dot} style={{ background: STAGE_FILL[t.stage.stage_number] ?? STAGE_FILL[0] }} aria-hidden="true" />}{t.stage ? `${t.stage.stage_number} · ${weeks(t.stage.weeks_in_stage)}` : "—"}</dd></div>
      <div><dt>RS rating</dt><dd>{t.rs.combined ?? "—"}</dd></div>
      {v && <div><dt>Confidence</dt><dd>{v.confidence}</dd></div>}
      <div><dt>Research</dt><dd>{s.research ? <Link href={researchHref(s)}>{s.research.status ? `Open (${s.research.status.replace(/_/g, " ")})` : "Open"}</Link> : "Not started"}</dd></div>
    </dl>
    <div className={styles.actions}>
      <Link className={ui.primary} href={researchHref(s)}>{s.research ? "Open research" : "Deep research"}</Link>
    </div>
  </aside>;
}

/** Measures the space it is given and renders a chart at that size, so a chart fills a card stretched by its row. */
function Fill({ className, children }: { className?: string; children: (width: number, height: number) => ReactNode }) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox((b) => {
      const w = Math.round(e.contentRect.width), h = Math.round(e.contentRect.height);
      return b && b.w === w && b.h === h ? b : { w, h };
    }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <div ref={ref} className={className}>{children(box?.w ?? 420, box?.h ?? 210)}</div>;
}

/**
 * The exit multiples each scenario ends year 5 on (from the low, middle and high of the company's own history of the
 * DCF metric), as three case-coloured bars. The engine's multiple history is drawn under them when there is one.
 */
function ExitMultiples({ s }: { s: QuantSnapshot }) {
  const d = s.value!.dcf, h = s.value!.charts.multiple_history;
  const exits = (["bear", "base", "bull"] as const).map((k) => ({ k, x: d[`exit_multiple_${k}`] }));
  const max = Math.max(...exits.map((e) => e.x || 0));
  const raw = d.exit_metric && d.exit_metric !== "N/A" ? d.exit_metric : h.metric;
  // "Median of 3 metrics (P/S, P/FCF, P/OCF)" reads as "the median of P/S, P/FCF and P/OCF".
  const blend = /^Median of \d+ metrics \((.+)\)$/.exec(raw)?.[1].split(/,\s*/);
  const metric = blend ? `the median of its ${blend.slice(0, -1).join(", ")} and ${blend[blend.length - 1]}` : raw;
  const hasHistory = h.points.filter((p) => Number.isFinite(p.multiple)).length >= 2;
  return <Card title={blend ? "Exit multiples" : `Exit multiples on ${metric}`}>
    {max > 0 ? <div className={styles.exits}>
      {exits.map((e) => <div key={e.k} data-case={e.k}>
        <span className={styles.exitName}>{e.k[0].toUpperCase() + e.k.slice(1)}</span>
        <b>{e.x ? `${e.x.toFixed(1)}x` : "—"}</b>
        <span className={styles.exitBar}><span style={{ width: `${Math.max(4, ((e.x || 0) / max) * 100)}%` }} /></span>
      </div>)}
    </div> : <p className={styles.unavailable}>No exit multiples: the DCF was skipped.</p>}
    <p className={styles.caption}>Each case values the company in year 5 at {blend ? `${metric} multiples` : `this ${metric} multiple`}, set from the low, middle and high of its own history.</p>
    {hasHistory ? <div className={styles.exitHistory}>
      <h3>{h.metric} at each fiscal year end</h3>
      <MultipleBand {...h} />
      <p className={styles.caption}>Shaded: 25th to 75th percentile of its own history.</p>
    </div> : <p className={styles.exitNote}>No {h.metric} history to chart{s.fundamentals?.missing.includes("ebit") && /EBIT/.test(h.metric) ? ": EBIT isn't reported in its filings" : ""}.</p>}
  </Card>;
}

function ValueTab({ s, pick, setPick }: { s: QuantSnapshot; pick: Case; setPick: (c: Case) => void }) {
  const v = s.value;
  if (!v) return <Card title="PragValue"><p className={styles.unavailable}>{s.value_reason}</p></Card>;
  const d = v.dcf, y5 = d.price_targets[d.price_targets.length - 1];
  const fwd = v.charts.projection[v.charts.projection.length - 1];
  const caseLabel: Record<Case, string> = { bear: "Bear", base: "Base", bull: "Bull" };
  const rows = (["bear", "base", "bull"] as const).map((k) => ({
    k, growth: d[`growth_rate_${k}`], exit: d[`exit_multiple_${k}`], value: d[`intrinsic_value_${k}`],
    forward: fwd && fwd.year > 0 ? fwd[k] : null, ret: y5 ? y5[`${k}_return`] : null,
  }));
  return <>
    {(() => {
      const e = parseEngineNote(v.engine_result.engine_note);
      return <ContextStrip label="Valuation engine" badge={e.code ? `Engine ${e.code}` : "Engine"} title={e.audience ?? "Valuation engine"} line={e.method} figures={e.figures} explain={explainEngine(e.code)} />;
    })()}
    {/* The scenarios as upside-first tiles (workshop V6, door D3): the upside leads, a meter runs from today's price
        to the case value, and growth and exit multiple slide in from the left on hover or keyboard focus. */}
    <div className={styles.cases} role="group" aria-label="Scenario">
      {rows.map((r) => {
        const vs = r.value && s.price ? r.value / s.price - 1 : null;
        const meter = caseMeter(s.price, rows.map((x) => x.value), r.value);
        const exit = r.exit ? `${r.exit.toFixed(1)}x` : "—";
        return <button type="button" key={r.k} className={styles.caseTile} data-case={r.k} aria-pressed={pick === r.k} onClick={() => setPick(r.k)}
          aria-label={`${caseLabel[r.k]} case: ${money(r.value)} a share${vs === null ? "" : `, ${pct(vs)} versus today's price`}; growth ${pct(r.growth)}, exit multiple ${exit}`}>
          <span className={styles.caseName}>{caseLabel[r.k]} case</span>
          <span className={styles.caseRow}>
            <span className={styles.caseUp} data-tone={vs === null ? undefined : vs >= 0 ? "good" : "bad"}>{vs === null ? "—" : pct(vs)}</span>
            <span className={styles.caseValue}>{money(r.value)}<small>a share</small></span>
          </span>
          {meter && <>
            <span className={styles.caseMeter}><span style={{ left: `${meter.left}%`, width: `${meter.width}%` }} /><i style={{ left: `${meter.tick}%` }} /></span>
            <span className={styles.caseScale}><span>{meter.lo === s.price ? `${money(s.price)} today` : money(meter.lo)}</span><span>{money(meter.hi)}</span></span>
          </>}
          <span className={styles.pocket} aria-hidden="true">
            <span><small>Growth</small>{pct(r.growth)}</span>
            <span><small>Exit multiple</small>{exit}</span>
          </span>
        </button>;
      })}
    </div>
    <Card title="Price and value paths" action={<span className={styles.caseKey} data-case={pick}>{caseLabel[pick]} case</span>}>
      <ValuePathChart history={s.price_history_5y} projection={v.charts.projection} selected={pick} current={s.price} />
      {/* How to read the chart, and the two DCF settings behind it. The case values themselves are in the tiles above. */}
      <div className={styles.chartFoot}>
        <p>The line is the case&apos;s value in each year, before discounting. The tiles above show it discounted to today.</p>
        {d.dcf_skipped ? <p className={styles.callout}><b aria-hidden="true">!</b>{d.dcf_skip_reason}</p>
          : <dl className={styles.footStats}>
            <div><dt>Discount rate</dt><dd>{rate(d.discount_rate)}</dd></div>
            <div><dt>Growth fades to</dt><dd>{rate(d.terminal_growth_rate)}</dd></div>
            <div><dt>Horizon</dt><dd>{fwd?.year || 5} years</dd></div>
          </dl>}
      </div>
    </Card>
    <div className={styles.cardGrid}>
      <Card className={styles.fillCard} title={v.charts.value_build ? `From cash flows to ${money(v.charts.value_build.per_share)} a share` : "Value build"}>
        {v.charts.value_build ? <>
          <Fill className={styles.fillChart}>{(w, h) => <ValueBuild build={v.charts.value_build!} width={w} height={h} />}</Fill>
          <p className={styles.caption}>Base case on {v.charts.value_build.metric}; terminal value is {(v.charts.value_build.terminal_share * 100).toFixed(0)}% of the total.</p>
        </> : <p className={styles.unavailable}>{d.dcf_skipped ? d.dcf_skip_reason : "No metric-level DCF to break down."}</p>}
      </Card>
      <ExitMultiples s={s} />
    </div>
    <Card title="Scenarios" flush>
      <div className={styles.tableBox}>
        <table className={styles.table}>
          <thead><tr><th scope="col">Case</th><th scope="col">Growth</th><th scope="col">Exit multiple</th><th scope="col">Intrinsic value</th><th scope="col">Year-{fwd?.year || 5} value (forward)</th><th scope="col">Return a year</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.k} data-case={r.k} aria-current={pick === r.k ? "true" : undefined}>
            <th scope="row">{caseLabel[r.k]}</th><td>{pct(r.growth)}</td><td>{r.exit ? `${r.exit.toFixed(1)}x` : "—"}</td>
            <td>{money(r.value)}</td><td>{money(r.forward)}</td><td data-tone={r.ret == null ? undefined : r.ret >= 0 ? "good" : "bad"}>{pct(r.ret)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </Card>
    <HowItWasBuilt s={s} />
  </>;
}

/** Percent with a sign, for slopes and distances already in percent. */
const signedPct = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}%`;
const STAGE_NAME: Record<number, string> = { 1: "Basing", 2: "Advancing", 3: "Topping", 4: "Declining" };

/**
 * A Trend signal tile, built like the Value tab's scenario tiles: a coloured name, the big figure, a meter, and the
 * detail on a pocket door that slides in on hover or keyboard focus (on touch screens it stays open).
 */
function SignalTile({ name, color, value, tone, side, meter, scale, door, label }: {
  name: string; color: string; value: string; tone?: "good" | "bad"; side: ReactNode; meter: ReactNode; scale: [string, string];
  door: { k: string; v: string }[]; label: string;
}) {
  return <div className={styles.caseTile} data-signal="" tabIndex={0} aria-label={label}
    style={{ ["--case-color" as string]: color, ["--case-tint" as string]: `color-mix(in srgb, ${color} 12%, var(--tile))` }}>
    <span className={styles.caseName}>{name}</span>
    <span className={styles.caseRow}><span className={styles.caseUp} data-tone={tone}>{value}</span><span className={styles.caseValue}>{side}</span></span>
    {meter}
    <span className={styles.caseScale}><span>{scale[0]}</span><span>{scale[1]}</span></span>
    <span className={styles.pocket} aria-hidden="true">{door.map((d) => <span key={d.k}><small>{d.k}</small>{d.v}</span>)}</span>
  </div>;
}

/** A row of equal segments, the first `on` filled (or only `only`, when given). */
function Segments({ count, on, only }: { count: number; on: number; only?: number }) {
  return <span className={styles.segMeter}>{Array.from({ length: count }, (_, i) => <span key={i} data-on={(only !== undefined ? i === only : i < on) ? "" : undefined} />)}</span>;
}

function TrendTab({ s }: { s: QuantSnapshot }) {
  const t = s.trend;
  const pivots = t.pocket_pivots.events.map((e) => e.day);
  const tone = trendTone(t.conditions.passed, t.conditions.evaluated);
  const toneColor = tone === "good" ? C.positive : tone === "caution" ? C.caution : tone === "bad" ? C.critical : C.ink3;
  const st = t.stage;
  const stageColor = st ? STAGE_FILL[st.stage_number] ?? STAGE_FILL[0] : C.ink3;
  const rs = t.rs.combined;
  const rsColor = rs === null ? C.ink3 : rs > 70 ? C.positive : rs >= 50 ? C.caution : C.critical;
  const mansfield = t.conditions.mansfield;
  const last = t.charts.price[t.charts.price.length - 1];
  const p52 = t.position_52w;
  const pivotCount = t.pocket_pivots.events.length;
  return <>
    <ContextStrip label="Price data" badge="Daily" title={`Daily closes to ${s.as_of}`} line="Split-adjusted, from stored daily bars"
      figures={[{ label: "Benchmark", value: "S&P 500" }, ...(s.sector_etf ? [{ label: "Sector", value: s.sector_etf }] : [])]}
      explain={`Every trend signal below uses each day's closing price, adjusted for splits, compared with the S&P 500${s.sector_etf ? ` and the ${s.sector_etf} sector fund` : ""}.`} />

    {/* The three signals as tiles, like the Value tab's scenarios: trend template, Weinstein stage, relative strength. */}
    <div className={styles.cases}>
      <SignalTile name="Trend template" color={toneColor} value={`${t.conditions.passed}/${t.conditions.evaluated}`} tone={tone === "good" ? "good" : tone === "bad" ? "bad" : undefined}
        side={<>conditions<small>met</small></>} meter={<Segments count={Math.max(1, t.conditions.evaluated)} on={t.conditions.passed} />} scale={["None", "All"]}
        door={[{ k: "Mansfield RS", v: mansfield ? `${mansfield.value > 0 ? "+" : ""}${mansfield.value}` : "—" }, { k: "Signal", v: mansfield ? mansfield.signal.toLowerCase() : "—" }]}
        label={`Trend template: ${t.conditions.score_label}${mansfield ? `; Mansfield RS ${mansfield.value} (${mansfield.signal.toLowerCase()})` : ""}`} />
      <SignalTile name="Weinstein stage" color={stageColor} value={st ? `Stage ${st.stage_number}` : "—"} tone={st?.stage_number === 2 ? "good" : st?.stage_number === 4 ? "bad" : undefined}
        side={<>{st ? STAGE_NAME[st.stage_number] ?? "" : ""}<small>{st ? weeks(st.weeks_in_stage) : "needs 200 days"}</small></>}
        meter={<Segments count={4} on={0} only={st ? st.stage_number - 1 : -1} />} scale={["1 basing", "4 declining"]}
        door={st ? [{ k: "30-week average", v: st.sma_30w_slope_pct > 0 ? `rising ${st.sma_30w_slope_pct}%` : st.sma_30w_slope_pct < 0 ? `falling ${Math.abs(st.sma_30w_slope_pct)}%` : "flat" }, { k: "Price vs it", v: signedPct(st.price_vs_sma_30w_pct) }] : [{ k: "Stage", v: "needs 200 trading days" }]}
        label={st ? `Weinstein stage ${st.stage_number}, ${st.label}, for ${weeks(st.weeks_in_stage)}` : "Weinstein stage needs 200 trading days of prices"} />
      <SignalTile name="RS rating" color={rsColor} value={rs === null ? "—" : String(rs)} tone={rs === null ? undefined : rs > 70 ? "good" : rs < 50 ? "bad" : undefined}
        side={<>of 99<small>{rs !== null && rs > 70 ? "above 70" : "70 to pass"}</small></>}
        meter={<span className={styles.caseMeter}><span style={{ left: 0, width: `${rs === null ? 0 : Math.min(100, (rs / 99) * 100)}%` }} /><i style={{ left: `${(70 / 99) * 100}%` }} /></span>}
        scale={["1", "99"]}
        door={[{ k: "vs S&P 500", v: t.rs.vs_spx === null ? "—" : String(t.rs.vs_spx) }, ...(t.rs.sector_symbol ? [{ k: `vs ${t.rs.sector_symbol}`, v: t.rs.vs_sector === null ? "—" : String(t.rs.vs_sector) }] : [])]}
        label={`RS rating ${rs ?? "unavailable"} of 99: S&P 500 ${t.rs.vs_spx ?? "—"}${t.rs.sector_symbol ? `, ${t.rs.sector_symbol} ${t.rs.vs_sector ?? "—"}` : ""}`} />
    </div>

    <Card title="Price, averages and volume">
      <PriceVolumeChart series={t.charts.price} pivots={pivots} />
      <div className={styles.chartFoot}>
        <p>Daily closes with the 50, 150 and 200-day averages. Green rings mark pocket pivots: up days on unusually heavy volume.</p>
        {last && <dl className={styles.footStats}>
          <div><dt>Close</dt><dd>{money(last.close)}</dd></div>
          <div><dt>50-day</dt><dd>{money(last.sma50)}</dd></div>
          <div><dt>200-day</dt><dd>{money(last.sma200)}</dd></div>
        </dl>}
      </div>
    </Card>
    <div className={styles.cardGrid}>
      <Card title="Rebased to 100 a year ago">
        <RebasedChart stock={t.charts.rebased.stock} spx={t.charts.rebased.spx} sector={t.charts.rebased.sector} sectorSymbol={t.rs.sector_symbol} />
        <div className={styles.chartFoot}>
          <p>Above 100 means up over the year; above the benchmark lines means it did better than them.</p>
          <dl className={styles.footStats}>
            <div><dt>RS rating</dt><dd>{rs ?? "—"}</dd></div>
            <div><dt>Mansfield</dt><dd>{mansfield ? `${mansfield.value > 0 ? "+" : ""}${mansfield.value}` : "—"}</dd></div>
          </dl>
        </div>
      </Card>
      <Card title="Weinstein stage, last 52 weeks">
        <StageStrip weeks={t.stage_history} />
        <div className={styles.chartFoot}>
          <p>{st ? st.detail : "Stage needs 200 trading days of prices."}</p>
          {st && <dl className={styles.footStats}>
            <div><dt>In stage</dt><dd>{weeks(st.weeks_in_stage)}</dd></div>
            <div><dt>30-week slope</dt><dd>{signedPct(st.sma_30w_slope_pct)}</dd></div>
          </dl>}
        </div>
      </Card>
    </div>
    <Card title={t.conditions.score_label} action={<span style={{ ["--case-color" as string]: toneColor }}><Segments count={Math.max(1, t.conditions.evaluated)} on={t.conditions.passed} /></span>}>
      <div className={styles.rules}>{t.conditions.rules.map((r) => <div key={r.key} className={styles.rule} data-rule={r.status}>
        <span className={styles.mark} data-status={r.status} aria-hidden="true">{r.status === "pass" ? "✓" : r.status === "fail" ? "×" : "–"}</span>
        <span><span className={styles.srOnly}>{r.status === "pass" ? "Met: " : r.status === "fail" ? "Not met: " : "Not enough history: "}</span>{r.label}{r.reason ? ` (${r.reason})` : ""}</span>
      </div>)}</div>
    </Card>
    <div className={styles.cardGrid}>
      <Card title="Patterns">
        <p className={styles.patternLead}>{t.vcp.detail}</p>
        {t.vcp.contractions.length > 0 && <><VcpDepths contractions={t.vcp.contractions} /><p className={styles.caption}>Pullbacks, oldest first: {t.vcp.contractions.map((c) => `${c.depth_pct.toFixed(1)}%`).join(" → ")}</p></>}
        <div className={styles.chartFoot}>
          <p>{t.pocket_pivots.status === "unavailable" ? `Pocket pivots: ${t.pocket_pivots.reason}` : "Pocket pivots in the last 90 sessions."}</p>
          {t.pocket_pivots.status !== "unavailable" && <dl className={styles.footStats}>
            <div><dt>Pocket pivots</dt><dd>{pivotCount}</dd></div>
            <div><dt>Latest</dt><dd>{pivotCount ? t.pocket_pivots.events[pivotCount - 1].day.slice(5) : "—"}</dd></div>
          </dl>}
        </div>
      </Card>
      <Card title="52-week position" className={styles.fillCard}>
        {p52 ? <div className={styles.range52Body}>
          {/* The year's range as one track: today's price as a dot, the distance from the low filled. */}
          <div className={styles.range52} role="img" aria-label={`${money(p52.price)}: ${p52.pct_above_low}% above the 52-week low of ${money(p52.low)} and ${p52.pct_below_high}% below the high of ${money(p52.high)}`}>
            <span className={styles.range52Track}><span style={{ width: `${p52.high > p52.low ? ((p52.price - p52.low) / (p52.high - p52.low)) * 100 : 50}%` }} /></span>
            <span className={styles.range52Scale}><span>Low {money(p52.low)}</span><b>{money(p52.price)}</b><span>High {money(p52.high)}</span></span>
          </div>
          <dl className={styles.footStats}>
            <div><dt>Above the low</dt><dd>{p52.pct_above_low}%</dd></div>
            <div><dt>Below the high</dt><dd>{p52.pct_below_high}%</dd></div>
          </dl>
        </div> : <p className={styles.unavailable}>Needs a year of prices.</p>}
      </Card>
    </div>
  </>;
}

/** The Quant view for a loaded snapshot. */
export function QuantView({ snapshot, tab, onTab, refreshError, onDismissError }: {
  snapshot: QuantSnapshot; tab: QuantTab; onTab: (tab: QuantTab) => void; onRefresh?: () => void; refreshing?: boolean;
  refreshError?: string; onDismissError?: () => void;
}) {
  // Held here, not in the Value tab, so the chosen scenario survives a switch to Trend and back.
  const [pick, setPick] = useState<Case>("base");
  // The tabs sit above both columns, so the rail and the first card of the tab start at the same height.
  return <>
    <div className={styles.viewBar}>
      <Segmented label="Quant tab" options={["Value", "Trend"] as const} value={tab === "value" ? "Value" : "Trend"} onChange={(o) => onTab(o === "Value" ? "value" : "trend")} />
    </div>
    <div className={styles.layout}>
    <Rail s={snapshot} />
    <main className={styles.main}>
      {refreshError && <div className={styles.alertRow} role="alert">
        <p className={styles.unavailable}>Refresh failed ({refreshError.replace(/[.\s]+$/, "")}). The figures below are from the last snapshot.</p>
        {onDismissError && <button type="button" className={ui.secondary} onClick={onDismissError}>Dismiss</button>}
      </div>}
      {tab === "value" ? <ValueTab s={snapshot} pick={pick} setPick={setPick} /> : <TrendTab s={snapshot} />}
    </main>
    </div>
  </>;
}
