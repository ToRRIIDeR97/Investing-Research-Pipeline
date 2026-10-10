import type { Sql, ResearchRunContext } from "../run-context";
import { saveReportArtifact } from "../reporting/store";
import {
  CROSS_CHECK_TOLERANCE_PCT,
  PRIMARY_PRICE_PROVIDER,
  loadStoredPriceHistory,
  periodEndMarketObservations,
  valuationPriceFromBars,
} from "@/lib/market-data/price-history";

type Row = Record<string, any>;

/**
 * Save the `market_price_history` artifact: period-end closes and market caps for every filed
 * period up to the market-data cutoff, and the valuation-date price. Reads bars stored by source
 * discovery; it fetches nothing.
 */
export async function captureMarketHistory(sql: Sql,
  ctx: Pick<ResearchRunContext, "runId" | "assetId" | "assetSlug" | "symbol" | "cutoffAt" | "marketDataCutoffAt">,
  statementObservations: Row[]) {
  const cutoffAt = ctx.marketDataCutoffAt || ctx.cutoffAt;
  const { bars, splits } = await loadStoredPriceHistory(sql, ctx.assetId, ctx.symbol, cutoffAt);
  const observations = bars.length
    ? periodEndMarketObservations({ bars, splits, statementObservations, cutoffAt, symbol: ctx.symbol })
    : [];
  const prices = observations.filter((o) => o.metric_key === "period_end_share_price" && o.value_numeric !== null);
  const content = {
    artifact_type: "market_price_history",
    provider: PRIMARY_PRICE_PROVIDER,
    provider_symbol: ctx.symbol.toUpperCase(),
    market_data_cutoff: cutoffAt.toISOString(),
    bars_available: bars.length,
    first_trading_day: bars[0]?.day ?? null,
    last_trading_day: bars.at(-1)?.day ?? null,
    splits: splits.filter((split) => split.ex_day <= cutoffAt.toISOString().slice(0, 10)),
    cross_check: {
      provider: "stooq",
      tolerance_pct: CROSS_CHECK_TOLERANCE_PCT,
      verified_periods: prices.filter((o) => o.metadata_json.verified === true).length,
      unverified_periods: prices.filter((o) => o.metadata_json.verified !== true).length,
    },
    valuation_price: valuationPriceFromBars(bars, splits, cutoffAt),
    observations,
    method: [
      "Close is the last trading day's close on or before each period end (at most 7 days earlier), as traded that day.",
      "Market cap = close × common shares outstanding at the period end (share classes summed); when a filing reports no period-end count, the latest diluted weighted-average count is used and labelled.",
      "A close is verified when Stooq's close for the same day agrees within 0.5%; otherwise it stays unverified or is marked mismatch.",
      "Only bars whose close was public by the market-data cutoff are used.",
    ],
    ...(bars.length ? {} : { gap: `No stored daily prices for ${ctx.symbol.toUpperCase()} by the market-data cutoff.` }),
  };
  await saveReportArtifact(sql, ctx, "market_price_history", `${ctx.assetSlug}-market-price-history`, content);
  return content;
}
