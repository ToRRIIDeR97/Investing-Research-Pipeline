/**
 * Peers through EDGAR (RQ-SRC-5, RQ-BIZ-6): the approved framing's named peers are resolved against SEC
 * company_tickers.json and one companyfacts download each gives a compact consolidated benchmark (quarterly revenue
 * and operating income, annual cash flow and capex) beside the subject. Private and non-SEC peers become gaps. Fetched
 * JSON is untrusted: only finite numbers from known concepts are read, and responses are capped by fetchCapped.
 */
import { fetchCapped } from "@/lib/net";

type Row = Record<string, any>;
const SEC_USER_AGENT = "ResearchOS/0.1 research-pipeline@example.com";
const MAX_PEERS = 4;
export interface TickerEntry { cik_str?: number; ticker?: string; title?: string }
export interface PeerRequest { name: string; ticker?: string }
export interface ResolvedPeer { name: string; ticker: string; cik: string; title: string }

const normalizeName = (value: string) => value.toLowerCase().replace(/[.,&']/g, " ")
  .replace(/\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|the|class [a-z])\b/g, " ")
  .replace(/\s+/g, " ").trim();

/** Ticker first, then an exact normalized-title match. Ambiguous or missing names are not guessed. */
export function resolvePeers(requests: PeerRequest[], tickers: Record<string, TickerEntry>): { resolved: ResolvedPeer[]; gaps: { name: string; reason: string }[] } {
  const entries = Object.values(tickers).filter((e) => e.cik_str && e.ticker && e.title);
  const resolved: ResolvedPeer[] = [], gaps: { name: string; reason: string }[] = [];
  for (const request of requests.slice(0, MAX_PEERS)) {
    const ticker = request.ticker?.trim().toUpperCase();
    let match = ticker ? entries.find((e) => e.ticker!.toUpperCase() === ticker) : undefined;
    if (!match) {
      const byTitle = entries.filter((e) => normalizeName(e.title!) === normalizeName(request.name));
      const ciks = new Set(byTitle.map((e) => e.cik_str));
      if (ciks.size === 1) match = byTitle[0];
    }
    if (!match) { gaps.push({ name: request.name, reason: "Not an SEC registrant found in company_tickers.json (private, foreign-listed or ambiguous name)." }); continue; }
    const cik = String(match.cik_str).padStart(10, "0");
    if (resolved.some((p) => p.cik === cik)) continue;
    resolved.push({ name: request.name, ticker: match.ticker!.toUpperCase(), cik, title: match.title! });
  }
  return { resolved, gaps };
}

const REVENUE = ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"];
const OPERATING_INCOME = ["OperatingIncomeLoss"];
const OCF = ["NetCashProvidedByUsedInOperatingActivities"];
const CAPEX = ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"];

/** Values by SEC frame (CY2025Q2 for a quarter, CY2025 for a year), filed on or before the cutoff. First concept with data wins. */
function framed(companyFacts: Row, concepts: string[], pattern: RegExp, cutoff: string): Map<string, number> {
  for (const concept of concepts) {
    const facts: Row[] = companyFacts?.facts?.["us-gaap"]?.[concept]?.units?.USD ?? [];
    const out = new Map<string, number>();
    for (const fact of facts) {
      const frame = String(fact.frame ?? "");
      const value = Number(fact.val);
      if (!pattern.test(frame) || !Number.isFinite(value) || String(fact.filed ?? "") > cutoff) continue;
      out.set(frame, value / 1e6);
    }
    if (out.size) return out;
  }
  return new Map();
}
const r4 = (v: number | null) => v === null || !Number.isFinite(v) ? null : Number(v.toFixed(4));
const r1 = (v: number | undefined) => v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(1));

