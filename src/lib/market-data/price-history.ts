/**
 * Daily price history per asset: backfill and incremental sync into `market_price_bars`,
 * a Stooq cross-check, period-end closes and market caps, and the valuation-date price.
 *
 * Stored closes are the primary provider's (Yahoo) split-adjusted closes as of `retrieved_at`.
 * Splits stored in `corporate_actions` re-express any close on another split basis, so a
 * later split never invalidates stored rows.
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PriceBar } from "./provider";
import { createMarketDataService } from "./service";
import { createYahooMarketDataProvider } from "./providers/yahoo";
import { fetchStooqCloses } from "./providers/stooq";
import { HistoricalObservation } from "@/lib/research/history/contracts";

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, any>;

export const PRICE_HISTORY_YEARS = 6;
export const CROSS_CHECK_TOLERANCE_PCT = 0.5;
export const PRIMARY_PRICE_PROVIDER = "yahoo";
/** The index beta is measured against. Its bars are stored under a shared reference asset (status `reference`). */
export const BETA_BENCHMARK = { symbol: "^GSPC", name: "S&P 500 index", provider: PRIMARY_PRICE_PROVIDER, asset_slug: "benchmark-gspc" } as const;
const MAX_CLOSE_GAP_DAYS = 7;
const DAY = 86_400_000;
const USER_AGENT = "ResearchOS/0.1 market-data@example.com";

export type SplitEvent = { ex_day: string; ratio: number };
export type StoredBar = {
  id: string;
  day: string;
  close: number;
  adjusted_close: number | null;
  currency: string;
  provider_symbol: string;
  retrieved_day: string;
  available_at: string;
  verification_status: string;
  verification_json: Row;
};
export type CrossCheck = {
  status: "verified" | "mismatch";
  provider: "stooq";
  reference_close: number;
  compared_close: number;
  diff_pct: number;
  basis: "close" | "adjusted_close";
  tolerance_pct: number;
};

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const round = (value: number, digits: number) => Number(value.toFixed(digits));

/** Exchange-local calendar day of a timestamp (YYYY-MM-DD); UTC when the zone is unknown. */
export function exchangeDay(date: Date, timeZone?: string | null): string {
  if (!timeZone) return isoDay(date);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return isoDay(date);
  }
}

/**
 * Store each bar under its exchange-local trading day (UTC midnight). A close counts as public
 * from the next UTC midnight, which is after every regular session closes; bars that are not
 * final at `now` (today's live bar) are dropped so a provisional close is never stored.
 */
export function normalizeDailyBars(bars: PriceBar[], now: Date): PriceBar[] {
  const byDay = new Map<string, PriceBar>();
  for (const bar of bars) {
    const day = exchangeDay(bar.trading_date, bar.exchange_timezone);
    const tradingDate = new Date(`${day}T00:00:00Z`);
    const availableAt = new Date(tradingDate.getTime() + DAY);
    if (availableAt.getTime() <= now.getTime()) byDay.set(day, { ...bar, trading_date: tradingDate, available_at: availableAt });
  }
  return [...byDay.values()].sort((a, b) => a.trading_date.getTime() - b.trading_date.getTime());
}

/** Re-express a close stored on the split basis of `fromDay` on the split basis of `toDay`. */
export function closeOnSplitBasis(close: number, tradingDay: string, fromDay: string, toDay: string, splits: SplitEvent[]): number {
  const factor = (basis: string) => splits
    .filter((split) => split.ex_day > tradingDay && split.ex_day <= basis && split.ratio > 0)
    .reduce((product, split) => product * split.ratio, 1);
  return (close * factor(fromDay)) / factor(toDay);
}

