import { NextRequest } from "next/server";
import { pipelineSql } from "@/db/pipeline-sql";
import { ApiError, handleApiError, successResponse } from "@/lib/api/errors";
import { closeOnSplitBasis, loadStoredPriceHistory, PRIMARY_PRICE_PROVIDER } from "@/lib/market-data/price-history";
import { isPriceRange, pricePoints, RANGES, type PricePoint } from "@/lib/market-data/price-series";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read-only price history for the company price chart: the asset's stored daily closes from `market_price_bars`,
 * rebased onto the latest bar's split basis (so the last point is the as-traded close the valuation uses), windowed
 * by `range`. Never calls a market-data provider; an asset with no stored bars returns an empty series.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const range = request.nextUrl.searchParams.get("range") ?? "6M";
    if (!isPriceRange(range)) throw new ApiError(`Unknown range. Use one of ${RANGES.join(", ")}.`, 400, "INVALID_RANGE");
    if (!UUID.test(id)) throw new ApiError("Asset id must be a UUID.", 400, "INVALID_ID");

    const sql = pipelineSql();
    const [asset] = await sql`SELECT base_currency FROM assets WHERE id = ${id}`;
    if (!asset) throw new ApiError("Asset not found.", 404, "NOT_FOUND");
    // The symbol of the asset's most recent stored primary bar; none means no history yet.
    const [latest] = await sql`
      SELECT b.provider_symbol FROM market_price_bars b JOIN instruments i ON i.id = b.instrument_id
      WHERE i.asset_id = ${id} AND b.provider = ${PRIMARY_PRICE_PROVIDER}
      ORDER BY b.trading_date DESC LIMIT 1`;
    const fallbackCurrency = asset.base_currency ? String(asset.base_currency) : "USD";
    if (!latest) return successResponse({ currency: fallbackCurrency, range, points: [], last: null });

    const { bars, splits } = await loadStoredPriceHistory(sql, id, String(latest.provider_symbol), new Date());
    const lastDay = bars.length ? bars[bars.length - 1].day : null;
    const closes: PricePoint[] = lastDay === null ? [] : bars
      .filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
      .map((bar) => ({ day: bar.day, close: Math.round(closeOnSplitBasis(bar.close, bar.day, bar.retrieved_day, lastDay, splits) * 10_000) / 10_000 }));
    const points = pricePoints(closes, range);
    const currency = bars.length ? bars[bars.length - 1].currency : fallbackCurrency;
    return successResponse({ currency, range, points, last: points.length ? points[points.length - 1] : null });
  } catch (error) {
    return handleApiError(error);
  }
}
