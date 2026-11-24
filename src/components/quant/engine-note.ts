// The PragValue engine note ("Engine F — Mid-cycle normalised (5yr weighted). Core yield: 0.0%, FCF yield: 7.0%")
// split into parts the page can lay out: the engine code, who it is for, the method, and its key figures. Pure.

/** Who each engine values, in plain words (routing in src/lib/quant/value/engines.ts). */
const ENGINE_FOR: Record<string, string> = {
  A: "Operating companies",
  B: "Growth companies",
  B2: "Pre-revenue biotech",
  C: "Banks and insurers",
  C1: "Banks",
  C2: "Insurers",
  D: "REITs",
  E: "Utilities",
  F: "Energy and mining",
  G: "Asset owners",
};

/** One plain sentence on how each engine values a company, shown when the engine strip is hovered or focused. */
const ENGINE_EXPLAIN: Record<string, string> = {
  A: "Values a profitable company on its normal operating profit compared with what the whole business costs to buy.",
  B: "Values a fast grower on its sales and on how well it balances growth with profit.",
  B2: "Scores a drug developer with no sales yet only against similar pipeline companies, since there are no earnings to value.",
  C: "Values a bank or insurer on what its tangible assets are worth and the return it earns on shareholders' money.",
  C1: "Values a bank on what its tangible assets are worth and whether it earns more on shareholders' money than that money costs.",
  C2: "Values an insurer on what its tangible assets are worth and the return it earns on shareholders' money.",
  D: "Values a property trust on the cash its buildings bring in and the dividend it pays out.",
  E: "Values a utility on its operating cash earnings and how comfortably it covers its interest bill.",
  F: "Values a miner or energy producer on its average profit across a whole commodity cycle, so one boom or bust year doesn't skew it.",
  G: "Values a company that mainly owns assets on the cash those assets produce and how much debt sits on top of them.",
};

/** The engine's one-sentence explanation, or null for an unknown code. */
export function explainEngine(code: string | null | undefined): string | null {
  if (!code) return null;
  return ENGINE_EXPLAIN[code] ?? ENGINE_EXPLAIN[code[0]] ?? null;
}

export type EngineNote = { code: string | null; audience: string | null; method: string; figures: { label: string; value: string }[] };

export function parseEngineNote(note: string | null | undefined): EngineNote {
  const text = (note ?? "").trim();
  const m = /^Engine\s+([A-Z][0-9]?)\s*[—-]\s*(.*)$/.exec(text);
  const code = m ? m[1] : null;
  const rest = m ? m[2] : text;
  // Figures are "Label: number" pairs, with an optional x or % unit.
  const figures: { label: string; value: string }[] = [];
  const re = /([A-Za-z][A-Za-z0-9/ ]*?):\s*(−?-?[\d.]+\s?[x%]?)/g;
  let first = -1;
  for (let hit = re.exec(rest); hit; hit = re.exec(rest)) {
    if (first < 0) first = hit.index;
    figures.push({ label: hit[1].trim(), value: hit[2].replace(/\s+/g, "") });
  }
  let method = (first >= 0 ? rest.slice(0, first) : rest).trim().replace(/[\s.,(]+$/, "");
  // "Revenue + Growth composite (EV/Rev: 3.1x, …)" leaves an unclosed "(": drop it with the figures.
  if ((method.match(/\(/g) ?? []).length > (method.match(/\)/g) ?? []).length) method = method.replace(/\s*\([^)]*$/, "");
  return { code, audience: code ? ENGINE_FOR[code] ?? ENGINE_FOR[code[0]] ?? null : null, method: method || text, figures };
}

/** "interest_expense" → "Interest expense"; "ebit" → "EBIT". */
export function fieldLabel(key: string): string {
  const words = key.split("_").map((w) => (["ebit", "ebitda", "fcf", "ocf", "eps"].includes(w) ? w.toUpperCase() : w));
  const s = words.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Metric weights, heaviest first, as whole percentages; weights at or below zero are left out. */
export function weightSegments(weights: Record<string, number> | null | undefined): { metric: string; pct: number }[] {
  const rows = Object.entries(weights ?? {}).filter(([, w]) => Number.isFinite(w) && w > 0);
  const total = rows.reduce((a, [, w]) => a + w, 0);
  if (!total) return [];
  return rows.map(([metric, w]) => ({ metric, pct: Math.round((w / total) * 100) })).sort((a, b) => b.pct - a.pct);
}
