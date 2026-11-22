"use client";
// The valuation at a glance (design round 7): key-number tiles, a ruler of price against bear, base and bull value,
// the yearly target fan, KPI gauges and the risk heat list. Every number comes from the run's artifacts through
// assetSnapshot; nothing is re-derived here.
import { useEffect, useRef, useState } from "react";
import type { AssetSnapshot, SnapshotKpi } from "@/lib/research/asset-snapshot";
import { C } from "@/components/ui/palette";
import styles from "./visuals.module.css";

type Tone = "good" | "bad" | "watch" | undefined;

/** The rendered width of a box, so an SVG can draw in real pixels and keep its text at its stated size. */
function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => { const w = Math.round(node.getBoundingClientRect().width); if (w > 0) setWidth(w); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function money(value: number | null | undefined, currency = "USD", digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const text = new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Math.abs(value));
  return value < 0 ? `−${text}` : text;
}
export function signedPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const pct = Math.round(value * 100);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}%`;
}
const gapTone = (gap: number | null): Tone => gap == null ? undefined : gap >= 0.1 ? "good" : gap <= -0.1 ? "bad" : "watch";
const kpiTone = (kpi: SnapshotKpi): Tone => kpi.tone === "good" ? "good" : kpi.tone === "bad" ? "bad" : undefined;

function Tile({ label, value, sub, tone, emphasis }: { label: string; value: string; sub?: string; tone?: Tone; emphasis?: boolean }) {
  return <div className={styles.tileNum} data-tone={tone} data-emphasis={emphasis || undefined}>
    <div className={styles.label} title={label}>{label}</div>
    <div className={styles.value}>{value}</div>
    {sub && <div className={styles.sub} title={sub}>{sub}</div>}
  </div>;
}

/** Price, case values with their gap to price, the weighted value and up to `kpis` monitored KPIs. */
export function KeyNumbers({ snapshot, kpis = 3, label = "Key numbers" }: { snapshot: AssetSnapshot | null; kpis?: number; label?: string }) {
  if (!snapshot) return <p className={styles.stripEmpty}>No valuation yet. Key numbers appear once a run has finished its valuation.</p>;
  const c = snapshot.currency;
  const caseSub = (gap: number | null) => gap == null ? "no price to compare" : `${signedPercent(gap)} vs price`;
  return <section className={styles.strip} aria-label={label}>
    <Tile label="Price" value={money(snapshot.price, c)} sub={snapshot.price_verified ? "verified" : "unverified"} tone={snapshot.price_verified ? undefined : "watch"} />
    <Tile label="Base value" value={money(snapshot.values.base, c)} sub={caseSub(snapshot.gap.base)} tone={gapTone(snapshot.gap.base)} emphasis />
    <Tile label="Bull value" value={money(snapshot.values.bull, c)} sub={caseSub(snapshot.gap.bull)} tone={gapTone(snapshot.gap.bull)} />
    <Tile label="Bear value" value={money(snapshot.values.bear, c)} sub={snapshot.values.bear != null && snapshot.values.bear < 0 ? "equity wiped out" : caseSub(snapshot.gap.bear)} tone={gapTone(snapshot.gap.bear)} />
    {snapshot.weighted != null && <Tile label="Weighted value" value={money(snapshot.weighted, c)} sub={caseSub(snapshot.price ? snapshot.weighted / snapshot.price - 1 : null)} tone={gapTone(snapshot.price ? snapshot.weighted / snapshot.price - 1 : null)} />}
    {snapshot.kpis.slice(0, kpis).map((kpi) => <Tile key={kpi.label} label={kpi.label} value={kpi.display}
      sub={kpi.tone === "good" ? "at or past bull level" : kpi.tone === "bad" ? "at or past bear level" : kpi.base_range ? `base ${kpi.base_range}` : "monitored"} tone={kpiTone(kpi)} />)}
  </section>;
}

/** Where today's price sits against the bear, base and bull values on one scale. */
export function ValueRuler({ snapshot, caption = true }: { snapshot: AssetSnapshot; caption?: boolean }) {
  const [box, boxWidth] = useWidth<HTMLDivElement>(560);
  const { bear, base, bull } = snapshot.values;
  const price = snapshot.price;
  const points = [bear, base, bull, price, 0].filter((v): v is number => v != null && Number.isFinite(v));
  if (!points.length || (bear == null && base == null && bull == null)) return <p className={styles.rulerCaption} style={{ padding: "16px 18px" }}>No case values to place on the ruler.</p>;
  const lo = Math.min(...points), hi = Math.max(...points);
  const pad = (hi - lo || 1) * 0.08;
  const W = Math.max(280, boxWidth - 36), x = (v: number) => 44 + ((v - lo + pad) / (hi - lo + 2 * pad)) * (W - 88);
  const c = snapshot.currency;
  const marks = ([["Bear", bear, C.ink3, 7], ["Base", base, C.navy, 9], ["Bull", bull, C.navy3, 7]] as [string, number | null, string, number][])
    .filter((m): m is [string, number, string, number] => m[1] != null);
  // Labels sit in lanes under the scale; a label moves down a lane when it would touch the one before it.
  const lanes: number[] = [];
  const labels = [...marks].sort((a, b) => a[1] - b[1]).map(([label, value]) => {
    const text = `${label} ${money(value, c)}`;
    const width = text.length * 7 + 8;
    const cx = Math.min(Math.max(x(value), width / 2 + 2), W - width / 2 - 2);
    let lane = 0;
    while (lanes[lane] != null && lanes[lane] > cx - width / 2) lane++;
    lanes[lane] = cx + width / 2;
    return { label, text, cx, y: 90 + lane * 17 };
  });
  const height = 90 + Math.max(1, lanes.length) * 17 + 2;
  const priceX = price != null ? Math.min(Math.max(x(price), 50), W - 50) : 0;
  return <div className={styles.ruler} ref={box}>
    <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`Price ${money(price, c)} against bear ${money(bear, c)}, base ${money(base, c)} and bull ${money(bull, c)} values`}>
      <line x1={30} x2={W - 30} y1={58} y2={58} stroke={C.line} strokeWidth={8} strokeLinecap="round" />
      {bear != null && bull != null && <rect x={x(Math.min(bear, bull))} y={50} width={Math.abs(x(bull) - x(bear))} height={16} rx={8} fill={C.navy2} />}
      {0 >= lo - pad && 0 <= hi + pad && <line x1={x(0)} x2={x(0)} y1={42} y2={74} stroke={C.ink4} strokeDasharray="3 3"><title>Zero</title></line>}
      {marks.map(([label, value, color, r]) => <circle key={label} cx={x(value)} cy={58} r={r} fill={color} stroke={C.tile} strokeWidth={2} />)}
      {labels.map((l) => <text key={l.label} x={l.cx} y={l.y} textAnchor="middle" fontSize={12} fontWeight={l.label === "Base" ? 700 : 600} fill={l.label === "Base" ? C.navy : C.ink2}>{l.text}</text>)}
      {price != null && <g>
        <line x1={x(price)} x2={x(price)} y1={24} y2={74} stroke={C.ink} strokeWidth={2.5} />
        <path d={`M${x(price) - 6} 18 L${x(price) + 6} 18 L${x(price)} 26 Z`} fill={C.ink} />
        <text x={priceX} y={12} textAnchor="middle" fontSize={12} fontWeight={700} fill={C.ink}>Price {money(price, c)}</text>
      </g>}
    </svg>
    {caption && base != null && price != null && <p className={styles.rulerCaption}>
      The base case values a share at <strong>{money(base, c)}</strong>, {signedPercent(snapshot.gap.base)} against today&apos;s <strong>{money(price, c)}</strong>.
      {bull != null && (bull >= price ? <> The bull case, <strong>{money(bull, c)}</strong>, is above the price.</> : <> Even the bull case, <strong>{money(bull, c)}</strong>, is below it.</>)}
    </p>}
  </div>;
}

/** A compact ruler for cards: price needle against the bear-to-bull band. */
export function MiniRuler({ snapshot }: { snapshot: AssetSnapshot }) {
  const { bear, base, bull } = snapshot.values;
  const price = snapshot.price;
  const points = [bear, base, bull, price].filter((v): v is number => v != null && Number.isFinite(v));
  if (points.length < 2 || base == null) return null;
  const lo = Math.min(...points), hi = Math.max(...points), pad = (hi - lo || 1) * 0.06;
  const x = (v: number) => 6 + ((v - lo + pad) / (hi - lo + 2 * pad)) * 288;
  return <svg className={styles.mini} viewBox="0 0 300 34" role="img" aria-label={`Price ${money(price, snapshot.currency)} against base value ${money(base, snapshot.currency)}`}>
    <line x1={6} x2={294} y1={18} y2={18} stroke={C.line} strokeWidth={6} strokeLinecap="round" />
    {bear != null && bull != null && <rect x={x(Math.min(bear, bull))} y={13} width={Math.abs(x(bull) - x(bear))} height={10} rx={5} fill={C.navy2} />}
    <circle cx={x(base)} cy={18} r={6} fill={C.navy} stroke={C.tile} strokeWidth={2} />
    {price != null && <><line x1={x(price)} x2={x(price)} y1={4} y2={30} stroke={C.ink} strokeWidth={2.5} /></>}
  </svg>;
}

/** Yearly bear-to-bull targets as a fan with the base path, against today's price. */
export function PriceFan({ snapshot }: { snapshot: AssetSnapshot }) {
  const [box, boxWidth] = useWidth<HTMLDivElement>(640);
  const rows = snapshot.targets.filter((t) => t.base != null || t.bear != null || t.bull != null);
  if (rows.length < 2) return null;
  const price = snapshot.price;
  const values = rows.flatMap((t) => [t.bear, t.base, t.bull]).concat(price ?? []).filter((v): v is number => v != null);
  const lo = Math.min(0, ...values), hi = Math.max(...values);
  const W = Math.max(300, boxWidth - 36), H = 230, L = 56, R = 16, T = 16, B = 30;
  const x = (i: number) => L + (i / (rows.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const path = (key: "bear" | "base" | "bull") => rows.map((t, i) => t[key] == null ? null : `${x(i)},${y(t[key]!)}`).filter(Boolean).join(" L");
  const band = rows.every((t) => t.bear != null && t.bull != null)
    ? `M${rows.map((t, i) => `${x(i)},${y(t.bull!)}`).join(" L")} L${[...rows].reverse().map((t, i) => `${x(rows.length - 1 - i)},${y(t.bear!)}`).join(" L")} Z` : null;
  const ticks = [lo, (lo + hi) / 2, hi];
  const c = snapshot.currency;
  return <div className={styles.fan} ref={box}>
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Yearly targets from ${rows[0].year} to ${rows[rows.length - 1].year}: base ${money(rows[rows.length - 1].base, c)} by ${rows[rows.length - 1].year}`}>
      {ticks.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={C.lineSoft} /><text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill={C.ink3}>{money(v, c, 0)}</text></g>)}
      {lo < 0 && <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke={C.ink4} strokeDasharray="3 3" />}
      {band && <path d={band} fill={C.navy2} opacity={0.55} />}
      {path("bull") && <path d={`M${path("bull")}`} fill="none" stroke={C.navy3} strokeWidth={1.5} />}
      {path("bear") && <path d={`M${path("bear")}`} fill="none" stroke={C.ink3} strokeWidth={1.5} />}
      {path("base") && <path d={`M${path("base")}`} fill="none" stroke={C.navy} strokeWidth={3} />}
      {rows.map((t, i) => t.base == null ? null : <circle key={t.year} cx={x(i)} cy={y(t.base)} r={4} fill={C.navy} stroke={C.tile} strokeWidth={1.5} />)}
      {price != null && <g><line x1={L} x2={W - R} y1={y(price)} y2={y(price)} stroke={C.ink} strokeDasharray="6 4" strokeWidth={1.5} /><text x={W - R} y={y(price) - 6} textAnchor="end" fontSize={11} fontWeight={700} fill={C.ink}>Price {money(price, c)}</text></g>}
      {rows.map((t, i) => <text key={t.year} x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill={C.ink3}>{t.year}</text>)}
    </svg>
    <div className={styles.legend} style={{ padding: "4px 0 10px" }}>
      <span><i className={styles.swatch} style={{ background: C.navy }} />Base</span>
      <span><i className={styles.swatch} style={{ background: C.navy2 }} />Bear to bull range</span>
      <span><i className={styles.swatch} style={{ background: C.ink, height: 2 }} />Today&apos;s price</span>
    </div>
  </div>;
}

