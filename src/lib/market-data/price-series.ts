/**
 * Shapes stored daily closes for the price chart. Pure: no database, no provider, never invents or interpolates a
 * price. Days are ISO `YYYY-MM-DD` strings.
 */

export const RANGES = ["1M", "3M", "6M", "1Y", "5Y"] as const;
export type PriceRange = (typeof RANGES)[number];
export type PricePoint = { day: string; close: number };

const MONTHS: Record<PriceRange, number> = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "5Y": 60 };

export const isPriceRange = (value: unknown): value is PriceRange => typeof value === "string" && (RANGES as readonly string[]).includes(value);

/** `day` minus `months` calendar months, same day of month clamped to that month's last day (2026-03-31 − 1M = 2026-02-28). */
export function monthsBefore(day: string, months: number): string {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  const index = y * 12 + (m - 1) - months;
  const year = Math.floor(index / 12);
  const month = index - year * 12; // 0-based
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${pad(month + 1)}-${pad(Math.min(d, last))}`;
}

/** Sort by day, keep the last close per day, and keep the days on or after the last day minus the range. */
export function pricePoints(bars: readonly PricePoint[], range: PriceRange): PricePoint[] {
  const byDay = new Map<string, number>();
  for (const bar of [...bars].sort((a, b) => a.day.localeCompare(b.day))) {
    if (Number.isFinite(bar.close)) byDay.set(bar.day, bar.close);
  }
  const points = [...byDay].map(([day, close]) => ({ day, close }));
  if (!points.length) return [];
  const from = monthsBefore(points[points.length - 1].day, MONTHS[range]);
  return points.filter((point) => point.day >= from);
}

/** Last close over first close, minus one; null under two points or a non-positive first close. */
export function seriesChange(points: readonly PricePoint[]): number | null {
  if (points.length < 2) return null;
  const first = points[0].close;
  const last = points[points.length - 1].close;
  return first > 0 ? last / first - 1 : null;
}
