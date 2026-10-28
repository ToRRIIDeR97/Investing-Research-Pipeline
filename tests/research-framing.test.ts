import test from "node:test";
import assert from "node:assert/strict";
import { framingContract, classificationArchetypes, mergeFramingArchetypes, checkGateEdits, packetFraming, type ResearchFraming } from "../src/lib/research/framing";
import { composeProfile } from "../src/lib/research/archetypes/compose";
import { stripNul } from "../src/lib/research/run-context";
import { includeFramingQuestions } from "../src/lib/research/reporting/runtime";
import { validateManagementAssessment } from "../src/lib/research/business/validation";
import { resolvePeers, peerBenchmarkRow, buildPeerBenchmark } from "../src/lib/research/sources/peers";
import { normalizeCountry, demandSeriesFor, parseFredCsv, parseWorldBank, summarizeSeries, buildDemandBackdrop } from "../src/lib/research/sources/demand";
import { irHostsFromText, selectResearchFilings, MAX_EARNINGS_RELEASES } from "../src/lib/research/sources/corpus";
import { RESEARCH_DOCTRINE, ANALYST_BEHAVIOUR_RULES } from "../src/lib/research/reporting/contracts";

const framing: ResearchFraming = {
  central_question: "Will management let the Family of Apps economics accrue to Class A holders while Reality Labs burns cash?",
  decisive_insight_hypothesis: "Two engines: one earns, one burns.",
  what_investor_owns: "Class A common stock with one vote; Class B holds ten votes per share.",
  engines: [{ name: "Family of Apps", role: "earner", value_treatment: "Cash-flow model" }, { name: "Reality Labs", role: "burner", value_treatment: "Loss stream" }],
  key_questions: [{ id: "capex-return", question: "Does AI capex earn above the cost of capital?", why_it_decides_value: "Capex absorbs most operating cash flow.", falsifier: "Incremental ROIC below 9% for 8 quarters." }],
  named_peers: [{ name: "Alphabet", ticker: "GOOGL", why: "Search and video ads" }, { name: "TikTok", ticker: "", why: "Short video" }],
  priority_documents: ["Latest DEF 14A proxy"], management_axes: ["capital allocation"],
  archetypes: [{ key: "operating_company_core", reason: "Base" }, { key: "advertising_platform", reason: "Ads" }], overlays: [],
};

test("the framing contract accepts a complete framing and rejects duplicate question ids and unknown archetypes", () => {
  const contract = framingContract();
  assert.deepEqual(contract.validate({ framing }), []);
  const duplicate = { ...framing, key_questions: [framing.key_questions[0], framing.key_questions[0]] };
  assert.match(contract.validate({ framing: duplicate })[0].message, /unique/);
  assert.ok(contract.validate({ framing: { ...framing, archetypes: [{ key: "crypto_casino", reason: "x" }] } }).length);
  assert.equal("archetypes" in packetFraming(framing, "Q"), false, "packets carry the framing without proposal metadata");
});

test("archetypes come from the asset's classification, and the framing adds only combinations that compose", () => {
  assert.deepEqual(classificationArchetypes("operating_company", { sector: "Communication Services", industry: "Internet Content & Information" }), ["operating_company_core", "advertising_platform"]);
  assert.ok(classificationArchetypes(null, { industry: "Internet Retail and Fintech" }).includes("marketplace"));
  assert.ok(classificationArchetypes(null, { industry: "Investment Holding Company" }).includes("holding_company"));
  assert.deepEqual(classificationArchetypes("financials", { industry: "Credit Services" }), ["bank", "lender"]);
  assert.deepEqual(classificationArchetypes(null, {}), ["operating_company_core"]);
  assert.deepEqual(mergeFramingArchetypes({ archetypes: ["operating_company_core"], overlays: [] }, framing, "a")?.archetypes, ["operating_company_core", "advertising_platform"]);
  assert.equal(mergeFramingArchetypes({ archetypes: ["operating_company_core", "advertising_platform"], overlays: [] }, framing, "a"), null, "nothing new");
  assert.throws(() => checkGateEdits({ archetypes: ["advertising_platform"] }, "a"), /base archetype/);
  assert.throws(() => checkGateEdits({ archetypes: ["nope"] }, "a"), /registry keys/);
  assert.throws(() => checkGateEdits({ framing: { ...framing, central_question: "" } }, "a"));
  assert.equal(checkGateEdits({ framing }, "a").framing?.central_question, framing.central_question);
});

