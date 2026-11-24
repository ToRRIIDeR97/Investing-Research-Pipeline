/**
 * SEC SIC code → the Yahoo-style sector and industry names PragValue's engine router and fair-multiple tables are
 * keyed by, plus the SPDR sector ETF used as the trend benchmark. Ranges are checked in order; the first match wins.
 * An unmapped code is "Unknown", which PragValue routes like Pragma did for an unknown sector (engine A, or B when
 * loss-making) with the default multiples.
 */
export type SectorInfo = { sector: string; industry: string; etf: string | null };

type Range = [from: number, to: number, sector: string, industry: string, etf: string];

const RANGES: Range[] = [
  // Financials
  [6020, 6029, "Financial Services", "Banks—Regional", "XLF"],
  [6021, 6021, "Financial Services", "Banks—Diversified", "XLF"],
  [6035, 6036, "Financial Services", "Banks—Regional", "XLF"],
  [6111, 6199, "Financial Services", "Credit Services", "XLF"],
  [6200, 6211, "Financial Services", "Capital Markets", "XLF"],
  [6221, 6221, "Financial Services", "Capital Markets", "XLF"],
  [6231, 6231, "Financial Services", "Financial Data & Stock Exchanges", "XLF"],
  [6282, 6282, "Financial Services", "Asset Management", "XLF"],
  [6311, 6311, "Financial Services", "Insurance—Life", "XLF"],
  [6321, 6399, "Financial Services", "Insurance—Property & Casualty", "XLF"],
  [6411, 6411, "Financial Services", "Insurance Brokers", "XLF"],
  [6719, 6719, "Financial Services", "Financial Conglomerates", "XLF"],
  [6726, 6726, "Financial Services", "Asset Management", "XLF"],
  // Real estate
  [6798, 6798, "Real Estate", "REIT—Diversified", "XLRE"],
  [6500, 6553, "Real Estate", "Real Estate Services", "XLRE"],
  // Utilities
  // Gas transmission (4922–4923) is midstream energy and must precede the gas-utility range that contains it.
  [4922, 4923, "Energy", "Oil & Gas Midstream", "XLE"],
  [4911, 4911, "Utilities", "Utilities—Regulated Electric", "XLU"],
  [4924, 4932, "Utilities", "Utilities—Regulated Gas", "XLU"],
  [4931, 4931, "Utilities", "Utilities—Diversified", "XLU"],
  [4941, 4941, "Utilities", "Utilities—Regulated Water", "XLU"],
  [4950, 4959, "Industrials", "Waste Management", "XLI"],
  [4991, 4991, "Utilities", "Utilities—Independent Power Producers", "XLU"],
  [4900, 4999, "Utilities", "Utilities—Diversified", "XLU"],
  // Energy and mining (1000–1499 in full)
  [1311, 1311, "Energy", "Oil & Gas E&P", "XLE"],
  [1381, 1389, "Energy", "Oil & Gas Equipment & Services", "XLE"],
  [1300, 1399, "Energy", "Oil & Gas E&P", "XLE"],
  [2911, 2911, "Energy", "Oil & Gas Refining & Marketing", "XLE"],
  [4610, 4619, "Energy", "Oil & Gas Midstream", "XLE"],
  [1040, 1040, "Basic Materials", "Gold", "XLB"],
  [1000, 1199, "Basic Materials", "Other Industrial Metals & Mining", "XLB"],
  [1200, 1299, "Energy", "Thermal Coal", "XLE"],
  [1400, 1499, "Basic Materials", "Building Materials", "XLB"],
  [3312, 3317, "Basic Materials", "Steel", "XLB"],
  [3330, 3399, "Basic Materials", "Other Industrial Metals & Mining", "XLB"],
  [2800, 2829, "Basic Materials", "Specialty Chemicals", "XLB"],
  [2845, 2899, "Basic Materials", "Specialty Chemicals", "XLB"],
  // Healthcare
  [2834, 2834, "Healthcare", "Drug Manufacturers—Specialty & Generic", "XLV"],
  [2833, 2833, "Healthcare", "Drug Manufacturers—General", "XLV"],
  [2835, 2836, "Healthcare", "Biotechnology", "XLV"],
  [3841, 3851, "Healthcare", "Medical Devices", "XLV"],
  [8000, 8099, "Healthcare", "Medical Care Facilities", "XLV"],
  [8731, 8731, "Healthcare", "Diagnostics & Research", "XLV"],
  [5122, 5122, "Healthcare", "Medical Distribution", "XLV"],
  [6324, 6324, "Healthcare", "Healthcare Plans", "XLV"],
  // Technology
  [7370, 7379, "Technology", "Software—Application", "XLK"],
  [7372, 7372, "Technology", "Software—Application", "XLK"],
  [7373, 7373, "Technology", "Software—Infrastructure", "XLK"],
  [3570, 3579, "Technology", "Computer Hardware", "XLK"],
  [3674, 3674, "Technology", "Semiconductors", "XLK"],
  [3559, 3559, "Technology", "Semiconductor Equipment & Materials", "XLK"],
  [3661, 3669, "Technology", "Communication Equipment", "XLK"],
  [3670, 3679, "Technology", "Electronic Components", "XLK"],
  [3600, 3699, "Technology", "Electronic Components", "XLK"],
  [3820, 3829, "Technology", "Scientific & Technical Instruments", "XLK"],
  // Communication services
  [4800, 4899, "Communication Services", "Telecom Services", "XLC"],
  [2711, 2741, "Communication Services", "Publishing", "XLC"],
  [7812, 7841, "Communication Services", "Entertainment", "XLC"],
  // Consumer
  [5961, 5961, "Consumer Cyclical", "Internet Retail", "XLY"],
  [5900, 5999, "Consumer Cyclical", "Specialty Retail", "XLY"],
  [5300, 5399, "Consumer Defensive", "Discount Stores", "XLP"],
  [5400, 5499, "Consumer Defensive", "Grocery Stores", "XLP"],
  [5600, 5699, "Consumer Cyclical", "Apparel Retail", "XLY"],
  [5700, 5736, "Consumer Cyclical", "Specialty Retail", "XLY"],
  [5800, 5813, "Consumer Cyclical", "Restaurants", "XLY"],
  [3711, 3716, "Consumer Cyclical", "Auto Manufacturers", "XLY"],
  [3714, 3714, "Consumer Cyclical", "Auto Parts", "XLY"],
  [3021, 3021, "Consumer Cyclical", "Footwear & Accessories", "XLY"],
  [3140, 3149, "Consumer Cyclical", "Footwear & Accessories", "XLY"],
  [2300, 2399, "Consumer Cyclical", "Apparel Manufacturing", "XLY"],
  [7011, 7011, "Consumer Cyclical", "Lodging", "XLY"],
  [3630, 3639, "Consumer Cyclical", "Furnishings, Fixtures & Appliances", "XLY"],
  [2000, 2099, "Consumer Defensive", "Packaged Foods", "XLP"],
  [2080, 2086, "Consumer Defensive", "Beverages—Non-Alcoholic", "XLP"],
  [2100, 2199, "Consumer Defensive", "Tobacco", "XLP"],
  [2840, 2844, "Consumer Defensive", "Household & Personal Products", "XLP"],
  // Industrials
  [3720, 3728, "Industrials", "Aerospace & Defense", "XLI"],
  [3760, 3769, "Industrials", "Aerospace & Defense", "XLI"],
  [3812, 3812, "Industrials", "Aerospace & Defense", "XLI"],
  [3500, 3569, "Industrials", "Specialty Industrial Machinery", "XLI"],
  [3580, 3599, "Industrials", "Specialty Industrial Machinery", "XLI"],
  [4011, 4013, "Industrials", "Railroads", "XLI"],
  [4210, 4231, "Industrials", "Trucking", "XLI"],
  [4512, 4522, "Industrials", "Airlines", "XLI"],
  [4513, 4513, "Industrials", "Integrated Freight & Logistics", "XLI"],
  [1500, 1799, "Industrials", "Engineering & Construction", "XLI"],
  [7380, 7389, "Industrials", "Specialty Business Services", "XLI"],
];

