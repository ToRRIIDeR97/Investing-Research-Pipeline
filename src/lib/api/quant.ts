/**
 * The Quant page's snapshot (Implementations/quant-page P4): PragValue and PragTrend for one ticker, cached per
 * ticker and day in `quant_snapshots`. Built by code from SEC facts and stored prices; no model calls, and nothing
 * here writes research artifacts.
 */
import postgres from "postgres";
import { ApiError } from "@/lib/api/errors";
import { loadQuantInputs, QuantInputError, TICKER_PATTERN, type QuantInputs } from "@/lib/quant/inputs";
import { computePragValue, type PragValue } from "@/lib/quant/value";
import { valuationEngine, valuationIndustry } from "@/lib/quant/sic";
import { toPragmaData } from "@/lib/quant/value/adapter";
import { computePragTrend, type PragTrend } from "@/lib/quant/trend";
import { weeklyCloses } from "@/lib/quant/trend/stage";

type Sql = ReturnType<typeof postgres>;

export type QuantSnapshot = {
  ticker: string;
  name: string;
  cik: string | null;
  sic: string | null;
  sic_description: string | null;
  sector: string;
  industry: string;
  sector_etf: string | null;
  as_of: string;
  price: number;
  /** The listing's trading currency (prices and per-share values are in it). Older snapshots lack it: USD. */
  currency?: string;
  /** The market index trend and RS are measured against (the S&P 500 for US listings). */
  benchmark?: { symbol: string; name: string };
  /** Weekly closes (last close of each week) over the last five years, for the Value tab's price-and-value chart. */
  price_history_5y: { day: string; close: number }[];
  value: PragValue | null;
  value_reason: string | null;
  trend: PragTrend;
  fundamentals: { years: string[]; currency: string; origin: string | null; missing: string[] } | null;
  research: { asset_id: string; run_id: string | null; status: string | null } | null;
  notes: string[];
  computed_at: string;
};

export type SnapshotStore = {
  get(ticker: string, day: string): Promise<QuantSnapshot | null>;
  put(snapshot: QuantSnapshot, day: string, status: "ok" | "partial"): Promise<void>;
};

export function sqlSnapshotStore(sql: Sql): SnapshotStore {
  return {
    async get(ticker, day) {
      const [row] = await sql`SELECT snapshot_json FROM quant_snapshots WHERE ticker = ${ticker} AND as_of_day = ${day}`;
      return row ? (row.snapshot_json as QuantSnapshot) : null;
    },
    async put(snapshot, day, status) {
      await sql`
        INSERT INTO quant_snapshots (ticker, as_of_day, status, snapshot_json, computed_at)
        VALUES (${snapshot.ticker}, ${day}, ${status}, ${sql.json(snapshot as never)}, NOW())
        ON CONFLICT (ticker, as_of_day) DO UPDATE SET status = EXCLUDED.status, snapshot_json = EXCLUDED.snapshot_json, computed_at = NOW()`;
      // Only the newest day is ever read (the finder and a same-day cache hit), so older days of this ticker go.
      await pruneQuantSnapshots(sql, snapshot.ticker);
    },
  };
}

/** Deletes every snapshot older than its ticker's newest day (one ticker, or all). Returns the rows removed. */
export async function pruneQuantSnapshots(sql: Sql, ticker?: string): Promise<number> {
  const rows = ticker
    ? await sql`DELETE FROM quant_snapshots s WHERE s.ticker = ${ticker}
        AND s.as_of_day < (SELECT max(as_of_day) FROM quant_snapshots WHERE ticker = ${ticker}) RETURNING 1`
    : await sql`DELETE FROM quant_snapshots s WHERE s.as_of_day < (SELECT max(n.as_of_day) FROM quant_snapshots n WHERE n.ticker = s.ticker) RETURNING 1`;
  return rows.length;
}