/** Each monitored KPI on a track from its bear to its bull threshold, the current level as a dot. */
export function KpiGauges({ kpis }: { kpis: SnapshotKpi[] }) {
  const usable = kpis.filter((k) => k.bear_threshold != null && k.bull_threshold != null && k.bear_threshold !== k.bull_threshold);
  if (!usable.length) return <p style={{ padding: "14px 18px", color: "var(--ink-2)" }}>No KPI has bear and bull thresholds yet.</p>;
  return <div className={styles.gauges}>{usable.map((kpi) => {
    const bear = kpi.bear_threshold!, bull = kpi.bull_threshold!;
    const lo = Math.min(bear, bull, kpi.value), hi = Math.max(bear, bull, kpi.value), pad = (hi - lo || 1) * 0.12;
    const x = (v: number) => 6 + ((v - lo + pad) / (hi - lo + 2 * pad)) * 288;
    const color = kpi.tone === "good" ? C.positive : kpi.tone === "bad" ? C.critical : C.navy;
    return <div key={kpi.label} className={styles.gauge} data-tone={kpi.tone}>
      <div className={styles.gaugeHead}><strong>{kpi.label}</strong><span>{kpi.display}</span></div>
      <svg viewBox="0 0 300 22" preserveAspectRatio="none" aria-hidden="true">
        <line x1={6} x2={294} y1={11} y2={11} stroke={C.line} strokeWidth={6} strokeLinecap="round" />
        <rect x={Math.min(x(bear), x(bull))} y={8} width={Math.abs(x(bull) - x(bear))} height={6} rx={3} fill={C.navy2} />
        <line x1={x(bear)} x2={x(bear)} y1={3} y2={19} stroke={C.critical} strokeWidth={2} />
        <line x1={x(bull)} x2={x(bull)} y1={3} y2={19} stroke={C.positive} strokeWidth={2} />
        <circle cx={x(kpi.value)} cy={11} r={6} fill={color} stroke={C.tile} strokeWidth={2} />
      </svg>
      <div className={styles.gaugeFoot}><span>Bear {formatLevel(bear, kpi)}</span>{kpi.base_range && <span>Base {kpi.base_range}</span>}<span>Bull {formatLevel(bull, kpi)}</span></div>
    </div>;
  })}</div>;
}
const formatLevel = (value: number, kpi: SnapshotKpi) => {
  const unit = (kpi.unit ?? "").toLowerCase();
  if (unit.includes("percent")) return `${Number(value.toFixed(2))}%`;
  const abs = Math.abs(value);
  return abs >= 1e9 ? `${(value / 1e9).toFixed(2)}bn` : abs >= 1e6 ? `${(value / 1e6).toFixed(1)}m` : String(Number(value.toFixed(2)));
};

