/**
 * Everything the Quant page computes from, for one ticker, without a research run (Implementations/quant-page P1).
 *
 * Issuer and SIC come from SEC submissions; annual fundamentals from companyfacts (the XBRL warehouse when it
 * covers the issuer, else SEC); daily bars with volume from the stored Yahoo history, synced first. Prices hang off
 * an asset row: a researched asset's when one lists the ticker, else a `quant-<ticker>` reference asset that stays
 * out of the Research list. Benchmarks are the S&P 500 and the issuer's SPDR sector ETF. No model calls.
 */
import postgres from "postgres";
import { fetchCapped } from "@/lib/net";
import {
  BETA_BENCHMARK, PRIMARY_PRICE_PROVIDER, closeOnSplitBasis, loadBenchmarkPriceHistory, loadStoredPriceHistory,
  syncAssetPriceHistory, syncBenchmarkPriceHistory, timedFetch, type SplitEvent, type StoredBar,
} from "@/lib/market-data/price-history";
import { createYahooMarketDataProvider } from "@/lib/market-data/providers/yahoo";
import { resolveSecCik } from "@/lib/research/sources/sec-cik";
import { loadCompanyFacts, type CompanyFactsOrigin } from "@/lib/research/history/xbrl-warehouse";
import { annualFundamentals, type AnnualFundamentals } from "./fundamentals";
import { sectorFromSic, type SectorInfo } from "./sic";

type Sql = ReturnType<typeof postgres>;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const SEC_USER_AGENT = "ResearchOS/0.1 research-pipeline-test@example.com";

/** A split-adjusted daily bar on the latest bar's split basis. */
export type QuantBar = { day: string; close: number; volume: number | null };

export class QuantInputError extends Error {
  constructor(readonly code: "invalid_ticker" | "unknown_ticker" | "not_equity" | "no_prices" | "upstream_unavailable", message: string) { super(message); }
}

export type QuantInputs = {
  ticker: string;
  name: string;
  cik: string | null;
  sic: string | null;
  sic_description: string | null;
  sector: SectorInfo;
  instrument_type: string | null;
  fundamentals: AnnualFundamentals | null;
  fundamentals_reason: string | null;
  company_facts_origin: CompanyFactsOrigin | null;
  bars: QuantBar[];
  benchmark: { symbol: string; bars: QuantBar[] };
  sector_etf: { symbol: string; bars: QuantBar[] } | null;
  asset: { id: string; researched: boolean };
  as_of: string;
  notes: string[];
  /** Upstream steps that failed this time (a snapshot built from them is not cached). */
  transient: string[];
};

import { TICKER_PATTERN } from "./ticker";
export { TICKER_PATTERN };

/** Daily bars restated on the latest bar's split basis, with volume rescaled the opposite way. */
export function quantBars(bars: StoredBar[], splits: SplitEvent[]): QuantBar[] {
  const toDay = bars[bars.length - 1]?.day;
  if (!toDay) return [];
  return bars.map((bar) => {
    const close = closeOnSplitBasis(bar.close, bar.day, bar.retrieved_day, toDay, splits);
    const factor = bar.close > 0 ? close / bar.close : 1;
    const volume = bar.volume === null || bar.volume === undefined ? null : factor > 0 ? Math.round(bar.volume / factor) : bar.volume;
    return { day: bar.day, close, volume };
  });
}

async function secJson(fetchImpl: FetchLike, url: string): Promise<any> {
  const response = await fetchImpl(url, { headers: { "User-Agent": SEC_USER_AGENT } });
  if (!response.ok) throw new Error(`SEC request failed: ${response.status} ${new URL(url).pathname}`);
  return response.json();
}