/** Compare a primary close with the reference close; null leaves the bar unverified. */
export function crossCheckClose(close: number, adjustedClose: number | null, reference: number | undefined,
  tolerancePct = CROSS_CHECK_TOLERANCE_PCT): CrossCheck | null {
  if (reference === undefined || !(reference > 0) || !(close > 0)) return null;
  const diff = (value: number) => (Math.abs(value - reference) / reference) * 100;
  const base = { provider: "stooq" as const, reference_close: reference, tolerance_pct: tolerancePct };
  if (diff(close) <= tolerancePct) return { ...base, status: "verified", basis: "close", compared_close: close, diff_pct: round(diff(close), 4) };
  // A source may also adjust history for dividends; agreement on that basis still corroborates the series.
  if (adjustedClose !== null && adjustedClose > 0 && diff(adjustedClose) <= tolerancePct) {
    return { ...base, status: "verified", basis: "adjusted_close", compared_close: adjustedClose, diff_pct: round(diff(adjustedClose), 4) };
  }
  return { ...base, status: "mismatch", basis: "close", compared_close: close, diff_pct: round(diff(close), 4) };
}

/** Last bar on or before the period end, if it is no more than a week before it. Bars must be sorted by day. */
export function closeOnOrBefore<T extends { day: string }>(bars: T[], periodEnd: string, maxGapDays = MAX_CLOSE_GAP_DAYS): T | null {
  let found: T | null = null;
  for (const bar of bars) {
    if (bar.day > periodEnd) break;
    found = bar;
  }
  if (!found) return null;
  return (Date.parse(periodEnd) - Date.parse(found.day)) / DAY <= maxGapDays ? found : null;
}

export type ShareCount = {
  value: number;
  basis: "shares_outstanding" | "diluted_weighted_average";
  label: string;
  period_end: string;
  available_at: string | null;
  inputs: Row[];
};

/**
 * Shares outstanding at a period end: the non-dimensional `CommonStockSharesOutstanding` fact, or
 * the sum of its share-class facts. Falls back to the latest diluted weighted-average count.
 */
export function sharesAtPeriodEnd(observations: Row[], periodEnd: string): ShareCount | null {
  const positive = (o: Row) => o.unit === "shares" && Number.isFinite(o.value_numeric) && o.value_numeric > 0;
  const bySegment = new Map<string, Row>();
  for (const o of observations) {
    if (o.metric_key !== "us_gaap_CommonStockSharesOutstanding" || o.period_end !== periodEnd || o.geography || !positive(o)) continue;
    const key = o.segment ?? "";
    const prior = bySegment.get(key);
    if (!prior || String(o.available_at ?? "") > String(prior.available_at ?? "")) bySegment.set(key, o);
  }
  const inputs = bySegment.has("") ? [bySegment.get("")!] : [...bySegment.values()];
  const latest = (rows: Row[]) => rows.map((r) => String(r.available_at ?? "")).sort().at(-1) || null;
  if (inputs.length) {
    return {
      value: inputs.reduce((sum, o) => sum + Number(o.value_numeric), 0),
      basis: "shares_outstanding",
      label: inputs.length > 1 ? `Common shares outstanding, sum of ${inputs.length} share classes` : "Common shares outstanding",
      period_end: periodEnd,
      available_at: latest(inputs),
      inputs,
    };
  }
  const diluted = observations
    .filter((o) => o.metric_key === "us_gaap_WeightedAverageNumberOfDilutedSharesOutstanding" && !o.segment && !o.geography
      && positive(o) && o.period_end && o.period_end <= periodEnd && (Date.parse(periodEnd) - Date.parse(o.period_end)) / DAY <= 400)
    .sort((a, b) => String(b.period_end).localeCompare(String(a.period_end))
      || Number(b.periodicity === "quarterly") - Number(a.periodicity === "quarterly")
      || String(b.available_at ?? "").localeCompare(String(a.available_at ?? "")))[0];
  if (!diluted) return null;
  return {
    value: Number(diluted.value_numeric),
    basis: "diluted_weighted_average",
    label: `Diluted weighted-average shares (${diluted.periodicity} period ended ${diluted.period_end}; fallback, period-end shares outstanding not reported)`,
    period_end: String(diluted.period_end),
    available_at: diluted.available_at ?? null,
    inputs: [diluted],
  };
}

export type PeriodEndInput = {
  bars: StoredBar[];
  splits: SplitEvent[];
  statementObservations: Row[];
  cutoffAt: Date;
  symbol: string;
};

