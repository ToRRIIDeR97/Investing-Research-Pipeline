"use client";
/**
 * The Quant page's charts, hand-drawn SVG on the palette tokens. Every chart has a text alternative (`aria-label`)
 * that states what it shows in numbers.
 */
import { C } from "@/components/ui/palette";
import styles from "./quant.module.css";

type Pt = { x: number; y: number };
const path = (pts: Pt[]) => pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
const money = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `$${v >= 100 ? v.toFixed(0) : v.toFixed(2)}`);

function scale(min: number, max: number, from: number, to: number) {
  const span = max - min || 1;
  return (v: number) => from + ((v - min) / span) * (to - from);
}

export type Case = "bear" | "base" | "bull";

/** Weekly price over five years, then the DCF's bear-to-bull range and the chosen case to year 5. */
export function ValuePathChart({ history, projection, selected, current }: {
  history: { day: string; close: number }[];
  projection: { year: number; bear: number; base: number; bull: number }[];
  selected: Case; current: number;
}) {
  const W = 880, H = 260, split = 520, top = 16, bottom = 236;
  const values = [...history.map((h) => h.close), ...projection.flatMap((p) => [p.bear, p.base, p.bull])].filter((v) => v > 0);
  if (!history.length || !values.length) return <p className={styles.unavailable}>No price history is stored yet.</p>;
  const y = scale(Math.min(...values) * 0.95, Math.max(...values) * 1.05, bottom, top);
  const xh = scale(0, Math.max(1, history.length - 1), 0, split);
  const years = Math.max(1, projection[projection.length - 1]?.year ?? 5);
  const xp = scale(0, years, split, W - 70);
  const hist = history.map((h, i) => ({ x: xh(i), y: y(h.close) }));
  const at = (k: Case) => projection.map((p) => ({ x: xp(p.year), y: y(p[k]) }));
  const band = [...at("bull"), ...at("bear").reverse()];
  const end = projection[projection.length - 1];
  const caseColor = selected === "bull" ? C.positive : selected === "bear" ? C.critical : C.navy3;
  const label = `Price over the last five years, ${money(history[0].close)} to ${money(current)}; ${years}-year DCF targets: bear ${money(end?.bear)}, base ${money(end?.base)}, bull ${money(end?.bull)}.`;
  return <figure style={{ margin: 0 }}>
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} role="img" aria-label={label}>
      {projection.length > 1 && <path d={`${path(band)} Z`} fill={C.navySoft} />}
      <line x1={split} y1={top} x2={split} y2={bottom} stroke={C.line} strokeDasharray="4 4" />
      <text x={split + 4} y={top + 10} fontSize="12" fill={C.ink3}>today {money(current)}</text>
      <path d={path(hist)} fill="none" stroke={C.navy} strokeWidth="2.5" />
      {projection.length > 1 && <path d={path(at(selected))} fill="none" stroke={caseColor} strokeWidth="3" />}
      {end && <text x={W - 66} y={y(end[selected]) + 4} fontSize="12" fill={C.ink}>{money(end[selected])}</text>}
      <text x={0} y={H - 4} fontSize="11" fill={C.ink3}>{history[0].day.slice(0, 4)}</text>
      <text x={split - 14} y={H - 4} fontSize="11" fill={C.ink3}>now</text>
      <text x={W - 80} y={H - 4} fontSize="11" fill={C.ink3}>+{years} years</text>
    </svg>
  </figure>;
}

/** From the DCF's present values to the base value per share. */
export function ValueBuild({ build }: { build: { pv_cash_flows: number; pv_terminal: number; net_debt_per_share: number; per_share: number; metric: string; terminal_share: number } }) {
  const W = 420, H = 200, base = 176;
  const top = Math.max(build.pv_cash_flows + build.pv_terminal, build.per_share, 1);
  const h = (v: number) => (Math.abs(v) / top) * 160;
  const bars = [
    { label: "Cash flows", value: build.pv_cash_flows, y0: base - h(build.pv_cash_flows), height: h(build.pv_cash_flows), fill: C.navy3 },
    { label: "Terminal", value: build.pv_terminal, y0: base - h(build.pv_cash_flows) - h(build.pv_terminal), height: h(build.pv_terminal), fill: C.navy2 },
    { label: build.net_debt_per_share >= 0 ? "Net debt" : "Net cash", value: -build.net_debt_per_share,
      y0: base - h(build.pv_cash_flows) - h(build.pv_terminal), height: Math.max(h(build.net_debt_per_share), 2), fill: build.net_debt_per_share >= 0 ? C.critical : C.positive },
    { label: "Per share", value: build.per_share, y0: base - h(build.per_share), height: h(build.per_share), fill: C.navy },
  ];
  const aria = `${build.metric} DCF: ${money(build.pv_cash_flows)} of discounted cash flows plus ${money(build.pv_terminal)} terminal value, ${build.net_debt_per_share >= 0 ? "less" : "plus"} ${money(Math.abs(build.net_debt_per_share))} net ${build.net_debt_per_share >= 0 ? "debt" : "cash"}, gives ${money(build.per_share)} a share.`;
  return <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} role="img" aria-label={aria}>
    {bars.map((b, i) => <g key={b.label}>
      <rect x={10 + i * 102} y={b.y0} width="82" height={b.height} rx="4" fill={b.fill} />
      <text x={10 + i * 102} y={Math.max(12, b.y0 - 6)} fontSize="12" fill={C.ink}>{i === 2 ? (b.value >= 0 ? "+" : "−") + money(Math.abs(b.value)) : money(b.value)}</text>
      <text x={10 + i * 102} y={H - 4} fontSize="11" fill={C.ink3}>{b.label}</text>
    </g>)}
  </svg>;
}

