/**
 * SEC ticker → zero-padded CIK from SEC's company ticker map. Throws "SEC CIK not found" for a ticker that is not an
 * SEC filer, and a different error when the map cannot be fetched. It has no research-corpus imports, so the Quant
 * page can use it without loading the corpus (and, through it, the agent harness).
 */
import { fetchCapped } from "@/lib/net";

/** SEC CIK for a ticker from SEC's ticker map. fetchImpl lets a caller (monitor-check) route it through its own guarded fetch. */
export async function resolveSecCik(symbol: string, fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetchCapped) {
  const upper = symbol.toUpperCase();
  const baseSymbol = upper.includes("_TEST") ? upper.split("_TEST")[0] : upper.split("_")[0];
  const response = await fetchImpl("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": "ResearchOS/0.1 research-pipeline@example.com" },
  });
  if (!response.ok) {
    throw new Error(`SEC ticker map failed: ${response.status}`);
  }

  const tickerMap = await response.json() as Record<
    string,
    { cik_str?: number; ticker?: string; title?: string }
  >;
  const match = Object.values(tickerMap).find(
    (entry) => entry.ticker?.toUpperCase() === upper || entry.ticker?.toUpperCase() === baseSymbol
  );
  if (!match?.cik_str) {
    throw new Error(`SEC CIK not found for ticker ${symbol}`);
  }
  return String(match.cik_str).padStart(10, "0");
}