/** The snapshot from loaded inputs. Pure: no I/O. */
export function buildQuantSnapshot(inputs: QuantInputs, research: QuantSnapshot["research"], now: Date): QuantSnapshot {
  const notes = [...inputs.notes];
  let value: PragValue | null = null;
  let valueReason: string | null = inputs.fundamentals_reason;
  if (inputs.fundamentals) {
    try {
      const data = toPragmaData(inputs.fundamentals, inputs.bars);
      const num = (v: unknown) => (typeof v === "number" ? v : null);
      const industry = valuationIndustry(inputs.sic, inputs.sector.industry, num(data.info.totalRevenue), num(data.info.ebit));
      if (industry !== inputs.sector.industry) notes.push(`SIC ${inputs.sic} is pharma and pre-revenue or loss-making, so PragValue scores it as Biotechnology (engine B2).`);
      value = computePragValue(data, {
        sector: inputs.sector.sector, industry, companyName: inputs.name, creditZ: null, engine: valuationEngine(inputs.sic),
      });
      notes.push(...value.notes);
      notes.push("Y0 is the latest fiscal year (Pragma used trailing-twelve-month values); analyst forward EPS is not available, so growth blends the company's own history.");
      if (inputs.sector.sector === "Unknown") notes.push(`SIC ${inputs.sic ?? "missing"} has no sector mapping, so PragValue used its default engine and multiples.`);
    } catch (error) {
      valueReason = `PragValue failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const computed = computePragTrend(inputs.bars, inputs.benchmark.bars, inputs.sector_etf);
  // Weeks are keyed by their Friday; the current week is labelled with its last real trading day, not a future date.
  const trend = { ...computed, stage_history: computed.stage_history.map((w) => (w.week > inputs.as_of ? { ...w, week: inputs.as_of } : w)) };
  return {
    ticker: inputs.ticker, name: inputs.name, cik: inputs.cik, sic: inputs.sic, sic_description: inputs.sic_description,
    sector: inputs.sector.sector, industry: inputs.sector.industry, sector_etf: inputs.sector.etf,
    as_of: inputs.as_of, price: inputs.bars[inputs.bars.length - 1].close,
    currency: inputs.currency, benchmark: inputs.benchmark_index,
    // Weeks are keyed by their Friday; the current week is labelled with its last real trading day, not a future date.
    price_history_5y: weeklyCloses(inputs.bars.slice(-1260)).map((w) => ({ day: w.week > inputs.as_of ? inputs.as_of : w.week, close: w.close })),
    value, value_reason: value ? null : valueReason ?? "PragValue unavailable.", trend,
    fundamentals: inputs.fundamentals ? {
      years: inputs.fundamentals.years.map((y) => y.period_end), currency: inputs.fundamentals.currency,
      origin: inputs.fundamentals_origin ?? inputs.company_facts_origin?.provider ?? null, missing: Object.keys(inputs.fundamentals.missing),
    } : null,
    research, notes, computed_at: now.toISOString(),
  };
}

const ERROR_STATUS: Record<QuantInputError["code"], [number, string]> = {
  invalid_ticker: [400, "INVALID_TICKER"], unknown_ticker: [404, "UNKNOWN_TICKER"], not_equity: [422, "NOT_EQUITY"], no_prices: [404, "NO_PRICES"],
  upstream_unavailable: [503, "UPSTREAM_UNAVAILABLE"],
};
/** A refresh within this window of the cached snapshot returns the cached one (no new SEC or Yahoo calls). */
export const REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;

export async function getQuantSnapshot(rawTicker: string, deps: {
  store: SnapshotStore;
  load: (ticker: string) => Promise<QuantInputs>;
  research: (inputs: QuantInputs) => Promise<QuantSnapshot["research"]>;
  refresh?: boolean;
  now?: Date;
}): Promise<{ snapshot: QuantSnapshot; cached: boolean }> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!TICKER_PATTERN.test(ticker)) throw new ApiError(`"${rawTicker}" is not a ticker symbol.`, 400, "INVALID_TICKER");
  const now = deps.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const cached = await deps.store.get(ticker, day);
  if (cached && (!deps.refresh || now.getTime() - Date.parse(cached.computed_at) < REFRESH_MIN_INTERVAL_MS)) {
    return { snapshot: cached, cached: true };
  }
  let inputs: QuantInputs;
  try {
    inputs = await deps.load(ticker);
  } catch (error) {
    if (error instanceof QuantInputError) { const [status, code] = ERROR_STATUS[error.code]; throw new ApiError(error.message, status, code); }
    throw error;
  }
  const snapshot = buildQuantSnapshot(inputs, await deps.research(inputs), now);
  // A snapshot built while SEC or Yahoo was failing is served but not cached, so the next request retries.
  if (!inputs.transient?.length) await deps.store.put(snapshot, day, snapshot.value ? "ok" : "partial");
  return { snapshot, cached: false };
}

/** The asset's latest research run, when the ticker belongs to a researched asset. */
export async function researchFor(sql: Sql, inputs: QuantInputs): Promise<QuantSnapshot["research"]> {
  if (!inputs.asset.researched) return null;
  const [run] = await sql`SELECT id, status FROM research_runs WHERE asset_id = ${inputs.asset.id} ORDER BY created_at DESC LIMIT 1`;
  return { asset_id: inputs.asset.id, run_id: run ? String(run.id) : null, status: run ? String(run.status) : null };
}

/** Production wiring: the SQL store, the network loader and the research lookup. */
export async function quantSnapshotFor(sql: Sql, ticker: string, refresh = false) {
  return getQuantSnapshot(ticker, {
    store: sqlSnapshotStore(sql),
    load: (t) => loadQuantInputs(sql, t),
    research: (inputs) => researchFor(sql, inputs),
    refresh,
  });
}