/**
 * Quarter-end and fiscal-year-end close and market cap for every reported period up to the cutoff.
 * Periods and fiscal labels come from the filed statements.
 */
export function periodEndMarketObservations(input: PeriodEndInput): HistoricalObservation[] {
  const cutoffDay = isoDay(input.cutoffAt);
  const bars = input.bars.filter((bar) => Date.parse(bar.available_at) <= input.cutoffAt.getTime()).sort((a, b) => a.day.localeCompare(b.day));
  const periods = new Map<string, { periodicity: "quarterly" | "annual"; fiscal_year: number; fiscal_quarter: number | null; period_end: string }>();
  for (const o of input.statementObservations) {
    if ((o.periodicity !== "quarterly" && o.periodicity !== "annual") || o.segment || o.geography || !o.period_end
      || !Number.isInteger(o.fiscal_year) || o.period_end > cutoffDay) continue;
    if (o.periodicity === "quarterly" && !Number.isInteger(o.fiscal_quarter)) continue;
    const quarter = o.periodicity === "annual" ? null : Number(o.fiscal_quarter);
    const key = `${o.periodicity}|${o.fiscal_year}|${quarter ?? 0}`;
    const prior = periods.get(key);
    if (!prior || o.period_end > prior.period_end) periods.set(key, { periodicity: o.periodicity, fiscal_year: o.fiscal_year, fiscal_quarter: quarter, period_end: o.period_end });
  }
  const sourceUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(input.symbol)}/history/`;
  const rows: HistoricalObservation[] = [];
  for (const period of [...periods.values()].sort((a, b) => a.period_end.localeCompare(b.period_end) || a.periodicity.localeCompare(b.periodicity))) {
    const bar = closeOnOrBefore(bars, period.period_end);
    const common = { ...period, segment: null, geography: null, reporting_basis: "as_reported" as const, comparability_status: "comparable" as const, restatement_version: 0 };
    if (!bar) {
      rows.push(HistoricalObservation.parse({ ...common, metric_key: "period_end_share_price", value_numeric: null, unit: null, currency: null, metric_type: "reported",
        confidence: 0, metadata_json: { metric_category: "market_data", statement_label: "Share price (period-end close)",
          missing_reason: `No stored close within ${MAX_CLOSE_GAP_DAYS} days on or before ${period.period_end}.` } }));
      continue;
    }
    const verified = bar.verification_status === "verified";
    const price = closeOnSplitBasis(bar.close, bar.day, bar.retrieved_day, bar.day, input.splits);
    const locator = { provider: PRIMARY_PRICE_PROVIDER, provider_symbol: bar.provider_symbol, market_price_bar_id: bar.id, trading_date: bar.day,
      field: "close", retrieved_at_day: bar.retrieved_day, split_basis: "as traded on trading_date" };
    const verification = { verified, verification_status: bar.verification_status, cross_check: bar.verification_json };
    const priceRow = HistoricalObservation.parse({ ...common, metric_key: "period_end_share_price", value_numeric: round(price, 4), unit: `${bar.currency}/shares`,
      currency: bar.currency, metric_type: "reported", available_at: bar.available_at.slice(0, 10), confidence: verified ? 0.98 : 0.9,
      formula_or_adjustment: `Close on ${bar.day}, the last trading day on or before ${period.period_end}.`,
      metadata_json: { metric_category: "market_data", statement_label: "Share price (period-end close)", source_url: sourceUrl, source_locator: locator, ...verification } });
    rows.push(priceRow);
    const shares = sharesAtPeriodEnd(input.statementObservations, period.period_end);
    if (!shares) {
      rows.push(HistoricalObservation.parse({ ...common, metric_key: "market_cap", value_numeric: null, unit: bar.currency, currency: bar.currency, metric_type: "calculated",
        confidence: 0, metadata_json: { metric_category: "market_data", statement_label: "Market capitalization",
          missing_reason: `No shares outstanding or diluted share count reported for ${period.period_end}.` } }));
      continue;
    }
    // Filings can restate share counts for a split made before filing; price on the same split basis.
    const shareBasisDay = shares.available_at ? String(shares.available_at).slice(0, 10) : bar.day;
    const priceOnShareBasis = closeOnSplitBasis(bar.close, bar.day, bar.retrieved_day, shareBasisDay, input.splits);
    const availableAt = [bar.available_at.slice(0, 10), shares.available_at ? String(shares.available_at).slice(0, 10) : ""].sort().at(-1)!;
    rows.push(HistoricalObservation.parse({ ...common, metric_key: "market_cap", value_numeric: Math.round(priceOnShareBasis * shares.value), unit: bar.currency,
      currency: bar.currency, metric_type: "calculated", available_at: availableAt, confidence: (verified ? 0.95 : 0.88) - (shares.basis === "shares_outstanding" ? 0 : 0.1),
      formula_or_adjustment: `Market cap = ${round(priceOnShareBasis, 4)} close on ${bar.day} × ${shares.value} (${shares.label}).`,
      metadata_json: { metric_category: "market_data", statement_label: "Market capitalization", source_url: sourceUrl, source_locator: locator, ...verification,
        share_basis: shares.basis, share_basis_label: shares.label, shares: shares.value, shares_period_end: shares.period_end,
        inputs: [{ ...priceRow, value_numeric: round(priceOnShareBasis, 4) }, ...shares.inputs] } }));
  }
  return rows;
}

/** Fetch with a timeout and a stable user agent; the shared provider adapters have none (#23). */
export const timedFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, headers: { "User-Agent": USER_AGENT, ...(init?.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(20_000) });

/** The asset's instrument, created once: runs syncing the shared benchmark at the same time wait on the asset's lock. */
export async function ensureInstrument(sql: Sql, assetId: string, assetName: string, symbol: string): Promise<string> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`instrument:${assetId}`}))`;
    const [existing] = await tx`
      SELECT i.id FROM instruments i WHERE i.asset_id = ${assetId}
      ORDER BY EXISTS (SELECT 1 FROM listings l WHERE l.instrument_id = i.id AND upper(l.symbol) = ${symbol}) DESC, i.created_at
      LIMIT 1`;
    if (existing) return String(existing.id);
    const [created] = await tx`
      INSERT INTO instruments (asset_id, instrument_type, name) VALUES (${assetId}, 'listed_security', ${`${assetName} (${symbol})`})
      RETURNING id`;
    return String(created.id);
  }) as Promise<string>;
}

