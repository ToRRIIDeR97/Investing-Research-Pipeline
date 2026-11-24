/** Closes rebased to 100 at the start of the window (the last `days` bars), for the relative-performance chart. */
export function rebased(bars: { day: string; close: number }[], days = 252): { day: string; value: number }[] {
  const window = bars.slice(-days);
  const base = window[0]?.close;
  if (!base) return [];
  return window.map((b) => ({ day: b.day, value: (b.close / base) * 100 }));
}
