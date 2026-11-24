/**
 * Companyfacts from the XBRL warehouse (`services/xbrl`), with SEC companyfacts as the fallback.
 *
 * The warehouse parses filings with Arelle and serves point-in-time facts through a read-only API. This
 * module rebuilds SEC's companyfacts shape from its non-dimensional standard-taxonomy facts, so every
 * existing companyfacts reader keeps working. The warehouse is used only when it holds the issuer's
 * newest periodic filing by the cutoff; anything else falls back to SEC and records why.
 * Warehouse output is untrusted data, like SEC's.
 */
import { fetchCapped, validateEndpointUrl } from "@/lib/net";

type Row = Record<string, any>;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type SecFactRow = {
  start?: string;
  end: string;
  val: number;
  accn: string;
  fy: number | null;
  fp: string | null;
  form: string;
  filed: string;
};

export type CompanyFacts = {
  cik: number;
  entityName: string | null;
  facts: Record<string, Record<string, { units: Record<string, SecFactRow[]> }>>;
};

export type CompanyFactsOrigin = {
  provider: "xbrl_warehouse" | "sec_companyfacts";
  url: string;
  reason?: string;
  accessions?: number;
};

const STANDARD_PREFIXES = new Set(["us-gaap", "dei", "ifrs-full", "srt"]);
const NAMESPACE_PREFIXES: Array<[RegExp, string]> = [
  [/fasb\.org\/us-gaap/i, "us-gaap"],
  [/xbrl\.sec\.gov\/dei/i, "dei"],
  [/xbrl\.ifrs\.org/i, "ifrs-full"],
  [/fasb\.org\/srt/i, "srt"],
];
const PERIODIC_FORM = /^(10-K|10-Q|20-F|40-F)(\/A)?$/;
const FILINGS_PAGE = 1_000;
const FACTS_PAGE = 10_000;
const MAX_OFFSET = 10_000; // the warehouse API caps offset at 10,000
const MIN_FACTS_PAGE = 400;
const WINDOW_MONTHS = 66; // the filing window fetchSecContext uses

