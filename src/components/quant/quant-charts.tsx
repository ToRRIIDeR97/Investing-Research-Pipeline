"use client";
/**
 * The Quant page's charts, hand-drawn SVG on the palette tokens. Every chart has a text alternative (`aria-label`)
 * that states what it shows in numbers, and every chart degrades to a sentence when its data is too thin to draw.
 */
import { C } from "@/components/ui/palette";
import styles from "./quant.module.css";

type Pt = { x: number; y: number };
const path = (pts: Pt[]) => pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
export const money = (v: number | null | undefined) => {
  if (!finite(v)) return "—";
  const a = Math.abs(v);
  return `${v < 0 ? "−" : ""}$${a >= 100 ? a.toFixed(0) : a.toFixed(2)}`;
};

function scale(min: number, max: number, from: number, to: number) {
  const span = max - min || 1;
  return (v: number) => from + ((v - min) / span) * (to - from);
}
/** A value domain padded by 8% of its span (or of its magnitude when flat), correct for negative values. */
export function padded(values: number[]): [number, number] {
  const vals = values.filter(finite);
  if (!vals.length) return [0, 1];
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.08;
  return [lo - pad, hi + pad];
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Spread label positions so no two are closer than `gap`, keeping them inside [top, bottom]. */
export function spreadLabels(ys: number[], gap: number, top: number, bottom: number): number[] {
  const order = ys.map((y, i) => [y, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(ys.length);
  let prev = -Infinity;
  for (const [y, i] of order) { const v = Math.max(clamp(y, top, bottom), prev + gap); out[i] = v; prev = v; }
  // Pushed past the bottom: shift the whole stack up.
  const over = Math.max(...out) - bottom;
  return over > 0 ? out.map((v) => Math.max(top, v - over)) : out;
}
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

export type Case = "bear" | "base" | "bull";

/**
 * Weekly price over five years, then the DCF's bear-to-bull range to year 5. The path shows forward values (each
 * year's target compounded at the discount rate, not discounted to today), so it starts at today's price and ends
 * at what the case implies the share is worth in year 5.
 */
export function ValuePathChart({ history, projection, selected, current }: {
  history: { day: string; close: number }[];
  projection: { year: number; bear: number; base: number; bull: number }[];
  selected: Case; current: number;
}) {
  const W = 880, H = 270, left = 52, split = 540, right = W - 74, top = 16, bottom = 236;
  const proj = projection.filter((p) => finite(p.bear) && finite(p.base) && finite(p.bull));
  const values = [...history.map((h) => h.close), ...proj.flatMap((p) => [p.bear, p.base, p.bull])].filter(finite);
  if (history.length < 2 || !values.length) return <p className={styles.unavailable}>Not enough stored price history to draw the value path.</p>;
  const [lo, hi] = padded(values);
  const y = scale(lo, hi, bottom, top);
  const xh = scale(0, history.length - 1, left, split);
  const years = Math.max(1, proj[proj.length - 1]?.year ?? 5);
  const xp = scale(0, years, split, right);
  const hist = history.map((h, i) => ({ x: xh(i), y: y(h.close) }));
  const at = (k: Case) => proj.map((p) => ({ x: xp(p.year), y: y(p[k]) }));
  const band = [...at("bull"), ...at("bear").reverse()];
  const end = proj[proj.length - 1];
  const caseColor = selected === "bull" ? C.positive : selected === "bear" ? C.critical : C.navy3;
  const label = `Price over the last five years, weekly from ${history[0].day} (${money(history[0].close)}) to ${money(current)} today; forward value in year ${years}: bear ${money(end?.bear)}, base ${money(end?.base)}, bull ${money(end?.bull)}.`;
  return <figure style={{ margin: 0 }}>
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} role="img" aria-label={label}>
      <text x={0} y={top + 4} fontSize="11" fill={C.ink3}>{money(hi)}</text>
      <text x={0} y={bottom} fontSize="11" fill={C.ink3}>{money(Math.max(lo, 0))}</text>
      {proj.length > 1 && <path d={`${path(band)} Z`} fill={C.navySoft} />}
      <line x1={split} y1={top} x2={split} y2={bottom} stroke={C.lineStrong} strokeDasharray="4 4" />
      <text x={split + 4} y={top + 10} fontSize="12" fill={C.ink3}>today {money(current)}</text>
      <path d={path(hist)} fill="none" stroke={C.navy} strokeWidth="2.5" />
      {proj.length > 1 && <path d={path(at(selected))} fill="none" stroke={caseColor} strokeWidth="3" />}
      {end && <text x={right + 6} y={clamp(y(end[selected]) + 4, top + 8, bottom)} fontSize="12" fill={C.ink}>{money(end[selected])}</text>}
      <text x={left} y={H - 8} fontSize="11" fill={C.ink3}>{history[0].day.slice(0, 7)}</text>
      <text x={split} y={H - 8} fontSize="11" fill={C.ink3} textAnchor="middle">now</text>
      <text x={right} y={H - 8} fontSize="11" fill={C.ink3} textAnchor="end">year {years}</text>
    </svg>
    <div className={styles.legend}>
      <span><i style={{ background: C.navy }} />Weekly close</span>
      <span><i style={{ background: caseColor }} />{selected[0].toUpperCase() + selected.slice(1)} forward value</span>
      <span><i style={{ background: C.navySoft, height: 10 }} />Bear to bull range</span>
    </div>
  </figure>;
}

/** From the DCF's present values to the base value per share, as a signed waterfall. */
export function ValueBuild({ build }: { build: { pv_cash_flows: number; pv_terminal: number; net_debt_per_share: number; per_share: number; metric: string; terminal_share: number } }) {
  const W = 420, H = 210, top = 22, bottom = 180;
  const a = build.pv_cash_flows, b = a + build.pv_terminal, c = b - build.net_debt_per_share;
  const [lo, hi] = padded([0, a, b, c, build.per_share]);
  const y = scale(lo, hi, bottom, top);
  const debtLabel = build.net_debt_per_share === 0 ? "No net debt" : build.net_debt_per_share > 0 ? "Net debt" : "Net cash";
  const steps = [
    { label: "Cash flows", from: 0, to: a, fill: C.navy3, text: money(build.pv_cash_flows) },
    { label: "Terminal", from: a, to: b, fill: C.navy2, text: `${build.pv_terminal < 0 ? "" : "+"}${money(build.pv_terminal)}` },
    { label: debtLabel, from: b, to: c, fill: build.net_debt_per_share > 0 ? C.critical : C.positive,
      text: build.net_debt_per_share === 0 ? "$0" : `${build.net_debt_per_share > 0 ? "−" : "+"}${money(Math.abs(build.net_debt_per_share))}` },
    { label: "Per share", from: 0, to: build.per_share, fill: C.navy, text: money(build.per_share) },
  ];
  const aria = `${build.metric} DCF: ${money(build.pv_cash_flows)} of discounted cash flows, ${money(build.pv_terminal)} terminal value, ${build.net_debt_per_share >= 0 ? "less" : "plus"} ${money(Math.abs(build.net_debt_per_share))} net ${build.net_debt_per_share >= 0 ? "debt" : "cash"}, gives ${money(build.per_share)} a share (floored at zero).`;
  return <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} role="img" aria-label={aria}>
    <line x1="0" y1={y(0)} x2={W} y2={y(0)} stroke={C.lineStrong} />
    {steps.map((s, i) => {
      const y0 = y(Math.max(s.from, s.to)), h = Math.max(2, Math.abs(y(s.from) - y(s.to)));
      return <g key={s.label}>
        <rect x={10 + i * 102} y={y0} width="82" height={h} rx="4" fill={s.fill} />
        <text x={10 + i * 102} y={Math.max(14, y0 - 6)} fontSize="12" fill={C.ink}>{s.text}</text>
        <text x={10 + i * 102} y={H - 6} fontSize="11" fill={C.ink3}>{s.label}</text>
      </g>;
    })}
  </svg>;
}

/** The engine's primary multiple at each fiscal year end, with the 25th to 75th percentile band. */
export function MultipleBand({ points, metric, p25, p75, current, percentile }: {
  points: { period: string; multiple: number }[]; metric: string; p25: number | null; p75: number | null; current: number | null; percentile: number | null;
}) {
  const pts0 = points.filter((p) => finite(p.multiple));
  if (pts0.length < 2) return <p className={styles.unavailable}>Fewer than two fiscal years of {metric} history, so there is no band to draw.</p>;
  const W = 420, H = 200, left = 40, right = W - 16, top = 16, bottom = 172;
  const [lo, hi] = padded([...pts0.map((p) => p.multiple), ...(finite(p25) && finite(p75) ? [p25, p75] : [])]);
  const y = scale(lo, hi, bottom, top);
  const x = scale(0, pts0.length - 1, left + 8, right - 8);
  const pts = pts0.map((p, i) => ({ x: x(i), y: y(p.multiple) }));
  const lastPt = pts[pts.length - 1];
  const aria = `${metric} at each fiscal year end from ${pts0[0].period.slice(0, 4)} to ${pts0[pts0.length - 1].period.slice(0, 4)}: ${pts0.map((p) => `${p.multiple.toFixed(1)}x`).join(", ")}${percentile !== null ? `; the latest is at the ${percentile}th percentile of its own history` : ""}.`;
  const bandTop = finite(p75) ? clamp(y(p75), top, bottom) : null, bandBottom = finite(p25) ? clamp(y(p25), top, bottom) : null;
  return <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} role="img" aria-label={aria}>
    <text x={0} y={top + 4} fontSize="11" fill={C.ink3}>{hi.toFixed(1)}x</text>
    <text x={0} y={bottom} fontSize="11" fill={C.ink3}>{lo.toFixed(1)}x</text>
    {bandTop !== null && bandBottom !== null && <rect x={left} y={bandTop} width={right - left} height={Math.max(2, bandBottom - bandTop)} fill={C.soft} />}
    {lo < 0 && hi > 0 && <line x1={left} y1={y(0)} x2={right} y2={y(0)} stroke={C.lineStrong} strokeDasharray="3 3" />}
    <path d={path(pts)} fill="none" stroke={C.navy} strokeWidth="2.5" />
    {pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={i === pts.length - 1 ? 5 : 3} fill={C.navy} />)}
    {current !== null && <text x={clamp(lastPt.x, left + 110, right)} y={clamp(lastPt.y - 10, top + 10, bottom)} fontSize="12" fill={C.ink} textAnchor="end">{current.toFixed(1)}x{percentile !== null ? ` · ${percentile}th pct` : ""}</text>}
    {pts0.map((p, i) => <text key={p.period} x={x(i)} y={H - 6} fontSize="11" fill={C.ink3} textAnchor={i === 0 ? "start" : i === pts0.length - 1 ? "end" : "middle"}>{p.period.slice(0, 4)}</text>)}
  </svg>;
}

