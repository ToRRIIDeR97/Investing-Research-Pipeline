import type { Sql, ResearchRunContext } from "../run-context";
import { saveReportArtifact } from "../reporting/store";
import {
  CROSS_CHECK_TOLERANCE_PCT,
  PRIMARY_PRICE_PROVIDER,
  loadStoredPriceHistory,
  periodEndMarketObservations,
  valuationPriceFromBars,
  type PriceHistorySync,
} from "@/lib/market-data/price-history";

type Row = Record<string, any>;

/**
 * Save the `market_price_history` artifact: period-end closes and market caps for every filed
 * period up to the market-data cutoff, and the valuation-date price. Reads bars stored by source
 * discovery; it fetches nothing.
 */
export async function captureMarketHistory(sql: Sql,
  ctx: Pick<ResearchRunContext, "runId" | "assetId" | "assetSlug" | "symbol" | "cutoffAt" | "marketDataCutoffAt">,
  statementObservations: Row[], sync?: PriceHistorySync | null) {
  const cutoffAt = ctx.marketDataCutoffAt || ctx.cutoffAt;
  const { bars, splits } = await loadStoredPriceHistory(sql, ctx.assetId, ctx.symbol, cutoffAt);
  const observations = bars.length
    ? periodEndMarketObservations({ bars, splits, statementObservations, cutoffAt, symbol: ctx.symbol })
    : [];
  const prices = observations.filter((o) => o.metric_key === "period_end_share_price" && o.value_numeric !== null);
  const check = crossCheckStatus(sync);
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
      status: check.status,
      ...(check.reason ? { reason: check.reason } : {}),
    },
    valuation_price: valuationPriceFromBars(bars, splits, cutoffAt),
    observations,
    method: [
      "Close is the last trading day's close on or before each period end (at most 7 days earlier), as traded that day.",
      "Market cap = close × common shares outstanding at the period end (share classes summed); when a filing reports no period-end count, the latest diluted weighted-average count is used and labelled.",
      "A close is verified when Stooq's close for the same day agrees within 0.5%; otherwise it stays unverified or is marked mismatch.",
      ...(check.status === "unavailable" || check.status === "unknown"
        ? [`Stooq verification did not run in this run's price sync (${check.status}${check.reason ? `: ${check.reason}` : ""}); earlier verifications still count.`] : []),
      "Only bars whose close was public by the market-data cutoff are used.",
    ],
    ...(bars.length ? {} : { gap: `No stored daily prices for ${ctx.symbol.toUpperCase()} by the market-data cutoff.` }),
  };
  await saveReportArtifact(sql, ctx, "market_price_history", `${ctx.assetSlug}-market-price-history`, content);
  return content;
}

/** Source discovery's price sync summary from the latest source review, validated or accepted at the second gate. */
export async function latestPriceHistorySync(sql: Sql, runId: string): Promise<PriceHistorySync | null> {
  const [review] = await sql`
    SELECT content_json->'price_history_sync' AS sync FROM research_artifacts
    WHERE research_run_id = ${runId} AND artifact_type = 'source_review' AND status IN ('validated', 'accepted')
    ORDER BY artifact_version DESC LIMIT 1
  `;
  return review?.sync ?? null;
}

/** The Stooq cross-check outcome of source discovery's price sync, or unknown when no summary was recorded. */
export function crossCheckStatus(sync?: PriceHistorySync | null): { status: "checked" | "not_needed" | "unavailable" | "unknown"; reason?: string } {
  if (!sync) return { status: "unknown", reason: "No price sync summary was recorded for this run." };
  if (sync.cross_check) return { status: sync.cross_check.status, ...(sync.cross_check.reason ? { reason: sync.cross_check.reason } : {}) };
  return { status: "unavailable", reason: sync.error ? `Price sync failed: ${sync.error}` : "Price sync did not reach the cross-check." };
}