/** `XBRL_WAREHOUSE_URL` as a loopback or private URL, or null when unset. */
export function warehouseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): URL | null {
  const raw = String(env.XBRL_WAREHOUSE_URL ?? "").trim();
  if (!raw) return null;
  return validateEndpointUrl(raw, "XBRL_WAREHOUSE_URL", { local: true });
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

/**
 * Decided from `dimensions_json` alone: the warehouse stores "[]" for a fact without dimensions, and its
 * `dimension_hash` is the SHA-256 of that JSON, so the hash is never empty.
 */
function isEmptyDimensions(row: Row): boolean {
  const dims = parseJson(row.dimensions_json);
  if (dims == null || dims === "") return true;
  if (Array.isArray(dims)) return dims.length === 0;
  return typeof dims === "object" && Object.keys(dims as object).length === 0;
}

function taxonomyOf(row: Row): string | null {
  const prefix = String(row.concept_qname ?? "").split(":")[0];
  if (STANDARD_PREFIXES.has(prefix)) return prefix;
  const namespace = String(row.concept_namespace ?? "");
  return NAMESPACE_PREFIXES.find(([pattern]) => pattern.test(namespace))?.[1] ?? null;
}

function measures(value: unknown): string[] {
  const parsed = parseJson(value);
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return list.map((m) => String(m).split(":").pop()!).filter(Boolean);
}

function unitOf(row: Row): string | null {
  const numerator = measures(row.unit_numerator_json);
  if (!numerator.length) return null;
  const denominator = measures(row.unit_denominator_json);
  return denominator.length ? `${numerator.join("*")}/${denominator.join("*")}` : numerator.join("*");
}

const day = (value: unknown) => (value ? String(value).slice(0, 10) : "");

/** Rebuild SEC companyfacts from warehouse fact rows (see the module comment for what is kept). */
export function warehouseFactsToCompanyFacts(rows: Row[], entity: { cik: string | number; entityName?: string | null }): CompanyFacts {
  const facts: CompanyFacts["facts"] = {};
  const seen = new Set<string>();
  for (const row of rows) {
    // is_nil is a UInt8 (0/1); duplicate facts are numbered from 1, so the first of a duplicate set is kept.
    if (row.is_nil === true || Number(row.is_nil) === 1 || Number(row.duplicate_ordinal ?? 1) > 1 || !isEmptyDimensions(row)) continue;
    const taxonomy = taxonomyOf(row);
    const concept = String(row.concept_name ?? "");
    const unit = unitOf(row);
    if (!taxonomy || !concept || !unit) continue;
    if (row.value_decimal === null || row.value_decimal === undefined || row.value_decimal === "") continue;
    const val = Number(row.value_decimal);
    if (!Number.isFinite(val)) continue;
    const instant = String(row.period_kind) === "instant";
    const end = day(instant ? row.period_instant : row.period_end);
    const start = instant ? "" : day(row.period_start);
    const accn = String(row.accession ?? "");
    if (!end || !accn || (!instant && !start)) continue;
    const key = [taxonomy, concept, unit, start, end, accn].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const fy = row.fiscal_year === null || row.fiscal_year === undefined || row.fiscal_year === "" ? null : Number(row.fiscal_year);
    const fact: SecFactRow = {
      ...(instant ? {} : { start }),
      end, val, accn,
      fy: Number.isFinite(fy) ? fy : null,
      fp: row.fiscal_period ? String(row.fiscal_period) : null,
      form: String(row.form ?? ""),
      filed: day(row.filed_date),
    };
    const units = ((facts[taxonomy] ??= {})[concept] ??= { units: {} }).units;
    (units[unit] ??= []).push(fact);
  }
  for (const concepts of Object.values(facts)) {
    for (const { units } of Object.values(concepts)) {
      for (const list of Object.values(units)) {
        list.sort((a, b) => a.end.localeCompare(b.end) || a.filed.localeCompare(b.filed) || a.accn.localeCompare(b.accn));
      }
    }
  }
  return { cik: Number(entity.cik), entityName: entity.entityName ?? null, facts };
}

const bareAccession = (value: unknown) => String(value ?? "").replace(/-/g, "");

/** Periodic filings (10-K, 10-Q, 20-F, 40-F, amendments included) that SEC submissions list, filed in the window. */
function periodicFilings(submissions: unknown, fromDate: string, cutoffDate: string): { accession: string; filed: string }[] {
  const recent = (submissions as Row)?.filings?.recent ?? {};
  const forms: unknown[] = Array.isArray(recent.form) ? recent.form : [];
  const out: { accession: string; filed: string }[] = [];
  forms.forEach((form, i) => {
    const filed = day(recent.filingDate?.[i]);
    const accession = String(recent.accessionNumber?.[i] ?? "");
    if (PERIODIC_FORM.test(String(form)) && filed && filed >= fromDate && filed <= cutoffDate && accession) out.push({ accession, filed });
  });
  return out.sort((a, b) => b.filed.localeCompare(a.filed));
}

/** The first day of the source window: five and a half years before the cutoff, as fetchSecContext selects filings. */
function windowStart(cutoffDate: string): string {
  const d = new Date(`${cutoffDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "0000-01-01";
  d.setUTCMonth(d.getUTCMonth() - WINDOW_MONTHS);
  return d.toISOString().slice(0, 10);
}

function apiUrl(base: URL, path: string): string {
  return `${base.origin}${base.pathname.replace(/\/+$/, "")}${path}`;
}

class WarehouseHttpError extends Error {
  constructor(readonly status: number, path: string) { super(`HTTP ${status} from ${path}`); }
}

async function getJson(fetchImpl: FetchLike, url: string, apiKey: string | null): Promise<Row> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetchImpl(url, { headers });
  if (!response.ok) throw new WarehouseHttpError(response.status, new URL(url).pathname);
  const body = await response.json() as Row;
  if (!body || typeof body !== "object" || !Array.isArray(body.items)) throw new Error(`unexpected response from ${new URL(url).pathname}`);
  return body;
}

/** Every fact row of one filing. A 503 (the API's result-size cap) retries the page with fewer rows. */
async function filingFacts(input: { base: URL; cik: number; accession: string; fetchImpl: FetchLike; apiKey: string | null }): Promise<Row[]> {
  const rows: Row[] = [];
  let limit = FACTS_PAGE;
  for (let offset = 0; ;) {
    let page: Row;
    try {
      page = await getJson(input.fetchImpl, apiUrl(input.base,
        `/v1/facts?cik=${input.cik}&accession=${encodeURIComponent(input.accession)}&limit=${limit}&offset=${offset}`), input.apiKey);
    } catch (error) {
      if (error instanceof WarehouseHttpError && error.status === 503 && limit > MIN_FACTS_PAGE) {
        limit = Math.max(MIN_FACTS_PAGE, Math.floor(limit / 5));
        continue;
      }
      throw error;
    }
    rows.push(...page.items);
    if (page.items.length < limit) return rows;
    offset += limit;
    if (offset > MAX_OFFSET) throw new Error(`has more than ${offset} facts in ${input.accession}`);
  }
}

async function warehouseCompanyFacts(input: {
  base: URL; cik: number; submissions: unknown; cutoffDate: string; fetchImpl: FetchLike; apiKey: string | null;
}): Promise<{ companyFacts: CompanyFacts; accessions: number }> {
  const filings: Row[] = [];
  for (let offset = 0; ; offset += FILINGS_PAGE) {
    const page = await getJson(input.fetchImpl, apiUrl(input.base, `/v1/companies/${input.cik}/filings?limit=${FILINGS_PAGE}&offset=${offset}`), input.apiKey);
    filings.push(...page.items);
    if (page.items.length < FILINGS_PAGE) break;
    if (offset + FILINGS_PAGE > MAX_OFFSET) throw new Error(`more than ${MAX_OFFSET + FILINGS_PAGE} filings for CIK ${input.cik}`);
  }
  if (!filings.length) throw new Error(`has no filings for CIK ${input.cik}`);
  // Every periodic filing SEC lists in the run's window must be loaded: a partial load would silently drop history.
  const required = periodicFilings(input.submissions, windowStart(input.cutoffDate), input.cutoffDate);
  if (!required.length) throw new Error(`cannot be checked: SEC submissions list no periodic filing by ${input.cutoffDate}`);
  const loaded = new Set(filings.map((f) => bareAccession(f.accession)));
  const missing = required.filter((f) => !loaded.has(bareAccession(f.accession)));
  if (missing.length) {
    throw new Error(`lacks ${missing.length} of ${required.length} periodic filings in the window (newest missing ${missing[0].accession}, filed ${missing[0].filed})`);
  }
  // Only periodic filings by the cutoff: companyfacts readers use 10-K, 10-Q, 20-F and 40-F facts.
  const readable = filings.filter((f) => f.accession && PERIODIC_FORM.test(String(f.form ?? "")) && day(f.filed_date) && day(f.filed_date) <= input.cutoffDate);
  const rows: Row[] = [];
  for (const filing of readable) {
    rows.push(...await filingFacts({ base: input.base, cik: input.cik, accession: String(filing.accession), fetchImpl: input.fetchImpl, apiKey: input.apiKey }));
  }
  const entityName = rows.find((r) => r.company_name)?.company_name ?? readable.find((f) => f.registrant_name)?.registrant_name ?? null;
  const companyFacts = warehouseFactsToCompanyFacts(rows, { cik: input.cik, entityName });
  const standard = ["us-gaap", "ifrs-full"].some((taxonomy) => Object.keys(companyFacts.facts[taxonomy] ?? {}).length > 0);
  if (!standard) throw new Error(`returned no us-gaap or ifrs-full facts for ${readable.length} periodic filings (${rows.length} rows)`);
  return { companyFacts, accessions: readable.length };
}

/**
 * The run's companyfacts: from the warehouse when `XBRL_WAREHOUSE_URL` is set and it holds every periodic
 * filing SEC lists in the run's window, otherwise from SEC. A warehouse failure never fails the run.
 * `XBRL_WAREHOUSE_API_KEY`, when set, is sent as the warehouse's Bearer key (its `XBRL_API_KEY`).
 */
export async function loadCompanyFacts(input: {
  cik: string; submissions: unknown; cutoffDate: string; userAgent: string;
  env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike;
}): Promise<{ companyFacts: any; origin: CompanyFactsOrigin }> {
  const fetchImpl = input.fetchImpl ?? fetchCapped;
  const env = input.env ?? process.env;
  const base = warehouseUrlFromEnv(env);
  let reason: string | undefined;
  if (base) {
    try {
      const apiKey = String(env.XBRL_WAREHOUSE_API_KEY ?? "").trim() || null;
      const { companyFacts, accessions } = await warehouseCompanyFacts({ base, cik: Number(input.cik), submissions: input.submissions, cutoffDate: input.cutoffDate, fetchImpl, apiKey });
      return { companyFacts, origin: { provider: "xbrl_warehouse", url: base.href, accessions } };
    } catch (error) {
      reason = `XBRL warehouse ${error instanceof Error ? error.message : String(error)}; used SEC companyfacts`;
      console.warn(`${reason} (CIK ${input.cik})`);
    }
  }
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${input.cik}.json`;
  const response = await fetchImpl(url, { headers: { "User-Agent": input.userAgent } });
  if (!response.ok) throw new Error(`SEC companyfacts failed: ${response.status}`);
  return { companyFacts: await response.json(), origin: { provider: "sec_companyfacts", url, ...(reason ? { reason } : {}) } };
}
