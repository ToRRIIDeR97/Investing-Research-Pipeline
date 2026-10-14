import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import postgres from "postgres";
import { syncAssetPriceHistory, syncBenchmarkPriceHistory, valuationDatePrice } from "../src/lib/market-data/price-history";
import { captureMarketHistory } from "../src/lib/research/history/market-history";

function loadLocalEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

const DAY = 86_400_000;
const closeFor = (day: string) => 100 + (Date.parse(day) / DAY) % 50;

/** Mocked Yahoo chart and Stooq CSV over weekdays. Stooq disagrees by 1% on 2026-06-30 and lacks 2026-06-29. */
function mockFetch(calls: string[], stooq: "csv" | "html") {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.hostname === "stooq.com") {
      if (stooq === "html") return new Response("<!DOCTYPE html><html>verify</html>", { status: 200 });
      const days: string[] = [];
      for (let t = Date.parse(`${url.searchParams.get("d1")!.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}T00:00:00Z`);
        t <= Date.parse(`${url.searchParams.get("d2")!.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}T00:00:00Z`); t += DAY) {
        const day = new Date(t).toISOString().slice(0, 10);
        if ([0, 6].includes(new Date(t).getUTCDay()) || day === "2026-06-29") continue;
        days.push(`${day},1,1,1,${day === "2026-06-30" ? closeFor(day) * 1.01 : closeFor(day)},1`);
      }
      return new Response(`Date,Open,High,Low,Close,Volume\n${days.join("\n")}\n`);
    }
    const period1 = Number(url.searchParams.get("period1")) * 1000, period2 = Number(url.searchParams.get("period2")) * 1000;
    const timestamps: number[] = [], closes: number[] = [];
    for (let t = Math.floor(period1 / DAY) * DAY; t <= period2; t += DAY) {
      if ([0, 6].includes(new Date(t).getUTCDay())) continue;
      const open = t + 13.5 * 3_600_000;
      if (open < period1 || open > period2) continue;
      timestamps.push(open / 1000);
      closes.push(closeFor(new Date(t).toISOString().slice(0, 10)));
    }
    const events = url.searchParams.get("events") === "div,split"
      ? { dividends: { "1774359000": { amount: 0.5, date: 1774359000 } } } : undefined;
    return new Response(JSON.stringify({ chart: { error: null, result: [{
      meta: { currency: "USD", symbol: "TESTPX", exchangeTimezoneName: "America/New_York", regularMarketPrice: closes.at(-1) },
      timestamp: timestamps,
      indicators: { quote: [{ open: closes, high: closes, low: closes, close: closes, volume: closes.map(() => 10) }], adjclose: [{ adjclose: closes }] },
      ...(events ? { events } : {}),
    }] } }));
  }) as typeof fetch;
}

