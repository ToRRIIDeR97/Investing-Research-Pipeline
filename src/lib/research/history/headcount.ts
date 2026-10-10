/**
 * Deterministic total-headcount capture from filing text (10-K Human Capital, 10-Q MD&A,
 * earnings releases). Only explicit company-wide statements with an as-of date are accepted;
 * anything forward-looking, partial (segment, team, country) or mixed with contractors is
 * dropped. When unsure the extractor returns nothing: it never estimates.
 *
 * TODO(headcount-llm-fallback): filings where this returns nothing could go to a reviewed
 * model extraction. Add it behind `HeadcountFallback` below, keep its output separate
 * (metric_type 'calculated' or lower confidence) and require the evidence sentence.
 */

export type HeadcountFinding = {
  value: number;
  as_of: string;
  approximate: boolean;
  /** The sentence the value and date were read from, whitespace-normalized. */
  evidence: string;
  /** Character offset of the sentence in `filingPlainText(html)`. */
  offset: number;
};

/** Hook for a later fallback extractor; not wired in this change. */
export type HeadcountFallback = (text: string) => Promise<HeadcountFinding[]>;

const NAMED: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', ensp: ' ', emsp: ' ', thinsp: ' ' };
const BLOCK = /<\/?(?:p|div|br|tr|td|th|li|ul|ol|table|tbody|thead|h[1-6]|section|article|header|footer|title)\b[^>]*>/gi;

/** Filing HTML to text with one block element per line and entities such as &#160; decoded. */
export function filingPlainText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<ix:header\b[\s\S]*?<\/ix:header\s*>/gi, ' ')
    .replace(BLOCK, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, code: string) => {
      if (code[0] !== '#') return NAMED[code.toLowerCase()] ?? entity;
      const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : entity;
    })
    .replace(/[    \t\r\f\v ]+/g, ' ')
    .replace(/ *\n[\n ]*/g, '\n')
    .trim();
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const DATE = `(${MONTH}\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+${MONTH}\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})`;
const NUM = '(\\d{1,3}(?:,\\d{3})+|\\d{1,7})';
// "Over", "more than", "nearly" and "up to" are bounds, not counts; they never match.
const QUALIFIER = '((?:a total of\\s+)?(?:approximately|about|around|roughly|an estimated)\\s+|a total of\\s+)?';
const SUBJECT = '\\b(?:we|the company|our company)\\s+(?:had|employed)\\s+(?:a\\s+(?:global\\s+|total\\s+|worldwide\\s+)?workforce\\s+of\\s+)?';
const KIND = '((?:(?:full[- ]time|total|permanent|global)\\s+)*)(?:employees|people)\\b';
const AS_OF = '(?:as of|at|on)\\s+';
// Earnings releases label the bullet: "• Headcount – Headcount was ...".
const LEAD = '^[^A-Za-z0-9]*(?:headcount\\s*[–—:-]\\s*)?(?:(?:our|total|global|worldwide|company-wide)\\s+){0,2}headcount\\s+';
const VERB = '(?:was|totaled|totalled|stood at)\\s+';

const PATTERNS: { re: RegExp; num: number; date: number; qual: number; tail?: number }[] = [
  // "Headcount was 75,472 as of June 30, 2026"
  { re: new RegExp(`${LEAD}${VERB}${QUALIFIER}${NUM}\\s+${AS_OF}${DATE}`, 'i'), qual: 1, num: 2, date: 3 },
  // "Headcount as of June 30, 2026 was 75,472"
  { re: new RegExp(`${LEAD}${AS_OF}${DATE},?\\s+${VERB}${QUALIFIER}${NUM}\\b`, 'i'), date: 1, qual: 2, num: 3 },
  // "As of December 31, 2025, we had approximately 78,000 full-time employees"
  { re: new RegExp(`\\b${AS_OF}${DATE},?\\s+${SUBJECT}${QUALIFIER}${NUM}\\s+${KIND}(.*)$`, 'i'), date: 1, qual: 2, num: 3, tail: 5 },
  // "We had 78,865 employees as of December 31, 2025"
  { re: new RegExp(`${SUBJECT}${QUALIFIER}${NUM}\\s+${KIND}\\s*(?:globally\\s+|worldwide\\s+|in total\\s+)?,?\\s*${AS_OF}${DATE}`, 'i'), qual: 1, num: 2, date: 4 },
];

