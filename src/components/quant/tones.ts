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