/** The engine's primary multiple at each fiscal year end, with the 25th to 75th percentile band. */
export function MultipleBand({ points, metric, p25, p75, current, percentile }: {
  points: { period: string; multiple: number }[]; metric: string; p25: number | null; p75: number | null; current: number | null; percentile: number | null;
}) {
  if (points.length < 2) return <p className={styles.unavailable}>Fewer than two fiscal years of {metric} history, so there is no band to draw.</p>;
  const W = 420, H = 200;
  const vals = points.map((p) => p.multiple);
  const y = scale(Math.min(...vals) * 0.9, Math.max(...vals) * 1.1, 176, 16);
  const x = scale(0, points.length - 1, 10, W - 20);
  const pts = points.map((p, i) => ({ x: x(i), y: y(p.multiple) }));
  const aria = `${metric} at each fiscal year end from ${points[0].period.slice(0, 4)} to ${points[points.length - 1].period.slice(0, 4)}: ${points.map((p) => `${p.multiple.toFixed(1)}x`).join(", ")}${percentile !== null ? `; the latest is at the ${percentile}th percentile of its own history` : ""}.`;
  return <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} role="img" aria-label={aria}>
    {p25 !== null && p75 !== null && <rect x="0" y={y(p75)} width={W} height={Math.max(2, y(p25) - y(p75))} fill={C.soft} />}
    <path d={path(pts)} fill="none" stroke={C.navy} strokeWidth="2.5" />
    {pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={i === pts.length - 1 ? 5 : 3} fill={C.navy} />)}
    {current !== null && <text x={W - 150} y={Math.max(14, pts[pts.length - 1].y - 10)} fontSize="12" fill={C.ink}>{current.toFixed(1)}x{percentile !== null ? ` · ${percentile}th pct` : ""}</text>}
    {points.map((p, i) => <text key={p.period} x={x(i) - 12} y={H - 4} fontSize="11" fill={C.ink3}>{p.period.slice(0, 4)}</text>)}
  </svg>;
}

/** One year of closes with the 50/150/200-day averages, volume bars and pocket pivots. */
export function PriceVolumeChart({ series, pivots }: {
  series: { day: string; close: number; volume: number | null; sma50: number | null; sma150: number | null; sma200: number | null }[];
  pivots: string[];
}) {
  if (series.length < 2) return <p className={styles.unavailable}>Not enough stored prices to draw the chart.</p>;
  const W = 880, H = 300, top = 12, priceBottom = 222, volTop = 236, volBottom = 290;
  const vals = series.flatMap((s) => [s.close, s.sma50, s.sma150, s.sma200]).filter((v): v is number => v !== null);
  const y = scale(Math.min(...vals) * 0.97, Math.max(...vals) * 1.03, priceBottom, top);
  const x = scale(0, series.length - 1, 0, W);
  const line = (k: "close" | "sma50" | "sma150" | "sma200") => path(series.flatMap((s, i) => (s[k] === null ? [] : [{ x: x(i), y: y(s[k]!) }])));
  const maxVol = Math.max(...series.map((s) => s.volume ?? 0));
  const pivotSet = new Set(pivots);
  const last = series[series.length - 1];
  const aria = `One year of daily closes from ${money(series[0].close)} to ${money(last.close)}; 50-day ${money(last.sma50)}, 150-day ${money(last.sma150)}, 200-day ${money(last.sma200)}; ${pivots.length} pocket pivot${pivots.length === 1 ? "" : "s"} marked.`;
  const barW = Math.max(1, W / series.length - 0.5);
  return <figure style={{ margin: 0 }}>
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} role="img" aria-label={aria}>
      <path d={line("sma200")} fill="none" stroke={C.navy2} strokeWidth="2" />
      <path d={line("sma150")} fill="none" stroke={C.navy3} strokeWidth="2" strokeDasharray="6 4" />
      <path d={line("sma50")} fill="none" stroke={C.sage} strokeWidth="2" />
      <path d={line("close")} fill="none" stroke={C.navy} strokeWidth="2.5" />
      {series.map((s, i) => pivotSet.has(s.day) ? <circle key={`p${i}`} cx={x(i)} cy={y(s.close)} r="6" fill="none" stroke={C.positive} strokeWidth="2" /> : null)}
      {maxVol > 0 && series.map((s, i) => s.volume ? <rect key={`v${i}`} x={x(i) - barW / 2} y={volBottom - ((s.volume / maxVol) * (volBottom - volTop))} width={barW} height={(s.volume / maxVol) * (volBottom - volTop)} fill={pivotSet.has(s.day) ? C.positive : C.lineStrong} /> : null)}
    </svg>
    <div className={styles.legend}>
      <span><i style={{ background: C.navy }} />Price</span><span><i style={{ background: C.sage }} />50-day</span>
      <span><i style={{ background: C.navy3 }} />150-day</span><span><i style={{ background: C.navy2 }} />200-day</span>
      <span><i style={{ background: C.positive }} />Pocket pivot (volume)</span>
    </div>
  </figure>;
}