/** The asset whose prices the page reads: a researched asset listing the ticker, else a reference asset. */
async function quantAsset(sql: Sql, ticker: string, name: string): Promise<{ id: string; name: string; researched: boolean }> {
  const [researched] = await sql`
    SELECT a.id, a.canonical_name FROM assets a
    JOIN instruments i ON i.asset_id = a.id
    WHERE a.status IS DISTINCT FROM 'reference'
      AND (EXISTS (SELECT 1 FROM listings l WHERE l.instrument_id = i.id AND upper(l.symbol) = ${ticker})
        OR EXISTS (SELECT 1 FROM market_price_bars b WHERE b.instrument_id = i.id AND b.provider_symbol = ${ticker}))
    ORDER BY a.created_at LIMIT 1`;
  if (researched) return { id: String(researched.id), name: String(researched.canonical_name), researched: true };
  const slug = `quant-${ticker.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  await sql`
    INSERT INTO assets (canonical_name, slug, asset_kind, base_currency, status, description)
    VALUES (${name}, ${slug}, 'equity', 'USD', 'reference', ${`Quant page prices for ${ticker}; not a research subject.`})
    ON CONFLICT (slug) DO NOTHING`;
  const [row] = await sql`SELECT id, canonical_name FROM assets WHERE slug = ${slug}`;
  return { id: String(row.id), name: String(row.canonical_name), researched: false };
}

/** A reference asset for a benchmark ETF, created on first use (like the S&P 500 benchmark). */
async function syncEtf(sql: Sql, symbol: string, fetchImpl: FetchLike | undefined): Promise<{ etf: { symbol: string; bars: QuantBar[] } | null; synced: boolean }> {
  const slug = `benchmark-${symbol.toLowerCase()}`;
  await sql`
    INSERT INTO assets (canonical_name, slug, asset_kind, base_currency, status, description)
    VALUES (${`${symbol} sector ETF`}, ${slug}, 'fund', 'USD', 'reference', ${`Sector benchmark (${symbol}) for the Quant page; not a research subject.`})
    ON CONFLICT (slug) DO NOTHING`;
  const [row] = await sql`SELECT id FROM assets WHERE slug = ${slug}`;
  const assetId = String(row.id);
  const sync = await syncAssetPriceHistory(sql, { assetId, assetName: `${symbol} sector ETF`, symbol, cutoffAt: null }, fetchImpl ? { fetchImpl: fetchImpl as typeof fetch } : {});
  const stored = await loadStoredPriceHistory(sql, assetId, symbol, new Date());
  return { etf: stored.bars.length ? { symbol, bars: quantBars(stored.bars, stored.splits) } : null, synced: sync.status === "synced" };
}

/** SEC submissions for a resolved CIK. The issuer is known to file, so any failure means SEC is unreachable (503). */
export async function fetchSubmissions(cik: string, fetchImpl: FetchLike): Promise<any> {
  try { return await secJson(fetchImpl, `https://data.sec.gov/submissions/CIK${cik}.json`); }
  catch { throw new QuantInputError("upstream_unavailable", "SEC filings could not be fetched for this issuer. Try again shortly."); }
}

/**
 * What a price sync means for the snapshot. A failed sync with nothing stored is an upstream failure (503); a failed
 * sync over stored bars uses them but marks the snapshot transient, so a stale day isn't cached. A sync that worked
 * but stored nothing means the provider has no prices for the ticker (404).
 */
export function priceSyncOutcome(ticker: string, synced: boolean, storedBars: number): { notes: string[]; transient: string[] } {
  if (!synced && !storedBars) throw new QuantInputError("upstream_unavailable", `Prices for ${ticker} could not be fetched. Try again shortly.`);
  if (!storedBars) throw new QuantInputError("no_prices", `No daily prices are stored for ${ticker}.`);
  if (!synced) return { notes: ["The price provider could not be reached, so the stored prices were used; Refresh later for today's close."], transient: ["prices"] };
  return { notes: [], transient: [] };
}