test("a specific archetype's explicit valuation rules override the core's defaults instead of conflicting", () => {
  const holding = composeProfile("p", "a", classificationArchetypes(null, { industry: "Investment Holding Company" }), []);
  assert.deepEqual(holding.errors, []);
  assert.deepEqual(holding.profile.valuation_methods.find(m => m.method === "sotp"), { method: "sotp", allowed: true, required: true, rationale: "Sum-of-the-parts primary" });
  assert.equal(holding.profile.valuation_methods.find(m => m.method === "dcf")?.required, true, "core's dcf still applies");
  const fund = composeProfile("p", "a", ["operating_company_core", "etf_fund"], []);
  assert.deepEqual(fund.errors, []);
  assert.equal(fund.profile.valuation_methods.find(m => m.method === "dcf")?.allowed, false);
  assert.equal(composeProfile("p", "a", ["bank", "lender"], []).profile.valuation_methods.find(m => m.method === "nav")?.required, true);
  assert.ok(composeProfile("p", "a", ["operating_company_core", "holding_company", "etf_fund"], []).errors.some(e => e.code === "conflict"),
    "two specific archetypes that disagree still conflict");
  assert.ok(composeProfile("p", "a", ["holding_company"], []).errors.some(e => e.code === "missing_base"), "a base archetype is still required");
  assert.equal(checkGateEdits({ archetypes: ["operating_company_core", "holding_company"] }, "a").archetypes?.length, 2);
});

test("NUL characters are stripped from model JSON before it is written as jsonb", () => {
  assert.deepEqual(stripNul({ "a\u0000": ["x\u0000y", 1, null, { b: "it's\u0000" }] }), { a: ["xy", 1, null, { b: "it's" }] });
});

test("framing key questions the outline skips are added as qualified, never blocked", () => {
  const outline = { sections: [], coverage: [], questions: [] } as any;
  const out = includeFramingQuestions(outline, framing);
  assert.deepEqual(out.questions.map(q => [q.id, q.status, q.materiality]), [["capex-return", "qualified", "material"]]);
  assert.match(out.questions[0].follow_up, /Incremental ROIC/);
  assert.equal(includeFramingQuestions(out, framing).questions.length, 1, "an answered id is not added twice");
  assert.equal(includeFramingQuestions(outline, null), outline);
});

test("management is scored per axis; a score needs a source and governance needs a cited claim", () => {
  const axis = (name: string, extra: Record<string, unknown> = {}) => ({ axis: name, score: 3, rationale: "r", analytics_paths: ["financial_analytics.capital_allocation.quarterly"], supporting_claim_ids: [], ...extra });
  const axes = ["operating_execution", "balance_sheet_discipline", "capital_returns", "capital_allocation"].map(a => axis(a));
  const ok = { artifact_type: "management_assessment", summary: "s", axes: [...axes, axis("governance_alignment", { score: null, analytics_paths: [] })] };
  assert.deepEqual(validateManagementAssessment(ok).errors, []);
  const governance = { ...ok, axes: [...axes, axis("governance_alignment")] };
  assert.match(validateManagementAssessment(governance).errors[0], /governance_alignment/);
  const unsourced = { ...ok, axes: [axis("operating_execution", { analytics_paths: [] }), ...ok.axes.slice(1)] };
  assert.match(validateManagementAssessment(unsourced).errors[0], /without an analytics path/);
});

const tickers = { 0: { cik_str: 1652044, ticker: "GOOGL", title: "Alphabet Inc." }, 1: { cik_str: 1652044, ticker: "GOOG", title: "Alphabet Inc." },
  2: { cik_str: 1564408, ticker: "SNAP", title: "Snap Inc" }, 3: { cik_str: 1506293, ticker: "PINS", title: "Pinterest, Inc." } };
const fact = (frame: string, val: number, filed = "2026-08-01") => ({ frame, val, filed });
const companyFacts = { entityName: "Snap Inc", facts: { "us-gaap": {
  Revenues: { units: { USD: [...["CY2024Q3", "CY2024Q4", "CY2025Q1", "CY2025Q2"].map(f => fact(f, 1e9)), ...["CY2025Q3", "CY2025Q4", "CY2026Q1", "CY2026Q2"].map(f => fact(f, 1.25e9)), fact("CY2025", 5e9), fact("CY2026Q3", 9e9, "2026-11-01")] } },
  OperatingIncomeLoss: { units: { USD: ["CY2025Q3", "CY2025Q4", "CY2026Q1", "CY2026Q2"].map(f => fact(f, 1e8)) } },
  NetCashProvidedByUsedInOperatingActivities: { units: { USD: [fact("CY2025", 8e8)] } },
  PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: [fact("CY2025", 3e8)] } } } } };

