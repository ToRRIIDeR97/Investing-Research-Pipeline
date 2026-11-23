/** Pure maths behind the interactive chart kit (src/components/interactive). No DOM, no React. */

export type CaseValues = { bear: number | null; base: number | null; bull: number | null };

const MINUS = "−";

/** A gap as a signed percentage: one decimal under 10%, whole percent otherwise, U+2212 for minus, "—" for null. */
export function formatGap(r: number | null | undefined): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return "—";
  const pct = Math.abs(r) * 100;
  const text = Math.abs(r) < 0.1 ? pct.toFixed(1) : String(Math.round(pct));
  if (Number(text) === 0) return "0%";
  return `${r < 0 ? MINUS : "+"}${text}%`;
}

/** value / price − 1; null when either is missing or the price is not positive. */
export function gapPct(value: number | null | undefined, price: number | null | undefined): number | null {
  if (value === null || value === undefined || price === null || price === undefined) return null;
  if (!Number.isFinite(value) || !Number.isFinite(price) || price <= 0) return null;
  return value / price - 1;
}

/** Half the base case plus half a mix of bear and bull: t = 0 leans to bear, t = 1 to bull. Null if a case is missing. */
export function blendValue(values: CaseValues, t: number): number | null {
  const { bear, base, bull } = values;
  if (bear === null || base === null || bull === null) return null;
  const w = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0.5));
  return 0.5 * base + 0.5 * (1 - w) * bear + 0.5 * w * bull;
}

/** Index of the nearest of n evenly spaced points between left and right, clamped; -1 when there are none. */
export function nearestIndex(x: number, n: number, left: number, right: number): number {
  if (n <= 0) return -1;
  if (n === 1 || right === left) return 0;
  const i = Math.round(((x - left) / (right - left)) * (n - 1));
  return Math.min(n - 1, Math.max(0, i));
}

/** Keyboard cursor movement over n points. */
export function cursorStep(i: number, key: string, n: number): number {
  if (n <= 0) return i;
  const clamp = (v: number) => Math.min(n - 1, Math.max(0, v));
  switch (key) {
    case "ArrowLeft": return clamp(i - 1);
    case "ArrowRight": return clamp(i + 1);
    case "Home": return 0;
    case "End": return n - 1;
    case "PageUp": return clamp(i - 10);
    case "PageDown": return clamp(i + 10);
    default: return i;
  }
}

/** Donut arcs as fractions of the circle: start is the share before, length is the share minus the gap (never negative). */
export function donutSegments(counts: readonly number[], gap: number): { start: number; length: number }[] {
  const total = counts.reduce((sum, c) => sum + Math.max(0, c), 0);
  if (!counts.length || total <= 0) return [];
  let start = 0;
  return counts.map((count) => {
    const share = Math.max(0, count) / total;
    const segment = { start, length: Math.max(0, share - gap) };
    start += share;
    return segment;
  });
}