/** One year of closes with the 50/150/200-day averages, volume bars and pocket pivots. */
export function PriceVolumeChart({ series, pivots }: {
  series: { day: string; close: number; volume: number | null; sma50: number | null; sma150: number | null; sma200: number | null }[];
  pivots: string[];
}) {
  const rows = series.filter((s) => finite(s.close));
  if (rows.length < 2) return <p className={styles.unavailable}>Not enough stored prices to draw the chart.</p>;
  const W = 880, H = 316, left = 52, top = 12, priceBottom = 222, volTop = 236, volBottom = 290;
  const [lo, hi] = padded(rows.flatMap((s) => [s.close, s.sma50, s.sma150, s.sma200]).filter(finite));
  const y = scale(lo, hi, priceBottom, top);
  const x = scale(0, rows.length - 1, left, W);
  const line = (k: "close" | "sma50" | "sma150" | "sma200") => path(rows.flatMap((s, i) => (finite(s[k]) ? [{ x: x(i), y: y(s[k]!) }] : [])));
  const maxVol = Math.max(0, ...rows.map((s) => s.volume ?? 0));
  const pivotSet = new Set(pivots);
  const last = rows[rows.length - 1];
  const aria = `One year of daily closes from ${money(rows[0].close)} to ${money(last.close)}; 50-day ${money(last.sma50)}, 150-day ${money(last.sma150)}, 200-day ${money(last.sma200)}; ${pivots.length} pocket pivot${pivots.length === 1 ? "" : "s"} marked.${maxVol > 0 ? "" : " No volume is stored."}`;
  const barW = Math.max(1, (W - left) / rows.length - 0.5);
  return <figure style={{ margin: 0 }}>
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} role="img" aria-label={aria}>
      <text x={0} y={top + 4} fontSize="11" fill={C.ink3}>{money(hi)}</text>
      <text x={0} y={priceBottom} fontSize="11" fill={C.ink3}>{money(lo)}</text>
      <text x={0} y={volBottom} fontSize="11" fill={C.ink3}>Volume</text>
      <path d={line("sma200")} fill="none" stroke={C.navy2} strokeWidth="2" />
      <path d={line("sma150")} fill="none" stroke={C.navy3} strokeWidth="2" strokeDasharray="6 4" />
      <path d={line("sma50")} fill="none" stroke={C.sage} strokeWidth="2" />
      <path d={line("close")} fill="none" stroke={C.navy} strokeWidth="2.5" />
      {rows.map((s, i) => pivotSet.has(s.day) ? <circle key={`p${i}`} cx={x(i)} cy={y(s.close)} r="6" fill="none" stroke={C.positive} strokeWidth="2" /> : null)}
      {maxVol > 0 && rows.map((s, i) => s.volume ? <rect key={`v${i}`} x={x(i) - barW / 2} y={volBottom - ((s.volume / maxVol) * (volBottom - volTop))} width={barW} height={(s.volume / maxVol) * (volBottom - volTop)} fill={pivotSet.has(s.day) ? C.positive : C.ink3} opacity={pivotSet.has(s.day) ? 1 : 0.55} /> : null)}
      <text x={left} y={H - 6} fontSize="11" fill={C.ink3}>{rows[0].day}</text>
      <text x={W} y={H - 6} fontSize="11" fill={C.ink3} textAnchor="end">{last.day}</text>
    </svg>
    <div className={styles.legend}>
      <span><i style={{ background: C.navy }} />Price</span><span><i style={{ background: C.sage }} />50-day</span>
      <span><i style={{ background: C.navy3 }} />150-day</span><span><i style={{ background: C.navy2 }} />200-day</span>
      <span><i style={{ background: C.positive }} />Pocket pivot (volume)</span>
    </div>
  </figure>;
}