export type PriceHistorySync = {
  status: "synced" | "failed";
  provider: string;
  provider_symbol: string;
  instrument_id?: string;
  window?: { start: string; end: string };
  fetched_from?: string | null;
  stored_bars?: number;
  bars_in_window?: number;
  first_trading_day?: string | null;
  last_trading_day?: string | null;
  corporate_actions_error?: string;
  cross_check?: { provider: "stooq"; status: "checked" | "unavailable" | "not_needed"; reason?: string; url?: string | null;
    verified: number; mismatch: number; unverified: number };
  error?: string;
};

/**
 * Backfill ~6 years of daily bars up to the run's market-data cutoff (or now), add splits and
 * dividends, then cross-check unverified closes against Stooq. Never throws: a failure is
 * returned in the summary and the run continues.
 */
export async function syncAssetPriceHistory(sql: Sql,
  asset: { assetId: string; assetName: string; symbol: string; cutoffAt: Date | null },
  options: { fetchImpl?: typeof fetch; now?: Date; years?: number } = {}): Promise<PriceHistorySync> {
  // The Drizzle driver rewrites its client's date parsers and serializers, so the service gets its
  // own connection and the caller's client is left as it was. Raw queries here pass ISO strings.
  let serviceClient: Sql | null = null;
  const symbol = asset.symbol.toUpperCase();
  const summary: PriceHistorySync = { status: "failed", provider: PRIMARY_PRICE_PROVIDER, provider_symbol: symbol };
  try {
    const now = options.now ?? new Date();
    const fetchImpl = options.fetchImpl ?? timedFetch;
    const end = asset.cutoffAt && asset.cutoffAt.getTime() < now.getTime() ? asset.cutoffAt : now;
    const start = new Date(end);
    start.setUTCFullYear(start.getUTCFullYear() - (options.years ?? PRICE_HISTORY_YEARS));
    summary.window = { start: start.toISOString(), end: end.toISOString() };
    const instrumentId = await ensureInstrument(sql, asset.assetId, asset.assetName, symbol);
    summary.instrument_id = instrumentId;
    serviceClient = postgres(process.env.DATABASE_URL!, { max: 1 });
    const service = createMarketDataService({ db: drizzle(serviceClient) as any, defaultProvider: createYahooMarketDataProvider(fetchImpl), providerName: PRIMARY_PRICE_PROVIDER });
    const history = await service.syncDailyHistory(instrumentId, symbol, start, end, (bars) => normalizeDailyBars(bars, now));
    summary.fetched_from = history.fetchedFrom?.toISOString() ?? null;
    summary.stored_bars = history.storedBars;
    // Splits after the cutoff are still needed to undo the provider's split adjustment.
    await service.syncCorporateActions(instrumentId, symbol, start, now).catch((error) => {
      summary.corporate_actions_error = error instanceof Error ? error.message : String(error);
    });
    summary.cross_check = await crossCheckWithStooq(sql, instrumentId, symbol, start, end, now, fetchImpl);
    const [range] = await sql`
      SELECT count(*)::int AS bars, min(trading_date) AS first, max(trading_date) AS last FROM market_price_bars
      WHERE instrument_id = ${instrumentId} AND provider = ${PRIMARY_PRICE_PROVIDER} AND provider_symbol = ${symbol}
        AND trading_date >= ${start.toISOString()} AND available_at <= ${end.toISOString()}`;
    summary.bars_in_window = Number(range.bars);
    summary.first_trading_day = range.first ? isoDay(new Date(range.first)) : null;
    summary.last_trading_day = range.last ? isoDay(new Date(range.last)) : null;
    summary.status = "synced";
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
  } finally {
    await serviceClient?.end();
  }
  return summary;
}