/** Exact single-code entries take precedence over ranges that contain them. */
const EXACT = new Map<number, Range>(RANGES.filter((r) => r[0] === r[1]).map((r) => [r[0], r]));

export function sectorFromSic(sic: string | number | null | undefined): SectorInfo {
  const code = Number(sic);
  if (!Number.isInteger(code) || code <= 0) return { sector: "Unknown", industry: "Unknown", etf: null };
  const hit = EXACT.get(code) ?? RANGES.find(([from, to]) => code >= from && code <= to);
  return hit ? { sector: hit[2], industry: hit[3], etf: hit[4] } : { sector: "Unknown", industry: "Unknown", etf: null };
}

/**
 * The plan routes SIC 2834–2836 (pharma and biotech) to engine B2 when pre-revenue (< $50M) or loss-making. SEC files
 * most clinical-stage biotechs under 2834, which maps to a drug-manufacturer industry, so those are relabelled
 * Biotechnology before PragValue's router runs; profitable pharma keeps its own industry and multiples.
 */
export function valuationIndustry(sic: string | number | null | undefined, industry: string, revenue: number | null, ebit: number | null): string {
  const code = Number(sic);
  if (!(code >= 2834 && code <= 2836)) return industry;
  return (revenue ?? 0) < 50_000_000 || (ebit ?? 0) < 0 ? "Biotechnology" : industry;
}

export const SECTOR_ETFS = ["XLK", "XLF", "XLV", "XLE", "XLU", "XLRE", "XLI", "XLB", "XLY", "XLP", "XLC"] as const;
