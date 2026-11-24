// Test support: CSS modules resolve to class names; helpers for paths, fetch stubs and price series.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ext = (require as unknown as { extensions: Record<string, (m: { exports: unknown }) => void> }).extensions;
ext[".css"] = (m) => { m.exports = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? false : k === "default" ? m.exports : String(k)) }); };

export const root = join(__dirname, "../../..");
export const read = (p: string) => readFileSync(join(root, p), "utf8");

export type Call = { url: string; init?: RequestInit };
/** A fetch that answers by URL prefix and records every call. A route value of Error rejects. */
export function stubFetch(routes: Array<[RegExp, unknown | ((url: string) => unknown)]>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const hit = routes.find(([pattern]) => pattern.test(url));
    if (!hit) return new Response("not found", { status: 404 });
    const value = typeof hit[1] === "function" ? (hit[1] as (u: string) => unknown)(url) : hit[1];
    if (value instanceof Error) throw value;
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Business days from a start date, one close per day. */
export function series(closes: number[], start = "2023-01-02") {
  const out: { day: string; close: number }[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  for (const close of closes) {
    while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
    out.push({ day: d.toISOString().slice(0, 10), close });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
export const ramp = (n: number, from: number, to: number) => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));

/** A warehouse fact row with defaults. */
export function fact(over: Record<string, unknown>): Record<string, unknown> {
  return {
    accession: "0000320193-25-000079", cik: 320193, form: "10-K", filed_date: "2025-10-31",
    fiscal_year: 2025, fiscal_period: "FY",
    concept_namespace: "http://fasb.org/us-gaap/2025", concept_name: "Revenues", concept_qname: "us-gaap:Revenues",
    value_kind: "decimal", raw_value: "1000", value_decimal: "1000", is_nil: false,
    unit_id: "u1", unit_numerator_json: '["iso4217:USD"]', unit_denominator_json: "[]",
    period_kind: "duration", period_start: "2024-09-29", period_end: "2025-09-27", period_instant: null,
    dimensions_json: "{}", dimension_hash: "", duplicate_ordinal: 0,
    ...over,
  };
}

/** Submissions JSON with recent filings, newest first. */
export function submissions(rows: Array<{ form: string; accessionNumber: string; filingDate: string }>) {
  return { filings: { recent: {
    form: rows.map((r) => r.form), accessionNumber: rows.map((r) => r.accessionNumber), filingDate: rows.map((r) => r.filingDate),
  } } };
}