async function loadSplits(sql: Sql, instrumentId: string): Promise<SplitEvent[]> {
  const rows = await sql`
    SELECT DISTINCT ex_date, split_ratio FROM corporate_actions
    WHERE instrument_id = ${instrumentId} AND provider = ${PRIMARY_PRICE_PROVIDER} AND action_type = 'split' AND ex_date IS NOT NULL`;
  return rows.map((row) => ({ ex_day: isoDay(new Date(row.ex_date)), ratio: Number(row.split_ratio) })).filter((split) => split.ratio > 0);
}

async function crossCheckWithStooq(sql: Sql, instrumentId: string, symbol: string, start: Date, end: Date, now: Date,
  fetchImpl: typeof fetch): Promise<NonNullable<PriceHistorySync["cross_check"]>> {
  const pending = await sql`
    SELECT id, trading_date, close, adjusted_close, retrieved_at FROM market_price_bars
    WHERE instrument_id = ${instrumentId} AND provider = ${PRIMARY_PRICE_PROVIDER} AND provider_symbol = ${symbol}
      AND verification_status = 'unverified' AND trading_date >= ${start.toISOString()} AND trading_date <= ${end.toISOString()}
    ORDER BY trading_date`;
  const counts = async () => {
    const rows = await sql`
      SELECT verification_status, count(*)::int AS n FROM market_price_bars
      WHERE instrument_id = ${instrumentId} AND provider = ${PRIMARY_PRICE_PROVIDER} AND provider_symbol = ${symbol}
        AND trading_date >= ${start.toISOString()} AND trading_date <= ${end.toISOString()}
      GROUP BY verification_status`;
    const count = (status: string) => Number(rows.find((row) => row.verification_status === status)?.n ?? 0);
    return { verified: count("verified"), mismatch: count("mismatch"), unverified: count("unverified") };
  };
  if (!pending.length) return { provider: "stooq", status: "not_needed", ...(await counts()) };
  // Stooq blocks for long stretches (HTTP 403 or a browser check); after a failure it is not asked again for a day.
  const [recent] = await sql`
    SELECT status, error_message FROM market_data_fetches
    WHERE instrument_id = ${instrumentId} AND provider = 'stooq' AND request_type = 'cross_check'
      AND created_at > ${new Date(now.getTime() - DAY).toISOString()}
    ORDER BY created_at DESC LIMIT 1`;
  if (recent?.status === "failed") {
    return { provider: "stooq", status: "unavailable", reason: `Not retried within a day of the last failure: ${recent.error_message}`, ...(await counts()) };
  }
  const first = new Date(pending[0].trading_date);
  const last = new Date(pending[pending.length - 1].trading_date);
  const started = Date.now();
  const stooq = await fetchStooqCloses(symbol, first, last, fetchImpl);
  await sql`
    INSERT INTO market_data_fetches (instrument_id, provider, provider_symbol, request_type, request_params_json, status, error_message, latency_ms, created_at)
    VALUES (${instrumentId}, 'stooq', ${symbol}, 'cross_check',
      ${sql.json({ start: isoDay(first), end: isoDay(last), url: stooq.url, tolerance_pct: CROSS_CHECK_TOLERANCE_PCT })},
      ${stooq.status === "ok" ? "success" : "failed"}, ${stooq.status === "ok" ? null : stooq.reason}, ${Date.now() - started}, ${now.toISOString()})`;
  if (stooq.status !== "ok") return { provider: "stooq", status: "unavailable", reason: stooq.reason, url: stooq.url, ...(await counts()) };
  const splits = await loadSplits(sql, instrumentId);
  const today = isoDay(now);
  const checked = pending.flatMap((row) => {
    const day = isoDay(new Date(row.trading_date));
    const retrievedDay = isoDay(new Date(row.retrieved_at));
    // Stooq history is adjusted to today's split basis.
    const rebase = (value: number) => closeOnSplitBasis(value, day, retrievedDay, today, splits);
    const check = crossCheckClose(rebase(Number(row.close)), row.adjusted_close === null ? null : rebase(Number(row.adjusted_close)), stooq.closes.get(day));
    return check ? [{ id: String(row.id), status: check.status, details: { ...check, url: stooq.url, checked_at: now.toISOString() } }] : [];
  });
  if (checked.length) await sql`
    UPDATE market_price_bars m SET verification_status = v.status, verification_json = v.details, verified_at = ${now.toISOString()}
    FROM jsonb_to_recordset(${sql.json(checked)}::jsonb) AS v(id uuid, status text, details jsonb)
    WHERE m.id = v.id`;
  return { provider: "stooq", status: "checked", url: stooq.url, ...(await counts()) };
}