/** Performance rebased to 100 a year ago: the stock, the S&P 500 and the sector ETF. */
export function RebasedChart({ stock, spx, sector, sectorSymbol }: {
  stock: { day: string; value: number }[]; spx: { day: string; value: number }[]; sector: { day: string; value: number }[]; sectorSymbol: string | null;
}) {
  if (stock.length < 2) return <p className={styles.unavailable}>Not enough stored prices to compare.</p>;
  const W = 420, H = 190;
  const all = [...stock, ...spx, ...sector].map((p) => p.value);
  const y = scale(Math.min(...all, 100) * 0.97, Math.max(...all, 100) * 1.03, 170, 12);
  const line = (s: { value: number }[]) => { const x = scale(0, Math.max(1, s.length - 1), 0, W - 90); return path(s.map((p, i) => ({ x: x(i), y: y(p.value) }))); };
  const last = (s: { value: number }[]) => (s.length ? s[s.length - 1].value : null);
  const fmt = (v: number | null) => (v === null ? "—" : v.toFixed(0));
  const aria = `Rebased to 100 a year ago: stock ${fmt(last(stock))}, S&P 500 ${fmt(last(spx))}${sectorSymbol ? `, ${sectorSymbol} ${fmt(last(sector))}` : ""}.`;
  return <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} role="img" aria-label={aria}>
    <line x1="0" y1={y(100)} x2={W - 90} y2={y(100)} stroke={C.line} />
    {spx.length > 1 && <path d={line(spx)} fill="none" stroke={C.ink4} strokeWidth="2" />}
    {sector.length > 1 && <path d={line(sector)} fill="none" stroke={C.navy3} strokeWidth="2" strokeDasharray="5 4" />}
    <path d={line(stock)} fill="none" stroke={C.navy} strokeWidth="3" />
    <text x={W - 84} y={y(last(stock) ?? 100) + 4} fontSize="12" fill={C.ink}>Stock {fmt(last(stock))}</text>
    {sector.length > 1 && <text x={W - 84} y={y(last(sector)!) + 18} fontSize="12" fill={C.navy3}>{sectorSymbol} {fmt(last(sector))}</text>}
    {spx.length > 1 && <text x={W - 84} y={y(last(spx)!) + 32} fontSize="12" fill={C.ink3}>S&amp;P {fmt(last(spx))}</text>}
  </svg>;
}

const STAGE_FILL: Record<number, string> = { 1: C.ink4, 2: C.navy, 3: C.caution, 4: C.critical, 0: C.line };
/** The Weinstein stage of each of the last 52 weeks. */
export function StageStrip({ weeks }: { weeks: { week: string; stage_number: number }[] }) {
  if (!weeks.length) return <p className={styles.unavailable}>Stage history needs about nine months of weekly closes.</p>;
  const counts = [1, 2, 3, 4].map((n) => weeks.filter((w) => w.stage_number === n).length);
  return <div>
    <div className={styles.strip} role="img" aria-label={`Weinstein stage over ${weeks.length} weeks: ${counts.map((c, i) => `${c} in stage ${i + 1}`).join(", ")}; latest stage ${weeks[weeks.length - 1].stage_number}.`}>
      {weeks.map((w) => <span key={w.week} title={`${w.week}: stage ${w.stage_number}`} style={{ background: STAGE_FILL[w.stage_number] }} />)}
    </div>
    <div className={styles.legend}>
      <span><i style={{ background: STAGE_FILL[1] }} />1 basing</span><span><i style={{ background: STAGE_FILL[2] }} />2 advancing</span>
      <span><i style={{ background: STAGE_FILL[3] }} />3 topping</span><span><i style={{ background: STAGE_FILL[4] }} />4 declining</span>
    </div>
  </div>;
}

/** A small three-month sparkline for the rail. */
export function Sparkline({ points }: { points: { close: number }[] }) {
  if (points.length < 2) return null;
  const W = 220, H = 50;
  const y = scale(Math.min(...points.map((p) => p.close)), Math.max(...points.map((p) => p.close)), H - 4, 4);
  const x = scale(0, points.length - 1, 0, W);
  const up = points[points.length - 1].close >= points[0].close;
  return <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} role="img"
    aria-label={`Three months: ${money(points[0].close)} to ${money(points[points.length - 1].close)} (${up ? "up" : "down"})`}>
    <path d={path(points.map((p, i) => ({ x: x(i), y: y(p.close) })))} fill="none" stroke={C.navy} strokeWidth="2" />
  </svg>;
}
