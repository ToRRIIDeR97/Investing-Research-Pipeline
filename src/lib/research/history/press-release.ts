/**
 * Quarterly statements from foreign-issuer earnings releases (6-K Ex-99.1), which carry no inline XBRL (RQ-SRC-2).
 * The HTML is untrusted: it is read with one linear tag scan (scanTags), with caps on size, tables, rows and cells,
 * and only labelled numeric cells under a recognised date and currency header become facts. Convenience-translation
 * columns (US$ beside RMB) are dropped. The output is FilingTable[], so statementObservations, coverage and the
 * analytics pack treat release figures like filed statements.
 */
import { scanTags, dropComments, dropElements } from "@/lib/html-scan";
import type { FilingFact, FilingSource, FilingTable, StatementKind } from "./filing-statements";

const MAX_HTML = 4_000_000, MAX_TABLES = 120, MAX_ROWS = 150, MAX_CELLS = 40;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DATE = /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),\s*(\d{4})$/i;
/** Reporting-currency tokens in release headers; anything else (US$, HK$ translations) is a convenience column. */
const CURRENCY: Record<string, string> = { rmb: "CNY", "rmb'000": "CNY", hk$: "HKD", "us$": "USD", usd: "USD", "nt$": "TWD", "₩": "KRW", "r$": "BRL", "€": "EUR", eur: "EUR" };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };
function decode(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") { const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1)); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " "; }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}
const clean = (text: string) => decode(text).replace(/[ \s]+/g, " ").trim();

type RawTable = { index: number; before: string; rows: string[][] };

/** Tables as rows of non-empty cell texts, with the text before each table, in one pass over the tags. */
export function scanTables(html: string): RawTable[] {
  const source = dropElements(dropComments(html.slice(0, MAX_HTML)), ["script", "style"]);
  const tables: RawTable[] = [];
  let depth = 0, current: RawTable | null = null, row: string[] | null = null, cell: string | null = null, last = 0, textSince = "";
  for (const tag of scanTags(source)) {
    const text = source.slice(last, tag.start);
    last = tag.end;
    if (cell !== null) cell += text; else if (depth === 0) textSince = (textSince + " " + text).slice(-2000);
    if (tag.name === "table") {
      if (!tag.closing) {
        if (++depth === 1 && tables.length < MAX_TABLES) current = { index: tables.length, before: clean(textSince).slice(-400), rows: [] };
      } else if (depth > 0 && --depth === 0) {
        if (current) tables.push(current);
        current = null; row = null; cell = null; textSince = "";
      }
      continue;
    }
    if (!current || depth !== 1) continue;
    if (tag.name === "tr") {
      if (row && row.length && current.rows.length < MAX_ROWS) current.rows.push(row);
      row = tag.closing ? null : [];
      cell = null;
    } else if (tag.name === "td" || tag.name === "th") {
      if (tag.closing) { if (row && cell !== null) { const value = clean(cell); if (value && row.length < MAX_CELLS) row.push(value); } cell = null; }
      else cell = "";
    } else if (tag.name === "br" && cell !== null) cell += " ";
  }
  return tables;
}

/** "(1,234" then ")" is -1234; "—" is null. Returns null for non-numeric text. */
function numericCells(cells: string[]): (number | null)[] | null {
  const out: (number | null)[] = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i].replace(/^RMB\s*|^US\$\s*/i, "");
    if (c === ")" || c === "%") continue;
    if (/^[—–-]$/.test(c)) { out.push(null); continue; }
    const m = /^(\()?(-?[\d,]*\.?\d+)\)?$/.exec(c);
    if (!m) return null;
    const value = Number(m[2].replace(/,/g, ""));
    if (!Number.isFinite(value)) return null;
    out.push(m[1] || cells[i + 1] === ")" ? -Math.abs(value) : value);
  }
  return out;
}

type Column = { end: string; periodicity: "quarterly" | "annual" | "ytd" | "instant"; months: number; currency: string };

