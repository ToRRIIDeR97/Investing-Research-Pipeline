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
