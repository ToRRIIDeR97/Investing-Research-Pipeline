/**
 * The market benchmark for a ticker's trend and relative strength: the S&P 500 for US listings, else the main index
 * of the exchange named by Yahoo's suffix (BBCA.JK → Jakarta Composite). An unknown suffix falls back to the S&P 500.
 */
export type Benchmark = { symbol: string; name: string };

export const US_BENCHMARK: Benchmark = { symbol: "^GSPC", name: "S&P 500" };

const BY_SUFFIX: Record<string, Benchmark> = {
  JK: { symbol: "^JKSE", name: "Jakarta Composite" },
  L: { symbol: "^FTSE", name: "FTSE 100" },
  T: { symbol: "^N225", name: "Nikkei 225" },
  HK: { symbol: "^HSI", name: "Hang Seng" },
  TO: { symbol: "^GSPTSE", name: "S&P/TSX Composite" },
  V: { symbol: "^GSPTSE", name: "S&P/TSX Composite" },
  AX: { symbol: "^AXJO", name: "S&P/ASX 200" },
  SI: { symbol: "^STI", name: "Straits Times" },
  NS: { symbol: "^NSEI", name: "Nifty 50" },
  BO: { symbol: "^BSESN", name: "BSE Sensex" },
  DE: { symbol: "^GDAXI", name: "DAX" },
  F: { symbol: "^GDAXI", name: "DAX" },
  PA: { symbol: "^FCHI", name: "CAC 40" },
  AS: { symbol: "^AEX", name: "AEX" },
  MI: { symbol: "FTSEMIB.MI", name: "FTSE MIB" },
  MC: { symbol: "^IBEX", name: "IBEX 35" },
  SW: { symbol: "^SSMI", name: "SMI" },
  ST: { symbol: "^OMX", name: "OMX Stockholm 30" },
  KS: { symbol: "^KS11", name: "KOSPI" },
  KQ: { symbol: "^KQ11", name: "KOSDAQ" },
  TW: { symbol: "^TWII", name: "Taiwan Weighted" },
  SS: { symbol: "000001.SS", name: "SSE Composite" },
  SZ: { symbol: "399001.SZ", name: "Shenzhen Component" },
  KL: { symbol: "^KLSE", name: "FTSE Bursa Malaysia KLCI" },
  BK: { symbol: "^SET.BK", name: "SET" },
  SA: { symbol: "^BVSP", name: "Ibovespa" },
  MX: { symbol: "^MXX", name: "IPC Mexico" },
  NZ: { symbol: "^NZ50", name: "S&P/NZX 50" },
};

/**
 * Yahoo quotes some exchanges in the minor unit (London in pence, "GBp" or "GBX"; Johannesburg in cents, "ZAc";
 * Tel Aviv in agorot, "ILA"). Returns the major currency and the factor that turns a quoted price into it; any other
 * three-letter code is its own major unit (factor 1). Null for a malformed code. Pure.
 */
export function listingUnit(code: string | null | undefined): { currency: string; factor: number } | null {
  const c = (code ?? "").trim();
  const minor: Record<string, string> = { GBp: "GBP", GBX: "GBP", ZAc: "ZAR", ZAC: "ZAR", ILA: "ILS" };
  if (minor[c]) return { currency: minor[c], factor: 0.01 };
  return /^[A-Za-z]{3}$/.test(c) ? { currency: c.toUpperCase(), factor: 1 } : null;
}

/** The exchange suffix of a Yahoo symbol ("BBCA.JK" → "JK"), or null for a US-style symbol (AAPL, BRK-B). */
export function exchangeSuffix(ticker: string): string | null {
  const m = /\.([A-Z]{1,3})$/.exec(ticker.trim().toUpperCase());
  return m ? m[1] : null;
}

/** A listing on a known non-US exchange (a class suffix such as BRK.B is not one). */
export function isInternationalTicker(ticker: string): boolean {
  const suffix = exchangeSuffix(ticker);
  return !!suffix && suffix in BY_SUFFIX;
}

export function benchmarkFor(ticker: string): Benchmark {
  const suffix = exchangeSuffix(ticker);
  return (suffix && BY_SUFFIX[suffix]) || US_BENCHMARK;
}