/** Header rows: a period phrase row, a date row and a currency row, read into one entry per value column. */
function headerColumns(rows: string[][]): { columns: Column[]; dataStart: number } | null {
  let phrases: string[] = [], dates: string[] = [], currencies: string[] = [];
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const r = rows[i];
    if (r.every((c) => DATE.test(c))) { dates = r; continue; }
    if (r.every((c) => /months ended|year ended|as of|as at|twelve months|nine months|six months/i.test(c))) { phrases = r; continue; }
    if (r.every((c) => c.toLowerCase() in CURRENCY)) { currencies = r.map((c) => CURRENCY[c.toLowerCase()]); continue; }
    if (dates.length && currencies.length) {
      const per = phrases.length ? Math.ceil(dates.length / phrases.length) : dates.length;
      const columns = dates.map((d, j) => {
        const [, month, dayText, year] = DATE.exec(d)!;
        const phrase = (phrases[Math.floor(j / per)] ?? phrases[0] ?? "").toLowerCase();
        const months = /three months/.test(phrase) ? 3 : /six months/.test(phrase) ? 6 : /nine months/.test(phrase) ? 9 : /year ended|twelve months/.test(phrase) ? 12 : 0;
        const periodicity = /as of|as at/.test(phrase) ? "instant" : months === 3 ? "quarterly" : months === 12 ? "annual" : months ? "ytd" : null;
        const end = `${year}-${String(MONTHS.indexOf(month.toLowerCase()) + 1).padStart(2, "0")}-${dayText.padStart(2, "0")}`;
        return periodicity ? { end, periodicity, months, currency: currencies[j] ?? "" } as Column : null;
      });
      if (columns.some((c) => !c)) return null;
      return { columns: columns as Column[], dataStart: i };
    }
  }
  return null;
}

/** Release line labels mapped to US-GAAP concepts, so the metric catalogue and analytics read them; others stay custom. */
const PL = "(?:income|loss)(?:\\/(?:income|loss))?";
const CASH = "net cash (?:provided by|used in)(?:\\/(?:provided by|used in))?";
const CONCEPTS: [RegExp, string, boolean?][] = [
  [/^total (?:consolidated )?net revenues$/, "Revenues"], [/^cost of revenues$/, "CostOfRevenue"],
  [/^marketing$/, "SellingAndMarketingExpense"], [/^research and development$/, "ResearchAndDevelopmentExpense"],
  [/^general and administrative$/, "GeneralAndAdministrativeExpense"],
  [new RegExp(`^(?:total consolidated )?${PL} from operations$`), "OperatingIncomeLoss"],
  [new RegExp(`^(?:total consolidated )?${PL} before tax$`), "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest"],
  [/^income tax (?:expenses?|benefits?)/, "IncomeTaxExpenseBenefit"], [new RegExp(`^net ${PL}$`), "ProfitLoss"],
  [new RegExp(`^net ${PL} attributable to the company.s ordinary shareholders$`), "NetIncomeLoss"],
  [/^cash and cash equivalents$/, "CashAndCashEquivalentsAtCarryingValue"], [/^short-term investments$/, "ShortTermInvestments"],
  [/^accounts receivable, net\b/, "AccountsReceivableNetCurrent"], [/^inventories, net$/, "InventoryNet"],
  [/^property, equipment and software, net$/, "PropertyPlantAndEquipmentNet"], [/^total assets$/, "Assets"],
  [/^short-term (?:borrowings|debts?)$/, "ShortTermBorrowings"], [/^accounts payable$/, "AccountsPayableCurrent"],
  [/^long-term (?:borrowings|debts?)$/, "LongTermDebtNoncurrent"], [/^total liabilities$/, "Liabilities"],
  [/^(?:total )?mezzanine equity$/, "TemporaryEquityCarryingAmountAttributableToParent"],
  [/^total liabilities(?:, mezzanine equity)? and (?:shareholders.|stockholders.)? ?equity$/, "LiabilitiesAndStockholdersEquity"],
  [/^total (?:shareholders.|stockholders.)? ?equity$/, "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  [/^total .+ (?:shareholders.|stockholders.) equity\b/, "StockholdersEquity"], [/^non-controlling interests$/, "MinorityInterest"],
  [new RegExp(`^${CASH} operating activities$`), "NetCashProvidedByUsedInOperatingActivities"],
  [new RegExp(`^${CASH} investing activities$`), "NetCashProvidedByUsedInInvestingActivities"],
  [new RegExp(`^${CASH} financing activities$`), "NetCashProvidedByUsedInFinancingActivities"],
  // Release capex lines are negative outflows; the us-gaap payment concept is a positive amount.
  [/^(?:less: )?capital expenditures(?:, net of related sales proceeds)?$/, "PaymentsToAcquireProductiveAssets", true],
];
const normalizeLabel = (label: string) => label.toLowerCase().replace(/[’']/g, "'").replace(/\s*\(\d+\)/g, "").replace(/\*+$/, "").replace(/\s+/g, " ").trim();
const slug = (label: string) => normalizeLabel(label).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80);

export function statementKind(before: string, rows: string[][]): StatementKind | null {
  if (rows.some((r) => /^total segment (?:income|loss|income\/\(loss\)|\(loss\)\/income) from operations$/i.test(r[0] ?? ""))) return "segment";
  const heading = before.slice(-300);
  if (/statements? of operations|statements? of income/i.test(heading)) return "income";
  if (/balance sheets?/i.test(heading)) return "balance";
  if (/statements? of cash flows/i.test(heading)) return "cashflow";
  return null;
}

function fiscal(end: string, yearEndMonth: number) {
  const month = Number(end.slice(5, 7)), year = Number(end.slice(0, 4));
  const offset = (month - yearEndMonth + 12) % 12;
  return { fiscal_year: offset === 0 || month <= yearEndMonth ? year : year + 1, fiscal_quarter: offset === 0 ? 4 : Math.ceil(offset / 3) };
}
function startOf(end: string, months: number) {
  const d = new Date(`${end}T00:00:00Z`);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months + 1, 1));
  return start.toISOString().slice(0, 10);
}