/** Performance rebased to 100 a year ago: the stock, the S&P 500 and the sector ETF, aligned by day. */
export function RebasedChart({ stock, spx, sector, sectorSymbol }: {
  stock: { day: string; value: number }[]; spx: { day: string; value: number }[]; sector: { day: string; value: number }[]; sectorSymbol: string | null;
}) {
  const clean = (s: { day: string; value: number }[]) => s.filter((p) => finite(p.value) && finite(dayMs(p.day)));
  const st = clean(stock), sp = clean(spx), se = clean(sector);
  if (st.length < 2) return <p className={styles.unavailable}>Not enough stored prices to compare.</p>;
  const W = 420, H = 200, left = 34, plotRight = W - 96, top = 12, bottom = 172;
  // One day axis for every series, spanning the stock's window, so a benchmark with a gap stays in step.
  const t0 = dayMs(st[0].day), t1 = dayMs(st[st.length - 1].day);
  const inWindow = (s: typeof st) => s.filter((p) => dayMs(p.day) >= t0 && dayMs(p.day) <= t1);
  const spW = inWindow(sp), seW = inWindow(se);
  const [lo, hi] = padded([...st, ...spW, ...seW].map((p) => p.value).concat(100));
  const y = scale(lo, hi, bottom, top);
  const x = scale(t0, t1 === t0 ? t0 + 1 : t1, left, plotRight);
  const line = (s: typeof st) => path(s.map((p) => ({ x: x(dayMs(p.day)), y: y(p.value) })));
  const last = (s: typeof st) => (s.length ? s[s.length - 1].value : null);
  const fmt = (v: number | null) => (v === null ? "—" : v.toFixed(0));
  const series = [
    { name: "Stock", s: st, color: C.ink, show: true },
    { name: sectorSymbol ?? "Sector", s: seW, color: C.navy3, show: seW.length > 1 && !!sectorSymbol },
    { name: "S&P", s: spW, color: C.ink3, show: spW.length > 1 },
  ].filter((r) => r.show);
  const labelY = spreadLabels(series.map((r) => y(last(r.s) ?? 100) + 4), 14, top + 8, bottom);
  const aria = `Rebased to 100 a year ago (${st[0].day}): stock ${fmt(last(st))}, S&P 500 ${fmt(last(spW))}${sectorSymbol ? `, ${sectorSymbol} ${fmt(last(seW))}` : ""} on ${st[st.length - 1].day}.`;
  return <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} role="img" aria-label={aria}>
    <text x={0} y={y(100) + 4} fontSize="11" fill={C.ink3}>100</text>
    <line x1={left} y1={y(100)} x2={plotRight} y2={y(100)} stroke={C.lineStrong} />
    {spW.length > 1 && <path d={line(spW)} fill="none" stroke={C.ink3} strokeWidth="2" />}
    {seW.length > 1 && <path d={line(seW)} fill="none" stroke={C.navy3} strokeWidth="2" strokeDasharray="5 4" />}
    <path d={line(st)} fill="none" stroke={C.navy} strokeWidth="3" />
    {series.map((r, i) => <text key={r.name} x={plotRight + 8} y={labelY[i]} fontSize="12" fill={r.color}>{r.name} {fmt(last(r.s))}</text>)}
    <text x={left} y={H - 6} fontSize="11" fill={C.ink3}>{st[0].day}</text>
    <text x={plotRight} y={H - 6} fontSize="11" fill={C.ink3} textAnchor="end">{st[st.length - 1].day}</text>
  </svg>;
}