/** A peer's last 8 quarters and last 2 fiscal years from companyfacts, in USD millions. */
export function peerBenchmarkRow(peer: ResolvedPeer, companyFacts: Row, cutoff: string) {
  const quarterPattern = /^CY\d{4}Q[1-4]$/, yearPattern = /^CY\d{4}$/;
  const revenueQ = framed(companyFacts, REVENUE, quarterPattern, cutoff);
  const opQ = framed(companyFacts, OPERATING_INCOME, quarterPattern, cutoff);
  const periods = [...revenueQ.keys()].sort().slice(-8);
  const quarters = periods.map((period) => ({ period, revenue: r1(revenueQ.get(period)), operating_income: r1(opQ.get(period)) }));
  const sum = (map: Map<string, number>, keys: string[]) => keys.every((k) => map.has(k)) ? keys.reduce((n, k) => n + map.get(k)!, 0) : null;
  const last4 = periods.slice(-4), prior4 = periods.slice(-8, -4);
  const revenueTtm = last4.length === 4 ? sum(revenueQ, last4) : null;
  const revenuePrior = prior4.length === 4 ? sum(revenueQ, prior4) : null;
  const opTtm = last4.length === 4 ? sum(opQ, last4) : null;
  const revenueY = framed(companyFacts, REVENUE, yearPattern, cutoff), ocfY = framed(companyFacts, OCF, yearPattern, cutoff), capexY = framed(companyFacts, CAPEX, yearPattern, cutoff);
  const years = [...revenueY.keys()].sort().slice(-2).map((fy) => {
    const revenue = revenueY.get(fy)!, ocf = ocfY.get(fy), capex = capexY.get(fy);
    return { fiscal_year: fy, revenue: r1(revenue), operating_cash_flow: r1(ocf), capex: r1(capex),
      capex_to_revenue: r4(capex !== undefined ? capex / revenue : null),
      fcf_margin: r4(ocf !== undefined && capex !== undefined ? (ocf - capex) / revenue : null) };
  });
  return { name: peer.name, ticker: peer.ticker, cik: peer.cik, registrant: String(companyFacts?.entityName ?? peer.title),
    source_url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${peer.cik}.json`,
    ttm: { period: last4.at(-1) ?? null, revenue: r1(revenueTtm ?? undefined), operating_income: r1(opTtm ?? undefined),
      operating_margin: r4(revenueTtm && opTtm !== null ? opTtm / revenueTtm : null),
      revenue_growth_yoy: r4(revenueTtm && revenuePrior ? revenueTtm / revenuePrior - 1 : null) },
    quarters, annual: years };
}

const TICKER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHED_ROWS = 200;
let tickerCache: { at: number; map: Record<string, TickerEntry> } | null = null;
// Only the compact benchmark row is kept (a companyfacts file can be tens of MB), per CIK and cutoff, oldest evicted first.
const rowCache = new Map<string, ReturnType<typeof peerBenchmarkRow>>();

/** The ticker map is refetched after a day; each peer's compact row is cached per cutoff, at most MAX_CACHED_ROWS. */
export async function buildPeerBenchmark(requests: PeerRequest[], cutoff: string, fetchImpl: typeof fetchCapped = fetchCapped, now = Date.now()) {
  const note = "Consolidated SEC companyfacts in USD millions; companyfacts has no segment detail, so peers compare on group growth, margin and capex only.";
  if (!requests.length) return { artifact_type: "peer_benchmark", note, peers: [], gaps: [], status: "no_named_peers" };
  if (!tickerCache || now - tickerCache.at > TICKER_TTL_MS) {
    const response = await fetchImpl("https://www.sec.gov/files/company_tickers.json", { headers: { "User-Agent": SEC_USER_AGENT } });
    if (!response.ok) throw new Error(`SEC ticker map failed: ${response.status}`);
    tickerCache = { at: now, map: await response.json() };
  }
  const { resolved, gaps } = resolvePeers(requests, tickerCache.map);
  const peers = [];
  for (const peer of resolved) {
    try {
      const key = `${peer.cik}:${cutoff}`;
      if (!rowCache.has(key)) {
        const response = await fetchImpl(`https://data.sec.gov/api/xbrl/companyfacts/CIK${peer.cik}.json`, { headers: { "User-Agent": SEC_USER_AGENT } });
        if (!response.ok) throw new Error(`companyfacts ${response.status}`);
        rowCache.set(key, peerBenchmarkRow(peer, await response.json(), cutoff));
        if (rowCache.size > MAX_CACHED_ROWS) rowCache.delete(rowCache.keys().next().value!);
      }
      peers.push({ ...rowCache.get(key)!, name: peer.name });
    } catch (error) {
      gaps.push({ name: peer.name, reason: `SEC companyfacts unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) });
    }
  }
  return { artifact_type: "peer_benchmark", note, cutoff, peers, gaps, status: peers.length ? "complete" : "unavailable" };
}