/** Bars available by the cutoff, plus every stored split (needed to rebase closes). */
export async function loadStoredPriceHistory(sql: Sql, assetId: string, symbol: string, cutoffAt: Date) {
  const rows = await sql`
    SELECT b.id, b.instrument_id, b.trading_date, b.close, b.adjusted_close, b.currency, b.provider_symbol, b.retrieved_at,
      b.available_at, b.verification_status, b.verification_json
    FROM market_price_bars b JOIN instruments i ON i.id = b.instrument_id
    WHERE i.asset_id = ${assetId} AND b.provider = ${PRIMARY_PRICE_PROVIDER} AND b.provider_symbol = ${symbol.toUpperCase()}
      AND b.available_at <= ${cutoffAt.toISOString()}
    ORDER BY b.trading_date`;
  const bars: StoredBar[] = rows.map((row) => ({
    id: String(row.id), day: isoDay(new Date(row.trading_date)), close: Number(row.close),
    adjusted_close: row.adjusted_close === null ? null : Number(row.adjusted_close), currency: String(row.currency),
    provider_symbol: String(row.provider_symbol), retrieved_day: isoDay(new Date(row.retrieved_at)),
    available_at: new Date(row.available_at).toISOString(), verification_status: String(row.verification_status),
    verification_json: (row.verification_json || {}) as Row,
  }));
  const instrumentIds = [...new Set(rows.map((row) => String(row.instrument_id)))];
  const loaded = (await Promise.all(instrumentIds.map((id) => loadSplits(sql, id)))).flat();
  const splits = [...new Map(loaded.map((split) => [`${split.ex_day}:${split.ratio}`, split])).values()];
  return { bars, splits };
}