/** reportingCurrency defaults to the first value column's currency (releases show the reporting currency first, translations after). */
export interface ReleaseOptions { reportingCurrency?: string; yearEndMonth?: number; scale?: number }

/**
 * Statement tables from one earnings release. Values are in millions unless the heading says otherwise; per-share
 * sections are skipped. Segment tables become facts on press:<Segment>Member dimensions.
 */
export function extractReleaseStatements(html: string, source: FilingSource, options: ReleaseOptions): FilingTable[] {
  const yearEndMonth = options.yearEndMonth ?? 12;
  const out: FilingTable[] = [];
  for (const table of scanTables(html)) {
    const kind = statementKind(table.before, table.rows);
    if (!kind) continue;
    const header = headerColumns(table.rows);
    if (!header) continue;
    const scale = options.scale ?? (/in thousands/i.test(table.before) ? 1e3 : /in billions/i.test(table.before) ? 1e9 : 1e6);
    let section = "", perShare = false;
    const segmentNames = new Set<string>();
    const rows: FilingTable["rows"] = [];
    for (let r = header.dataStart; r < table.rows.length; r++) {
      const [label = "", ...rest] = table.rows[r];
      if (!rest.length) { section = normalizeLabel(label); perShare = /per (?:share|ads)/.test(section); continue; }
      const values = numericCells(rest);
      if (!values || values.length !== header.columns.length || perShare) continue;
      const name = normalizeLabel(label);
      // A segment section runs from its "Net revenues:" or "... from operations:" header to its total line.
      if (kind === "segment" && /^total/.test(name)) { section = ""; continue; }
      // Segments are the lines of the revenue section; later sections count only those names, not reconciling items.
      const isRevenueSection = /net revenues/.test(section);
      if (kind === "segment" && isRevenueSection && !/eliminations|unallocated/.test(name)) segmentNames.add(name);
      const segment = kind === "segment" && section && segmentNames.has(name) ? label.replace(/\*+$/, "").trim() : null;
      const mapped = kind === "segment"
        ? (segment && /net revenues/.test(section) ? ["Revenues"] : segment && /from operations/.test(section) ? ["OperatingIncomeLoss"] : null)
        : CONCEPTS.find(([pattern]) => pattern.test(name.replace(/[()]/g, "")))?.slice(1) as [string, boolean?] | undefined;
      if (kind === "segment" && !mapped) continue;
      // A balance-sheet line that appears under both current and non-current headings (JD's "Unsecured senior notes")
      // keeps the two apart, or one would replace the other as the same fact.
      const side = kind === "balance" ? (/^non-current|^noncurrent/.test(section) ? "_non_current" : /^current/.test(section) ? "_current" : "") : "";
      const concept = mapped ? `us-gaap:${mapped[0]}` : `press:${slug(label)}${side}`;
      const cells = header.columns.map((column, i) => {
        const value = values[i];
        if (column.currency !== (options.reportingCurrency ?? header.columns[0].currency)) return null;
        const { fiscal_year, fiscal_quarter } = fiscal(column.end, yearEndMonth);
        const fact: FilingFact = { concept, value: value === null ? null : (mapped?.[1] ? Math.abs(value) : value) * scale, text: rest[i] ?? "",
          unit: column.currency, start: column.periodicity === "instant" ? null : startOf(column.end, column.months),
          end: column.end, dimensions: segment ? `press:${segment}Member` : "", locator: `release table ${table.index} row ${r} column ${i}`, scale,
          fiscal_year, fiscal_quarter: column.periodicity === "annual" ? 4 : fiscal_quarter, periodicity: column.periodicity };
        return { text: rest[i] ?? "", colspan: 1, rowspan: 1, facts: [fact] };
      }).filter((c): c is NonNullable<typeof c> => c !== null);
      if (cells.length) rows.push({ cells: [{ text: label, colspan: 1, rowspan: 1, facts: [] }, ...cells] });
    }
    if (!rows.length) continue;
    const latest = header.columns.map((c) => c.end).sort().at(-1)!;
    // A statement continued on the next page repeats its heading: one table, so balance checks see every line.
    const previous = out.at(-1);
    if (previous && previous.statement === kind && previous.period_end === latest) { previous.rows.push(...rows); continue; }
    const { fiscal_year, fiscal_quarter } = fiscal(latest, yearEndMonth);
    out.push({ statement: kind, identified_by: "heading", title: table.before.slice(-160), source_document_id: source.id, source_url: source.url,
      accession: String(source.metadata_json.accession_number ?? source.metadata_json.filing?.accessionNumber ?? ""), filed: source.published_at,
      form: "6-K", period_end: latest, fiscal_year, fiscal_quarter, table_index: table.index, rows, warnings: [] });
  }
  return out;
}