export const STAGE_FILL: Record<number, string> = { 1: C.ink3, 2: C.navy, 3: C.caution, 4: C.critical, 0: C.lineStrong };
/** The Weinstein stage of each of the last 52 weeks. */
export function StageStrip({ weeks }: { weeks: { week: string; stage_number: number }[] }) {
  if (!weeks.length) return <p className={styles.unavailable}>Stage history needs about nine months of weekly closes.</p>;
  const counts = [1, 2, 3, 4].map((n) => weeks.filter((w) => w.stage_number === n).length);
  return <div>
    <div className={styles.strip} role="img" aria-label={`Weinstein stage over ${weeks.length} weeks: ${counts.map((c, i) => `${c} in stage ${i + 1}`).join(", ")}; latest stage ${weeks[weeks.length - 1].stage_number}.`}>
      {weeks.map((w) => <span key={w.week} title={`Week to ${w.week}: stage ${w.stage_number}`} style={{ background: STAGE_FILL[w.stage_number] ?? STAGE_FILL[0] }} />)}
    </div>
    <div className={styles.legend}>
      <span><i style={{ background: STAGE_FILL[1] }} />1 basing</span><span><i style={{ background: STAGE_FILL[2] }} />2 advancing</span>
      <span><i style={{ background: STAGE_FILL[3] }} />3 topping</span><span><i style={{ background: STAGE_FILL[4] }} />4 declining</span>
    </div>
  </div>;
}

