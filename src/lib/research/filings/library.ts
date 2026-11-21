/**
 * The filings library (notebook panel, Filings tab): which of an asset's stored documents are primary filings, and
 * how a filing's stored passages are compressed into an outline, a section's text and a plain-text download. Pure:
 * the routes in `src/app/api/assets/[id]/filings/**` read the rows and call these. Filing text is untrusted data and
 * leaves here as plain text only (tags removed, whitespace collapsed).
 */

export const FILING_FORMS = ["10-K", "10-Q", "20-F", "40-F", "6-K", "8-K"] as const;
export type FilingForm = typeof FILING_FORMS[number];

// A whole-word form: "10-K/A" and "sofi-10-k-2025.htm" are 10-K, "110-K" and "10-KT" are not.
const FORM = /(?<![A-Za-z0-9])(10-K|10-Q|20-F|40-F|6-K|8-K)(?![A-Za-z0-9])/i;
const formIn = (text: unknown): FilingForm | null => {
  const match = typeof text === "string" ? FORM.exec(text) : null;
  return match ? match[1].toUpperCase() as FilingForm : null;
};

export type FilingDoc = { source_type: string; title: string; url: string | null; metadata_json?: Record<string, unknown> | null };

/**
 * The document's library form (one of FILING_FORMS; an amendment such as "10-K/A" is its form) or null. A stated
 * `metadata_json.form` (an EDGAR filing names it) is authoritative: a form outside the library (for example
 * "DEF 14A") gives null, without looking at the title or URL. Otherwise the title, else the URL.
 */
export function filingForm(doc: FilingDoc): FilingForm | null {
  const stated = doc.metadata_json?.form;
  if (typeof stated === "string" && stated.trim()) return formIn(stated);
  return formIn(doc.title) ?? formIn(doc.url);
}

type Dated = { id: string; source_type: string; title: string; url: string | null; published_at: string | null; retrieved_at: string; metadata_json?: Record<string, unknown> | null };
const time = (value: string | null | undefined) => { const t = value ? Date.parse(value) : NaN; return Number.isFinite(t) ? t : null; };

/**
 * The library's filings: forms in FILING_FORMS only, published within `years` of `now` (undated documents are left
 * out), one per URL (the copy retrieved last), newest publication first.
 */
/** `years` before `now`: whole years on the calendar, then any fraction as that share of 365.25 days. */
export function yearsBefore(now: Date, years: number): number {
  const whole = Math.trunc(years);
  const since = new Date(now);
  since.setUTCFullYear(since.getUTCFullYear() - whole);
  return since.getTime() - (years - whole) * 365.25 * 86_400_000;
}

export function recentFilings<T extends Dated>(docs: T[], now: Date, years = 2): (T & { form: string })[] {
  const since = yearsBefore(now, years);
  const byUrl = new Map<string, T & { form: string }>();
  for (const doc of docs) {
    const form = filingForm(doc);
    if (!form) continue;
    const published = time(doc.published_at);
    if (published === null || published < since || published > now.getTime()) continue;
    const key = doc.url || `id:${doc.id}`;
    const held = byUrl.get(key);
    if (!held || (time(doc.retrieved_at) ?? 0) > (time(held.retrieved_at) ?? 0)) byUrl.set(key, { ...doc, form });
  }
  return [...byUrl.values()].sort((a, b) => (time(b.published_at)! - time(a.published_at)!) || a.id.localeCompare(b.id));
}

export type FilingChunk = { chunk_index: number; section_title: string | null; text: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" };
const TAG = /<\/?[a-z!][^>]*>/gi;
/** Plain text: tags removed (before and after decoding common entities), whitespace collapsed. */
export function plainText(text: string): string {
  return text.replace(TAG, " ").replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, name: string) => ENTITIES[name])
    .replace(TAG, " ").replace(/\s+/g, " ").trim();
}

type Section = { index: number; title: string; text: string };
/** Consecutive chunks with the same title form one section; untitled sections are titled "Section <n>". */
function sections(chunks: FilingChunk[]): Section[] {
  const ordered = [...chunks].sort((a, b) => a.chunk_index - b.chunk_index);
  const out: (Section & { key: string | null; parts: string[] })[] = [];
  for (const chunk of ordered) {
    const key = chunk.section_title ? plainText(chunk.section_title) || null : null;
    const last = out.at(-1);
    const text = plainText(chunk.text);
    if (last && last.key === key) { if (text) last.parts.push(text); continue; }
    out.push({ index: out.length, key, title: key ?? `Section ${out.length + 1}`, text: "", parts: text ? [text] : [] });
  }
  return out.map(({ index, title, parts }) => ({ index, title, text: parts.join(" ") }));
}

/** At most `max` characters, cut at a word boundary with "…" when cut. */
function preview(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The filing as an outline: each section's title, size and a short preview; `total_chars` is the full size and
 * `preview_chars` the compressed size (the previews' lengths added up). Both are 0 for no chunks.
 */
export function compressFiling(chunks: FilingChunk[], previewChars = 400) {
  const list = sections(chunks).map((s) => ({ index: s.index, title: s.title, chars: s.text.length, preview: preview(s.text, previewChars) }));
  return { sections: list, total_chars: list.reduce((n, s) => n + s.chars, 0), preview_chars: list.reduce((n, s) => n + s.preview.length, 0) };
}

/** One section's full text, or null when there is no such section. */
export function sectionText(chunks: FilingChunk[], index: number): string | null {
  return sections(chunks).find((s) => s.index === index)?.text ?? null;
}

/** The plain-text download: `# <title>`, then `## <section title>` and its text per section. No HTML. */
export function filingText(title: string, chunks: FilingChunk[]): string {
  const body = sections(chunks).map((s) => `## ${s.title}\n${s.text}`).join("\n\n");
  return `# ${plainText(title) || "Filing"}\n\n${body}\n`;
}
