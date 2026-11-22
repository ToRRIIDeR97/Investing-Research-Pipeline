/**
 * Reader-facing text from a report answer, cleaned in code before validation and storage: reference tokens and
 * record IDs are removed and snake_case field names become words, so the reader never sees pipeline identifiers.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TOKEN = "(?:ev|ar|id)\\d+";
/** A UUID or any-case token inside brackets, with a directly preceding "see". */
const BRACKETED_REF = new RegExp(`(?:\\bsee\\s+)?(?:\\b${UUID}\\b|\\b${TOKEN}\\b)`, "gi");
/**
 * Outside brackets: a run of UUIDs (any case) or lower-case tokens joined by separators or conjunctions
 * ("ev1, ev2 and ar3"), with a directly preceding "see" in any case. The whole run goes, so no orphan "," or "and".
 */
const UUID_ANY_CASE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const BARE_REF = `\\b(?:${UUID_ANY_CASE}|${TOKEN})\\b`;
const BARE_RUN = new RegExp(`(?:\\b[Ss][Ee][Ee]\\s+)?${BARE_REF}(?:\\s*(?:,|;|&|\\band\\b|\\bor\\b)\\s*${BARE_REF})*`, "g");
/** Text before a removed run that ends a sentence, so the next word is capitalised. */
const SENTENCE_START = /(?:^|[.!?]["')\]]?\s+)\s*$/;
/** Text before a removed run that ends in an opening quote or bracket, so the space after the run goes too. */
const OPENING = /(?:(?:^|[\s:(\[])["']|[“‘(\[])$/;
/**
 * Marks left where a run was removed, resolved after snake_case words are written: CAPITAL upper-cases the next
 * letter, TIGHT eats the following space, GAP lets a separator left directly before the end of a sentence go.
 */
const CAPITAL = "\u0000", TIGHT = "\u0001", GAP = "\u0002";
const BRACKETS = /([([])([^()[\]]*)([)\]])/g;
const ONLY_SEPARATORS = /^[\s,;:/&|.\-–—]*$/;
const SNAKE = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g;

/** Finance acronyms a snake_case part is written as. */
const ACRONYMS: Record<string, string> = {
  ttm: "TTM", yoy: "YoY", qoq: "QoQ", fcf: "FCF", fcff: "FCFF", fcfe: "FCFE", ocf: "OCF", roic: "ROIC", roe: "ROE",
  roa: "ROA", ronic: "RONIC", nopat: "NOPAT", sbc: "SBC", ev: "EV", ebit: "EBIT", ebitda: "EBITDA", eps: "EPS",
  gaap: "GAAP", usd: "USD", dso: "DSO", dpo: "DPO", dio: "DIO", ccc: "CCC", nwc: "NWC", capm: "CAPM", wacc: "WACC",
  da: "D&A", cagr: "CAGR", ppe: "PP&E", nii: "NII", nim: "NIM",
};

const words = (identifier: string) => identifier.split("_").map(part => ACRONYMS[part] ?? part).join(" ");

/** Removes reference tokens and UUIDs, turns snake_case identifiers into words and tidies the spacing. Idempotent. */
export function readerProse(text: string): string {
  if (typeof text !== "string" || !text) return text;
  let out = text.replace(BRACKETS, (match, open: string, inner: string, close: string) => {
    const kept = inner.replace(BRACKETED_REF, "");
    if (kept === inner) return match;
    if (ONLY_SEPARATORS.test(kept)) return "";
    return open + kept.replace(/\s*([,;])(?:\s*[,;])+/g, "$1").replace(/^[\s,;]+|[\s,;]+$/g, "") + close;
  });
  out = out.replace(BARE_RUN, (_match, offset: number, whole: string) => {
    const before = whole.slice(0, offset);
    return SENTENCE_START.test(before) ? CAPITAL : OPENING.test(before) ? TIGHT : GAP;
  });
  out = out.replace(SNAKE, words)
    .replace(new RegExp(`[,;:][ \\t]*${GAP}(?=[ \\t]*(?:[.!?]|$))`, "g"), "")
    .replace(new RegExp(`${TIGHT}[ \\t]*`, "g"), "")
    .replace(new RegExp(`${CAPITAL}[ \\t]*([a-z])`, "g"), (_m, letter: string) => letter.toUpperCase())
    .replace(new RegExp(`[${CAPITAL}${TIGHT}${GAP}]`, "g"), "");
  return out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([,.;:])(?=\s|$)/g, "$1").replace(/^[ \t]+|[ \t]+$/g, "");
}

/** A number written in thousands ("240,989 thousand"), with its optional decimals. */
const IN_THOUSANDS = /\b(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?[ \t]*thousands?\b/gi;
/**
 * Rewrites amounts written in thousands as millions or billions ("240,989 thousand" is "241.0 million",
 * "9,520,479 thousand" is "9.52 billion"); one under a million is written in full ("512 thousand" is "512,000").
 * Applied to newly written answers only (cleanReaderFields), so stored reports render and hash as before. Idempotent.
 */
export function withoutThousands(text: string): string {
  if (typeof text !== "string" || !text) return text;
  return text.replace(IN_THOUSANDS, (_match, whole: string, decimals = "") => {
    const value = Number(whole.replace(/,/g, "") + decimals) * 1000;
    if (!Number.isFinite(value)) return _match;
    const millions = value / 1e6;
    if (value >= 1e9 || Number(millions.toFixed(1)) >= 1000) return `${(value / 1e9).toFixed(2)} billion`;
    if (value >= 1e6) return `${millions.toFixed(1)} million`;
    return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  });
}

/** Write-time cleaning of one reader-facing string: readerProse, then amounts in thousands rewritten. */
const clean = (value: unknown) => typeof value === "string" ? withoutThousands(readerProse(value)) : value;
const each = <T>(list: T[] | undefined, fn: (item: T) => T) => Array.isArray(list) ? list.map(fn) : list;
const withText = (item: any, keys: string[]) => item && typeof item === "object"
  ? { ...item, ...Object.fromEntries(keys.filter(key => typeof item[key] === "string").map(key => [key, clean(item[key])])) } : item;

function cleanSection(section: any) {
  if (!section || typeof section !== "object") return section;
  const out = withText(section, ["title", "counterevidence", "implication"]);
  if (Array.isArray(section.paragraphs)) out.paragraphs = section.paragraphs.map((p: any) => withText(p, ["text"]));
  if (Array.isArray(section.gaps)) out.gaps = section.gaps.map(clean);
  if (Array.isArray(section.key_reasons)) out.key_reasons = section.key_reasons.map((r: any) => withText(r, ["headline", "explanation", "figure"]));
  if (Array.isArray(section.visuals)) out.visuals = section.visuals.map((visual: any) => {
    const v = withText(visual, ["title", "caption"]);
    if (Array.isArray(visual?.lanes)) v.lanes = visual.lanes.map((lane: any) => {
      const l = withText(lane, ["note"]);
      if (Array.isArray(lane?.nodes)) l.nodes = lane.nodes.map((node: any) => withText(node, ["label"]));
      return l;
    });
    return v;
  });
  return out;
}

function cleanOutline(outline: any) {
  if (!outline || typeof outline !== "object") return outline;
  return { ...outline,
    ...(Array.isArray(outline.sections) ? { sections: each(outline.sections, (s: any) => withText(s, ["title"])) } : {}),
    ...(Array.isArray(outline.questions) ? { questions: each(outline.questions, (q: any) => withText(q, ["question", "answer", "follow_up"])) } : {}),
    ...(Array.isArray(outline.coverage) ? { coverage: each(outline.coverage, (c: any) => withText(c, ["rationale"])) } : {}) };
}

/**
 * Applies readerProse to the reader-facing fields of a `{section}` answer (and a conclusion's top-level coverage
 * rationales) or an `{outline}` answer. Ids, coverage keys, kinds and citation arrays are untouched.
 */
export function cleanReaderFields<T>(value: T): T {
  const v = value as any;
  if (!v || typeof v !== "object" || Array.isArray(v)) return value;
  const out = { ...v };
  if (v.section) {
    out.section = cleanSection(v.section);
    if (Array.isArray(v.coverage)) out.coverage = v.coverage.map((c: any) => withText(c, ["rationale"]));
  }
  if (v.outline) out.outline = cleanOutline(v.outline);
  return out as T;
}
