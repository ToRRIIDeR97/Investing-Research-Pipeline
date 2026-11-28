import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeQuery, parseYahooQuote, parseYahooSearch, searchListedCompanies } from "../src/lib/market-data/company-search";

const SEARCH = {
  quotes: [
    { quoteType: "EQUITY", symbol: "NVDA", longname: "NVIDIA Corporation", shortname: "NVIDIA Corp", exchDisp: "NASDAQ", sectorDisp: "Technology", industryDisp: "Semiconductors" },
    { quoteType: "EQUITY", symbol: "NVDA.TO", longname: "NVIDIA Corporation", exchDisp: "Toronto" },
    { quoteType: "FUTURE", symbol: "SNVDA=F", shortname: "NVIDIA future" },
    { quoteType: "ETF", symbol: "NVDX", shortname: "2X Long NVIDIA" },
    { quoteType: "EQUITY", symbol: "NVDA", longname: "duplicate" },
    { quoteType: "EQUITY", symbol: "brk-b", shortname: "  Berkshire\u0007 Hathaway  " },
    { quoteType: "EQUITY", symbol: "NONAME" },
    "junk",
  ],
};

test("parseYahooSearch keeps unique US-style equities and cleans names", () => {
  const results = parseYahooSearch(SEARCH);
  assert.deepEqual(results.map((r) => r.symbol), ["NVDA", "BRK-B"]);
  assert.equal(results[0].name, "NVIDIA Corporation");
  assert.equal(results[0].exchange, "NASDAQ");
  assert.equal(results[0].industry, "Semiconductors");
  assert.equal(results[1].name, "Berkshire Hathaway");
  assert.equal(results[1].sector, null);
});

test("parseYahooSearch tolerates malformed bodies", () => {
  assert.deepEqual(parseYahooSearch(null), []);
  assert.deepEqual(parseYahooSearch({ quotes: "x" }), []);
});

test("parseYahooQuote reads price and change, and nulls what is missing", () => {
  const quote = parseYahooQuote({ chart: { result: [{ meta: { regularMarketPrice: 110, chartPreviousClose: 100, currency: "USD" } }] } });
  assert.equal(quote.price, 110);
  assert.ok(Math.abs((quote.change_pct ?? 0) - 10) < 1e-9);
  assert.equal(quote.currency, "USD");
  assert.deepEqual(parseYahooQuote({}), { price: null, change_pct: null, currency: null });
});

test("normalizeQuery trims, strips control characters and caps length", () => {
  assert.equal(normalizeQuery("  so\nfi "), "so fi");
  assert.equal(normalizeQuery("x".repeat(100)).length, 60);
  assert.equal(normalizeQuery(null), "");
});

test("searchListedCompanies adds prices best-effort and throws when search fails", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/v1/finance/search")) return new Response(JSON.stringify(SEARCH));
    if (url.includes("/NVDA?")) return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 150, chartPreviousClose: 150, currency: "USD" } }] } }));
    return new Response("nope", { status: 500 });
  }) as typeof fetch;
  const results = await searchListedCompanies("nvidia", fetchImpl);
  assert.equal(results[0].price, 150);
  assert.equal(results[1].price, null);
  assert.ok(urls[0].includes("q=nvidia"));
  assert.deepEqual(await searchListedCompanies("   ", fetchImpl), []);
  await assert.rejects(searchListedCompanies("x", (async () => new Response("", { status: 503 })) as typeof fetch));
});