// Subset, outlook and conditional wording before the count disqualifies the sentence.
const PREFIX_REJECT = /\b(?:expect|expects|anticipate|anticipates|plan|plans|intend|intends|project|projects|forecast|target|will|would|could|might|if|segment|segments|division|subsidiary|subsidiaries|business unit|team|contractors?|consultants?|contingent|temporary|seasonal|part-time|excluding|excludes|including|includes|acquisition|acquired)\b/i;
// After "employees" only a sentence break, a breakdown clause or a global qualifier is accepted.
const TAIL_REJECT = /^\s*,?\s*(?:and|or|plus|including|excluding|as well as)\s+(?:[\w-]+\s+){0,3}(?:contractors?|consultants?|contingent|temporary|interns?|seasonal)/i;
const TAIL_OK = /^\s*(?:$|[,;.:)]|(?:globally|worldwide|around the world)\b|(?:in|across)\s+(?:(?:over|more than|approximately|about)\s+)?\d+\s+countries\b)/i;

const TABLE_HEADER = new RegExp(`\\bnumber\\s+of\\s+(?:our\\s+)?(?:full[- ]time\\s+)?employees\\s+by\\s+(?:country|region|geography|geographic area|location|function|department)\\s+${AS_OF}${DATE}`, 'i');

function isoDate(text: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  let year: number, month: number, day: number;
  if (iso) [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else {
    const parts = text.replace(/[.,]/g, ' ').trim().split(/\s+/);
    const [m, d] = /^\d/.test(parts[0]) ? [parts[1], parts[0]] : [parts[0], parts[1]];
    month = MONTHS.indexOf(m.slice(0, 3).toLowerCase()) + 1; day = Number(d); year = Number(parts[2]);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return month >= 1 && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && year > 1900 ? date.toISOString().slice(0, 10) : null;
}

function* sentences(text: string): Generator<{ sentence: string; offset: number }> {
  let lineStart = 0;
  for (const line of text.split('\n')) {
    let start = 0;
    const boundary = /(?<=[.!?])\s+(?=[A-Z“"(])/g;
    for (let m = boundary.exec(line); ; m = boundary.exec(line)) {
      const end = m ? m.index : line.length;
      const sentence = line.slice(start, end).trim();
      if (sentence) yield { sentence, offset: lineStart + start };
      if (!m) break;
      start = m.index + m[0].length;
    }
    lineStart += line.length + 1;
  }
}

/** One finding per as-of date. A date with conflicting counts in the same text yields nothing. */
export function extractHeadcount(text: string): HeadcountFinding[] {
  const byDate = new Map<string, HeadcountFinding[]>();
  for (const { sentence, offset } of sentences(text)) {
    if (!/headcount|employees|people/i.test(sentence)) continue;
    for (const p of PATTERNS) {
      const m = p.re.exec(sentence);
      if (!m) continue;
      if (PREFIX_REJECT.test(sentence.slice(0, m.index + m[0].length - (p.tail ? m[p.tail].length : 0)))) continue;
      if (p.tail !== undefined && (TAIL_REJECT.test(m[p.tail]) || !TAIL_OK.test(m[p.tail]))) continue;
      const value = Number(m[p.num].replace(/,/g, ''));
      const as_of = isoDate(m[p.date]);
      if (!as_of || !Number.isInteger(value) || value <= 0 || value >= 10_000_000) continue;
      const finding = { value, as_of, approximate: !!m[p.qual] && /approx|about|around|roughly|estimated/i.test(m[p.qual]), evidence: sentence, offset };
      (byDate.get(as_of) ?? byDate.set(as_of, []).get(as_of)!).push(finding);
      break;
    }
  }
  // A breakdown table ("number of our employees by country as of <date>") whose Total row is the company count.
  const lines = text.split('\n');
  for (let i = 0, offset = 0; i < lines.length; offset += lines[i].length + 1, i++) {
    const header = TABLE_HEADER.exec(lines[i]);
    const as_of = header && isoDate(header[1]);
    if (!as_of || PREFIX_REJECT.test(lines[i].slice(0, header.index + header[0].length))) continue;
    for (let j = i + 1; j < Math.min(lines.length - 1, i + 80) && lines[j].length <= 60; j++) {
      if (!/^total$/i.test(lines[j])) continue;
      const total = new RegExp(`^${NUM}$`).exec(lines[j + 1]);
      const value = total ? Number(total[1].replace(/,/g, '')) : 0;
      if (value > 0 && value < 10_000_000) (byDate.get(as_of) ?? byDate.set(as_of, []).get(as_of)!).push({ value, as_of, approximate: false, evidence: `${header[0]} … Total ${total![1]}`, offset });
      break;
    }
  }
  return [...byDate.values()].flatMap(found => new Set(found.map(f => f.value)).size === 1 ? [found[0]] : [])
    .sort((a, b) => a.as_of.localeCompare(b.as_of));
}

export type HeadcountSource = { id: string; url: string; published_at: string; form: string };
export type FiscalPeriod = { end: string; fiscal_year: number; fiscal_quarter: number };

/**
 * Place findings on the run's fiscal calendar and shape them as `employees` observations.
 * The as-of date must be a known period end from the captured statements or fall on the
 * quarter grid from the nearest one (within 10 days); otherwise the finding is left unplaced.
 * Per as-of date the latest filing wins; a periodic report beats an 8-K filed the same day.
 */
export function headcountObservations(found: { source: HeadcountSource; findings: HeadcountFinding[] }[], periods: FiscalPeriod[]) {
  const known = new Map(periods.map(p => [p.end, p]));
  const day = 86_400_000;
  const place = (asOf: string) => {
    if (known.has(asOf)) return known.get(asOf)!;
    const nearest = [...known.values()].sort((a, b) => Math.abs(Date.parse(a.end) - Date.parse(asOf)) - Math.abs(Date.parse(b.end) - Date.parse(asOf)))[0];
    if (!nearest) return null;
    const quarters = (Date.parse(asOf) - Date.parse(nearest.end)) / day / 91.3125;
    if (Math.abs(quarters - Math.round(quarters)) * 91.3125 > 10) return null;
    const index = nearest.fiscal_year * 4 + nearest.fiscal_quarter - 1 + Math.round(quarters);
    return { end: asOf, fiscal_year: Math.floor(index / 4), fiscal_quarter: index % 4 + 1 };
  };
  const periodic = (form: string) => /^10-[KQ]/.test(form);
  const groups = new Map<string, { source: HeadcountSource; finding: HeadcountFinding }[]>();
  const unplaced: { source_document_id: string; as_of: string; value: number; evidence: string }[] = [];
  for (const { source, findings } of found) for (const finding of findings) {
    if (!place(finding.as_of)) { unplaced.push({ source_document_id: source.id, as_of: finding.as_of, value: finding.value, evidence: finding.evidence }); continue; }
    (groups.get(finding.as_of) ?? groups.set(finding.as_of, []).get(finding.as_of)!).push({ source, finding });
  }
  const observations = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([asOf, group]) => {
    const filed = (c: typeof group[number]) => c.source.published_at.slice(0, 10);
    const { source, finding } = group.reduce((best, c) => filed(c) > filed(best) || (filed(c) === filed(best) && periodic(c.source.form) && !periodic(best.source.form)) ? c : best);
    const period = place(asOf)!;
    const revisions = new Set(group.filter(c => filed(c) < source.published_at.slice(0, 10) && c.finding.value !== finding.value).map(c => c.finding.value)).size;
    const base = {
      metric_key: 'employees', value_numeric: finding.value, value_text: null, unit: 'persons', currency: null, segment: null,
      period_start: null, period_end: asOf, fiscal_year: period.fiscal_year, fiscal_quarter: period.fiscal_quarter,
      reporting_basis: 'as_reported', metric_type: 'reported', source_document_id: source.id, available_at: source.published_at.slice(0, 10),
      restatement_version: revisions, comparability_status: 'comparable', confidence: 1,
      metadata_json: {
        metric_category: 'operating_metric', period_type: 'instant', statement_label: 'Total employees', capture_method: 'headcount-text-v1',
        form: source.form, source_url: source.url, source_locator: `text-offset:${finding.offset}`, evidence: finding.evidence, approximate: finding.approximate,
      },
    };
    return [{ ...base, periodicity: 'quarterly' }, ...(period.fiscal_quarter === 4 ? [{ ...base, periodicity: 'annual', fiscal_quarter: null }] : [])];
  });
  return { observations, unplaced };
}
