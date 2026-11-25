/**
 * Pure helpers for the statement table: the hierarchy (which lines add up to which total), number
 * format, and the change on a year earlier shown under each value.
 */

export type UnitKind = 'currency' | 'shares' | 'per_share' | 'other';

/** Headline lines that sit on the navy band. */
const KEY = /^(revenue|revenues|net_revenue|total_net_revenue|net_interest_income|net_income|net_income_loss|us_gaap_NetIncomeLoss|us_gaap_OperatingIncomeLoss|operating_income|total_assets|stockholders_equity|operating_cash_flow|us_gaap_Revenues|us_gaap_NetCashProvidedByUsedInOperatingActivities)$/;
const TOTAL = /^(total\b|net\b|gross profit|income before|loss before|(income|loss|earnings) \(loss\) before|operating income|income from operations|comprehensive)/i;
export const isKeyLine = (key: string) => KEY.test(key);
export const isTotalLine = (name: string) => TOTAL.test(name.trim());

export type TreeInput = {
  key: string; name: string;
  /** One value per period (all periods, not only the window); null where none or several. */
  values: (number | null)[];
  /** Rows only nest with rows of the same unit. */
  unit: string;
  /** Segment and geography rows never nest or take parts. */
  segment?: boolean;
};
export type StatementTree = {
  /** Row indexes in display order: each total, then its parts. */
  order: number[];
  depth: number[];
  parent: (number | null)[];
  children: number[][];
};

const POOL = 18;

/**
 * Nest a statement by its arithmetic. A total takes as its parts the lines that add up to it in
 * every period where all of them are reported (at least two periods when the total has two):
 * first plain sums ("Total interest expense" = deposits + warehouses + borrowings + other), smallest
 * totals first so they nest, then "Net …" lines that already sit inside a total, which may subtract
 * costs ("Net interest income" = interest income − interest expense). Parts can come from anywhere
 * in the filing, so lines filed out of place move under their total. Top-level differences
 * (operating income, net income) keep their place, and unmatched lines stay where they were filed.
 * Display order puts each total above its parts, at the place of its earliest line.
 */
export function statementTree(rows: TreeInput[]): StatementTree {
  const parent: (number | null)[] = rows.map(() => null);
  const children: number[][] = rows.map(() => []);
  const magnitude = rows.map((r) => Math.max(0, ...r.values.map((v) => (v === null ? 0 : Math.abs(v)))));
  const totals = rows.map((r, i) => i).filter((i) => !rows[i].segment && (isKeyLine(rows[i].key) || isTotalLine(rows[i].name)) && magnitude[i] > 0)
    .sort((a, b) => magnitude[a] - magnitude[b]);
  const inSubtree = (root: number, x: number): boolean => root === x || children[root].some((c) => inSubtree(c, x));

  function attach(t: number, signed: boolean) {
    const pool = rows.map((_, i) => i)
      .filter((i) => i !== t && parent[i] === null && !rows[i].segment && rows[i].unit === rows[t].unit && magnitude[i] > 0 && !inSubtree(i, t)
        // A headline line (revenue, net income) only sits under another headline line.
        && (!isKeyLine(rows[i].key) || isKeyLine(rows[t].key))
        // Assets equal liabilities plus equity, but they are not its parts.
        && !(/asset/i.test(rows[t].name) && /liabilit|equity|stock/i.test(rows[i].name)))
      .sort((a, b) => Math.abs(a - t) - Math.abs(b - t));
    const best = findParts(rows, t, pool, signed);
    if (!best) return false;
    for (const i of best) parent[i] = t;
    children[t] = best.sort((a, b) => a - b);
    return true;
  }
  for (let pass = 0; pass < 2; pass++) for (const t of totals) if (!children[t].length) attach(t, false);
  for (const t of totals) if (!children[t].length && parent[t] !== null && /^net\b/i.test(rows[t].name.trim())) attach(t, true);

  const first = (i: number): number => Math.min(i, ...children[i].map(first));
  const depth = rows.map(() => 0);
  const order: number[] = [];
  const visit = (i: number, d: number) => {
    depth[i] = d;
    order.push(i);
    [...children[i]].sort((a, b) => first(a) - first(b)).forEach((c) => visit(c, d + 1));
  };
  rows.map((_, i) => i).filter((i) => parent[i] === null).sort((a, b) => first(a) - first(b)).forEach((i) => visit(i, 0));
  return { order, depth, parent, children };
}

/** Costs subtract in a "Net …" line; everything else adds. */
const signOf = (name: string) => (COST.test(name) && !PROFIT.test(name) ? -1 : 1);

