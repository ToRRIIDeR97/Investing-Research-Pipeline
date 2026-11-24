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

function isEmptyDimensions(row: Row): boolean {
  if (row.dimension_hash) return false;
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
    if (row.is_nil === true || Number(row.duplicate_ordinal ?? 0) > 0 || !isEmptyDimensions(row)) continue;
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

/** The newest 10-K, 10-Q, 20-F or 40-F (amendments included) filed on or before the cutoff. */
function newestPeriodicFiling(submissions: unknown, cutoffDate: string): { accession: string; filed: string } | null {
  const recent = (submissions as Row)?.filings?.recent ?? {};
  const forms: unknown[] = Array.isArray(recent.form) ? recent.form : [];
  let best: { accession: string; filed: string } | null = null;
  forms.forEach((form, i) => {
    const filed = day(recent.filingDate?.[i]);
    const accession = String(recent.accessionNumber?.[i] ?? "");
    if (!PERIODIC_FORM.test(String(form)) || !filed || filed > cutoffDate || !accession) return;
    if (!best || filed > best.filed) best = { accession, filed };
  });
  return best;
}

function apiUrl(base: URL, path: string): string {
  return `${base.origin}${base.pathname.replace(/\/+$/, "")}${path}`;
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<Row> {
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).pathname}`);
  const body = await response.json() as Row;
  if (!body || typeof body !== "object" || !Array.isArray(body.items)) throw new Error(`unexpected response from ${new URL(url).pathname}`);
  return body;
}

async function warehouseCompanyFacts(input: {
  base: URL; cik: number; submissions: unknown; cutoffDate: string; fetchImpl: FetchLike;
}): Promise<{ companyFacts: CompanyFacts; accessions: number }> {
  const filings: Row[] = [];
  for (let offset = 0; ; offset += FILINGS_PAGE) {
    const page = await getJson(input.fetchImpl, apiUrl(input.base, `/v1/companies/${input.cik}/filings?limit=${FILINGS_PAGE}&offset=${offset}`));
    filings.push(...page.items);
    if (page.items.length < FILINGS_PAGE) break;
    if (offset + FILINGS_PAGE > MAX_OFFSET) throw new Error(`more than ${MAX_OFFSET + FILINGS_PAGE} filings for CIK ${input.cik}`);
  }
  if (!filings.length) throw new Error(`has no filings for CIK ${input.cik}`);
  const newest = newestPeriodicFiling(input.submissions, input.cutoffDate);
  if (!newest) throw new Error(`cannot be checked: SEC submissions list no periodic filing by ${input.cutoffDate}`);
  if (!filings.some((f) => bareAccession(f.accession) === bareAccession(newest.accession))) {
    throw new Error(`lacks the newest periodic filing ${newest.accession} (filed ${newest.filed})`);
  }
  const readable = filings.filter((f) => f.accession && day(f.filed_date) && day(f.filed_date) <= input.cutoffDate);
  const rows: Row[] = [];
  let entityName: string | null = null;
  for (const filing of readable) {
    const accession = encodeURIComponent(String(filing.accession));
    for (let offset = 0; ; offset += FACTS_PAGE) {
      const page = await getJson(input.fetchImpl, apiUrl(input.base, `/v1/facts?cik=${input.cik}&accession=${accession}&limit=${FACTS_PAGE}&offset=${offset}`));
      rows.push(...page.items);
      entityName ??= page.items.find((r: Row) => r.company_name)?.company_name ?? null;
      if (page.items.length < FACTS_PAGE) break;
      if (offset + FACTS_PAGE > MAX_OFFSET) throw new Error(`has more than ${MAX_OFFSET + FACTS_PAGE} facts in ${filing.accession}`);
    }
  }
  entityName ??= readable.find((f) => f.registrant_name)?.registrant_name ?? null;
  return { companyFacts: warehouseFactsToCompanyFacts(rows, { cik: input.cik, entityName }), accessions: readable.length };
}

/**
 * The run's companyfacts: from the warehouse when `XBRL_WAREHOUSE_URL` is set and it holds the newest
 * periodic filing by the cutoff, otherwise from SEC. A warehouse failure never fails the run.
 */
export async function loadCompanyFacts(input: {
  cik: string; submissions: unknown; cutoffDate: string; userAgent: string;
  env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike;
}): Promise<{ companyFacts: any; origin: CompanyFactsOrigin }> {
  const fetchImpl = input.fetchImpl ?? fetchCapped;
  const base = warehouseUrlFromEnv(input.env ?? process.env);
  let reason: string | undefined;
  if (base) {
    try {
      const { companyFacts, accessions } = await warehouseCompanyFacts({ base, cik: Number(input.cik), submissions: input.submissions, cutoffDate: input.cutoffDate, fetchImpl });
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