/** An earnings release, judged from its opening text: "<Issuer> announces ... quarter ... results". */
export function isResultsRelease(text: string): boolean {
  const head = clean(text.slice(0, 20_000).replace(/<[^<>]*>/g, " ")).slice(0, 3000);
  return /announces\s+(?:unaudited\s+)?(?:(?:first|second|third|fourth)\s+quarter|q[1-4]|quarterly|interim|full[- ]year|annual|fiscal)[^.]{0,80}results/i.test(head)
    || /press release[—–-]\s*.{0,60}announces[^.]{0,80}quarter[^.]{0,40}results/i.test(head);
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, fifty: 50, hundred: 100 };
/**
 * Ordinary shares per ADS from release or 20-F text ("each ADS representing two Class A ordinary shares",
 * "one ADS represents 0.5 ordinary share"). Null when the text states none or several different ratios.
 */
export function depositaryRatioFromText(text: string): number | null {
  const plain = clean(text.replace(/<[^<>]*>/g, " ")).slice(0, 2_000_000);
  const found = new Set<number>();
  const patterns = [
    /each\s+ADS\s+represent(?:s|ing)\s+([a-z]+|\d+(?:\.\d+)?)\s+(?:class\s+[a-z]\s+)?ordinary\s+shares?/gi,
    /(?:one|each)\s+(?:American\s+depositary\s+share|ADS)\s*(?:\(["“]?ADS["”]?\))?\s+represents?\s+([a-z]+|\d+(?:\.\d+)?)\s+(?:class\s+[a-z]\s+)?ordinary\s+shares?/gi,
  ];
  for (const pattern of patterns) for (const m of plain.matchAll(pattern)) {
    const raw = m[1].toLowerCase();
    const n = /^\d/.test(raw) ? Number(raw) : WORDS[raw];
    if (Number.isFinite(n) && n > 0 && n < 10_000) found.add(n);
  }
  return found.size === 1 ? [...found][0] : null;
}
