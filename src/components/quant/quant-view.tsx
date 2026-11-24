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
import { MultipleBand, PriceVolumeChart, RebasedChart, Sparkline, StageStrip, ValueBuild, ValuePathChart, type Case } from "./quant-charts";
import styles from "./quant.module.css";

export type QuantTab = "value" | "trend";
const pct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(digits)}%`);
const rate = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`);
const money = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `$${v.toFixed(2)}`);

export function researchHref(s: QuantSnapshot): string {
  return s.research ? `/assets/${s.research.asset_id}/view` : `/research/new?ticker=${encodeURIComponent(s.ticker)}&name=${encodeURIComponent(s.name)}`;
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
        <div className={styles.grade}><span>PulseGrade</span><b>{v.pulse_grade.grade}</b><span>{v.pulse_grade.label}</span></div>
        <div className={styles.grade}><span>PQ-Grade</span><b>{v.pq_grade.grade}</b><span>{v.pq_grade.label}</span></div>
      </div>
      <div>
        <span className={styles.sub}>PulseScore {pulse === null ? "—" : pulse.toFixed(2)}</span>
        <div className={styles.gauge} role="img" aria-label={`PulseScore ${pulse?.toFixed(2)} on a scale from −3 (overvalued) to +3 (undervalued)`}>
          <span className={styles.gaugeMid} /><span className={styles.gaugePin} style={{ left: `${((Math.max(-3, Math.min(3, pulse ?? 0)) + 3) / 6) * 100}%` }} />
        </div>
        <div className={styles.gaugeScale}><span>−3 over</span><span>fair</span><span>+3 under</span></div>
      </div>
    </> : <p className={styles.unavailable}>PragValue unavailable: {s.value_reason}</p>}
    <dl className={styles.facts}>
      <div><dt>Trend</dt><dd>{t.conditions.score_label}</dd></div>
      <div><dt>Stage</dt><dd>{t.stage ? `${t.stage.stage_number} · ${t.stage.weeks_in_stage} weeks` : "—"}</dd></div>
      <div><dt>RS rating</dt><dd>{t.rs.combined ?? "—"}</dd></div>
      {v && <div><dt>Confidence</dt><dd>{v.confidence}</dd></div>}
      <div><dt>Research</dt><dd>{s.research ? <Link href={researchHref(s)}>{s.research.status ? `Open (${s.research.status.replace(/_/g, " ")})` : "Open"}</Link> : "Not started"}</dd></div>
    </dl>
    <div className={styles.actions}>
      <Link className={ui.primary} href={researchHref(s)}>{s.research ? "Open research" : "Deep research"}</Link>
    </div>
  </aside>;
}

function ValueTab({ s }: { s: QuantSnapshot }) {
  const [pick, setPick] = useState<Case>("base");
  const v = s.value;
  if (!v) return <Card title="PragValue"><p className={styles.unavailable}>{s.value_reason}</p></Card>;
  const d = v.dcf, y5 = d.price_targets[d.price_targets.length - 1];
  const caseLabel: Record<Case, string> = { bear: "Bear", base: "Base", bull: "Bull" };
  const rows = (["bear", "base", "bull"] as const).map((k) => ({
    k, growth: d[`growth_rate_${k}`], exit: d[`exit_multiple_${k}`], value: d[`intrinsic_value_${k}`],
    target: y5 ? y5[`${k}_target`] : null, ret: y5 ? y5[`${k}_return`] : null,
  }));
  return <>
    <div className={styles.toolbar}><p>{v.engine_result.engine_note}</p></div>
    <Card title="Price and value paths" action={<Segmented label="Scenario" options={["Bear", "Base", "Bull"] as const} value={caseLabel[pick] as "Bear" | "Base" | "Bull"} onChange={(o) => setPick(o.toLowerCase() as Case)} />}>
      <ValuePathChart history={s.price_history_5y} projection={v.charts.projection} selected={pick} current={s.price} />
      <p className={styles.caption}>Intrinsic value (Pragma: the five-year DCF discounted to today): bear {money(d.intrinsic_value_bear)}, base {money(d.intrinsic_value_base)}, bull {money(d.intrinsic_value_bull)}. {d.dcf_skipped ? d.dcf_skip_reason : `Discount rate ${rate(d.discount_rate)}; growth fades to ${rate(d.terminal_growth_rate)}.`}</p>
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
          <thead><tr><th scope="col">Case</th><th scope="col">Growth</th><th scope="col">Exit multiple</th><th scope="col">Intrinsic value</th><th scope="col">Year-5 target (discounted)</th><th scope="col">Return a year</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.k}>
            <th scope="row">{caseLabel[r.k]}</th><td>{pct(r.growth)}</td><td>{r.exit ? `${r.exit.toFixed(1)}x` : "—"}</td>
            <td>{money(r.value)}</td><td>{money(r.target)}</td><td>{pct(r.ret)}</td>
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
        <p className={styles.caption}>{t.stage ? `${t.stage.label}: ${t.stage.weeks_in_stage} weeks · 30-week average ${t.stage.sma_30w_slope_pct > 0 ? "rising" : "falling"} ${Math.abs(t.stage.sma_30w_slope_pct)}% · price ${t.stage.price_vs_sma_30w_pct}% from it. ${t.stage.detail}` : "Stage needs 200 trading days of prices."}</p>
      </Card>
    </div>
    <Card title={t.conditions.score_label}>
      <div className={styles.rules}>{t.conditions.rules.map((r) => <div key={r.key} className={styles.rule}>
        <span className={styles.mark} data-status={r.status} aria-label={r.status === "pass" ? "met" : r.status === "fail" ? "not met" : "not enough history"}>{r.status === "pass" ? "✓" : r.status === "fail" ? "×" : "–"}</span>
        <span>{r.label}{r.reason ? ` (${r.reason})` : ""}</span>
      </div>)}</div>
    </Card>
    <div className={styles.cardGrid}>
      <Card title="Patterns">
        <p className={styles.unavailable}>{t.vcp.detail}</p>
        {t.vcp.contractions.length > 0 && <p className={styles.caption}>Pullbacks: {t.vcp.contractions.map((c) => `${c.depth_pct.toFixed(1)}%`).join(" → ")}</p>}
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
export function QuantView({ snapshot, tab, onTab, onRefresh, refreshing }: { snapshot: QuantSnapshot; tab: QuantTab; onTab: (tab: QuantTab) => void; onRefresh?: () => void; refreshing?: boolean }) {
  return <div className={styles.layout}>
    <Rail s={snapshot} />
    <main className={styles.main}>
      <div className={styles.toolbar}>
        <Segmented label="Quant tab" options={["Value", "Trend"] as const} value={tab === "value" ? "Value" : "Trend"} onChange={(o) => onTab(o === "Value" ? "value" : "trend")} />
        <span className={styles.spacer} />
        <p>Computed {new Date(snapshot.computed_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</p>
        {onRefresh && <button type="button" className={ui.secondary} onClick={onRefresh} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh"}</button>}
      </div>
      {tab === "value" ? <ValueTab s={snapshot} /> : <TrendTab s={snapshot} />}
    </main>
  </div>;
}
