/**
 * Stooq daily CSV, used only to cross-check closes from the primary provider.
 * The CSV is untrusted: anything that is not a dated close table is treated as unavailable.
 */

export const STOOQ_BASE_URL = "https://stooq.com/q/d/l/";

/** Stooq lists US shares as `<ticker>.us`. Other listings are not mapped yet. */
export function stooqSymbol(symbol: string): string | null {
  return /^[A-Za-z]{1,6}(-[A-Za-z])?$/.test(symbol) ? `${symbol.toLowerCase()}.us` : null;
}

export function stooqUrl(stooqSymbolValue: string, start: Date, end: Date): string {
  const day = (date: Date) => date.toISOString().slice(0, 10).replaceAll("-", "");
  return `${STOOQ_BASE_URL}?s=${encodeURIComponent(stooqSymbolValue)}&d1=${day(start)}&d2=${day(end)}&i=d`;
}

/** Parse `Date,Open,High,Low,Close[,Volume]` rows into trading day → close. Returns null when the body is not that CSV. */
export function parseStooqCsv(body: string): Map<string, number> | null {
  const lines = body.trim().split(/\r?\n/);
  const header = lines[0]?.split(",").map((cell) => cell.trim().toLowerCase()) ?? [];
  const dateIndex = header.indexOf("date");
  const closeIndex = header.indexOf("close");
  if (dateIndex !== 0 || closeIndex < 0) return null;
  const closes = new Map<string, number>();
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const date = cells[dateIndex]?.trim();
    const close = Number(cells[closeIndex]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") && Number.isFinite(close) && close > 0) closes.set(date!, close);
  }
  return closes;
}

export type StooqResult =
  | { status: "ok"; url: string; closes: Map<string, number> }
  | { status: "unavailable"; url: string | null; reason: string };

export async function fetchStooqCloses(symbol: string, start: Date, end: Date, fetchImpl: typeof fetch = fetch): Promise<StooqResult> {
  const mapped = stooqSymbol(symbol);
  if (!mapped) return { status: "unavailable", url: null, reason: `No Stooq symbol mapping for ${symbol}` };
  const url = stooqUrl(mapped, start, end);
  try {
    const response = await fetchImpl(url, { headers: { "User-Agent": "ResearchOS/0.1 market-data" } });
    if (!response.ok) return { status: "unavailable", url, reason: `Stooq HTTP ${response.status}` };
    const body = await response.text();
    const closes = parseStooqCsv(body.slice(0, 2_000_000));
    if (!closes) return { status: "unavailable", url, reason: "Stooq did not return CSV (no data, rate limit or browser check)" };
    if (!closes.size) return { status: "unavailable", url, reason: "Stooq returned no rows" };
    return { status: "ok", url, closes };
  } catch (error) {
    return { status: "unavailable", url, reason: `Stooq fetch failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