export interface HeatRisk { name: string; probability: number | null; severity: number | null; detail?: string | null }

/** Risks ranked by probability × severity, each with a heat cell (high, medium, low). */
export function RiskHeat({ risks, onPick }: { risks: HeatRisk[]; onPick?: (index: number) => void }) {
  const scored = risks.map((risk, index) => ({ risk, index, score: risk.probability != null && risk.severity != null ? risk.probability * risk.severity : null }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return <div className={styles.heat}>{scored.map(({ risk, index, score }) => {
    const level = score == null ? 1 : score >= 2.5 ? 3 : score >= 1.25 ? 2 : 1;
    const Row = onPick ? "button" : "div";
    return <Row key={index} className={styles.heatRow} {...(onPick ? { type: "button" as const, onClick: () => onPick(index) } : {})}>
      <span className={styles.heatCell} data-level={level} aria-label={["", "low", "medium", "high"][level] + " risk"}>{score == null ? "—" : score.toFixed(1)}</span>
      <span><span className={styles.heatName}>{risk.name}</span>{risk.detail && <span className={styles.heatMeta} style={{ display: "block" }}>{risk.detail}</span>}</span>
      <span className={styles.heatScore}>{risk.probability != null ? `${Math.round(risk.probability * 100)}% likely` : ""}{risk.severity != null ? <><br />severity {risk.severity}/5</> : null}</span>
    </Row>;
  })}</div>;
}

/** Thesis conditions as numbered pillars. */
export function ThesisPillars({ items }: { items: string[] }) {
  return <ol className={styles.pillars}>{items.map((item) => <li key={item} className={styles.pillar}>{item}</li>)}</ol>;
}