test("price history sync backfills, updates incrementally, cross-checks and respects the cutoff", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  loadLocalEnv();
  const sql = postgres(process.env.DATABASE_URL!);
  const assetId = crypto.randomUUID(), runId = crypto.randomUUID();
  const asset = { assetId, assetName: "Price History Fixture", symbol: "TESTPX" };
  try {
    await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind) VALUES (${assetId}, 'Price History Fixture', ${`px-${assetId.slice(0, 8)}`}, 'equity')`;
    // First run: market data cut off on 2 July 2026, Stooq blocked by a browser check.
    const calls: string[] = [];
    const first = await syncAssetPriceHistory(sql, { ...asset, cutoffAt: new Date("2026-07-02T15:00:00Z") },
      { fetchImpl: mockFetch(calls, "html"), now: new Date("2026-10-10T12:00:00Z"), years: 1 });
    assert.equal(first.status, "synced", first.error);
    assert.equal(first.cross_check?.status, "unavailable");
    assert.equal(first.cross_check?.verified, 0);
    assert.ok(first.cross_check!.unverified > 250);
    const [latest] = await sql`SELECT max(trading_date) AS last FROM market_price_bars b JOIN instruments i ON i.id = b.instrument_id WHERE i.asset_id = ${assetId}`;
    // Yahoo's 2 July bar opened before the cutoff, but nothing later was requested.
    assert.equal(new Date(latest.last).toISOString().slice(0, 10), "2026-07-02");
    const [fetchLog] = await sql`SELECT status, error_message FROM market_data_fetches WHERE instrument_id = ${first.instrument_id!} AND provider = 'stooq'`;
    assert.equal(fetchLog.status, "failed");
    const [dividend] = await sql`SELECT dividend_per_share FROM corporate_actions WHERE instrument_id = ${first.instrument_id!} AND action_type = 'dividend'`;
    assert.equal(Number(dividend.dividend_per_share), 0.5);

    // Valuation as of the cutoff uses the 1 July close: 2 July's close was not public at 15:00 UTC.
    const price = await valuationDatePrice(sql, assetId, "TESTPX", new Date("2026-07-02T15:00:00Z"));
    assert.deepEqual([price?.trading_date, price?.price, price?.verified], ["2026-07-01", Number(closeFor("2026-07-01").toFixed(4)), false]);

    // A gap inside the window (left by runs with other cutoffs) is fetched again, and Stooq,
    // which failed an hour ago, is not asked again.
    await sql`DELETE FROM market_price_bars WHERE instrument_id = ${first.instrument_id!} AND trading_date BETWEEN '2025-12-01T00:00:00Z' AND '2025-12-31T00:00:00Z'`;
    const refill: string[] = [];
    const repeat = await syncAssetPriceHistory(sql, { ...asset, cutoffAt: new Date("2026-07-02T15:00:00Z") },
      { fetchImpl: mockFetch(refill, "csv"), now: new Date("2026-10-10T13:00:00Z"), years: 1 });
    assert.equal(repeat.status, "synced", repeat.error);
    assert.equal(repeat.fetched_from, "2025-07-02T15:00:00.000Z");
    const [{ december }] = await sql`SELECT count(*)::int AS december FROM market_price_bars
      WHERE instrument_id = ${first.instrument_id!} AND trading_date BETWEEN '2025-12-01T00:00:00Z' AND '2025-12-31T00:00:00Z'`;
    assert.equal(december, 23);
    assert.equal(refill.some((url) => url.includes("stooq.com")), false);
    assert.equal(repeat.cross_check?.status, "unavailable");
    assert.match(repeat.cross_check?.reason || "", /Not retried within a day/);

    // Second run, live and a day later: only the new days are fetched, and Stooq verifies what it can.
    const later: string[] = [];
    const second = await syncAssetPriceHistory(sql, { ...asset, cutoffAt: null },
      { fetchImpl: mockFetch(later, "csv"), now: new Date("2026-10-11T13:00:00Z"), years: 1 });
    assert.equal(second.status, "synced", second.error);
    const history = new URL(later.find((url) => url.includes("events=history"))!);
    assert.equal(new Date(Number(history.searchParams.get("period1")) * 1000).toISOString().slice(0, 10), "2026-06-27");
    assert.equal(second.cross_check?.status, "checked");
    assert.equal(second.cross_check?.mismatch, 1);
    assert.ok(second.cross_check!.verified > 250);
    const statuses = await sql`SELECT to_char(trading_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, verification_status, verification_json FROM market_price_bars
      WHERE instrument_id = ${second.instrument_id!} AND trading_date BETWEEN '2026-06-29T00:00:00Z' AND '2026-07-01T00:00:00Z' ORDER BY trading_date`;
    assert.deepEqual(statuses.map((row) => [row.day, row.verification_status]),
      [["2026-06-29", "unverified"], ["2026-06-30", "mismatch"], ["2026-07-01", "verified"]]);
    assert.equal(statuses[2].verification_json.provider, "stooq");
    const [{ duplicates }] = await sql`SELECT count(*) - count(DISTINCT trading_date) AS duplicates FROM market_price_bars WHERE instrument_id = ${second.instrument_id!}`;
    assert.equal(Number(duplicates), 0);
    const [{ dividends }] = await sql`SELECT count(*)::int AS dividends FROM corporate_actions WHERE instrument_id = ${second.instrument_id!}`;
    assert.equal(dividends, 1);

    // Period-end observations for a run cut off on 2 July read only bars public by then.
    await sql`INSERT INTO research_runs (id, asset_id, run_type, status, pipeline_version, market_data_cutoff_at)
      VALUES (${runId}, ${assetId}, 'deep_dive', 'running', 3, '2026-07-02T15:00:00Z')`;
    const statements = [
      { metric_key: "us_gaap_CommonStockSharesOutstanding", segment: "us-gaap:CommonClassAMember", value_numeric: 900, unit: "shares", period_end: "2026-06-30", available_at: "2026-07-30", periodicity: "quarterly", fiscal_year: 2026, fiscal_quarter: 2 },
      { metric_key: "us_gaap_CommonStockSharesOutstanding", segment: "us-gaap:CommonClassBMember", value_numeric: 100, unit: "shares", period_end: "2026-06-30", available_at: "2026-07-30", periodicity: "quarterly", fiscal_year: 2026, fiscal_quarter: 2 },
      { metric_key: "net_revenue", segment: null, value_numeric: 1, unit: "USD", period_end: "2026-06-30", available_at: "2026-07-30", periodicity: "quarterly", fiscal_year: 2026, fiscal_quarter: 2 },
      { metric_key: "net_revenue", segment: null, value_numeric: 1, unit: "USD", period_end: "2026-03-31", available_at: "2026-04-30", periodicity: "quarterly", fiscal_year: 2026, fiscal_quarter: 1 },
    ];
    const content = await captureMarketHistory(sql, { runId, assetId, assetSlug: "px", symbol: "TESTPX", cutoffAt: new Date("2026-07-02T15:00:00Z"),
      marketDataCutoffAt: new Date("2026-07-02T15:00:00Z") }, statements);
    assert.equal(content.last_trading_day, "2026-07-01");
    assert.equal(content.valuation_price?.trading_date, "2026-07-01");
    const q2Cap = content.observations.find((o) => o.metric_key === "market_cap" && o.fiscal_quarter === 2)!;
    assert.equal(q2Cap.value_numeric, Math.round(closeFor("2026-06-30") * 1000));
    assert.equal(q2Cap.metadata_json.verification_status, "mismatch");
    const q1Price = content.observations.find((o) => o.metric_key === "period_end_share_price" && o.fiscal_quarter === 1)!;
    assert.deepEqual([q1Price.metadata_json.verified, (q1Price.metadata_json.source_locator as any).trading_date], [true, "2026-03-31"]);
    const [artifact] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId} AND artifact_type = 'market_price_history'`;
    assert.equal(artifact.content_json.observations.length, 4);
  } finally {
    await sql`DELETE FROM research_artifacts WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    for (const table of ["market_price_bars", "corporate_actions", "market_data_fetches"]) {
      await sql`DELETE FROM ${sql(table)} WHERE instrument_id IN (SELECT id FROM instruments WHERE asset_id = ${assetId})`;
    }
    await sql`DELETE FROM instruments WHERE asset_id = ${assetId}`;
    await sql`DELETE FROM assets WHERE id = ${assetId}`;
    await sql.end();
  }
});

test("the S&P 500 benchmark syncs under a reference asset and gives the run a regression beta", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async (t) => {
  loadLocalEnv();
  const sql = postgres(process.env.DATABASE_URL!);
  const assetId = crypto.randomUUID(), runId = crypto.randomUUID();
  const cutoffAt = new Date("2026-07-02T15:00:00Z");
  const options = { now: new Date("2026-10-10T12:00:00Z"), years: 3 };
  const [existing] = await sql`SELECT id FROM assets WHERE slug = 'benchmark-gspc'`;
  // Never write mock bars into a database that already holds the real benchmark.
  if (existing) { await sql.end(); t.skip("benchmark asset already exists in this database"); return; }
  try {
    await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind) VALUES (${assetId}, 'Beta Fixture', ${`beta-${assetId.slice(0, 8)}`}, 'equity')`;
    const calls: string[] = [];
    const stock = await syncAssetPriceHistory(sql, { assetId, assetName: "Beta Fixture", symbol: "TESTPX", cutoffAt }, { ...options, fetchImpl: mockFetch(calls, "html") });
    const benchmark = await syncBenchmarkPriceHistory(sql, cutoffAt, { ...options, fetchImpl: mockFetch(calls, "html") });
    assert.equal(stock.status, "synced", stock.error);
    assert.equal(benchmark.status, "synced", benchmark.error);
    assert.ok(calls.some((url) => url.includes("/%5EGSPC?")));
    assert.ok(calls.some((url) => url.includes("s=%5Espx")));
    const [asset] = await sql`SELECT asset_kind, status FROM assets WHERE slug = 'benchmark-gspc'`;
    assert.deepEqual([asset.asset_kind, asset.status], ["index", "reference"]);

    await sql`INSERT INTO research_runs (id, asset_id, run_type, status, pipeline_version, market_data_cutoff_at)
      VALUES (${runId}, ${assetId}, 'deep_dive', 'running', 3, ${cutoffAt.toISOString()})`;
    const content = await captureMarketHistory(sql, { runId, assetId, assetSlug: "beta", symbol: "TESTPX", cutoffAt, marketDataCutoffAt: cutoffAt }, []);
    // The fixture's stock and index closes are the same series, so the regression is exact.
    assert.equal(content.beta.status, "computed", content.beta.reason);
    assert.deepEqual([content.beta.raw_beta, content.beta.adjusted_beta, content.beta.r_squared], [1, 1, 1]);
    assert.equal(content.beta.window_end, "2026-06-29");
    assert.equal(content.beta.verified, false);
  } finally {
    await sql`DELETE FROM research_artifacts WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    const fixtures = sql`SELECT id FROM assets WHERE id = ${assetId} OR slug = 'benchmark-gspc'`;
    for (const table of ["market_price_bars", "corporate_actions", "market_data_fetches"]) {
      await sql`DELETE FROM ${sql(table)} WHERE instrument_id IN (SELECT id FROM instruments WHERE asset_id IN (${fixtures}))`;
    }
    await sql`DELETE FROM instruments WHERE asset_id IN (${fixtures})`;
    await sql`DELETE FROM assets WHERE id = ${assetId} OR slug = 'benchmark-gspc'`;
    await sql.end();
  }
});