test("peers resolve by ticker or exact name through company_tickers.json; private peers become gaps", () => {
  const { resolved, gaps } = resolvePeers([{ name: "Alphabet", ticker: "googl" }, { name: "Snap" }, { name: "Pinterest Inc" }, { name: "TikTok", ticker: "" }], tickers);
  assert.deepEqual(resolved.map(p => [p.ticker, p.cik]), [["GOOGL", "0001652044"], ["SNAP", "0001564408"], ["PINS", "0001506293"]]);
  assert.deepEqual(gaps.map(g => g.name), ["TikTok"]);
  const row = peerBenchmarkRow(resolved[1], companyFacts, "2026-09-30");
  assert.equal(row.ttm.revenue, 5000);
  assert.equal(row.ttm.operating_margin, 0.08);
  assert.equal(row.ttm.revenue_growth_yoy, 0.25);
  assert.equal(row.quarters.length, 8, "a fact filed after the cutoff is ignored");
  assert.deepEqual([row.annual[0].capex_to_revenue, row.annual[0].fcf_margin], [0.06, 0.1]);
});

test("the peer benchmark caches its SEC fetches and records failures as gaps", async () => {
  const calls: string[] = [];
  const fake = (async (url: string) => { calls.push(url); return url.includes("company_tickers") ? new Response(JSON.stringify(tickers))
    : url.includes("1564408") ? new Response(JSON.stringify(companyFacts)) : new Response("no", { status: 503 }); }) as any;
  const out = await buildPeerBenchmark([{ name: "Snap" }, { name: "Pinterest", ticker: "PINS" }], "2026-09-30", fake);
  assert.deepEqual([out.status, out.peers.length, out.gaps.length], ["complete", 1, 1]);
  await buildPeerBenchmark([{ name: "Snap" }], "2026-09-30", fake);
  assert.equal(calls.filter(u => u.includes("1564408")).length, 1, "companyfacts is fetched once per worker");
});

test("the demand backdrop maps the home country to series and summarizes them at the cutoff", async () => {
  assert.deepEqual([normalizeCountry("United States"), normalizeCountry("US"), normalizeCountry("China"), normalizeCountry("Uruguay"), normalizeCountry("Atlantis")], ["US", "US", "CN", "UY", null]);
  assert.deepEqual(demandSeriesFor("US").map(s => s.id), ["RSAFS", "PCE", "ECOMSA", "CPIAUCSL"]);
  assert.deepEqual(demandSeriesFor("CN").map(s => s.id), ["CN:NE.CON.PRVT.KD.ZG", "CN:FP.CPI.TOTL.ZG", "CN:NY.GDP.MKTP.KD.ZG", "DEXCHUS"]);
  const fred = parseFredCsv("observation_date,RSAFS\n2025-06-01,700000\n2025-07-01,.\n2026-06-01,735000\n2026-10-01,999999", "2026-09-30");
  assert.equal(fred.length, 2, "holidays and post-cutoff rows are dropped");
  const summary = summarizeSeries(demandSeriesFor("US")[0], fred)!;
  assert.deepEqual([summary.latest.value, summary.yoy_change], [735000, 0.05]);
  const wb = parseWorldBank([{}, [{ date: "2025", value: 1.3 }, { date: "2024", value: null }, { date: "2023", value: 4.1 }]], "2026-09-30");
  assert.deepEqual(wb.map(p => p.value), [4.1, 1.3]);
  const fake = (async (url: string) => url.includes("worldbank") ? new Response(JSON.stringify([{}, [{ date: "2025", value: 1.3 }]]))
    : new Response("nope", { status: 500 })) as any;
  const backdrop = await buildDemandBackdrop("China", "2026-09-30", fake);
  assert.deepEqual([backdrop.country, backdrop.series.length, backdrop.gaps.map(g => g.id)], ["CN", 3, ["DEXCHUS"]]);
  assert.equal((await buildDemandBackdrop(null, "2026-09-30", fake)).status, "no_country");
});

test("issuer IR hosts come from earnings exhibits, and every results release in the window is fetched", () => {
  assert.deepEqual(irHostsFromText("Webcast at investor.atmeta.com. Transcript: investor.atmeta.com; filings at www.sec.gov and ir.example.org."), ["investor.atmeta.com", "ir.example.org"]);
  const releases = Array.from({ length: 24 }, (_, i) => ({ form: "8-K", items: "2.02,9.01", filingDate: `2026-${String((i % 9) + 1).padStart(2, "0")}-15`, accessionNumber: `a${i}` }));
  const selected = selectResearchFilings([{ form: "10-K", filingDate: "2026-02-01", accessionNumber: "k" }, ...releases] as any, "2021-01-01", "2026-12-31");
  assert.equal(selected.filter((f: any) => f.semanticRole === "earnings_release").length, MAX_EARNINGS_RELEASES);
});

test("the doctrine carries the analyst behaviour rules", () => {
  for (const rule of ANALYST_BEHAVIOUR_RULES) assert.ok(RESEARCH_DOCTRINE.includes(rule));
  assert.ok(ANALYST_BEHAVIOUR_RULES.some(r => /below the bear case/.test(r)));
});
