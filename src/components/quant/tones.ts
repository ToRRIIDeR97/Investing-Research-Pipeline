// Colour tones for the Quant page (DESIGN.md "Quant colour"). Pure, so the finder, the rail and tests share them.
// The CSS for each tone lives in src/app/globals.css (--grade-*-ink / --grade-*-bg and --case-*).

export type GradeTone = "a" | "b" | "c" | "d" | "f" | "none";

/** A PulseGrade or PQ-Grade letter ("A+", "B-", "F") as a colour tone: A green through F red. */
export function gradeTone(grade: string | null | undefined): GradeTone {
  const letter = grade?.trim().charAt(0).toUpperCase();
  return letter === "A" ? "a" : letter === "B" ? "b" : letter === "C" ? "c" : letter === "D" ? "d" : letter === "F" ? "f" : "none";
}

export type ScenarioCase = "bear" | "base" | "bull";
/** Bear is red, base navy, bull green, wherever a scenario appears. */
export const CASE_VAR: Record<ScenarioCase, string> = { bear: "var(--case-bear)", base: "var(--case-base)", bull: "var(--case-bull)" };

/**
 * A scenario tile's meter, in percent of the track. The track runs from the lowest to the highest of today's price
 * and the case values; the fill spans today's price to this case's value (at least 3% wide so it always shows), and
 * `tick` marks today's price. Null when a number is missing. Pure.
 */
export function caseMeter(price: number | null | undefined, values: (number | null | undefined)[], value: number | null | undefined):
  { left: number; width: number; tick: number; lo: number; hi: number } | null {
  const ok = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
  if (!ok(price) || !ok(value)) return null;
  const all = [price, ...values.filter(ok)];
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const at = (v: number) => ((v - lo) / span) * 100;
  const a = at(price), b = at(value);
  let left = Math.min(a, b), width = Math.abs(b - a);
  if (width < 3) { width = 3; left = Math.min(Math.max(0, value >= price ? a : a - 3), 97); }
  return { left, width, tick: a, lo, hi };
}