/** The shared benchmark asset, created on first use. */
async function ensureBenchmarkAsset(sql: Sql): Promise<string> {
  await sql`
    INSERT INTO assets (canonical_name, slug, asset_kind, base_currency, status, description)
    VALUES (${BETA_BENCHMARK.name}, ${BETA_BENCHMARK.asset_slug}, 'index', 'USD', 'reference',
      ${`Benchmark for regression betas (${BETA_BENCHMARK.symbol}); not a research subject.`})
    ON CONFLICT (slug) DO NOTHING`;
  const [row] = await sql`SELECT id FROM assets WHERE slug = ${BETA_BENCHMARK.asset_slug}`;
  return String(row.id);
}

/** Sync the benchmark's daily bars to the run's market-data cutoff, like the asset's own. Never throws. */
export async function syncBenchmarkPriceHistory(sql: Sql, cutoffAt: Date | null,
  options: { fetchImpl?: typeof fetch; now?: Date; years?: number } = {}): Promise<PriceHistorySync> {
  try {
    const assetId = await ensureBenchmarkAsset(sql);
    return await syncAssetPriceHistory(sql, { assetId, assetName: BETA_BENCHMARK.name, symbol: BETA_BENCHMARK.symbol, cutoffAt }, options);
  } catch (error) {
    return { status: "failed", provider: PRIMARY_PRICE_PROVIDER, provider_symbol: BETA_BENCHMARK.symbol, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Benchmark bars available by the cutoff; empty when the benchmark was never synced. */
export async function loadBenchmarkPriceHistory(sql: Sql, cutoffAt: Date) {
  const [row] = await sql`SELECT id FROM assets WHERE slug = ${BETA_BENCHMARK.asset_slug}`;
  return row ? loadStoredPriceHistory(sql, String(row.id), BETA_BENCHMARK.symbol, cutoffAt) : { bars: [] as StoredBar[], splits: [] as SplitEvent[] };
}

export type ValuationPrice = {
  price: number;
  currency: string;
  trading_date: string;
  provider: string;
  provider_symbol: string;
  verified: boolean;
  verification_status: string;
  cross_check: Row;
  source_url: string;
  market_price_bar_id: string;
};

/** The last stored close available by the cutoff, as traded that day; null if older than a week. */
export function valuationPriceFromBars(bars: StoredBar[], splits: SplitEvent[], cutoffAt: Date): ValuationPrice | null {
  const eligible = bars.filter((bar) => Date.parse(bar.available_at) <= cutoffAt.getTime()).sort((a, b) => a.day.localeCompare(b.day));
  const bar = closeOnOrBefore(eligible, isoDay(cutoffAt));
  if (!bar) return null;
  return {
    price: round(closeOnSplitBasis(bar.close, bar.day, bar.retrieved_day, bar.day, splits), 4),
    currency: bar.currency, trading_date: bar.day, provider: PRIMARY_PRICE_PROVIDER, provider_symbol: bar.provider_symbol,
    verified: bar.verification_status === "verified", verification_status: bar.verification_status, cross_check: bar.verification_json,
    source_url: `https://finance.yahoo.com/quote/${encodeURIComponent(bar.provider_symbol)}/history/`, market_price_bar_id: bar.id,
  };
}

export async function valuationDatePrice(sql: Sql, assetId: string, symbol: string, cutoffAt: Date): Promise<ValuationPrice | null> {
  const { bars, splits } = await loadStoredPriceHistory(sql, assetId, symbol, cutoffAt);
  return valuationPriceFromBars(bars, splits, cutoffAt);
}