/** VCP pullback depths, oldest first: a true VCP steps down. */
export function VcpDepths({ contractions }: { contractions: { high_day: string; depth_pct: number }[] }) {
  const rows = contractions.filter((c) => finite(c.depth_pct));
  if (!rows.length) return null;
  const W = 300, H = 92, bottom = 70, max = Math.max(...rows.map((c) => c.depth_pct), 1);
  const bw = Math.min(56, (W - 10) / rows.length - 10);
  return <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} role="img"
    aria-label={`Pullback depths, oldest first: ${rows.map((c) => `${c.depth_pct.toFixed(1)}%`).join(", ")}.`}>
    {rows.map((c, i) => {
      const h = Math.max(2, (c.depth_pct / max) * 54);
      return <g key={c.high_day}>
        <rect x={i * (bw + 10)} y={bottom - h} width={bw} height={h} rx="3" fill={C.navy3} />
        <text x={i * (bw + 10)} y={bottom - h - 4} fontSize="11" fill={C.ink}>{c.depth_pct.toFixed(1)}%</text>
        <text x={i * (bw + 10)} y={H - 6} fontSize="10" fill={C.ink3}>{c.high_day.slice(5)}</text>
      </g>;
    })}
  </svg>;
}

/** A small three-month sparkline for the rail. */
export function Sparkline({ points }: { points: { close: number }[] }) {
  const pts = points.filter((p) => finite(p.close));
  if (pts.length < 2) return null;
  const W = 220, H = 50;
  const [lo, hi] = padded(pts.map((p) => p.close));
  const y = scale(lo, hi, H - 4, 4);
  const x = scale(0, pts.length - 1, 0, W);
  const up = pts[pts.length - 1].close >= pts[0].close;
  return <svg viewBox={`0 0 ${W} ${H}`} className={styles.spark} preserveAspectRatio="none" role="img"
    aria-label={`Three months: ${money(pts[0].close)} to ${money(pts[pts.length - 1].close)} (${up ? "up" : "down"})`}>
    <path d={path(pts.map((p, i) => ({ x: x(i), y: y(p.close) })))} fill="none" stroke={C.navy} strokeWidth="2" vectorEffect="non-scaling-stroke" />
  </svg>;
}
