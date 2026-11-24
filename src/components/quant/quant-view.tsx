"use client";
/**
 * The Quant page (Implementations/quant-page, layout Q2): a summary rail and Value / Trend tabs over one snapshot.
 * Built by code from SEC facts and stored prices; no model calls. Separate from Research, with links across.
 */
import { useState } from "react";
import Link from "next/link";
import { Card, Segmented, Tag } from "@/components/ui/primitives";
import ui from "@/components/research-ui.module.css";
import type { QuantSnapshot } from "@/lib/api/quant";
import { MultipleBand, PriceVolumeChart, RebasedChart, STAGE_FILL, Sparkline, StageStrip, ValueBuild, ValuePathChart, VcpDepths, type Case } from "./quant-charts";
import { caseMeter, gradeTone } from "./tones";
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

function Rail({ s }: { s: QuantSnapshot }) {
  const v = s.value, t = s.trend;
  const pulse = v?.pulse_score ?? null;
  return <aside className={styles.rail} aria-label={`${s.name} summary`}>
    <div className={styles.who}>
      <Tag>{s.ticker}</Tag>
      <div><h1>{s.name}</h1><span className={styles.sub}>{[s.sector !== "Unknown" ? s.sector : null, s.industry !== "Unknown" ? s.industry : s.sic_description].filter(Boolean).join(" · ")}</span></div>
    </div>
    <div><span className={styles.price}>{money(s.price)}</span> <span className={styles.sub}>close {s.as_of}</span></div>
    <Sparkline points={t.charts.sparkline} />
    {v ? <>
      <div className={styles.grades}>
        <div className={styles.grade} data-grade={gradeTone(v.pulse_grade.grade)}><span>PulseGrade</span><b>{v.pulse_grade.grade}</b><span>{v.pulse_grade.label}</span></div>
        <div className={styles.grade} data-grade={gradeTone(v.pq_grade.grade)}><span>PQ-Grade</span><b>{v.pq_grade.grade}</b><span>{v.pq_grade.label}</span></div>
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
    <div className={styles.toolbar}><p>{v.engine_result.engine_note}</p></div>
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
      <p className={styles.caption}>The line shows forward values (the case&apos;s value in each year, before discounting). Intrinsic value (Pragma: the five-year DCF discounted to today): bear {money(d.intrinsic_value_bear)}, base {money(d.intrinsic_value_base)}, bull {money(d.intrinsic_value_bull)}. {d.dcf_skipped ? d.dcf_skip_reason : `Discount rate ${rate(d.discount_rate)}; growth fades to ${rate(d.terminal_growth_rate)}.`}</p>
    </Card>
    <div className={styles.cardGrid}>
      <Card title={v.charts.value_build ? `From cash flows to ${money(v.charts.value_build.per_share)} a share` : "Value build"}>
        {v.charts.value_build ? <>
          <ValueBuild build={v.charts.value_build} />
          <p className={styles.caption}>Base case on {v.charts.value_build.metric}; terminal value is {(v.charts.value_build.terminal_share * 100).toFixed(0)}% of the total.</p>
        </> : <p className={styles.unavailable}>{d.dcf_skipped ? d.dcf_skip_reason : "No metric-level DCF to break down."}</p>}
      </Card>
      <Card title={`${v.charts.multiple_history.metric}, fiscal year ends`}>
        <MultipleBand {...v.charts.multiple_history} />
        <p className={styles.caption}>Shaded: 25th to 75th percentile of its own history. Scenario exits use the low, mean and high (peer growth is not fetched).</p>
      </Card>
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
    <Card title="How it was built">
      <ul className={styles.notes}>
        <li>{d.dcf_base_cf_label}. Operating leverage {d.operating_leverage_trend.toLowerCase()}.</li>
        {v.engine_result.quality_flags.map((f) => <li key={f}>{f}</li>)}
        {v.engine_result.structural_flags.map((f) => <li key={f}>{f}</li>)}
        {s.fundamentals && <li>Fiscal years {s.fundamentals.years.join(", ")} ({s.fundamentals.currency}) from {s.fundamentals.origin === "xbrl_warehouse" ? "the XBRL warehouse" : "SEC companyfacts"}.</li>}
        {s.notes.map((n) => <li key={n}>{n}</li>)}
      </ul>
    </Card>
  </>;
}

function TrendTab({ s }: { s: QuantSnapshot }) {
  const t = s.trend;
  const pivots = t.pocket_pivots.events.map((e) => e.day);
  return <>
    <div className={styles.toolbar}><p>Daily closes to {s.as_of}, split-adjusted · benchmarks S&amp;P 500{s.sector_etf ? ` and ${s.sector_etf}` : ""}</p></div>
    <Card title="Price, averages and volume"><PriceVolumeChart series={t.charts.price} pivots={pivots} /></Card>
    <div className={styles.cardGrid}>
      <Card title="Rebased to 100 a year ago">
        <RebasedChart stock={t.charts.rebased.stock} spx={t.charts.rebased.spx} sector={t.charts.rebased.sector} sectorSymbol={t.rs.sector_symbol} />
        <p className={styles.caption}>RS rating {t.rs.combined ?? "—"} (S&amp;P 500 {t.rs.vs_spx ?? "—"}{t.rs.sector_symbol ? `, ${t.rs.sector_symbol} ${t.rs.vs_sector ?? "—"}` : ""}) · Mansfield RS {t.conditions.mansfield ? `${t.conditions.mansfield.value > 0 ? "+" : ""}${t.conditions.mansfield.value} (${t.conditions.mansfield.signal.toLowerCase()})` : "—"}</p>
      </Card>
      <Card title="Weinstein stage, last 52 weeks">
        <StageStrip weeks={t.stage_history} />
        <p className={styles.caption}>{t.stage ? `${t.stage.label}: ${weeks(t.stage.weeks_in_stage)} · 30-week average ${t.stage.sma_30w_slope_pct > 0 ? `rising ${t.stage.sma_30w_slope_pct}%` : t.stage.sma_30w_slope_pct < 0 ? `falling ${Math.abs(t.stage.sma_30w_slope_pct)}%` : "flat"} · price ${t.stage.price_vs_sma_30w_pct === 0 ? "at it" : `${Math.abs(t.stage.price_vs_sma_30w_pct)}% ${t.stage.price_vs_sma_30w_pct > 0 ? "above" : "below"} it`}. ${t.stage.detail}` : "Stage needs 200 trading days of prices."}</p>
      </Card>
    </div>
    <Card title={t.conditions.score_label}>
      <div className={styles.rules}>{t.conditions.rules.map((r) => <div key={r.key} className={styles.rule}>
        <span className={styles.mark} data-status={r.status} aria-hidden="true">{r.status === "pass" ? "✓" : r.status === "fail" ? "×" : "–"}</span>
        <span><span className={styles.srOnly}>{r.status === "pass" ? "Met: " : r.status === "fail" ? "Not met: " : "Not enough history: "}</span>{r.label}{r.reason ? ` (${r.reason})` : ""}</span>
      </div>)}</div>
    </Card>
    <div className={styles.cardGrid}>
      <Card title="Patterns">
        <p className={styles.unavailable}>{t.vcp.detail}</p>
        {t.vcp.contractions.length > 0 && <><VcpDepths contractions={t.vcp.contractions} /><p className={styles.caption}>Pullbacks: {t.vcp.contractions.map((c) => `${c.depth_pct.toFixed(1)}%`).join(" → ")}</p></>}
        <p className={styles.caption}>{t.pocket_pivots.status === "unavailable" ? `Pocket pivots: ${t.pocket_pivots.reason}` : `${t.pocket_pivots.events.length} pocket pivot${t.pocket_pivots.events.length === 1 ? "" : "s"} in the last 90 sessions${t.pocket_pivots.events.length ? `, latest ${t.pocket_pivots.events[t.pocket_pivots.events.length - 1].day}` : ""}.`}</p>
      </Card>
      <Card title="52-week position">
        {t.position_52w ? <p className={styles.caption}>{money(t.position_52w.price)} · {t.position_52w.pct_above_low}% above the low ({money(t.position_52w.low)}) · {t.position_52w.pct_below_high}% below the high ({money(t.position_52w.high)})</p>
          : <p className={styles.unavailable}>Needs a year of prices.</p>}
      </Card>
    </div>
  </>;
}

/** The Quant view for a loaded snapshot. */
export function QuantView({ snapshot, tab, onTab, onRefresh, refreshing, refreshError, onDismissError }: {
  snapshot: QuantSnapshot; tab: QuantTab; onTab: (tab: QuantTab) => void; onRefresh?: () => void; refreshing?: boolean;
  refreshError?: string; onDismissError?: () => void;
}) {
  // Held here, not in the Value tab, so the chosen scenario survives a switch to Trend and back.
  const [pick, setPick] = useState<Case>("base");
  return <div className={styles.layout}>
    <Rail s={snapshot} />
    <main className={styles.main}>
      <div className={styles.toolbar}>
        <Segmented label="Quant tab" options={["Value", "Trend"] as const} value={tab === "value" ? "Value" : "Trend"} onChange={(o) => onTab(o === "Value" ? "value" : "trend")} />
        <span className={styles.spacer} />
        <p>Computed {new Date(snapshot.computed_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</p>
        {onRefresh && <button type="button" className={ui.secondary} onClick={onRefresh} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh"}</button>}
      </div>
      {refreshError && <div className={styles.alertRow} role="alert">
        <p className={styles.unavailable}>Refresh failed ({refreshError.replace(/[.\s]+$/, "")}). The figures below are from the last snapshot.</p>
        {onDismissError && <button type="button" className={ui.secondary} onClick={onDismissError}>Dismiss</button>}
      </div>}
      {tab === "value" ? <ValueTab s={snapshot} pick={pick} setPick={setPick} /> : <TrendTab s={snapshot} />}
    </main>
  </div>;
}
