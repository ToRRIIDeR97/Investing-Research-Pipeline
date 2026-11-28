/**
 * Listed-company search for Start research, backed by Yahoo Finance's public search endpoint.
 * The browser never calls Yahoo: GET /api/market-search proxies this. Yahoo's output is untrusted,
 * so every field is type-checked, trimmed and length-capped. Start research keeps only US-style equity
 * symbols (letters, digits, hyphen), because an asset slug is the ticker and the pipeline reads SEC
 * filings; the Quant finder also keeps exchange-suffixed listings (BBCA.JK).
 */
import { readCapped } from "@/lib/net";

export const YAHOO_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";
const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const SYMBOL = /^[A-Z0-9-]{1,30}$/;
/** A Yahoo symbol with an exchange suffix (BBCA.JK, VOD.L, 7203.T), kept only by the international search. */
const INTL_SYMBOL = /^[A-Z0-9-]{1,20}\.[A-Z]{1,3}$/;
const MAX_RESULTS = 6;
const SEARCH_TIMEOUT_MS = 6_000;
const QUOTE_TIMEOUT_MS = 4_000;
const MAX_BYTES = 1_000_000;
const HEADERS = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };

export type CompanySearchResult = {
  symbol: string;
  name: string;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  price: number | null;
  change_pct: number | null;
  currency: string | null;
};

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return trimmed ? trimmed.slice(0, max) : null;
};
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Cleans a search query: trimmed, control characters removed, at most 60 characters. */
export function normalizeQuery(raw: string | null | undefined): string {
  return (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60);
}

/** Keeps the equity quotes with a usable symbol and name, deduplicated, best first. */
export function parseYahooSearch(body: unknown, options: { international?: boolean } = {}): CompanySearchResult[] {
  const quotes = (body as { quotes?: unknown })?.quotes;
  if (!Array.isArray(quotes)) return [];
  const seen = new Set<string>();
  const results: CompanySearchResult[] = [];
  for (const quote of quotes) {
    if (!quote || typeof quote !== "object") continue;
    const q = quote as Record<string, unknown>;
    if (q.quoteType !== "EQUITY") continue;
    const symbol = text(q.symbol, 30)?.toUpperCase();
    const name = text(q.longname, 200) ?? text(q.shortname, 200);
    if (!symbol || !(SYMBOL.test(symbol) || (options.international && INTL_SYMBOL.test(symbol))) || !name || seen.has(symbol)) continue;
    seen.add(symbol);
    results.push({
      symbol,
      name,
      exchange: text(q.exchDisp, 60) ?? text(q.exchange, 20),
      sector: text(q.sectorDisp, 100) ?? text(q.sector, 100),
      industry: text(q.industryDisp, 100) ?? text(q.industry, 100),
      price: null,
      change_pct: null,
      currency: null,
    });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

/** Reads the last price and today's change from a chart response; nulls when absent. */
export function parseYahooQuote(body: unknown): Pick<CompanySearchResult, "price" | "change_pct" | "currency"> {
  const meta = (body as { chart?: { result?: { meta?: Record<string, unknown> }[] } })?.chart?.result?.[0]?.meta;
  const price = finite(meta?.regularMarketPrice);
  const previous = finite(meta?.chartPreviousClose) ?? finite(meta?.previousClose);
  const change = price !== null && previous ? ((price - previous) / previous) * 100 : null;
  return { price, change_pct: change !== null && Number.isFinite(change) ? change : null, currency: text(meta?.currency, 6) };
}

async function getJson(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  const response = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  if (!response.ok) throw new Error(`Yahoo Finance returned ${response.status}`);
  return JSON.parse(new TextDecoder().decode(await readCapped(response, MAX_BYTES)));
}

/**
 * Searches Yahoo Finance for listed companies, then adds a best-effort price to each result.
 * Throws when the search itself fails; a missing price only leaves that result's price null.
 */
export async function searchListedCompanies(query: string, fetchImpl: typeof fetch = fetch, options: { international?: boolean; withQuotes?: boolean } = {}): Promise<CompanySearchResult[]> {
  const q = normalizeQuery(query);
  if (!q) return [];
  const url = `${YAHOO_SEARCH_URL}?${new URLSearchParams({ q, quotesCount: "12", newsCount: "0", listsCount: "0", enableFuzzyQuery: "false" })}`;
  const results = parseYahooSearch(await getJson(url, fetchImpl, SEARCH_TIMEOUT_MS), { international: options.international });
  if (options.withQuotes === false) return results;
  return Promise.all(results.map(async (result) => {
    try {
      const chart = await getJson(`${YAHOO_CHART_URL}/${encodeURIComponent(result.symbol)}?range=1d&interval=1d`, fetchImpl, QUOTE_TIMEOUT_MS);
      return { ...result, ...parseYahooQuote(chart) };
    } catch {
      return result;
    }
  }));
}