function findParts(rows: TreeInput[], t: number, pool: number[], signed: boolean): number[] | null {
  const T = rows[t].values;
  const periods = T.map((v, p) => (v === null ? -1 : p)).filter((p) => p >= 0);
  if (!periods.length || pool.length < 2) return null;
  const tol = (target: number, size: number) => Math.max(Math.abs(target) * 0.0015, 1000 * size);
  // Reference period: where the total and the most candidates are reported.
  const ref = periods.map((p) => [p, pool.filter((i) => rows[i].values[p] !== null).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  // A part is reported in at least half the periods the total is, and is no bigger than it.
  const cand = pool.filter((i) => rows[i].values[ref] !== null
    && periods.filter((p) => rows[i].values[p] !== null).length * 2 >= periods.length
    // A plain sum's parts are no bigger than it (a net line's can be).
    && (signed || magnitudeOf(rows[i]) <= magnitudeOf(rows[t]) * 1.001 + 1000)
    // A line smaller than the rounding slack proves nothing either way.
    && Math.max(...rows[i].values.map((v) => (v === null ? 0 : Math.abs(v)))) > tol(T[ref]!, 1) * 2).slice(0, POOL);
  const k = cand.length;
  if (k < 2) return null;
  const sign = cand.map((i) => (signed ? signOf(rows[i].name) : 1));
  const sums = new Float64Array(1 << k);
  let best: { mask: number; matched: number; spread: number; size: number } | null = null;
  for (let mask = 1; mask < 1 << k; mask++) {
    const low = mask & -mask, bit = 31 - Math.clz32(low);
    sums[mask] = sums[mask ^ low] + sign[bit] * rows[cand[bit]].values[ref]!;
    const size = popcount(mask);
    if (size < 2 || Math.abs(sums[mask] - T[ref]!) > tol(T[ref]!, size)) continue;
    if (signed && !cand.some((_, j) => mask & (1 << j) && sign[j] < 0)) continue;
    let matched = 0, ok = true;
    for (const p of periods) {
      let sum = 0, all = true;
      for (let j = 0; j < k && all; j++) if (mask & (1 << j)) { const v = rows[cand[j]].values[p]; if (v === null) all = false; else sum += sign[j] * v; }
      if (!all) continue;
      if (Math.abs(sum - T[p]!) > tol(T[p]!, size)) { ok = false; break; }
      matched++;
    }
    if (!ok || matched < Math.min(3, periods.length)) continue;
    // Every part must carry a value somewhere: a line of zeros proves nothing.
    if (cand.some((i, j) => mask & (1 << j) && rows[i].values.every((v) => !v))) continue;
    const spread = cand.reduce((s, i, j) => (mask & (1 << j) ? s + Math.abs(i - t) : s), 0) / size;
    if (!best || matched > best.matched || (matched === best.matched && (spread < best.spread - 1e-9 || (Math.abs(spread - best.spread) < 1e-9 && size > best.size)))) best = { mask, matched, spread, size };
  }
  if (!best) return null;
  const parts = cand.filter((_, j) => best!.mask & (1 << j));
  // Lines too small to test (a $0.1M "Other") join when they are filed among the parts.
  const lo = Math.min(...parts), hi = Math.max(...parts, t);
  const tiny = pool.filter((i) => !cand.includes(i) && i > lo && i < hi && magnitudeOf(rows[i]) <= tol(T[ref]!, 1) * 2);
  return [...parts, ...tiny];
}

const magnitudeOf = (r: TreeInput) => Math.max(0, ...r.values.map((v) => (v === null ? 0 : Math.abs(v))));

function popcount(x: number) { let c = 0; while (x) { x &= x - 1; c++; } return c; }

export function unitKind(unit: string | null | undefined, currency: string | null | undefined): UnitKind {
  if (unit && unit === currency && /^[A-Z]{3}$/.test(unit)) return 'currency';
  if (/\/shares$/i.test(unit ?? '')) return 'per_share';
  if (/^shares$/i.test(unit ?? '')) return 'shares';
  return 'other';
}

/** Currency in millions with one decimal; shares in millions; per-share amounts to the cent. */
export function formatAmount(value: number, kind: UnitKind): string {
  const sign = value < 0 ? '−' : '';
  const a = Math.abs(value);
  const fixed = (n: number, d: number) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  if (kind === 'currency') return sign + fixed(a / 1e6, 1);
  if (kind === 'shares') return `${sign}${fixed(a / 1e6, 1)}M`;
  if (kind === 'per_share') return sign + fixed(a, 2);
  return sign + a.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export const unitHeading = (kind: UnitKind, currency: string | null) =>
  kind === 'currency' ? `${currency ?? 'USD'} millions` : kind === 'shares' ? 'Shares, millions' : kind === 'per_share' ? `${currency ?? 'USD'} per share` : 'Value';

/** "Q3 2026" → "Q3 2025"; "2026" → "2025". */
export function priorYearLabel(label: string): string {
  const m = /^(Q\d )?(\d{4})$/.exec(label);
  return m ? `${m[1] ?? ''}${Number(m[2]) - 1}` : '';
}

/** Change on the same period a year earlier; null when either side is missing or the base is zero. */
export function yearChange(now: number | null, before: number | null): number | null {
  if (now === null || before === null || before === 0 || !Number.isFinite(now) || !Number.isFinite(before)) return null;
  return (now - before) / Math.abs(before);
}

/** Costs going up is bad news; everything else going up is good. */
const COST = /expense|cost|provision|loss|impairment|payments|purchases|repurchase|dividends paid|tax/i;
/** Profit lines filed as "Net loss" or "Loss before income taxes" still read up = good. */
const PROFIT = /^(net (income|loss|earnings)|(income|loss|earnings).*before income tax|comprehensive (income|loss)|total net revenue|net revenue|(earnings|income|loss) per share)/i;
export function changeTone(name: string, change: number | null, parent?: string | null): 'good' | 'bad' | null {
  if (change === null || Math.abs(change) < 0.005) return null;
  // A part takes its total's side: "Sales and marketing" under "Total noninterest expense" is a cost.
  const isCost = (n: string) => COST.test(n) && !PROFIT.test(n);
  const cost = isCost(name) || (!!parent && isCost(parent) && !/income|revenue/i.test(name));
  return (change > 0) !== cost ? 'good' : 'bad';
}

export const formatChange = (change: number) =>
  `${change >= 0 ? '+' : '−'}${Math.abs(change * 100) >= 1000 ? '999+' : Math.abs(change * 100).toFixed(0)}%`;

/** Command bar search: every word, in any order. "sales marketing" finds "Sales and marketing". */
export function matches(text: string, query: string) {
  const hay = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}