export async function loadQuantInputs(sql: Sql, rawTicker: string, options: { fetchImpl?: FetchLike; now?: Date } = {}): Promise<QuantInputs> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!TICKER_PATTERN.test(ticker)) throw new QuantInputError("invalid_ticker", `"${rawTicker}" is not a ticker symbol.`);
  const fetchImpl = options.fetchImpl ?? fetchCapped;
  const now = options.now ?? new Date();
  const notes: string[] = [];

  const issuer = await resolveIssuer(ticker, { fetchImpl, yahooFetch: options.fetchImpl ?? timedFetch });
  const { instrumentType, cik } = issuer;
  notes.push(...issuer.notes);
  const transient = [...issuer.transient];

  let name = ticker, sic: string | null = null, sicDescription: string | null = null;
  let fundamentals: AnnualFundamentals | null = null, fundamentalsReason: string | null = null, origin: CompanyFactsOrigin | null = null;
  if (cik) {
    // The CIK resolved, so this is a filer: a submissions failure means SEC is unreachable, not "no filer".
    const submissions = await fetchSubmissions(cik, fetchImpl);
    name = String(submissions.name || ticker);
    sic = submissions.sic ? String(submissions.sic) : null;
    sicDescription = submissions.sicDescription ? String(submissions.sicDescription) : null;
    try {
      const loaded = await loadCompanyFacts({ cik, submissions, cutoffDate: now.toISOString().slice(0, 10), userAgent: SEC_USER_AGENT, fetchImpl });
      origin = loaded.origin;
      fundamentals = annualFundamentals(loaded.companyFacts, { years: 5 });
      if (!fundamentals.years.length) { fundamentalsReason = "Companyfacts has no annual revenue or operating income."; fundamentals = null; }
    } catch {
      fundamentalsReason = "SEC companyfacts could not be fetched; try Refresh later.";
      transient.push("companyfacts");
    }
  } else {
    fundamentalsReason = "Not an SEC filer.";
  }

  const asset = await quantAsset(sql, ticker, name);
  const sync = await syncAssetPriceHistory(sql, { assetId: asset.id, assetName: asset.name, symbol: ticker, cutoffAt: null },
    options.fetchImpl ? { fetchImpl: options.fetchImpl as typeof fetch, now } : { now });
  const stored = await loadStoredPriceHistory(sql, asset.id, ticker, now);
  const priced = priceSyncOutcome(ticker, sync.status === "synced", stored.bars.length);
  notes.push(...priced.notes);
  transient.push(...priced.transient);

  const benchSync = await syncBenchmarkPriceHistory(sql, null, options.fetchImpl ? { fetchImpl: options.fetchImpl as typeof fetch } : {});
  if (benchSync.status !== "synced") { notes.push("S&P 500 prices could not be refreshed; relative strength uses the stored series."); transient.push("benchmark"); }
  const benchmark = await loadBenchmarkPriceHistory(sql, now);
  const sector = sectorFromSic(sic);
  let sectorEtf: QuantInputs["sector_etf"] = null;
  if (sector.etf) {
    let synced = false;
    try { const r = await syncEtf(sql, sector.etf, options.fetchImpl); sectorEtf = r.etf; synced = r.synced; } catch { /* reported below */ }
    if (!synced) {
      notes.push(sectorEtf ? `Sector ETF ${sector.etf} prices could not be refreshed; RS uses the stored series.` : `Sector ETF ${sector.etf} prices could not be synced; RS uses the S&P 500 only.`);
      transient.push("sector_etf");
    }
  }

  return {
    ticker, name, cik, sic, sic_description: sicDescription, sector, instrument_type: instrumentType,
    fundamentals, fundamentals_reason: fundamentalsReason, company_facts_origin: origin,
    bars: quantBars(stored.bars, stored.splits),
    benchmark: { symbol: BETA_BENCHMARK.symbol, bars: quantBars(benchmark.bars, benchmark.splits) },
    sector_etf: sectorEtf,
    asset: { id: asset.id, researched: asset.researched },
    as_of: stored.bars[stored.bars.length - 1].day,
    notes: [...notes, `Prices: ${PRIMARY_PRICE_PROVIDER} daily closes; volume where the provider gave it.`],
    transient,
  };
}

/** Is this resolveSecCik error a definite "no such filer", as opposed to the ticker map being unreachable? */
const isCikNotFound = (error: unknown) => error instanceof Error && /CIK not found/i.test(error.message);

/**
 * Listing type (Yahoo) and SEC CIK for a ticker. A definite "not an SEC filer" is a partial result; an SEC ticker map
 * that cannot be fetched is `upstream_unavailable` (503, never cached). A Yahoo metadata failure is recorded in
 * `transient`, so the snapshot built from it is not cached either.
 */
export async function resolveIssuer(ticker: string, deps: { fetchImpl: FetchLike; yahooFetch: FetchLike }):
  Promise<{ instrumentType: string | null; cik: string | null; notes: string[]; transient: string[] }> {
  const notes: string[] = [], transient: string[] = [];
  // Listing type first: PragValue values individual equities only (Pragma rejected ETFs, indices and funds).
  let instrumentType: string | null = null;
  try {
    const meta = await createYahooMarketDataProvider(deps.yahooFetch as typeof fetch).getInstrumentMetadata(ticker);
    instrumentType = meta.instrument_type ? String(meta.instrument_type).toUpperCase() : null;
  } catch {
    notes.push("The listing type could not be checked (Yahoo unavailable), so the equity check was skipped.");
    transient.push("listing_type");
  }
  if (instrumentType && instrumentType !== "EQUITY") {
    throw new QuantInputError("not_equity", `${ticker} is a ${instrumentType.toLowerCase()}, not an individual stock. PragValue values individual equities.`);
  }
  let cik: string | null = null;
  try {
    cik = await resolveSecCik(ticker, deps.fetchImpl);
  } catch (error) {
    if (!isCikNotFound(error)) throw new QuantInputError("upstream_unavailable", "SEC could not be reached to identify the issuer. Try again shortly.");
    if (!instrumentType) throw new QuantInputError("unknown_ticker", `No listing or SEC filer found for ${ticker}.`);
    notes.push(`${ticker} is not an SEC filer, so PragValue has no statements to value.`);
  }
  return { instrumentType, cik, notes, transient };
}
