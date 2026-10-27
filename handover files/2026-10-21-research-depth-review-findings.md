# Research depth and architecture review: full findings (2026-10-21)

Companion to [2026-10-21-research-depth-and-architecture-review.md](2026-10-21-research-depth-and-architecture-review.md). Generated from the review workflow output (run wf_49fb128a-df6). Each finding was checked by an independent verifier against main at cfcbdbfa and the dev database. The verifier's notes are kept verbatim under **Verifier check**; where the verdict is `corrected`, the recommendation already includes the correction.

Baseline run: META `4fae0fb1-76b3-4d2b-b386-e48eb9547a75` (2026-10-13, claude-haiku-5-5 for all 79 calls).

## RQ-SRC: Source coverage and what the analysts actually read

The analysis stages are short of source material. The problem is not that too few documents are collected. On the META run (4fae0fb1), the source reader read 102 passages (170 KB, about 2% of a 7.65 MB / ~1.9M-token stored corpus, and 0.9% of the 10-K/10-Q passages). Hard caps then limit the whole initiation to 150 accepted claims. The moat stage received about 46 KB of real source text in a 59k-token call, while the same run sent 481k-token calls to the reviewer. Data the pipeline already captured deterministically also never reaches the stages that write about it: 20 quarters of Reality Labs segment revenue, Class B share counts, buybacks and working capital. The report then says these are "not in the reviewed claims". Governance and peer evidence are missing for structural reasons. selectResearchFilings drops DEF 14A and 13D/13G, no retrieval need asks for ownership text (META's 10-K voting-control passages produced 0 claims), and named peers (Alphabet, Snap, Pinterest) are looked up by web search instead of EDGAR. That search returned an aggregator page for Alphabet and nothing for Pinterest. For a foreign private issuer like JD the filings path does not work: 6-K exhibits are never fetched, any 6-K counts as "results", and statement capture and companyfacts accept only 10-K/10-Q forms in USD. historical_record would then pass silently with almost no quarters, and valuation would get no financial inputs. The relevant code paths have not changed since the META run (PRs #61-#74 touched none of them in a way that matters here).

<details><summary>Measurements</summary>

All measured read-only on the dev DB for META run 4fae0fb1-76b3-4d2b-b386-e48eb9547a75, plus one local tsx probe.

Corpus actually stored (latest research-memory parse per document, document_chunks text/token_count):
- 10-Q: 2,888 passages, 4.36 MB (1.09M tokens)
- 10-K: 1,714 passages, 2.40 MB (0.60M tokens)
- 8-K: 90 passages, 96 KB. Each Ex-99.1 release is 18-22.5 KB; each 8-K cover page is 3.7 KB in 5 passages.
- Web: 565 passages, 0.78 MB
- Total about 7.65 MB, about 1.9M tokens.

What the source reader saw (research_tasks.input_json->packet->source_corpus, 26 batches):
- 102 passages, 169,873 chars, from 22 documents. 43 are 10-K/10-Q passages (72 KB, 0.9% of filing passages); 14 of the 90 8-K passages.
- Batches held 4 chunks each because .env.local:47-48 sets 4 chunks / 16 KB; the code default is 8 / 36 KB.
- 26 calls of 5,232-7,722 input tokens (165,475 total), average latency 27.3 s, $0.098 in total.
- Claims: 150 accepted (cap = target 139 + 10). 47 are operating_kpi. 0 mention META voting control, 3 mention buybacks.

Analysis stage inputs (model_call_logs.input_tokens):
- company_genesis 42,961; business_process 63,563; moat 58,997; operating_model 112,397; asset_valuation 66,682-78,768; decision_synthesis 158,698-164,971; export-writer calls up to 382,579; research-reviewer 476,438 and 481,362. So the provider accepts at least 481k tokens.
- Moat packet in detail: evidence_claims 67,389 B for 106 claims, of which only 15,552 chars are claim text and 12,287 chars are quotes (about 58% is ids, URLs and location strings). filing_passages 22,541 B: 14 passages, 18,225 chars, only from the newest 10-K/10-Q/8-K. team_context 42,258 B.
- valuation financial_inputs is 3.1 KB (8 quarters, 4 years).

Captured but never delivered: financial_statement_set holds 20 quarters each of Reality Labs and Family of Apps revenue and operating income, 18 quarters of CommonClassB shares issued, and 18 quarters each of AR, AP and PaymentsForRepurchaseOfCommonStock. Only the operating-model task packet contains RealityLabsMember (bool_or over research_tasks.input_json). The moat, genesis, process-map, valuation and decision tasks do not.

Source review: 3 rounds. Collector searches for the Alphabet 10-K returned the last10k.com aggregator; Pinterest 10-K, the Q2 transcript, IR slides and the EU DMA decision were unavailable. Proxy was "not searched in any round". All 6 team-request searches (2 proxy, 2 peer, 2 filing) were unavailable; each query was the reviewer's question prose, 300 chars long.

Local probe (/private/tmp/claude-501/-Users-japardinathaniel-Documents-GitHub-Investing-Research-Pipeline/fdaaf424-0588-4f7e-be73-9b055f9db53a/scratchpad/fpi-probe/probe.ts, run with tsx in test mode, no network):
- secQuarterlyObservations on a CNY/20-F companyfacts fixture returns 0.
- selectResearchFilings labels the 8 newest 6-Ks "interim_results_or_update" only because they carry a reportDate, and never selects SC 13G/A.

</details>

### RQ-SRC-1: Analysis stages see about 2% of the stored corpus; fixed caps, not the context window, set the depth

Severity **high**, effort **M**, verdict **corrected**, JD trait: Segment-level economics, computed history statistics, cash-conversion and working-capital diagnosis (JD sections 3-5): all need the analyst to read filings, not a 150-claim digest.

**Problem.** Each model receives a few hundred claims and about 18 KB of MD&A, so it cannot do JD-style work: segment economics, 20-quarter statistics, cash-conversion diagnosis. The report fills with "not in the reviewed claims" (report.md:121 on Reality Labs revenue; :2899 on peer multiples). Several caps bind together: a passage budget of at most 128, source-reader batches of 4 passages (.env.local), a claim target of at most 160 with a per-batch target of 7, about 150 persisted claims, a packet limit of 120 with 280-char quotes, and filing_passages of 24 KB from the newest filings only. Only four task types receive any raw filing text.

**Evidence.** Retrieval and extraction caps:
- needs.ts:120-124 evidencePassageBudget clamps to 32..128 (META: 33 documents, 102 passages actually used).
- evidence-extraction.ts:60 sets RESEARCH_EVIDENCE_TARGET_MAX 160; :263 batchTarget = ceil(139/26)+1 = 7 claims per batch; :360 persistEvidence caps at target+10, giving 150 accepted claims.
- .env.local:47-48 sets 4 chunks / 16,000 B per batch against the code default 8 / 36,000 (source-reader-batching.ts:57-58). That produced 26 calls of 5.2-7.7k tokens each.

What the stages receive:
- corpus.ts:1815 EVIDENCE_QUOTE_CHARS = 280; :1864 packet limit 120.
- filing-passages.ts:7 FILING_PASSAGE_TASKS covers only business_process_analysis, moat_analysis, operating_model and report_section. :9-10 sets 24,000 B with at most 6 per source. latestFilings keeps only the newest copy of each form.
- DB: the moat packet carries 106 claims (15,552 chars claim text + 12,287 chars quotes inside 67,389 B of JSON) plus 14 filing passages (18,225 chars, two of them 'Provision for income taxes' and a 194-char 'Reality Labs' stub).
- The source reader read 169,873 of about 7.65M chars stored.
- The same run sent the reviewer 481,362 input tokens, so the window is not the constraint.

Cost: the 26 source-reader calls cost $0.098, so a 3-4x larger read costs well under $0.50.

**Recommendation.** 1) Fix the split before raising caps (needs.ts:141-145). Give each role a share proportional to sqrt(stored passages for that role), with a floor of 3, and pass unused slots to regulatory_filing and earnings. The function needs passage counts per role, which runDocuments/document_chunks already provide.

2) Then raise the full-initiation caps: RESEARCH_EVIDENCE_PASSAGES_MAX about 300-400, RESEARCH_EVIDENCE_TARGET_MAX about 400. Remove the 4/16 KB batch override from .env.local, or apply it only to the slow DeepSeek default route it was likely set for.

3) Build stage-specific passage packs. Generalize loadFilingPassages into stagePassages(stageKey) using retrievePassages with stage needs: competition, pricing and peers for moat; ownership, voting and buybacks for genesis; debt, leases and share count for valuation. Add company_genesis, asset_valuation and decision_synthesis to FILING_PASSAGE_TASKS, with a budget of about 60-100 KB.

4) Optional: serialize claims compactly with a per-packet source index (about 58% of claim bytes are ids, URLs and locations).

Verify without a paid call: a unit test of evidenceNeeds with META's role passage counts gives regulatory_filing at least 40 role passages and the IR page at most 6, and the shares sum to the budget. Rebuild the moat packet for 4fae0fb1 in a script and check it contains competition/peer passages and stays under about 150k tokens. On the next approved run, at least 300 passages are read and the 'not in the reviewed claims' gaps drop.

**Verifier check.** The caps and measurements hold. needs.ts:120-124 clamps to 32..128. evidence-extraction.ts:60, :263 and :360 give a target of 139, 7 claims per batch and 150 accepted (DB: 150 of 150 non-rejected). .env.local:47-48 sets 4/16000, while the code default is 8/36000. The source reader saw 26 batches, 102 passages and 226,871 chars of corpus JSON. Stored corpus without the companyfacts JSON is about 7.65 MB; 10-K/10-Q are 4,602 passages and only 43 were read (0.93%). The moat packet holds 106 claims, 67,389 B of claims, 15,552 chars of claim text, 12,287 of quotes, and 14 filing passages of 18,225 chars. Those passages are generic MD&A: 'Provision for income taxes', 'Cost of revenue', 'Revenue Seasonality', a 194-char 'Reality Labs' stub, and nothing on competition. Only business_process_analysis, moat_analysis, operating_model and report_section carry filing_passages. The reviewer call is 481,362 tokens. One fact is wrong: asset_valuation calls were 66,682-69,332 tokens; the 78,768 call is a valuation team_answer.

The main correction is to the mechanism. The binding constraint is not only the total cap but how evidenceNeeds splits it (needs.ts:141-145). With 8 roles, each role gets floor((128-32)/8) = 12 passages. Measured split: role:regulatory_filing 12 (17 filings, 4,602 passages), company_investor_relations 12 (one statwonk.com aggregator page of 20 passages), industry 12, peer 12, macro 2, market 1. The 26 unspent slots are not redistributed, which is why only 102 of 128 were used. Raising RESEARCH_EVIDENCE_PASSAGES_MAX to 400 alone gives every role about 37: the aggregator page would be read in full while filings still get a small share. One more cost of the 4-chunk override: the 26 batches emitted 169 source gaps, 79 of them batch-scoped ('not in this batch'). corpus.ts:553 then keeps only the first 48.

### RQ-SRC-2: Foreign private issuers (the JD example) get no quarterly history, no statement capture and no valuation inputs

Severity **high**, effort **L**, verdict **confirmed**, JD trait: The user's own example asset: the twenty-quarter table (section 4), segment economics of Retail/Logistics/New Businesses, net cash in RMB, and the ADS to Cayman holdco to per-ADS bridge (section 2).

**Problem.** JD files a 20-F each year. Its quarterly results arrive only as Exhibit 99.1 press releases attached to 6-Ks, with no inline XBRL, and it reports in RMB. Five separate gaps break this path:
- Any 6-K with a reportDate counts as 'results', so the 8 newest 6-Ks are picked whatever they contain.
- Only the 6-K primary document (a cover page) is fetched; exhibits are fetched for 8-Ks only.
- Statement capture reads only 10-K/10-Q forms, so even the 20-F's inline XBRL statements are never parsed.
- companyfacts parsing accepts only form 10-K/10-Q in USD.
- Valuation has no FX or ADS-ratio handling.
historical_record does not fail: it falls back to at most 60 model-normalized rows from at most 120 claims and builds a 20-quarter record that is nearly empty. That breaks the PRD rule that a missing filing must show as a visible coverage gap and a failed check (research-product-requirements.md:14).

**Evidence.** - corpus.ts:624-635: a 6-K is selected as results when the regex matches OR Boolean(filing.reportDate); 6-Ks carry a period-of-report, so effectively every 6-K qualifies, then .slice(0,8). Probe: 8 generic 'FORM 6-K' rows were all labeled interim_results_or_update.
- corpus.ts:931: exhibits are fetched only when form === '8-K'. META's 8-K covers are 3.7 KB (5 passages) and the releases are in the 18-22 KB exhibits (DB).
- filing-store.ts:15 accepts only form IN ('10-Q','10-K','10-Q/A','10-K/A'). With no sources, no financial_statement_set is saved and coverage is [], so the throw in historical-record.ts:115-116 never fires.
- sec-companyfacts.ts:120,135 accept forms 10-K/10-Q only; :132 reads us-gaap only; :153 reads units.USD only; the currency is hard-coded 'USD'. Probe on a CNY/20-F fixture: 0 observations.
- corpus.ts:791-792 (context revenue and net income) and asset-valuation.ts:316-321 (equity, shares, diluted shares) are also USD- and 10-K/10-Q-only.
- financial-inputs.ts builds from financial_statement_set, which is absent for an FPI, so valuationFinancialInputs returns null.
- No FX or ADS-ratio logic exists anywhere (grep for exchange_rate, ads_ratio and 'per ADS' finds nothing).

**Recommendation.** Do it in two phases. Phase 1 is deterministic and cheap:
(a) corpus.ts:931: fetch exhibits for 6-K as well as 8-K.
(b) selectResearchFilings: drop the reportDate shortcut. Keep 6-Ks whose ex-99 exhibit name or first about 3 KB matches results wording, capped at about 20 in the window.
(c) filing-store.ts:15: add 20-F, 20-F/A, 40-F and 40-F/A.
(d) sec-companyfacts.ts: accept 20-F/40-F forms, and take the unit as the issuer's dominant ISO currency instead of USD, carrying it into currency.
(e) For filingFamily foreign_private_issuer with fewer than 12 covered quarters, write a high-severity source gap and fail completeness, as PRD:14 requires. Respect semiannual reporters (PRD:15).

Phase 2: extract quarterly P&L and segment tables from 6-K release exhibits. Use a deterministic HTML table parse first and one cheap normalizer call only as a fallback. Accept a row only if segments sum to consolidated revenue within 0.5% and four quarters sum to the 20-F year. Add the ADS ratio and a dated FX rate (FRED DEXCHUS) for per-ADS value.

Verify: a fixture test with a saved 20-F and three 6-K exhibits. A mock JD run must produce financial_statement_set, and historical_record revenue coverage must be at least 18 of 20 quarters, or a visible failed coverage check.

**Verifier check.** Code:
- corpus.ts:624-635: a 6-K is 'results' when resultTerms match OR Boolean(filing.reportDate), then .slice(0,8).
- corpus.ts:931: exhibits are fetched only for 8-K.
- filing-store.ts:15: form IN ('10-Q','10-K','10-Q/A','10-K/A').
- sec-companyfacts.ts:120 and :135: 10-K/10-Q only; :132 reads us-gaap; :153 reads units.USD.
- corpus.ts:791-792 reads units.USD.
- asset-valuation.ts:316-321 asks for 'USD'.
- historical-record.ts:115: with no sources, coverage=[] and failures=[], so the throw never fires. Model rows are capped at MAX_NORMALIZED_OBSERVATIONS=60 from a 120-claim packet. fiscalLabel falls back to calendar labels when no filing periods exist. Currency defaults to 'USD' (about line 186).
- grep finds no FX or ADS handling; there is only an 'fx_rate' driver key in archetypes/registry.ts:626.

I re-ran the reviewer's probe offline from the repo root: secQuarterlyObservations returns 0 for a CNY/20-F fixture, and all 8 'FORM 6-K' rows are labeled interim_results_or_update.

Caveat: the probe assumes EDGAR submissions rows give 6-Ks a reportDate. That is plausible (6-Ks carry a period of report), but no FPI filing is stored locally to confirm it (DB has 0 documents with form 20-F or 6-K). The conclusion holds either way: taking the 8 newest 6-Ks can never cover 20 quarters for a frequent 6-K filer. None of the commits since the run touch these paths.

### RQ-SRC-3: Proxy and ownership filings are dropped, and no retrieval need asks for governance text, so 'governance cannot be assessed' even when the 10-K states it

Severity **high**, effort **S**, verdict **confirmed**, JD trait: Management scored separately, with governance 1.5-2/5 from voting vs economic ownership (12.5% / 71.8% per 13G) and buybacks as a share of shares; framework Stage 16 'Incentive structure' (research-framework-v2.1.md:1572-1588).

**Problem.** The submissions list the pipeline already downloads contains DEF 14A and Schedule 13D/13G filings, but selectResearchFilings keeps only 10-K, 10-Q and 8-K 2.02. proxy_and_governance is not among the 8 default discovery roles and is not required. Worse, the evidence needs never query regulatory filings for ownership or voting text. META's FY2025 10-K states that the founder controls a majority of the voting power, three times in stored passages. Only one such passage reached the source reader (a Snap share-class table), and it produced 0 META voting claims. The report blocks the ownership claim and leaves Class B effects unreviewed.

**Evidence.** Code:
- corpus.ts:594-635: no DEF 14A, SC 13D/G or SCHEDULE 13D/G branch.
- corpus.ts:1602-1611: discoveryRoles omits proxy_and_governance.
- roles.ts:57-65: proxy is not in REQUIRED_SOURCE_ROLES_FOR_INITIATION; archetypes/registry.ts:17 marks it required:false.
- needs.ts:23: the regulatory_filing query is 'revenue segment margin ... liquidity risk'. The only filings need touching governance is FOUNDER_FILINGS_NEED (:13-17), which searches founder terms.
- role-coverage.ts:30 maps any source type containing 'filing' to regulatory_filing before the proxy check at :46, so a fetched DEF 14A needs an explicit metadata.source_role.

DB:
- document_chunks for 'Meta Platforms, Inc. 10-K report 2025-12-31' include 'Risks Related to Ownership of Our Class A Common Stock' with 'control of a majority of the voting power ... by our founder'.
- evidence_claims: 1 'voting/class B' match, and it is Snap's.
- source_review round 3: 'No proxy statement (DEF 14A) ... was not searched in any round.'

Report: report.md:27, :92, :2614-2615 ('ownership claim is blocked'), :2902, :3067.

**Recommendation.** As proposed:
1) Add the newest DEF 14A, and up to 3 rows matching /^(SC 13[DG]|SCHEDULE 13[DG])(\/A)?$/, to selectResearchFilings for domestic issuers.
2) Set metadata.source_role = 'proxy_and_governance' for them.
3) Add a governance need over regulatory_filing and proxy_and_governance, maxPassages about 8. Query: voting power, class B, beneficial ownership, controlling shareholder, compensation, repurchase.

Pair it with the team-request role widening (missed item 2). Otherwise late governance requests still retrieve nothing from the stored 10-K.

Verify: buildSourcePacket on 4fae0fb1's corpus selects a 'Risks Related to Ownership' passage. On the next approved run, at least one accepted META voting-control claim exists and the governance chapter no longer says 'cannot be assessed'.

**Verifier check.** Code:
- corpus.ts:594-635 has no DEF 14A or SC 13D/G branch.
- corpus.ts:1602-1611: discoveryRoles omit proxy_and_governance.
- roles.ts:57-65 does not require it; registry.ts:17 marks it required:false.
- needs.ts:23: the regulatory_filing query is the generic financial one. FOUNDER_FILINGS_NEED (:13-17) is the only filing need that touches governance.
- role-coverage.ts:20 honours an explicit source_role first; :30 otherwise maps 'filing' types to regulatory_filing before the proxy check at :46.

DB:
- 'majority of the voting power' appears in chunks of every stored META 10-K (2021-2025) and every 10-Q.
- Exactly 1 source-reader passage contains 'voting power'. The only matching claim is Snap's Class A/B/C net loss. That gives 0 META voting-control claims.
- source_retrieval_attempts: both team proxy_and_governance requests came back 'unavailable'.

Report: lines 27, 92, 2614-2615 and 3067 say there is no voting-control disclosure, although the 10-K states it. The 'SCHEDULE 13D/G' form names (Dec 2024 EDGAR change) are correct.

### RQ-SRC-4: Captured segment, share-class, buyback and working-capital series never reach the stages that write about them

Severity **high**, effort **S**, verdict **corrected**, JD trait: Segment-level economics, who earns vs who burns (JD Retail+Logistics vs New Businesses); computed 20-quarter statistics with current-vs-median positioning; inventory and receivable days; net share count.

**Problem.** financial_statement_set already holds 20 quarters of segment revenue and operating income, Class A and Class B share counts, buybacks, dividends, receivables and payables. Only operating_model receives a slice of this: 6 quarters of consolidated data and 8 quarters per segment. company_genesis, business_process_analysis, moat_analysis, asset_valuation and decision_synthesis rely on claims alone. So the report says Reality Labs revenue 'is not in the reviewed claims, so unit economics cannot be built' and that Class B shares 'are not reviewed', although both series were captured deterministically. This is the cheapest depth gain available: no new sources and no model calls.

**Evidence.** DB: financial_statement_set observations for run 4fae0fb1:
- revenue and us_gaap_OperatingIncomeLoss for meta:RealityLabsMember and meta:FamilyOfAppsMember: 20 quarters each.
- us_gaap_CommonStockSharesIssued for CommonClassBMember: 18.
- us_gaap_PaymentsForRepurchaseOfCommonStock, AccountsReceivableNetCurrent and AccountsPayableTradeCurrent: 17-18 each.

DB, per task (bool_or over research_tasks.input_json ~ 'RealityLabsMember'): true only for forecast-analyst:operating-model and the report and team tasks, which carry it buried in an 844 KB artifacts blob. False for genesis, process-map, moat, valuation and decision.

Code:
- operating-model.ts:73-77 builds recentByMetric(...,6) and an 8-quarter reportedSegmentHistory for that one stage.
- financial-inputs.ts:11-29 COLUMNS lack AR, AP, inventory, buybacks and dividends.

Report: report.md:121, :2902, :2977, :2764 ('Working capital is not modelled because the reinvestment working-capital series is empty').

**Recommendation.** Add one deterministic reportedFactsDigest(financial_statement_set), reusing recentByMetric. It holds:
- the 20-quarter segment revenue, operating income and margin;
- consolidated revenue, operating income, OCF, capex, SBC, buybacks and dividends;
- shares by class;
- AR, AP and inventory with days outstanding;
- for each series: median, min, max and the current percentile.
Target about 8-12 KB of compact rows. Attach it in callResearchAgent for company_genesis, business_process_analysis, moat_analysis, asset_valuation and decision_synthesis. Add AR, AP, inventory and buyback columns to financial-inputs.ts COLUMNS.

Verify: a unit test that the digest built from 4fae0fb1's statement set has 20 Reality Labs quarters and Class B shares. Re-render the packets and check that the moat and genesis packets contain RealityLabsMember and CommonClassBMember.

**Verifier check.** Data confirmed in financial_statement_set (quarterly):
- revenue and OperatingIncomeLoss for RealityLabsMember and FamilyOfAppsMember: 20 periods each.
- CommonClassBMember shares issued and outstanding: 18 each.
- PaymentsForRepurchaseOfCommonStock 18, AccountsReceivableNetCurrent 18, AccountsPayableTradeCurrent 17, PaymentsOfDividends 13.

Code: financial-inputs.ts:11-29 COLUMNS lack AR, AP, inventory, buybacks and dividends. operating-model.ts:73-77 passes 6 consolidated and 8 segment quarters, taken from historical_record rather than the statement set. 'RealityLabsMember' appears only in the operating_model, report, team and ai_review packets.

Overstatement: valuation and decision do not 'rely on claims alone'. Their packets carry the operating_model and operating_scenarios artifacts; 'Reality Labs' appears 49 times in the asset_valuation packet and 25-39 times in decision_synthesis. So segment numbers reach them second-hand, through the operating model's restatement of 8 quarters. The real gaps:
- genesis, process map and moat get no reported series at all;
- no stage gets share-class, buyback, AR/AP or 20-quarter segment history ('Class B' appears 0-1 times in every analysis packet).
Report lines 121, 2764, 2902 and 2977 confirm the visible effect.

### RQ-SRC-5: Named peers are fetched by web search instead of EDGAR, so the moat is never tested against competitor numbers

Severity **high**, effort **M**, verdict **confirmed**, JD trait: Moat attack table with competitor numbers (PDD Q1 revenue and operating profit, Alibaba CMR growth) and residual-moat conclusion (sections 8-9); framework 4.3 peer comparison.

**Problem.** The collector correctly named Alphabet, Snap and Pinterest 10-Ks. The web search returned a last10k.com aggregator page for Alphabet and nothing for Pinterest; only Snap's annual-report PDF arrived. All three are SEC filers the pipeline can resolve with company_tickers.json, which it already downloads every run. Without peer companyfacts there is no peer margin, growth or capex comparison, so the report omits peer multiples and calls the moat 'untested'. Framework 4.3 requires a peer or industry comparison for each material metric.

**Evidence.** - DB source_review rounds 1-2: 'Alphabet Inc. Form 10-K for fiscal year 2025' returned https://last10k.com/sec-filings/googl; Pinterest 10-K was unavailable. Round-3 accepted_gaps say 'Alphabet is covered only through the last10k.com aggregator rather than a primary Alphabet filing.'
- source_retrieval_attempts: two later team:business peer searches were both unavailable.
- Code: corpus.ts:1470-1491 resolveSecCik already maps ticker to CIK from company_tickers.json; role-discovery.ts:43-58 and :193-245 handle peers only through generic web queries; corpus.ts:1006 and :1269 contain MELI-specific branches but no peer logic.
- Report: report.md:52, :168, :2651, :2899 ('Peer multiples ... omitted because peer primary financials are missing'), :2980.
- Framework: research-framework-v2.1.md:552 and :821.

**Recommendation.** As proposed:
- Before web search, resolve the organisation named in a peer_company_primary query against company_tickers.json titles (normalized exact match only).
- Fetch that CIK's companyfacts and build a compact peer table with secQuarterlyObservations: 8-20 quarters of revenue, operating income, OCF and capex, with growth and margins.
- Store the peer's latest 10-K with source_role peer_company_primary.
- Feed a peer_comparison block of about 3 KB per peer to moat, valuation and decision.

Extend the same EDGAR-first route to named filings of the subject issuer (S-1, older 10-K) for founder history. Today loadSubmissionFilings pages back only 5 years, so this needs one older submissions page.

Verify: the resolver maps the 4fae0fb1 queries to CIKs 1652044, 1564408 and 1506293 with sec.gov URLs. On the next approved run, the moat output cites peer margins.

**Verifier check.** DB source_retrieval_attempts:
- The Alphabet 10-K query fetched https://last10k.com/sec-filings/googl.
- Snap's 10-K came from the s25.q4cdn.com annual report.
- Pinterest: unavailable.
- Both team:business peer_company_primary requests: unavailable.
The round-3 accepted_gaps confirm Alphabet is covered only through the aggregator.

Code: resolveSecCik (corpus.ts:1470-1491) loads company_tickers.json but matches by ticker only, for the subject asset. No peer EDGAR route exists; peers go through generic web discovery.

The report omits peer multiples (2899) and cannot test the moat (52, 168, 2651, 2980). The CIKs cited (1652044, 1564408, 1506293) are correct.

The same pattern hits the issuer's own older EDGAR filings: the collector's 'Facebook, Inc. Form S-1 (2012)' and 'FY2012 10-K' founder searches were both unavailable, so genesis rests on a Harvard Magazine article.

### RQ-SRC-6: 10-Q selection stops at 12 filings, leaving exactly the three oldest quarters of the 20-quarter window unconfirmed

Severity **medium**, effort **S**, verdict **confirmed**, JD trait: Twenty-quarter table (JD section 4) with confirmed coverage.

**Problem.** A 20-quarter window ending in a Q2 needs 15 10-Qs; the Q4s come from 10-Ks. selectResearchFilings keeps the newest 12. In the META run the three uncovered quarters, 2021Q3, 2022Q1 and 2022Q2, are exactly the ones the report calls 'not confirmed against primary statement tables', and the confidence and gaps sections repeat this.

**Evidence.** - corpus.ts:612-615: .filter(form === '10-Q').slice(0, 12).
- DB research_run_sources: the oldest fetched 10-Q is for 2022-09-30. The 2021-09-30, 2022-03-31 and 2022-06-30 10-Qs are absent, while 10-Ks cover FY2021-FY2025.
- historical_record ends 2026Q2 (20 quarters back is 2021Q3).
- Report: report.md:51, :2510, :3059 ('Of the 100 required quarters, 98 are present. The 2021 Q3, 2022 Q1 and 2022 Q2 periods are not confirmed'), :3101.

**Recommendation.** Replace .slice(0, 12) with a window-derived count: every 10-Q whose reportDate falls inside the 20-quarter window plus one comparison year (about 16). storedSecFiling reuse means repeat runs add no downloads. Verify with a unit test in tests/sec-filing-history.test.ts or tests/research-v2-contracts.test.ts: 20 quarterly rows must yield 15-16 10-Qs. Re-capture on 4fae0fb1's corpus with the 3 extra 10-Qs and expect 100 of 100 quarters confirmed.

**Verifier check.** corpus.ts:612-615 keeps .slice(0, 12) 10-Qs. Coverage in financial_statement_set lists 17 sources: 10-K FY2021-FY2025 and 10-Qs from 2022-09-30 on. The history ends 2026Q2, so the window starts at 2021Q3. Five Q4s come from 10-Ks, which leaves 15 quarters that need 10-Qs; with 12 kept, the missing three are exactly 2021Q3, 2022Q1 and 2022Q2. All three were filed after the 5-year earliestDate (2021-10-13), so they are eligible. The report repeats the caveat at 51, 2510, 3059 and 3101. The values exist from companyfacts (98 of 100), so the effect is unconfirmed provenance plus missing statement-only fields (capital allocation for 2021Q3), not missing headline numbers. Medium severity is fair.

### RQ-SRC-7: Only the last 4 earnings releases are fetched, and the KPI need gives them 4 passages, so there is no 20-quarter KPI series

Severity **medium**, effort **M**, verdict **corrected**, JD trait: Monitoring dashboard numbers and 20-quarter KPI and segment-margin history; latest-results check (sections 4, 19, 20).

**Problem.** Earnings releases are the densest KPI and segment documents: about 20 KB, roughly 5k tokens, each. The pipeline fetches 4 (8-K item 2.02 slice(0,4)), and the headline_kpis need then draws 28 of its 32 passages from 10-K/10-Q and only 4 from releases. The source reader logged 48 gaps saying DAP, MAP, ARPP, impressions and price-per-ad history are missing or garbled. Reading 20 releases in full would cost about 100k tokens.

**Evidence.** - corpus.ts:616-619: 8-K item 2.02 .slice(0, 4).
- needs.ts:136-138: the KPI need is max(6, budget/4) passages shared across all KPI roles.
- DB packet composition: headline_kpis gave 28 regulatory_filing and 4 earnings_release passages; Ex-99.1 sizes were 22,510 / 21,037 / 18,110 / 19,517 chars.
- source_gaps (owner system:source-reader, 48 rows) include: 'No quarterly history for DAU, MAU, MAP, ARPU, ARPP, ad impressions, or average price per ad. The 20-quarter KPI series is not covered'; 'quarterly ARPU and ARPP values in the 10-K trend charts are garbled'.
- Report: report.md:2659 ('Q2 2026 earnings slides and call transcripts were not available').

**Recommendation.** 1) In the headline_kpis need, demote risk-factor and 'Limitations of key metrics' sections (reuse the sectionScore risk penalty) and prefer passages with many digits.

2) Deterministic chart-row mapping: in a 10-Q or 10-K 'Trends in…' section, a row of N values maps to the N quarters ending at the document's period_end. Store these rows as KPI observations, labelled as derived placement.

3) Fetch every 8-K item 2.02 release in the 20-quarter window (cap 21). They are stored once and reused across runs.

4) Only if gaps remain after 1-3: a per-release KPI extraction pass, with values accepted only when the period matches the release's own column header.

Verify offline: re-rank the 4fae0fb1 KPI need and check that no risk-section passages remain among the 32. Chart-row mapping on the stored 10-Q gives 9 dated ARPP quarters. On the next run, historical_record holds at least 16 quarters of DAP/ARPP.

**Verifier check.** corpus.ts:616-619 keeps only 4 8-K item 2.02 releases. The headline_kpis need is max(6, budget/4) = 32 passages: 28 regulatory_filing and 4 earnings_release (DB). 48 source-reader gaps cite missing KPI history.

The framing needs correcting: the KPI series is mostly already in the stored 10-Qs. The 2026-06-30 10-Q passage contains 'ARPP: | $11.89 | $12.29 | ... | $16.86', nine quarters. It is called 'garbled' because the chart's quarter labels are not in the chunk text.

The KPI need also wastes slots. Of the 32 passages, at least 5 come from 'Risks Related to...' or 'LIMITATIONS OF KEY METRICS' sections, and 9 contain 11 or fewer digits (methodology prose). sectionScore (filing-passages.ts) already penalizes these sections, but the evidence needs do not use it. Release passages are also small fragments: the 'Financial Highlights' passages are about 540 chars, cut off mid-table. Fetching 20 releases helps, but the cheaper levers are retrieval ranking and table handling.

### RQ-SRC-8: Team-request searches send the reviewer's question prose as the web query; all 6 attempts in the META run found nothing

Severity **medium**, effort **S**, verdict **confirmed**, JD trait: Closing the governance and competitor gaps that the JD example fills (sections 9-10).

**Problem.** Late-stage requests for exactly the missing evidence (proxy statement, peer filings, full statements) go through searchForRequest. It builds the query as "Name" SYMBOL plus the full question text, e.g. '... Management, governance and ownership are not sourced. Obtain the latest proxy statement and officer disclosures ...'. A search engine cannot find a document from that. Since PR #69 constrainSearch cuts it to 200 chars, but it is still prose. The pipeline's own mechanism for closing gaps therefore cannot close them.

**Evidence.** - team.ts:355: query = `"${ctx.assetName}" ${ctx.symbol} ${request.question}`.slice(0,300). git blame dates the line to 2026-10-11, unchanged since the run.
- DB source_retrieval_attempts for run 4fae0fb1, requested_by team:*: 6 rows (regulatory_filing x2, peer_company_primary x2, proxy_and_governance x2), all 'unavailable / no_substantive_source_fetched', each query 300 chars of question text.
- By contrast, the collector's named-document queries (e.g. 'Snap Inc. Form 10-K for fiscal year 2025') did fetch documents.

**Recommendation.** 1) Route by role before web search:
- proxy_and_governance and regulatory_filing for the subject issuer: pick from the EDGAR submissions rows already loaded (RQ-SRC-3, RQ-SRC-6).
- peer_company_primary: the EDGAR peer resolver (RQ-SRC-5).
2) For the other roles, add a short 'document' field (organisation + document type + period) to the team-request contract and search that instead of the question.

Verify: a unit test replays the 6 logged questions through the routing function and gets sec.gov URLs for the proxy and peer requests. On the next run, the team:* unavailable rate is below 50%.

**Verifier check.** team.ts:355 builds the query as `"${assetName}" ${symbol} ${request.question}`. On current main it passes through constrainSearch (collector.ts:19), and MAX_QUERY_CHARS = 200 (source-requests.ts:36). The query is still question prose. DB: 6 team:* attempts (regulatory_filing x2, peer_company_primary x2, proxy_and_governance x2) are all 'unavailable / no_substantive_source_fetched', each with a 300-char query (the run predates #69). Named-document collector queries, such as 'Snap Inc. Form 10-K for fiscal year 2025', did fetch. A second cause compounds this: requestPassages restricts retrieval to request.source_role, so the proxy requests got 0 stored passages (see missed item 2).

### RQ-SRC-9: Macro and industry demand data is one US 10-year yield series for every asset, plus two hard-coded special cases

Severity **medium**, effort **S**, verdict **confirmed**, JD trait: End-demand constraint from national statistics (China retail sales +1.3%, online goods +4.8%, appliances -7.4%) feeding a no-consumption-boom forecast (section 6).

**Problem.** Every run gets FRED DGS10 as its only macro dataset. Industry context exists only for financials (the FDIC page) and for MELI (a World Bank internet-adoption call keyed on the ticker). No end-demand series, such as retail sales, consumption, ad spend or CPI, is collected for the asset's home country or sector. The forecast therefore cannot check growth against demand, and the report notes 'broader macro drivers of ad demand are not sourced'.

**Evidence.** - corpus.ts:863-894: macroSourcePayload fetches only fredgraph.csv?id=DGS10.
- corpus.ts:1005-1088: industrySourcePayload covers profileKey 'financials' (FDIC) and isMeli (:1006), and returns null otherwise.
- DB research_run_sources for META: the macro_context document is DGS10 only.
- source_review round 3: 'Only the 10-year Treasury yield series is in the corpus. Broader macro drivers of ad demand are not sourced'.
- assets.home_country and sector are populated, e.g. META 'United States' / 'Communication Services'.

**Recommendation.** As proposed. Use a small static map from normalized home_country (and sector) to keyless series, fetched with fetchCapped:
- US: FRED RSAFS, PCE, CPIAUCSL, ECOMSA.
- Other countries: World Bank NE.CON.PRVT.KD.ZG, FP.CPI.TOTL.ZG and NY.GDP.MKTP.KD.ZG.
- China: also DEXCHUS.
Normalize country names first ('US' to 'United States'). Pass a demand_backdrop block of about 1 KB to operating_model and operating_scenarios.

Verify: unit tests that JD maps to CN series and META and Apple map to US series. On the next run, operating_scenarios cites the demand series.

**Verifier check.** corpus.ts:863-894: macroSourcePayload fetches only fredgraph DGS10. corpus.ts:1005-1088: industrySourcePayload covers profileKey 'financials' (FDIC) and isMeli (World Bank internet adoption), and returns null otherwise (:1046). The source_review round-3 accepted gap says only the 10-year yield is sourced. assets.home_country and sector are populated, but inconsistently ('United States' for META, 'US' for Apple, 'Uruguay' for MELI).

### RQ-SRC-10: No issuer IR seed, so the IR role is filled by a third-party aggregator and transcripts and slides are never found

Severity **low**, effort **S**, verdict **confirmed**, JD trait: Latest-results check and management commentary behind thesis breakers (sections 18, 20).

**Problem.** EDGAR submissions carry website and investorWebsite as null for META, so discovery has no issuer site to link-scan. company_investor_relations was satisfied by statwonk.com, an aggregator page. Earnings presentations and call transcripts are not in the default discovery roles, and the collector's named searches for them failed. Yet the stored earnings release names investor.atmeta.com 5 times and says the webcast and transcript will be posted there.

**Evidence.** - DB primary_source_context JSON for run 4fae0fb1: website=None, investorWebsite=None.
- corpus.ts:1625-1629: seedUrls come only from those fields and RESEARCH_SOURCE_SEED_URLS.
- research_run_sources: web_company_investor_relations is https://statwonk.com/earnings/META/.
- grep of the stored Ex-99.1 (meta-06302026xexhibit991.htm): 'investor.atmeta.com' appears 5 times, alongside 'Webcast' and 'Transcript'.
- corpus.ts:1602-1611: discoveryRoles omit earnings_presentation and earnings_transcript.
- source_review round 2: the IR slides and Q2 transcript searches were unavailable.

**Recommendation.** As proposed: take investor/ir.* hosts from the newest stored earnings exhibit and add them to seedUrls ahead of web search. Add earnings_presentation and earnings_transcript to discoveryRoles, limited to issuer-host candidates, and prefer issuer hosts over aggregators for company_investor_relations. Verify: a unit test shows the stored META exhibit yields investor.atmeta.com as a seed. On the next run, the IR source host is investor.atmeta.com or a q4cdn PDF.

**Verifier check.** The stored primary_source_context JSON has website=None and investorWebsite=None. seedUrls come only from those fields and env (corpus.ts:1625-1629). company_investor_relations was filled by https://statwonk.com/earnings/META/. Each of the 4 stored Ex-99.1 files mentions 'investor.atmeta.com' 5 times, alongside 'webcast'. The collector's own IR-slides query named investor.atmeta.com, but the search was unavailable. That aggregator page also took 12 of the source reader's 102 passages (21.8 KB), the same slot count as all 17 SEC filings' role need.

## RQ-MOD: Model choice, prompting and output shape

In the META run all 79 calls used claude-haiku-5-5, and no request set effort or thinking. Haiku therefore ran its default adaptive thinking at medium effort. About 61% of output tokens were hidden reasoning that is neither logged (reasoning_tokens = 0 on every call) nor kept. The model is not the main cap on depth, though. The output shape is. Closed structured-output schemas and code-owned valuation leave room for 3 numbers per segment, a single undated capex figure and one discount rate per scenario, even where the prompts ask for price x volume, margin bridges and return on incremental capital. The valuation analyst correctly objected (terminal-year capex 4x D&A, negative explicit FCF), but its objections go only into display-only source_notes. The prompts mostly enforce format and integrity. No stage forms a central debate or "what would change my mind", and the Haiku reviewer (about 5% reasoning on a 476K-token review) raised 0 of 58 findings challenging the valuation framing. Tiering can't be configured per task today: RESEARCH_ALL_AGENTS_MODEL overrides the per-agent variables, and one agent serves both 410-token team answers and decision synthesis. The pricing table would also record Opus and Sonnet at $0.50/$1.00 per MTok. The recommended tiering is Opus 5.5 at high effort for the 6 analytic stages, Sonnet 5.5 for the outline and the reviewer, and Haiku for the rest. It costs about $13-18 per META-sized run, against $3.74 real ($1.05 logged) today. Input tokens are about two-thirds of that, so context trimming should ship with it.

<details><summary>Measurements</summary>

All figures are from run 4fae0fb1 via read-only SELECTs. Per-call rows were exported to /private/tmp/claude-501/-Users-japardinathaniel-Documents-GitHub-Investing-Research-Pipeline/fdaaf424-0588-4f7e-be73-9b055f9db53a/scratchpad/meta-calls.csv and priced with /private/tmp/claude-501/-Users-japardinathaniel-Documents-GitHub-Investing-Research-Pipeline/fdaaf424-0588-4f7e-be73-9b055f9db53a/scratchpad/cost_model.py and cost_variants.py.
- Calls: 79, all claude-haiku-5-5. 7,708,006 input tokens, 691,826 output tokens, $1.045 logged.
- By agent (logged $): export-writer 23 calls/$0.432, asset-analyst 14/$0.274, research-reviewer 2/$0.127, source-reader 26/$0.098, metric-normalizer 5/$0.058, valuation-analyst 6/$0.051, source-discovery 3/$0.005.
- Long prompts: 24 of 79 calls had over 100K input tokens, totalling 5.74M (74%) of the input tokens.
- Request settings: max_output_tokens was 32,768 on every call except decision_synthesis attempt 2 (65,536). No request carried effort or thinking.
- Hidden reasoning (estimate: answer tokens = stored output_json chars / 3.2, compared with logged output_tokens): about 61% overall. operating_scenarios 75%, operating_model 67%, decision_synthesis 65%, report_section 64%, ai_review 5%.
- Haiku throughput on heavy calls: 195-252 output tokens/s (latency_ms).
- Artifact sizes: operating_model 424 B, reinvestment_model 105 B, confidence_assessment 154 B, top_down_bottom_up_reconciliation 226 B, expected_return_matrix 307 B (no_rerating_return null).
- Reviewer: 58 findings over 2 rounds (writing 19, evidence 20, calculation 10, research_gap 9). None challenges the horizon, normalization or terminal-value share.

Price assumptions per MTok (input/output/cache read/5-minute cache write): Opus 5.5 $4/$20/$0.20/$5; Sonnet 5.5 $2/$10/$0.20/$2.50; Haiku 5.5 $0.10/$0.50/$0.01/$0.125 up to 100K prompt tokens and $0.50/$2.50/$0.05/$0.625 above. These come from the claude-api skill's cached table (2026-10-06). It is an assumption that the Haiku long-prompt rate applies to the whole request and that Opus and Sonnet 5.5 have no long-context premium. Cache hits are assumed unchanged, although caches are per model.

Per-run cost at META token counts:
- (A) all Haiku, repriced: $3.74.
- (B) Opus for the 6 analytic stages (9 calls), Sonnet for outline and reviewer, Haiku for the rest: $13.43 with the same output tokens, $17.61 if upgraded calls double their output at higher effort. The ledger would log only $2.22 for B.
- (C) Sonnet for the 6 analytic stages plus outline and reviewer: $9.58 to $11.78.
- (D) as B, plus Opus for outline and reviewer and Sonnet for report sections and genesis: $22.80 to $29.50.
- All-Opus: $41.42. All-Sonnet: $20.91.
- Input share of cost: 66% in B, 70% in D.
- The truncated decision_synthesis attempt would cost $1.45 on Opus.

</details>

### RQ-MOD-1: Model tiering can't be configured per task: RESEARCH_ALL_AGENTS_MODEL overrides per-agent models, and one agent mixes trivial and decisive calls

Severity **high**, effort **S**, verdict **corrected**, JD trait: Prerequisite for every trait: the central reframing insight, segment economics and the valuation matrix need a frontier model on the synthesis stages.

**Problem.** The documented Anthropic setup routes every agent to claude-haiku-5-5. Changing that per agent doesn't help much, for 3 reasons:
- resolveAgentModel lets RESEARCH_ALL_AGENTS_MODEL win over RESEARCH_<AGENT>_MODEL.
- Model choice is by agent, not by task. asset-analyst serves company_genesis, business_process, moat, operating_model, operating_scenarios, decision_synthesis, report_outline, team_brief and team_answer. export-writer serves report sections and 380K-token team_requests calls that produce 2K-token answers.
- The modelTier that handlers pass ("mid" even for decision_synthesis) only feeds the budget check and escalationReason, not model choice.
So putting a frontier model on the six stages that decide depth would also put it on about 20 coordination calls.

**Evidence.** - src/lib/agent-harness/registry.ts:758-762: `modelOverride || process.env.RESEARCH_ALL_AGENTS_MODEL || process.env[agentModelKey] || process.env[config.modelEnvVar] || config.defaultModel`.
- runner.ts:113-120: modelCandidates re-resolves by agent name, ignores any per-call model and drops the fallback when ALL is set.
- run-context.ts:447 resolves the model by agent only. run-context.ts:479-481 shows modelTier is used only for escalationReason. decision-synthesis.ts:235 passes `modelTier: "mid"`.
- AgentRequest (types.ts:135-155) has no model field.
- docs/local-agent-harness.md:23 and the user's live-run memory note both require RESEARCH_ALL_AGENTS_MODEL=claude-haiku-5-5.
- DB: `SELECT agent_name, model_name, count(*) ... GROUP BY 1,2` gives claude-haiku-5-5 for all 79 calls.
- Per-task spread for asset-analyst: team_answer 4 calls of 347-2,067 output tokens; decision_synthesis 3 calls of 30-39K output tokens on 158-165K input tokens.

**Recommendation.** Reuse the existing per-call tier field rather than adding a parallel map.
- In callResearchAgent (run-context.ts:447), resolve `model = process.env[`RESEARCH_${modelTier.toUpperCase()}_MODEL`] || undefined` and call `resolveAgentModel(agent, model)`. The tier variable then wins over RESEARCH_ALL_AGENTS_MODEL, while ALL remains the default for untiered calls.
- Add an optional `model` to AgentRequest and use `input.model ?? resolveAgentModel(agentName)` in modelCandidates (runner.ts:114).
- Retag call sites:
  - premium: business_process_analysis, moat_analysis, operating_model, operating_scenarios, asset_valuation, decision_synthesis.
  - mid: report_outline, ai_review, company_genesis.
  - cheap: team_brief, team_answer, team_requests and the extraction calls.
- The model is already in the request hash (run-context.ts:447), so cached outputs from another model are not reused.
- Land RQ-MOD-6 before raising the $6 default budget.

Verify:
- A unit test of the precedence.
- After a run, `SELECT t.task_type, m.model_name, m.model_tier, count(*) FROM model_call_logs m JOIN research_tasks t ON t.id=m.task_id WHERE m.research_run_id=$1 GROUP BY 1,2,3` matches the tags.

**Verifier check.** The facts hold on main (cfcbdbfa).
- registry.ts:758-762: the precedence is modelOverride, then RESEARCH_ALL_AGENTS_MODEL, then RESEARCH_<AGENT>_MODEL. No caller passes modelOverride: grep finds only run-context.ts:447 and runner.ts:114, both calling resolveAgentModel(agent).
- runner.ts:113-120 re-resolves the model by agent and drops the fallback when ALL is set.
- run-context.ts:479-481: modelTier only feeds escalationReason and the budget/ledger rows.
- decision-synthesis.ts:235 passes "mid". AgentRequest (types.ts:136-157) has no model field.
- docs/local-agent-harness.md sets RESEARCH_ALL_AGENTS_MODEL=claude-haiku-5-5.
- DB: all 79 calls ran on claude-haiku-5-5. asset-analyst served 9 task types, from team_answer (347-2,067 output tokens) to decision_synthesis (30-39K output on 158-165K input).

Correction, to the recommendation only: a new TASK_TIERS map with a 4-level env precedence duplicates something that already exists. Every call site already passes a per-call modelTier ('cheap'|'mid'|'premium'|...), and model_call_logs.model_tier already records it. resolveAgentModel already has an unused override parameter.

### RQ-MOD-2: No effort or thinking control: Haiku thinks at its default medium effort, the reasoning is unmeasured, and output and timeout limits don't fit a frontier tier

Severity **high**, effort **S**, verdict **corrected**, JD trait: Every trait. With adaptive thinking always on for Claude 5.5 models, effort is the only depth control (central insight, what would change my mind, impairment below bear).

**Problem.** The Anthropic request sends no output_config.effort and no thinking setting.
- Claude 5.5 models run adaptive thinking by default, at medium effort on Haiku 5.5 and Opus 5.5, so depth is whatever that default gives. The reviewer, reading a 476K-token report, spent almost nothing on reasoning.
- reasoning_tokens is never filled for Anthropic, so the roughly 60% of output spent on hidden thinking isn't visible in telemetry or cost analysis.
- The 32,768-token default output limit already truncated decision_synthesis on Haiku and threw that attempt away. On Opus the same waste costs about $1.45.
- Timeouts are 240 s (600 s for asset-analyst). Haiku runs at about 200 tokens/s, so a 39K-token synthesis on a slower frontier model would time out.

**Evidence.** - providers/anthropic-compatible.ts:98-108: the body is model, system, messages, max_tokens, optional output_config.format and stream. There is no effort or thinking, and grep finds no effort or thinking settings anywhere in src or .env.example.
- anthropic-compatible.ts:195 maps only visible thinking_delta. With the default display 'omitted' that is empty, so reasoningTokens stays 0. The DB shows reasoning_tokens = 0 on all 79 calls.
- Hidden-share estimate (stored output_json chars / 3.2 vs output_tokens): operating_scenarios 75%, operating_model 67% (7,704 output tokens for about 2.5K answer tokens), decision_synthesis 65%, ai_review 5%, overall 61%.
- runner.ts:18 sets DEFAULT_OUTPUT_TOKENS = 32,768. runner.ts:59-61 sets timeouts (240 s default, 600 s for asset-analyst and source-reader).
- DB: decision_synthesis attempt 1 failed at output_tokens = 32,768 with max_output_tokens 32,768. Attempt 2 at 65,536 produced 39,292 tokens.
- Haiku latency: 195-252 tokens/s on the heavy calls (operating_scenarios 48,103 tokens in 190.6 s).

**Recommendation.** - Add `effort` to ModelRequest and ExecutionPolicy. For Claude models, serialize it as `output_config: { ...(format ? { format } : {}), ...(effort ? { effort } : {}) }`.
- Derive effort from the RQ-MOD-1 tier, overridable by RESEARCH_<AGENT>_EFFORT: premium high, mid medium, cheap low. Opus 5.5 also defaults to medium, so set it explicitly.
- In callResearchAgent, pass a per-task policy:
  - initial maxOutputTokens of 65,536 for decision_synthesis and operating_scenarios, so the escalation retry is not needed;
  - a premium-tier timeout of about 1,200,000 ms. Size it from the first measured Opus latency rather than an assumed throughput.
- Record thinking spend as a separately named estimate (`estimated_thinking_tokens = output_tokens - answer chars/3.2`). Don't store it in reasoning_tokens as if it were measured.
- Optional: send `thinking: {type:'adaptive', display:'summarized'}` on premium stages, and capture reasoning.delta into response metadata for audit.
- Map stop_reason 'refusal' to its own non-retryable category instead of a JSON-parse failure plus a repair.
- Remove the dead RESEARCH_ATTEMPT_TIMEOUT_MS from the env template.

Verify:
- request.sent bodies contain output_config.effort.
- No decision_synthesis attempt fails with output_exhausted.
- On a META A/B, the ai_review hidden share rises and framing findings appear (RQ-MOD-5).

**Verifier check.** Confirmed:
- anthropic-compatible.ts:98-108 serializes only model, system, messages, max_tokens, an optional output_config.format and stream. grep finds no effort or thinking setting in src, .env.example or docs.
- The claude-api skill's model table (2026-10-06) says Haiku 5.5 and Opus 5.5 both default to effort medium, with adaptive thinking on and display 'omitted'. Sonnet 5.5 defaults to high.
- anthropic-compatible.ts:195 maps only thinking_delta. runner.ts:330 takes reasoningTokens only from provider usage. The runner never consumes reasoning.delta (runner.ts:317 handles only text.delta).
- DB: decision_synthesis attempt 1 failed with output_exhausted at 32,768 tokens after 161.6 s; attempt 2 produced 39,292 tokens in 183 s.
- Recomputed hidden share (output_json::text chars / 3.2): operating_model 67%, operating_scenarios 75%, decision_synthesis 65% (excluding the failed attempt), ai_review 5%. This is a rough estimate, and jsonb text spacing inflates the character count.

Corrections:
- reasoning_tokens is a key inside model_call_logs.response_metadata_json, not a column. It is 0 on all 79 rows.
- The runner already escalates the output limit after output_exhausted (runner.ts:66, 689). The waste is one discarded attempt per run, not a structural failure.
- Effective timeouts come from the user's .env.local: RESEARCH_AGENT_TIMEOUT_MS=720000 and RESEARCH_ASSET_ANALYST_TIMEOUT_MS=600000, not the 240 s code default. RESEARCH_ATTEMPT_TIMEOUT_MS=360000 is read nowhere.
- display 'summarized' would be dropped unless the runner starts capturing reasoning.delta.

### RQ-MOD-3: Closed structured-output schemas cap analytic artifacts below what the prompts ask for

Severity **high**, effort **M**, verdict **corrected**, JD trait: Segment-level economics (who earns vs who burns), cash-conversion and reinvestment diagnosis, current-vs-history positioning, confidence gates naming the largest missing evidence.

**Problem.** The operating-model prompt asks for:
- price x volume per segment;
- a margin bridge from the base year;
- return on incremental capital against history;
- units and horizon "in optional explanatory fields".
The schema has no such fields. On anthropic-direct every object is sent closed (additionalProperties: false), so the model physically can't emit them. 7.7K output tokens became a 424-byte operating_model (3 numbers per segment) and a 105-byte reinvestment_model: one undated capex number and an empty working-capital array.

The same holds elsewhere:
- SegmentDetails is 12 free-text strings with no numeric segment revenue, margin, price, volume or unit economics, although the business-process prompt asks for them.
- ConfidenceAssessment is 7 bare numbers. The framework requires 11 areas, each high/moderate/low with reasons.
- The operating-model packet drops historical_diagnosis current_level, median, min and max, so current-vs-history positioning isn't possible.

**Evidence.** - handlers/operating-model.ts:121-123 (price x volume, margin bridge, ROIIC), :128 ("optional explanatory fields"), :131 (reinvestment). :105-107 passes only metric_key, trend, observation_count and confidence from the diagnoses.
- forecast/contracts.ts:70-101: SegmentForecast {segment_name, forecast_revenue, forecast_operating_income}; ReinvestmentModel {capex_forecast: number[], working_capital_forecast: number[]}.
- providers/anthropic-schema.ts:82 sets additionalProperties = false on every object.
- DB: provider_requests[].structuredOutput.sent = true, fallback = false for operating_model.
- Artifacts: operating_model `{segments:[{Family of Apps, 250.2bn, 104.8bn},{Reality Labs, 2.4bn, -19.1bn}], ...}` (424 B); reinvestment_model `{capex_forecast:[137500000000], working_capital_forecast:[]}`.
- business/contracts.ts:21-36 (SegmentDetails, all strings) vs handlers/business-process-analysis.ts:51-53.
- decision/contracts.ts:125-134 vs docs/research-framework-v2.1.md:2105-2119 (11 areas). The stored confidence_assessment is `{data:0.55, moat:0.25, history:0.3, ...}`.
- Downstream, report.md:2679 calls this the "main structural weakness": margin and depreciation are not computed from the same capital base.

**Recommendation.** Give the fields the prompts ask for typed homes, and keep them small and required, not nullable.
- ReinvestmentModel becomes per-year rows {fiscal_year, capex, maintenance_capex, growth_capex, depreciation, nwc_change, incremental_invested_capital, incremental_operating_income, roiic, basis} plus `gaps: string[]`.
- SegmentForecast gains {price_driver_key, price_change, volume_driver_key, volume_change, operating_margin}.
- Code fills SegmentDetails.reported_economics from historical_record segment rows.
- ConfidenceAssessment becomes the 11 framework areas {level, score, reason, largest_missing_evidence}.
- Add a required `gaps` array wherever a prompt says source_gaps, or delete those prompt lines.
- Pass the diagnoses' current_level, historical_median, min and max into the operating-model packet.
- Mind the Anthropic limits (anthropic-schema.ts:63-73). Several contracts are already rejected by the API, so check each changed contract against a real request, or accept plain-text mode for it.

Verify on a META mock and a paid rerun:
- reinvestment_model holds per-year rows.
- The reinvestment and segment report tables are not empty.
- A validator rejects a reinvestment_model that has neither a roiic row nor a gap.

**Verifier check.** The core claim holds.
- operating-model.ts:122-123 asks for price x volume, a margin bridge and ROIIC. :128 says "optional explanatory fields" and :131 says "use source_gaps".
- forecast/contracts.ts:83-101: OperatingModel is 3 numbers per segment. ReinvestmentModel is two bare number arrays.
- business/contracts.ts:21-36: SegmentDetails is all strings.
- decision/contracts.ts:125-134: 7 bare 0-1 scores, against the 11 high/moderate/low areas at framework v2.1:2105-2119.
- operating-model.ts:105-107 drops current_level and the median/min/max, which do exist on every diagnosis (verified in historical_diagnosis).
- anthropic-schema.ts:80-81 closes every object.
- DB: operating_model 424 B, reinvestment_model `{capex_forecast:[137500000000], working_capital_forecast:[]}`, confidence_assessment 154 B.

Corrections:
- The same operating_model call also returned a 7,232 B driver_tree whose formula_decomposition carries price x volume as text ("FoA advertising revenue = ad impressions delivered x average price per ad"). The gap is typed and numeric fields, not the analysis itself.
- The closed wire schema is the mechanism only where the API accepted the schema. provider_requests show structuredOutput sent=true, fallback=false for operating_model, moat and asset_valuation. They show sent=true, fallback=true (API 400, then resent without the schema) for business_process_analysis, company_genesis and decision_synthesis. So SegmentDetails and ConfidenceAssessment were capped by the contract plus "Follow output_schema exactly", not by constrained decoding.
- Added evidence: the base prompt (run-context.ts:335, "explain gaps in source_gaps") and operating-model.ts:131 point to a source_gaps field that no forecast, decision, business or moat contract defines. Missing data therefore becomes silent empty arrays.

### RQ-MOD-4: The scenario and valuation output shape discards the model's segment drivers and its valuation objections

Severity **high**, effort **M**, verdict **corrected**, JD trait: Operating-case x valuation-assumption matrix, normalized FCF across a full reinvestment cycle, no-rerating return, segment engines (FoA vs Reality Labs) driving value.

**Problem.** Operating scenarios:
- The model writes segment-level numeric_assumptions (ad impressions, price per ad, Reality Labs loss), but code builds the statements only from consolidated yearly_drivers (revenue_growth, operating_margin, capex_to_revenue). The segment logic is narrative only.
- da_to_revenue was left null, so D&A stays at the historical 8.99% while capex is 54% of revenue.

Valuation:
- The analyst may only supply one discount rate and one terminal per scenario over a fixed 3-year horizon, and is told not to change the drivers.
- Haiku saw the problem: "2028 reinvestment (capex 106,342 against D&A 23,901) is inconsistent with a low perpetual growth rate", plus three 'Disagreement with drivers' notes. Those notes go to source_notes, which are display-only, so nothing reruns.
- The result is negative explicit FCF, terminal value at 99-129% of EV, and a $378 base value that the thesis then treats as evidence of mispricing.

no_rerating_return is arithmetic but left to the LLM ("Judge no_rerating_return ..."), which returned null.

**Evidence.** - forecast/contracts.ts:29-37: YearlyDriver is consolidated-only.
- handlers/operating-scenarios.ts:89: code builds statements from yearly_drivers and history_ratios.
- DB: all 3 scenarios carry numeric_assumption keys including reality_labs_operating_loss and average_price_per_ad_growth. Every yearly_drivers row has da_to_revenue = null.
- valuation/engine.ts:302-313: ValuationAssumptions is {scenario_type, discount_rate, terminal, rationale} x 3. engine.ts:355-358: forecastHorizon defaults to 3 years.
- handlers/asset-valuation.ts:35 ("Supply only valuation_assumptions") and :39 ("do not change the scenario drivers; note any disagreement with them in source_notes").
- reporting/valuation-summary.ts:242 is the only consumer of source_notes, and it is display-only.
- Latest asset_valuation output_json, scenario rationales and source_notes, quoted above.
- decision-synthesis.ts:225. The expected_return_matrix artifact has no_rerating_return = null.
- report.md:2679 and the reviewer's terminal-share findings.

**Recommendation.** In priority order:
1. In buildScenarioStatements, when da_to_revenue is null, derive D&A from the capex path (straight-line run-off of forecast capex over a stated useful life, plus the historical D&A base), instead of the history ratio.
2. Raise the RESEARCH_FORECAST_YEARS default to 5. The engine allows up to 10, and operating_scenarios must then supply 5 years of yearly_drivers.
3. Compute these in code and remove them from the prompt:
   - terminal value share of EV per scenario;
   - no_rerating_return (current EV/NOPAT multiple held to the terminal year, plus distributions);
   - a below-bear impairment case.
4. Have the analyst return conservative, base and aggressive {discount_rate, terminal} sets, applied by code to each operating case for a 3x3 grid.
5. Later: add optional segment_drivers that code sums into the consolidated figures, and a typed driver_objections array that queues at most one operating_scenarios rerun through the existing team_requests path.

Verify on a META rerun:
- D&A rises with capex.
- The base terminal share is below 100%, or a reason is stored.
- no_rerating_return is not null and permanent_loss_limit is below bear_return.
- valuation_scenario_set holds 9 cells.

**Verifier check.** Confirmed:
- forecast/contracts.ts:29-37: YearlyDriver is consolidated-only.
- DB: every yearly_drivers row has da_to_revenue null, while capex_to_revenue runs 0.30-0.56. All 3 scenarios carry segment numeric_assumptions (reality_labs_operating_loss, average_price_per_ad_growth, ...) that the code does not use.
- method_schedules for base 2028: capex 103,211 vs D&A 28,996. Bear: 106,342 vs 23,901.
- engine.ts:302-313: ValuationAssumptions holds one {discount_rate, terminal} per scenario. engine.ts:355-358 sets a 3-year default horizon.
- asset-valuation.ts:35 and :39.
- decision-synthesis.ts:225 leaves no_rerating_return to the LLM, and it is null.
- The report states terminal value at 99-129% of EV.
- The second valuation call's source_notes include 3 "Disagreement with drivers" notes. Its bear rationale contains the quoted capex-vs-D&A sentence.

Corrections:
- source_notes are not purely display-only. They are copied into valuation_scenario_set.method_inputs[].source_notes (asset-valuation.ts:524), which decision synthesis and the report read, and the report discusses them. No code acts on them, though.
- Added evidence: expected_return_matrix has weak_stock_outcome = permanent_loss_limit = bear_return = -0.709049. So there is no impairment case below the bear case (JD trait 17).
- Priority: the D&A that doesn't follow capex is a code-owned defect and the largest numeric distortion. Fix it first. The driver-objection rerun loop is the most complex part and can wait.

### RQ-MOD-5: Prompts enforce format, not analyst behaviour: there is no central-debate step, the doctrine contradicts itself, and the reviewer checks consistency rather than framing

Severity **high**, effort **M**, verdict **corrected**, JD trait: One central reframing insight, explicit 'what would change my mind', impairment and tail cases below bear, reviewer challenge of the model's framing.

**Problem.** Most prompt lines are schema, citation and format rules. Few ask for what a strong analyst does: name the central debate and the consensus view, separate earning from loss-making segments, place current metrics against history, diagnose cash conversion, and state what would change the view.
- decision_synthesis gets 15 rules. The only analytic one is "Synthesize the final investment decision, including a clear thesis statement, risk factors, and upcoming catalysts."
- No artifact carries a central question for later stages to build on, so the META thesis restated a model artifact ("the price implies 64% margins") instead of questioning a 3-year horizon set at peak capex.
- The doctrine says "write the executive judgment last", while the outline rule says "First section should summarize the eventual judgment". Code already writes conclusions last, so the reviewer reads the doctrine as a placement rule and raises it as a high-severity finding.
- The Haiku reviewer raised 58 findings, none about horizon, normalization or terminal share.

**Evidence.** - reporting/contracts.ts:106-121: RESEARCH_DOCTRINE has 15 rules. About 10 are format or integrity (lines 107-112, 116, 118, 120); the analytic ones are 113-115, 117 and 119.
- handlers/decision-synthesis.ts:215-230.
- handlers/operating-model.ts:120-132: 11 rules, 3 analytic.
- reporting/runtime.ts:73 ("Design a report outline around the material investment questions ... First section should summarize the eventual judgment") vs contracts.ts:113.
- reporting/compose.ts:31-37 already writes conclusions after the body.
- DB: in the META run the first review finding is severity 'high', 'The executive judgment is placed as the first section rather than written last'. The same finding appears in 2 of the 5 runs that have a report_review.
- Reviewer findings in this run: writing 19, evidence 20, calculation 10, research_gap 9. An ILIKE search for horizon, normali, three-year or peak returns 0.
- investment_thesis.market_mispricing (DB) rests entirely on the reverse valuation's 64% margin.

**Recommendation.** - Extend the existing business team_brief, or add one premium-tier call after moat_analysis, to return {central_question, consensus_view, variant_view, value_at_stake_per_share, decisive_metrics[], earners_vs_burners (segment operating income refs), below_bear_impairment_cases[]}.
- Pass it into the operating_model, operating_scenarios, valuation, decision_synthesis and outline packets. Require investment_thesis and the opening section to cite it.
- Reword contracts.ts:113 to "Form the executive judgment from the finished analysis".
- Where validators or composeReviewedReport already enforce a doctrine rule, drop it, and add 4-5 behaviour rules instead: earners vs burners, current vs median/min/max, FCF/NI conversion and working-capital days, voting vs economic ownership, impairment below the bear case.
- Add a reviewer rule: "Challenge the valuation framing: horizon vs the reinvestment cycle, terminal value share of EV above 75%, terminal-year capex vs D&A, normalization; raise as calculation findings."

Verify on a META rerun:
- The debate fields exist and are cited by the thesis and the opening section.
- The placement finding is gone.
- At least one reviewer finding addresses framing when TV exceeds EV.

**Verifier check.** Confirmed:
- The doctrine contradiction. reporting/contracts.ts:113 says "write the executive judgment last". runtime.ts:73 says "First section should summarize the eventual judgment". compose.ts:31-37 already writes conclusions after the body.
- DB: the high-severity 'executive judgment is placed as the first section rather than written last' is finding #1 of review round 2 in META. It appears in 2 of 5 runs with a report_review (4fae0fb1 and 1d427f3f). Another finding says the judgment "otherwise follows the 'write last' requirement", which shows the confusion.
- Review categories: evidence 20, writing 19, calculation 10, research_gap 9. 0 findings match horizon, normali, three-year or peak.

Corrections:
- RESEARCH_DOCTRINE has 14 rules (lines 107-120), not 15.
- decision_synthesis has 12 extra rules. Besides the 'Synthesize...' rule, 'Derive material risks ... Map confidence to specific evidence gaps' is also analytic.
- 'What would change my mind' is not absent. investment_thesis has must_be_true and disproving_evidence (5 items in META), thesis_breakers exists, and doctrine rule 9 asks what would disprove the interpretation. The real gap is that the central question is formed last (decision_synthesis) and never steers the operating model or valuation, and nothing captures a consensus vs variant view.
- The reviewer did raise terminal-value share above 100% twice, but as a consistency or presentation issue. It explicitly accepted the framing ("the Gordon alternative is rejected, which is acceptable").

### RQ-MOD-6: The cost ledger underprices Haiku prompts over 100K tokens by 5x and has no Opus or Sonnet prices, so the budget guard would miss a tiered run

Severity **high**, effort **S**, verdict **confirmed**

**Problem.** Two pricing gaps:
- calculateCost ignores Haiku 5.5's long-prompt rate. Its own comment acknowledges it: "Prompts up to 100k tokens; longer prompts cost 5x." 74% of META's input tokens were in prompts over 100K, so the logged $1.05 is about $3.74 at list prices.
- PRICING_DB has no claude-opus-5-5 or claude-sonnet-5-5 entry, so those models fall to DEFAULT_PRICING ($0.50/$1.00 per MTok), which is 8x and 20x too low for Opus.

The budget guard (default $6 limit, $0.10 per-attempt reserve) sums these ledger costs. Under the RQ-MOD-1 tiering it would log about $2.22 for a $13.43 run and never trip. The 5x gap was noted inside P4's evidence in the 2026-10-11 audit and is still unfixed (P4's fix sliced team-answer packets only).

**Evidence.** - agent-harness/telemetry.ts:10-20: PRICING_DB holds only the DeepSeek, Qwen, GLM, Kimi and claude-haiku-5-5 entries. :18 is the 5x comment. :22-25 sets DEFAULT_PRICING to 0.5/1.0. :48-64: calculateCost has no threshold logic.
- runner.ts:266 computes cost with calculateCost when the provider doesn't. The Anthropic provider sets costUsd only for 1-hour cache writes (anthropic-compatible.ts:207-211).
- lib/agents/model-calls.ts:97-104 compares the budget with actual_cost_usd from the ledger. run-context.ts:503 reserves $0.10 per attempt.
- DB: 24 of 79 calls had input_tokens over 100,000, totalling 5,742,134. Repricing (scratchpad cost_model.py) gives $3.736 vs $1.045 logged. The META research_plan budget is {limit_usd: 6}.
- Prior audit: handover files/2026-10-11-optimization-audit.md:728,732.

**Recommendation.** - Add `longContext: {thresholdTokens: 100_000, multiplier: 5}` to the claude-haiku-5-5 pricing. Apply it in calculateCost and oneHourCacheWriteSurcharge when inputTokens, which already include cache tokens, exceed the threshold.
- Add claude-opus-5-5 (4 / 20 / read 0.20 / write 5.0) and claude-sonnet-5-5 (2 / 10 / read 0.20 / write 2.5).
- Log a warning, or fail, for an unknown `claude-*` model instead of using DEFAULT_PRICING.
- Scale the attempt reserve by tier (for example $1.50 for premium).

Verify:
- Unit tests: a 150K-token Haiku call costs 5x; an Opus call is priced at $4/$20.
- Re-pricing the META ledger gives about $3.74.
- A mock run with a $2 limit and a premium tier stops at the budget.

**Verifier check.** - telemetry.ts:10-20: PRICING_DB has DeepSeek, Qwen, GLM, Kimi and claude-haiku-5-5 only. :18 carries the 5x long-prompt comment. :22-25 sets DEFAULT_PRICING to 0.5/1.0. calculateCost (:48-64) has no threshold logic.
- runner.ts:264 falls back to calculateCost. The provider sets costUsd only for 1-hour cache writes (anthropic-compatible.ts ~205-212).
- The budget check sums ledger costs (model-calls.ts:93-104). run-context.ts:503 reserves RESEARCH_ATTEMPT_BUDGET_RESERVE_USD (0.1 in .env.local).
- I recomputed from logged tokens, with 5x on calls over 100K prompt tokens: 24 calls, 5,742,134 tokens, $3.736 vs $1.045 logged.
- I recomputed variant B independently: $13.43 with the same output, $17.61 with doubled output. All-Opus: $41.42.
- The prior audit mentions the 5x gap only inside P4's evidence and verifier notes (audit lines ~728-732). It is unfixed on main.
- An Opus model ID matches no PRICING_DB key, so it gets $0.50/$1.00: 8x too low on input and 20x on output.

### RQ-MOD-7: Analytic reasoning is hidden and discarded; report writers can only restate thin artifacts, and decision synthesis packs 8 artifacts into one call

Severity **medium**, effort **M**, verdict **corrected**, JD trait: Prose causal analysis per engine, 'what happened to the economics', and the final scorecard and 'what would change my mind'. In the JD example this is a reasoned narrative over computed numbers, not template fields.

**Problem.** The analysis lives in hidden thinking (about 61% of output tokens, display omitted, not stored) or in short schema strings. The report writers are told "Keep numerical models unchanged" and "Do not author or recalculate table values", so the report can be no deeper than the stored artifacts.

decision_synthesis returns investment_thesis, risk_register, catalyst_register, expected_return_matrix, thesis_breakers, monitoring_dashboard, confidence_assessment and decision_record in one generation. On Haiku its first attempt hit the 32,768 limit and was discarded. The thesis and the confidence work compete for output budget with mechanical registers.

**Evidence.** - stage-contracts.ts:78-82: DECISION_SYNTHESIS_CONTRACT holds 8 artifacts.
- DB: decision_synthesis attempts produced 32,768 tokens (failed), then 39,292 and 30,104. Its stored artifacts total about 31 KB (investment_thesis 4.9 KB, risk_register 10.3 KB, monitoring 7.6 KB, confidence 154 B).
- reporting/runtime.ts:77 ("Keep numerical models unchanged") and :104 ("Do not author or recalculate table values").
- The hidden-share estimate in RQ-MOD-2.
- reporting/runtime.ts:56-59: report sections get artifacts and evidence only, with no analysis narrative from the specialists.

**Recommendation.** - Add a required `analysis_memo` [{claim, reasoning, figures:[{label, artifact_path}], evidence_ids}] to the premium-stage contracts (operating_model, operating_scenarios, moat, decision_synthesis). Figures must reference artifact paths so validators can check them. Include memos in report sections whose coverage matches.
- Split decision_synthesis in two:
  - a premium call for investment_thesis, confidence_assessment, decision_record and the memo;
  - a cheap-tier call that derives the risk, catalyst, breaker and monitoring registers from the thesis and the accepted artifacts.

Verify:
- No decision_synthesis attempt hits its output limit.
- Report sections cite memo artifacts.
- On the META packet, the judgment names a central driver instead of restating the reverse-valuation margin.

**Verifier check.** Confirmed:
- stage-contracts.ts:78-82: DECISION_SYNTHESIS_CONTRACT holds 8 artifacts.
- DB: attempts produced 32,768 tokens (failed), 39,292 and 30,104.
- Stored sizes: investment_thesis 4.9 KB, risk_register 10.3 KB, monitoring 7.6 KB, confidence 154 B.
- Hidden thinking is not stored. Display is omitted, and the runner ignores reasoning.delta.

Corrections:
- "Keep numerical models unchanged" (runtime.ts:77) is in the outline prompt, not the section writer's.
- Section writers get every evidence_claim and are told to "Develop the reasoning in connected paragraphs; do not merely restate artifact fields" (runtime.ts:100). "Do not author or recalculate table values" (:104) applies to tables only.
- So the binding limits are the doctrine's "Never invent ... calculated results" and the thin artifacts, which is mostly RQ-MOD-3's fix. A free-text memo should not become a second, unvalidated channel for numbers.

### RQ-MOD-8: Input context, not output, dominates the cost of any model upgrade; trim before moving report sections and the reviewer up a tier

Severity **medium**, effort **M**, verdict **confirmed**

**Problem.** Two-thirds of a tiered run's cost would be input tokens.
- The 20 report-section calls take 2.89M input tokens with only 30% read from cache.
- The two reviews take 958K tokens, the outline 404K, the two team_requests calls 763K (for 2.9K output tokens), and decision_synthesis 482K over 3 attempts.
- Each report section gets every evidence claim. The report packets also carry the full historical_record observation table, because the series_table encoding keeps every observation.

On Sonnet, report sections alone would cost about $6 per run. That makes the step from variant B to D ($13 to $23) mostly a context bill rather than a quality one.

**Evidence.** - DB: report_section has 20 calls, 2,889,889 input tokens, 877,419 cache-read tokens. ai_review 957,800. report_outline 403,563. team_requests 762,798 in, 2,896 out.
- Cost model: input share is 66% in variant B ($8.81 of $13.43) and 70% in D ($15.96 of $22.80).
- reporting/runtime.ts:56-59: `common` includes all artifacts and evidence_claims; sections replace only artifacts.
- reporting/store.ts:9 excludes financial_statement_set but not historical_record.
- reporting/packet.ts:26-29: "Every original observation is retained".

**Recommendation.** Before moving report_section or ai_review up a tier:
- Send each section only the evidence claims cited by its selected artifacts, plus claims matching its coverage keys.
- Replace historical_record observations in model packets with a code-computed summary: per-metric median, min, max, latest and percentile, plus the last 8 quarters. Keep the full series only for sections whose coverage includes history and for table paths. This also gives the JD-style current-vs-history statistics.
- Cap team_requests packets the way P4 did for team answers.
- Target under 100K tokens for every call that stays on Haiku.

Verify on a META mock run:
- report_section and ai_review input tokens fall at least 40%.
- The number of Haiku calls above 100K falls from 24.
- Section validators still pass.

Then re-price variant D.

**Verifier check.** DB, matching the reviewer:
- report_section: 20 calls, 2,889,889 input, 877,419 cache-read.
- ai_review: 957,800. report_outline: 403,563. team_requests: 762,798 in, 2,896 out. decision_synthesis: 482,367.

Code:
- runtime.ts:55-58: `common` carries all artifacts and every evidence claim. Sections replace only the artifacts.
- store.ts:9 excludes financial_statement_set but not historical_record (2.39 MB).
- packet.ts:30 keeps every observation.
- team.ts:150-152 sends the full loadReportInputs to team_requests.

Repriced: report sections on Sonnet come to about $6.7 per run. Input share in variant B is 66% with unchanged output.

Additional point that strengthens the finding: on Haiku the 100K threshold is a cliff. 10 of 20 report_section calls and 4 of 10 team_answer calls are above 100K, so each costs 5x. Trimming them below 100K pays off even if they stay on Haiku.

## RQ-ANA: Deterministic analytics layer (history, segments, cash conversion)

Nearly all the numbers needed for framework Section 4 are already captured. The META financial_statement_set has 2,488 filed observations, including 20 quarters of Family of Apps and Reality Labs revenue and operating income, and 18 quarters each of capex, D&A, SBC, buybacks, receivables, payables, cash, securities and debt. Almost nothing is computed from them before the models reason. historical_record's ttm_series and statistics are always empty because they are keyed by plan families. historical_diagnosis computes level statistics only for companyfacts and model-extracted series (no margins, FCF or segments) and stamps every metric 'unexplained' with boilerplate. The 39-metric catalogue (TTM, average balances, ROIC, SBC ratios) only feeds the UI. The models therefore act as calculators: the report prose holds 22 hand-made '(derived: ...)' calculations. The 20-quarter chapter got 454 KB of raw observations (277K input tokens) and returned 3.5K tokens plus a 2,300-row raw dump. Sections on capital allocation, valuation and moat received no financial history at all. A prototype pack computed from the stored data turns up JD-style insights the report missed. Net cash fell from $49bn to $6.6bn. TTM FCF/net income is 0.60, the lowest of 16 quarters. Capex/D&A is 3.9x, the highest. The Family of Apps margin is at its 15th percentile. Reality Labs lost $81bn against Family of Apps' $374bn over 20 quarters. 1-year incremental ROIC is about 9%. Share count is up 1.3% with buybacks stopped. The recommendation is one compact deterministic 'financial_analytics' artifact that reuses MetricBook. It would be about 10-15 KB and would go to every analyst and report section.

<details><summary>Measurements</summary>

All on META run 4fae0fb1 unless noted. (1) historical_record: 2,311 observations, ttm_series=0, statistics={} (SQL jsonb_array_length / jsonb_object_keys). I re-ran the CURRENT normalizer.ts through tsx on the run's statement observations. Plan family keys gave 0 TTM rows and 0 statistics. Line-item keys (revenue, net_income, OCF, capex, OI) gave 75 TTM rows. Scratch script: /private/tmp/claude-501/-Users-japardinathaniel-Documents-GitHub-Investing-Research-Pipeline/fdaaf424-0588-4f7e-be73-9b055f9db53a/scratchpad/ttm-check.ts. (2) historical_diagnosis: 17 diagnoses. 9 have 3 or fewer observations. 0 have a causal_process_node. All 8 twenty-quarter diagnoses say 'expect reversion risk' at confidence 0.45. (3) financial_statement_set: 2,488 observations. Segment members meta:FamilyOfApps and meta:RealityLabs have 20 quarters of revenue and us_gaap_OperatingIncomeLoss, 2021Q3-2026Q2. Capex, D&A, SBC and buybacks have 18 quarters; weighted diluted shares 15 (no Q4). (4) Prototype pack, Python over the stored observations (/private/tmp/claude-501/-Users-japardinathaniel-Documents-GitHub-Investing-Research-Pipeline/fdaaf424-0588-4f7e-be73-9b055f9db53a/scratchpad/pack.py). 12 metrics x 20 quarters plus stats is 3,191 bytes of JSON. For comparison, the report history-section packet carried 453,952 bytes of historical_record and the operating-model packet 84,028 bytes of recent_reported_history (136 raw metric keys). The prototype handles Q4 derivation naively for non-flow items, so the production version should reuse MetricBook. Its 2026Q2 values: revenue YoY 28.0% (94th percentile of 16 quarters, median 21.9%); operating margin 30.9% (35th percentile, median 38.0%); FoA margin 38.8% (15th percentile, median 48.8%); TTM FCF $41.0bn (median $45.5bn); TTM FCF/NI 0.60 (min of 16, median 0.85); TTM capex/D&A 3.93x (max, median 3.16x); growth capex (capex minus D&A) $66.6bn vs $35.4bn a year earlier; SBC/revenue 11.0% (max); net cash (cash + current marketable securities - LT debt) $6.6bn (6th percentile, median $35.1bn, $49.0bn at 2024Q4); period-end Class A+B shares 2,548m vs 2,516m a year earlier (+1.3%); TTM buybacks $3.3bn vs $31.7bn; buyback yield 0.23% vs 1.71%; FCF yield 2.9%; FCF-minus-SBC yield 1.1%; RL cumulative 20-quarter operating loss -$81.3bn vs FoA +$374.3bn; incremental TTM operating margin 16.6% (1y), 35.9% (2y), 54.1% (3y); incremental ROIC (flat 15% tax, IC = equity + LTD - cash - securities) about 9% (1y), 17% (2y), 32% (3y); revenue/net PP&E 1.45 (2024Q2) to 1.01 (2026Q2). (5) Report: 22 '(derived' calculations in prose outside the table dump. The quarterly table runs from line 187 to 2516 of 3,225. historical-performance section call: 277,509 input / 3,563 output tokens. evidence-gaps section: 355,692-365,707 input tokens.

</details>

### RQ-ANA-1: No deterministic analytics pack exists: margins, FCF, conversion, returns and statistics are left to the models, which compute them by hand or not at all

Severity **high**, effort **M**, verdict **corrected**, JD trait: Section 4 twenty-quarter table with computed statistics (median growth 7.35%, median retail margin 3.95%, range 2.1-5.9%, median TTM FCF) and current-vs-median positioning

**Problem.** The only quantitative views code gives the models are raw tables and three ratios, so the models act as calculators. Raw tables: financial_inputs has 8 quarters and 4 years of 16 columns; recent_reported_history has the last 6 raw rows of 136 keys. Ratios: historyRatios returns the 3-year mean D&A/revenue and capex/revenue and a tax rate. A full metric engine exists (metric-catalogue.ts: 39 metrics, TTM, average balances, derived Q4 flows, missing-input reasons), but it is imported only by React components and chart-series.ts. The report doctrine says 'Financials Metrics must expose ... ROE, ROIC' and 'Never invent ... calculated results', yet the writer is never given a calculated result. The META report computes ratios inline 22 times and says 'the metric normalization for margins, ROE and ROIC is withheld'. It never states any of the Section 4 statistics the JD example leads with: median, range, percentile of the current value, or current vs history.

**Evidence.** src/components/financial-statements.tsx:9 and src/components/financials/*.tsx are the only importers of metric-catalogue.ts besides src/lib/research/reporting/chart-series.ts:9; no handler imports it (grep). src/lib/research/valuation/financial-inputs.ts:11-29 (COLUMNS), :126 (8 quarters by default); src/lib/research/valuation/engine.ts:54-77 (historyRatios); src/lib/research/handlers/operating-model.ts:75 (recentByMetric(...,6)); src/lib/research/reporting/contracts.ts:109,120 (doctrine). Report: grep -c '(derived' = 22 outside the table, e.g. 'Q2 2026 capex equalled about 49.5% of Q2 revenue (derived: 30,116 divided by 60,801)'. Framework docs/research-framework-v2.1.md:545-569 (4.3: median, percentile, CV, seasonality) and :803-821 (4.13 required outputs).

**Recommendation.** Build one pure module, src/lib/research/history/analytics.ts (buildFinancialAnalytics), call it from historical-record.ts after buildHistoricalRecord, and save it as a financial_analytics artifact with a small zod schema. Reuse MetricBook for aliases, flow Q4/missing-quarter derivation, ttm(), average() and missing reasons. Do NOT reuse its nopat: compute NOPAT with a normalized rate, the median quarterly effective rate over 20 quarters restricted to 0-50%, labelled. Extend BASE_INPUTS with receivables, payables (trade and total aliases), deferred revenue/contract liabilities, net PP&E, buybacks, R&D, per-class period-end shares and finance-lease principal. Contents: quarterly_economics on ratios, growth and TTM; stats per series (n, median, p25/p75, min/max, current, percentile, 1y/3y change), never on raw levels of trending flows; incremental margins and ROIC; segments; capital allocation; code-written positioning sentences; and a missing map. Use a fixed columnar layout and rounding. Measure the size and keep it under about 25 KB. Unit test on the META statement-set fixture: TTM FCF 40.98bn, FCF/NI 0.60, FoA margin percentile 0.15, net cash 6.60bn, RL cumulative -81.34bn. Then run test:sofi-v3. After a user-approved paid run, check that prose '(derived' counts fall and Section 4 statistics appear.

**Verifier check.** Code checks: metric-catalogue.ts is imported by src/components/*, chart-series.ts and data-views.ts:20 (a re-export used by kpi-health.ts and valuation-summary.ts, both UI-only). No handler imports it. financial-inputs.ts:11-29 has 17 columns (16 financial plus employees) and 3 market columns, 8 quarters and 4 years (:126-127), and only asset-valuation.ts:249 sends it to a model. operating-model.ts:87 uses only historyRatios (engine.ts:54-77) and recentByMetric(...,6) at :75; the stored packet has 136 keys and 84,028 bytes. contracts.ts doctrine confirmed. Report: 22 '(derived' outside the table (23 in total), the 'metric normalization for margins, ROE and ROIC is withheld' quote is at report.md:3209, and no 'median'/'percentile' appears anywhere in the prose. I recomputed the headline numbers from the stored statement set with my own script (not pack.py): TTM FCF $40.98bn (median 45.5bn), FCF/NI 0.602 (min of 16), capex/D&A 3.93x (max), FoA margin 38.75% (median 48.7%, 15th percentile inclusive), net cash $6.60bn, RL cumulative -$81.34bn vs FoA +$374.35bn. All reproduce. Two recommendation fixes. (1) MetricBook's nopat (metric-catalogue.ts:247-251) applies each quarter's GAAP effective tax rate. META's rates are 87.5% in 2025Q3 ($18.95bn tax on $21.66bn pretax) and -23.1% in 2026Q1, which puts the implied TTM rate at 20.8% vs a 20-quarter median of 15.8%. 'Reuse MetricBook for every value' would carry that into ROIC. (2) Cash-flow TTM through 2025Q3 works only because MetricBook back-derives the quarter from the FY total; the stored quarter is missing because of a filing-parser bug (see missed item 1). The size target is plausible for the core but not for blocks (a)-(f); measure it rather than assume 15 KB.

### RQ-ANA-2: historical_record TTM series and statistics are always empty because plan metric families are passed as metric keys

Severity **low**, effort **S**, verdict **corrected**, JD trait: Twenty-quarter TTM FCF series (median TTM FCF RMB30.2bn)

**Problem.** buildHistoricalRecord builds TTM and statistics for requiredMetricKeys. historical-record.ts sets those to the research plan's metric families: income_statement, balance_sheet, cash_flow, share_count, capital_allocation. buildTTMSeries looks each key up with findObservation, which needs an exact metric_key, so no family ever matches. computeHistoricalStatistics then runs over an empty TTM set. Every run stores ttm_series=[] and statistics={}, and the coverage matrix (which does map families) hides the gap. The framework's rolling-TTM view (4.3 item 2) is missing for every asset.

**Evidence.** src/lib/research/handlers/historical-record.ts:110-112 (requiredMetricKeys = metric_family values), :218; src/lib/research/history/normalizer.ts:60-70 (TTM and statistics from requiredMetricKeys), :220-237 (findObservation exact metric_key); src/lib/research/history/diagnostics.ts:25-38. SQL on META: SELECT jsonb_array_length(content_json->'ttm_series'), content_json->'statistics' FROM research_artifacts WHERE artifact_type='historical_record' returns 0 and {} (2,311 observations). Plan: [{metric_family:'income_statement'},...,{metric_family:'capital_allocation'}]. I reproduced it on current code with tsx and the run's statement observations: families give 0 TTM rows and 0 statistics; ['revenue','net_income','operating_cash_flow','us_gaap_PaymentsToAcquirePropertyPlantAndEquipment','us_gaap_OperatingIncomeLoss'] gives 75 TTM rows.

**Recommendation.** Do not expand families to all keys. When financial_analytics lands, remove ttm_series and statistics from HistoricalRecord (contracts.ts:110-111 already default them) and stop packet.ts:37 from encoding them, so no artifact field is silently empty. Until then, either leave the fields alone or fill them from a fixed short list (revenue, operating income, net income, OCF, capex). Add a regression test in tests/historical-record.test.ts that fails if a plan family key yields an empty TTM series without a recorded reason.

**Verifier check.** Mechanism confirmed. historical-record.ts:108-112 passes plan metric_family values (the META plan is income_statement, balance_sheet, cash_flow, share_count, capital_allocation). buildTTMSeries (diagnostics.ts:25-38) calls findObservation, which needs an exact metric_key (normalizer.ts:220-237), and computeHistoricalStatistics runs only on the TTM rows. I re-ran the reviewer's tsx script on the current code: families give 0 TTM rows and 0 stats; five line-item keys give 75 rows. 'Every run' is overstated: SOFI runs dd02bb41 (51 TTM rows, 3 stats) and 77eef6e2/59d6397b (170 rows, 10 stats) got values because the bank plan families (net_interest_income, credit_losses...) match model metric keys. Every non-bank run since 2026-09 has 0/0. Severity is lower than stated: nothing in the pipeline reads ttm_series or statistics except packet.ts:37 and presentation.mjs labels, and the real loss (no TTM reaches the models) is RQ-ANA-1. The stopgap is harmful. Expanding each family to every present currency key would create TTM rows for about 100 flow keys, and packet.ts:37 serializes ttm_series into every packet that carries historical_record, which is already 454 KB. Statistics on TTM levels are also the meaningless level stats (TTM revenue median 149.8bn).

### RQ-ANA-3: historical_diagnosis analyses the wrong series in the wrong way and stamps every metric 'unexplained' with boilerplate

Severity **medium**, effort **M**, verdict **corrected**, JD trait: Section 5 'what happened to the economics' (margin thesis proven, then deliberate reinvestment) and framework 4.11 metric diagnosis

**Problem.** Framework 4.11 and Stage 4 require, for every core metric: level, history against the 5-year median, peak and trough, trend, stability, inflection, cause, control, sustainability and forecast implication. The stage meant to do this falls short in four ways. (1) It reads only metric_observations, which hold the 9-17 companyfacts keys plus model one-offs, so it never sees margins, FCF, capex, D&A, SBC, segments or shares from the filed statements. The companyfacts METRICS list is bank-oriented. (2) It computes mean, median and z-score inflections on raw levels of growing flows, so 'median revenue' is meaningless and the 'inflection' is the seasonal Q4 peak. (3) processNodeMapping is never passed, so causal_process_node is always undefined, classification is always 'unexplained', management_control is always 'unassigned' and forecast_implication is template text. (4) There is no percentile, coefficient of variation, peak-to-trough or seasonality. Units are mixed: Reality Labs is in millions while revenue is in dollars. Downstream, operating_model receives only {metric_key, trend, observation_count, confidence}.

**Evidence.** src/lib/research/handlers/historical-diagnosis.ts:26-41 (metric_observations only), :80-91 (no processNodeMapping); src/lib/research/diagnosis/diagnosis.ts:35-45 (stats on raw values), :54-56 (causal node only from processNodeMapping), :91 ('unassigned'), :94-96 (template implication), :124-135; src/lib/research/history/diagnostics.ts:115-129 (z-score on levels); src/lib/research/history/sec-companyfacts.ts:45-63 (no OperatingIncomeLoss, capex, D&A, SBC, shares, buybacks); src/lib/research/handlers/operating-model.ts:105-107. SQL on META historical_diagnosis gives 17 diagnoses. 9 have 3 or fewer observations: ad_impressions_yoy_growth 3, average_price_per_ad_yoy_growth 2, reality_labs_operating_loss_quarterly 1 (value -4619), operating_margin_gaap 1. All 8 twenty-quarter diagnoses read 'Current trend for X is increasing; expect reversion risk.' at confidence 0.45. unexplained_inflections includes revenue 2025Q4 z=1.90. 0 of 17 have a causal_process_node.

**Recommendation.** Rebuild historical-diagnosis.ts on financial_analytics. Diagnose ratio, growth and TTM series (revenue YoY, gross/operating/FCF margin, segment margins, FCF/NI, capex/D&A, DSO/DPO, ROIC, net share change), detect inflections on YoY change or ratio level, and report percentile and seasonality by fiscal quarter. Drop the code-guessed cause and control fields and the template forecast_implication. Leave causal_process_node and management_control null for a later analyst stage. Keep metric_observations-only KPIs as a separate kpi block with true counts, and skip one-off model keys (fewer than 4 observations) entirely. Verify on the META fixture: revenue_yoy current 0.28, FoA margin percentile 0.15, and no diagnosis on raw revenue level.

**Verifier check.** Code confirmed. historical-diagnosis.ts:26-41 reads only metric_observations and :80-91 passes no processNodeMapping (diagnosis.ts:15,55; the only other caller is :174, a single-metric helper). Stats run on raw levels (:35-44), management_control is hard-coded 'unassigned' (:91), the forecast_implication is a template (:94-96), and classifyChange returns 'unexplained' whenever no causal node exists (:131-132). detectInflections uses a z-score on levels (diagnostics.ts:115-129). The companyfacts METRICS list (sec-companyfacts.ts:45-63) has no operating income, capex, D&A, SBC, shares or buybacks. The DB matches the claims: 17 diagnoses, 9 with 3 or fewer observations (several are one-off model keys such as income_tax_one_time_charge_q3_2025), and all 8 twenty-quarter rows read 'expect reversion risk' at 0.45. There are 0 causal nodes, revenue is an unexplained inflection at 2025Q4 (z 1.90, the seasonal Q4 peak), and RL is -4619 in millions while revenue is in dollars. I lowered severity to medium: downstream use is thin (operating_model takes 4 fields at :105-107; the monitoring report section gets the artifact), and the fix depends on RQ-ANA-1.

### RQ-ANA-4: Twenty quarters of segment P&L are captured but never turned into segment economics, the JD example's central insight

Severity **high**, effort **S**, verdict **confirmed**, JD trait: Two economic engines: segment-level economics (who earns vs who burns; New Businesses loss = 82% of core segment profit)

**Problem.** The filing parser already extracts each reportable segment's revenue and operating income for all 20 quarters. No code computes segment margins, the share of group profit each segment consumes, TTM figures or cumulative losses. MetricBook drops segment rows. operating_model sees only the last 8 rows per segment, mixing FY and quarterly rows, so about 6 quarters, and the namespace prefix splits fb: from meta: members. business_process_analysis (which writes segment_model) does not depend on historical_record. The report's business-model section never received historical_record. The META report therefore asserts the data is missing ('Quarterly segment revenue and operating income ... are not verified in the reviewed history, so ... segment margin trends are not shown by quarter') and hand-sums Reality Labs losses for 2020-2022 only.

**Evidence.** SQL on financial_statement_set: revenue and us_gaap_OperatingIncomeLoss for segment meta:FamilyOfAppsMember and meta:RealityLabsMember have 20 quarterly rows each (2021Q3-2026Q2); fb:RealityLabsMember appears only as FY2021. src/lib/research/reporting/metric-catalogue.ts:140 (filters out r.segment); src/lib/research/handlers/operating-model.ts:77-79 (recentByMetric(segmentRows, 8)). The operating-model task packet's reported_segment_history holds FY2024, 2025Q1-Q4, FY2025, 2026Q1, 2026Q2. src/lib/research/team-plan.ts:46 (business_process_analysis depends on company_genesis only). Report section packets: business-model-and-segments = business_process_map, customer_decision_map, segment_model. Computed from stored rows: RL 20-quarter cumulative operating loss -$81.3bn vs FoA +$374.3bn (21.7%); RL loss as % of FoA operating income: median 21.1%, range 15.0-40.1%, 2026Q2 19.7%; FoA margin 38.8% in 2026Q2 vs 20-quarter median 48.8% (15th percentile).

**Recommendation.** Add a segments block to financial_analytics from statement observations with metadata_json.statement==='segment'. Normalize member names by stripping the fb:/meta: prefix and the 'Member' suffix. Per quarter, give revenue, OI, margin, YoY, TTM, share of consolidated OI and cumulative OI with stats, plus a consolidated-minus-segments residual row. Feed the block to business_process_analysis, operating_model (replacing reported_segment_history) and the business-model section. Verify on the META fixture: 20 rows per segment, RL cumulative -81.34bn, and one RealityLabs key across the fb/meta rename for annual rows.

**Verifier check.** SQL on financial_statement_set 79c2438f: revenue and us_gaap_OperatingIncomeLoss for meta:FamilyOfAppsMember and meta:RealityLabsMember have 20 quarterly rows each, 2021Q3-2026Q2. One small fact fix: the fb: members appear as FY2019-FY2021 annual rows (3 each), not only FY2021. MetricBook drops segment rows (metric-catalogue.ts:140). operating-model.ts:77-79 uses recentByMetric(segmentRows, 8); the stored packet's RL revenue holds FY2024, 2025Q1-Q4, FY2025, 2026Q1 and 2026Q2. Under team-plan.ts:46, business_process_analysis depends only on company_genesis, and the business-model section got segment_model, customer_decision_map and business_process_map only. Report line 161 says segment margin trends are 'not verified'. My recomputation: RL -81.34bn vs FoA +374.35bn cumulative; FoA margin 38.75% vs median 48.7%.

### RQ-ANA-5: Cash conversion and reinvestment economics are not computed, so the valuation has no historical anchor for return on new capital

Severity **high**, effort **M**, verdict **corrected**, JD trait: Cash-conversion diagnosis (FCF/NI 106% -> 33%), normalized FCF base for the DCF matrix and reverse DCF in FCF-growth terms

**Problem.** No code computes FCF, FCF/NI and OCF/NI conversion, capex/D&A, growth vs maintenance capex, incremental ROIC or capital turnover, although every input is in the statement set. The operating-model prompt asks the model to compare return on incremental capital 'against the historical rate', but no historical rate is supplied. As a result reinvestment_model is a single capex number with an empty working-capital list. Scenario D&A stays at the 3-year history ratio of 9.0% of revenue while capex runs at 32-54% of revenue. The valuation rationale falls back to a NOPAT multiple because 'a sourced return on new capital ... the corpus does not provide'. The data show conversion at its 20-quarter low and reinvestment at its high, which is the JD-style cash-conversion diagnosis the report never makes.

**Evidence.** src/lib/research/handlers/operating-model.ts:123 (prompt asks for the historical rate); src/lib/research/valuation/engine.ts:54-77 (historyRatios: only D&A/revenue, capex/revenue, tax), :121-123 (capex and D&A as revenue ratios; ΔNWC defaults to 0). SQL: reinvestment_model = {capex_forecast:[137500000000], working_capital_forecast:[]}; base method_schedules FY2028 capex 103,211 vs D&A 28,996 (USD m); rationale quote 'a sourced return on new capital that the corpus does not provide'. Computed from stored rows (2026Q2): TTM FCF $41.0bn; FCF/NI 0.60, the minimum of 16 quarters (median 0.85); capex/D&A 3.93x, the maximum (median 3.16x); capex minus D&A $66.6bn vs $35.4bn a year earlier; revenue/net PP&E 1.45 (2024Q2) to 1.01; incremental ROIC about 9% (1y), 17% (2y), 32% (3y) with a flat 15% tax, vs the model's 9% discount rate.

**Recommendation.** Add FCF (and FCF net of finance-lease principal), OCF/NI, FCF/NI, capex/D&A, growth capex (capex minus D&A, labelled a proxy), revenue/net PP&E, NOPAT at a normalized rate (median 0-50% quarterly effective rate), and 1/2/3-year incremental operating margin and ROIC to financial_analytics. Pass them as reinvestment_history to operating_model, operating_scenarios and asset_valuation. Replace the proposed check with one that targets the actual gap: in operating-scenarios, when a year's capex_to_revenue exceeds 1.5x history_ratios.capex_to_revenue and da_to_revenue is null, add a source_gap requiring a D&A driver tied to the capex build. Verify on the META fixture (FCF/NI 0.60, capex/D&A 3.93), check that the valuation packet contains reinvestment_history, and check that the META base scenario now emits that gap or sets da_to_revenue.

**Verifier check.** Confirmed: reinvestment_model = {capex_forecast:[137500000000], working_capital_forecast:[]}. history_ratios da_to_revenue is 0.0899 and capex_to_revenue 0.258. Every yearly driver leaves da_to_revenue null while capex_to_revenue is 0.30-0.56. Base schedules: FY2026 capex 137,503 vs D&A 22,710; FY2028 103,211 vs 28,996. The rationale quote 'a sourced return on new capital that the corpus does not provide' is in valuation_scenario_set. The operating-model prompt (:123) asks for 'the historical rate', but none is supplied. Corrections: (1) 'No code computes FCF ... ROIC' is too broad. MetricBook computes FCF, FCF margin, SBC ratios and ROIC, but only for the UI. (2) The proposed soft check would not fire on META. Base terminal capex/D&A is 103,211/28,996 = 3.56x, inside the 20-quarter TTM range (max 3.93x). The defect is that D&A stays on the revenue ratio while capex runs at 2-2.2x its history ratio, so D&A never follows the capex build. (3) NOPAT must use a normalized tax rate: META's quarterly effective rates are 87.5% (2025Q3) and -23.1% (2026Q1).

### RQ-ANA-6: Working-capital days cannot be computed: the inputs are not wired and the only helper is dead code with wrong formulas

Severity **medium**, effort **S**, verdict **corrected**, JD trait: Working-capital diagnosis (inventory days 31.5 -> 38.3, receivable days 5.9 -> 8.7)

**Problem.** Framework 4.9 requires DSO, DIO, DPO, cash-conversion cycle, and receivables vs revenue growth. MetricBook and financial-inputs carry no receivables, payables, inventory or deferred revenue input, although the statement set has 16-18 quarters of them. diagnostics.computeWorkingCapitalMetrics is unused and wrong: it divides payables and inventory by revenue instead of cost of revenue and calls NWC/revenue 'cash_conversion'. All 9 scenario yearly drivers have nwc_to_revenue_change null, so ΔNWC is 0 in every case. The report never mentions days. The stored data hold a signal worth explaining: payables-to-cost-of-revenue days rose from 42 (2024Q2) to 125 (2026Q1) as payables grew from $3.2bn to $13.3bn. Capex payables likely flatter OCF. The trade payables concept also changed in 2026Q2 (AccountsPayableTradeCurrent to AccountsPayableCurrent), which needs an alias.

**Evidence.** src/lib/research/reporting/metric-catalogue.ts:98-123 (BASE_INPUTS: no receivables, payables, inventory or deferred revenue); src/lib/research/valuation/financial-inputs.ts:11-29; src/lib/research/history/diagnostics.ts:164-179 (payables_days = payables/revenue*365, inventory_days = inventory/revenue*365); grep shows no caller outside the file. src/lib/research/valuation/engine.ts:123 (ΔNWC = (nwc_to_revenue_change ?? 0) x Δrevenue). SQL on operating_scenario_set: nwc_to_revenue_change null in all 9 yearly drivers. Statement set: us_gaap_AccountsReceivableNetCurrent 18 quarters, us_gaap_AccountsPayableTradeCurrent 17 quarters, us_gaap_AccountsPayableCurrent 2025Q4 and 2026Q2. Computed: DSO 34.8 days in 2026Q2 (median 34.7).

**Recommendation.** Add receivables, trade and total payables (as separate, labelled aliases), contract liabilities/deferred revenue and inventory to BASE_INPUTS. In financial_analytics, compute DSO on TTM revenue, DPO and DIO on TTM cost of revenue, CCC, NWC/revenue and the YoY change in NWC, each with stats and a concept_changed flag where the alias switches. Delete computeWorkingCapitalMetrics. Feed historyRatios a nwc_to_revenue_change default computed on annual (or YoY TTM) ΔNWC/Δrevenue, median of the available years and clamped, so ΔNWC is no longer an implicit zero. Verify on the META fixture: DSO about 34.8, DPO 2026Q2 present and flagged as total AP, and scenario statements naming the ΔNWC source.

**Verifier check.** Confirmed: BASE_INPUTS (metric-catalogue.ts:98-123) and financial-inputs COLUMNS have no receivables, payables, inventory or deferred revenue. computeWorkingCapitalMetrics (diagnostics.ts:164-179) divides payables and inventory by revenue and has no caller. engine.ts:123 defaults ΔNWC to 0, and all 9 yearly drivers have nwc_to_revenue_change null. Recomputed: DSO 34.8 days at 2026Q2. Payables days on TTM cost of revenue are 41.6 (2024Q2), 125.3 (2026Q1) and 139.2 (2026Q2, through AccountsPayableCurrent $15.9bn). Fact fixes: (1) 'Capex payables likely flatter OCF' is wrong. Unpaid capex accruals lower cash capex and so flatter FCF; trade-payable growth flatters OCF. (2) The 3.2bn to 7.7bn jump between 2024Q2 and 2024Q3 is suspicious, and AccountsPayableCurrent may be broader than trade payables, so the alias must be labelled before any trend is narrated. (3) A quarterly median of ΔNWC/Δrevenue is noisy: Q1 revenue often falls quarter on quarter, which flips the sign. META has no inventory, so DIO is not applicable there.

### RQ-ANA-7: Net cash, share-count change, buyback yield and SBC offset are not computed, and the capital-allocation chapter gets no financial data at all

Severity **high**, effort **S**, verdict **confirmed**, JD trait: Balance-sheet net cash computed (RMB128bn) with haircuts; buybacks as % of shares (6.3% in 2025); net share count on the monitoring dashboard

**Problem.** Framework 4.10 says capital allocation 'must be analyzed on a per-share basis'. No code computes net cash and its path, period-end share count change, buyback or dividend yield, buybacks as % of FCF, or the SBC offset ratio. Weighted diluted shares are missing for every Q4 (non-additive), and the period-end per-class counts that market-history already sums are not reused. The META capital-allocation section received only founder_profile and strategic_dna. It wrote 'the capital allocation series are not stored as a single comparable observation set'. It called share classes 'not sourced', although Class A and Class B counts are in the statement set. It described liquidity as ample against a $90bn headline and never computed net cash. market_price_history is excluded from report inputs, so the writer cannot compute yields itself.

**Evidence.** Report section packets: management-and-capital-allocation = founder_profile, strategic_dna. src/lib/research/reporting/store.ts:9 (market_price_history excluded). src/lib/research/reporting/metric-catalogue.ts:172 note ('Fourth quarters have no diluted share count'). docs/system.md:145 (market-history sums per-class CommonStockSharesOutstanding). Statement set: us_gaap_CommonStockSharesOutstanding for Class A and Class B over 18 quarters (2026Q2: 2,206m A + 342m B). Computed (cash + current marketable securities - LT debt): $49.0bn at 2024Q4, $18.2bn at 2025Q2, $6.6bn at 2026Q2 (15.46 + 74.80 - 83.66), the 6th percentile of 17 quarters. Shares 2,516m to 2,548m (+1.3% YoY). TTM buybacks $3.3bn vs $31.7bn. Buyback yield 0.23% vs 1.71% (market caps $1,435bn and $1,857bn from market_price_history). SBC 11.0% of TTM revenue. FCF-minus-SBC yield 1.1%.

**Recommendation.** Add a capital_allocation block to financial_analytics: a net cash series (cash + securities - debt, minus finance leases when captured, components listed); period-end shares summed over class members with the per-class split and YoY change; TTM buybacks, dividends and SBC; buybacks and dividends as % of FCF; buybacks/SBC; and buyback, dividend, FCF and FCF-minus-SBC yields on period-end market cap. Attach the block to management and capital-allocation sections. Verify on the META fixture: net cash 6.60bn, share change +1.27%, buyback yield 0.0023.

**Verifier check.** The capital-allocation section got founder_profile and strategic_dna only (outline 7e104218). store.ts:9 excludes market_price_history and docs/system.md:145 confirms that. Report lines 2615 and 2621 carry the quoted text. Recomputed: Class A + B period-end shares 2,516m (2025Q2) to 2,548m (2026Q2), +1.27%. TTM buybacks are $3.33bn (2025Q3 derived from FY 26.248bn) vs $31.74bn. Market caps of $1,435bn and $1,857bn from market_price_history give a buyback yield of 0.23% vs 1.71%. Net cash (cash + current securities - LT debt) is 48.99bn, 18.24bn and 6.60bn at 2024Q4, 2025Q2 and 2026Q2. Weighted diluted shares are missing for every Q4 (the note sits at metric-catalogue.ts:311, not :172). A related point: decision-synthesis.ts:128-137 latest_reported_metrics hands the model us_gaap_CommonStockSharesOutstanding as the Class A row only (2,206m), because it keeps one row per metric_key regardless of segment.

### RQ-ANA-8: Computed history never reaches the sections that need it: the report can only table raw observations, and the history chapter burns about 277K tokens on them

Severity **high**, effort **M**, verdict **corrected**, JD trait: Executive conclusion built on computed history (retail margin 4.0% -> 4.6% -> 5.6%) and moat rated against financial evidence

**Problem.** The writer may only cite tables as artifact paths and must 'not author or recalculate table values'. No derived table exists, so the 'Quarterly revenue and operating income ... (USD millions, GAAP)' table pointed at historical_record.observations and dumped about 2,300 raw rows of every metric in dollars, 72% of the report. The history section packet was 454 KB of raw observations: 277,509 input tokens for 3,563 output tokens. The evidence-gaps section paid about 356-366K. Meanwhile the sections that must reason with history (capital allocation, constraints, valuation, executive judgment) got none. Moat and business analysis run before or without the record: framework 7.7 says 'Every moat claim must be tested against the 20-quarter record', yet the moat packet contains no financial data. With the stronger models the user wants for deeper analysis, the raw history becomes the dominant cost.

**Evidence.** src/lib/research/reporting/runtime.ts:104 (table rule), :88-90 (sections get only outline-selected artifacts); src/lib/research/reporting/packet.ts:35-38 (whole historical_record encoded as a series_table). Report section table path: 'Quarterly revenue and operating income, Meta consolidated (USD millions, GAAP)' -> artifact 80d656a0 path 'observations' (report.md lines 187-2516 of 3,225). Packet bytes: historical-performance 453,954 (historical_record only); management-and-capital-allocation 10,971 (founder_profile, strategic_dna); operating-constraints 5,958. model_call_logs: report:section:historical-performance 277,509 in / 3,563 out; evidence-gaps 355,692 and 365,707 in. src/lib/research/team-plan.ts:46-47 (business_process_analysis depends on company_genesis; moat_analysis on business_process_analysis); moat-analyst task upstream_artifacts = bottleneck_register, business_process_map, competitive_response_matrix, customer_decision_map, segment_model. src/lib/research/run-context.ts:414 adds the full historical_record to any dependent's packet.

**Recommendation.** Put financial_analytics in the shared part of the report packet (a top-level key in common, before the per-call keys) so every section, the outline and the review see it once and it caches. Replace historical_record in loadReportInputs-based report packets (outline, sections, review) with the pack plus a code-built 20-quarter statement summary, and keep the full record only for keepUsableReferences. Add outline rules pointing to the pack's table paths (tables.quarterly_economics, tables.segments, tables.capital_allocation). Make business_process_analysis and moat_analysis depend on historical_record, and change run-context.ts:414 to add financial_analytics instead of historical_record. Replace recent_reported_history in operating-model.ts with the pack. Verify on a mock run that the artifacts part of the history section packet is under 40 KB and that no raw-observation table is rendered. On a user-approved paid run, historical-performance input should be about 90-100K tokens, and the outline and review should drop by about 180K each.

**Verifier check.** Confirmed: runtime.ts:104 bars authored or recalculated tables, runtime.ts:86-87 sends sections only the selected artifacts, and packet.ts:35-38 encodes the whole record. The historical-performance section's only artifact was historical_record, and its tables point at 'observations' (report.md:187 to about 2,510). model_call_logs: historical-performance 277,509 in / 3,563 out (615,668 input bytes); evidence-gaps 355,692 and 365,707 in. Corrections: (1) The token target is wrong. Sections without historical_record already cost 81-90K input tokens (origins 88,692; operating-constraints 81,521; 203-225 KB), so 'under 60K' cannot be met. Realistic: about 90-100K, saving about 180K per history call and about 270K per evidence-gaps call. (2) The largest calls are not sections. The outline (403,563), the two reviews (481,362 and 476,438) and team:requests (about 380K) all carry the full historical_record through common.artifacts (runtime.ts:51-57). (3) The section artifacts key is a perCallKey (runtime.ts:93), so appending the pack there is paid in every call; a top-level key in the shared part is cached. (4) run-context.ts:414 affects only direct dependents of historical_record (today only the deterministic historical_diagnosis), so point (3) matters only together with the new dependencies.

### RQ-ANA-9: Monitoring KPI current levels are typed by the model; code fills only deposits and diluted shares

Severity **medium**, effort **S**, verdict **corrected**, JD trait: Monitoring dashboard of five computed numbers (retail margin, new-business loss, TTM FCF, inventory days, net share count)

**Problem.** Thesis breakers and the monitoring dashboard depend on current levels and thresholds. Code overwrites the model's current_level only for KPIs whose names match /total deposits/ or /diluted shares/. All other current levels in META came from model arithmetic: capex intensity 0.495, operating margin 0.309, derived FCF 1,746 and RL loss -4619. None carries the 20-quarter median or percentile that would show whether a threshold is extreme. Once financial_analytics exists, matching by metric_key is trivial and makes the dashboard deterministic.

**Evidence.** src/lib/research/handlers/decision-synthesis.ts:245-263 (regex overrides for deposits and diluted shares only), :228-229 (prompt asks the model to set current levels). Report 'Capex and cash-flow thresholds linked to model inputs' rows: capex_pct_revenue_quarterly current_level 0.495 ('Q2 2026: 30,116 / 60,801'), operating_margin_gaap_quarterly 0.309, free_cash_flow_quarterly_derived 1746 ('Analyst-derived, not a company-reported measure').

**Recommendation.** After finalizeDecisionOutput, match each monitoring item's metric_key, not its name, against financial_analytics, with a short suffix alias map (_quarterly, _derived, _gaap). On a match, set current_level from code, add history_median and history_percentile, and set source_role to 'financial_analytics <period>'. Remove the name regexes. Build latest_reported_metrics from consolidated rows only (no segment), with class totals taken from the pack. Offer the pack's metric keys as the allowed key list in indicator design. Unit test: a META item with metric_key operating_margin_gaap_quarterly gets 0.3088 and its percentile whatever the model wrote, and a 'Diluted share count' item is overridden.

**Verifier check.** Confirmed, and worse than stated. decision-synthesis.ts:245-263 overrides current_level only when the KPI name matches /total deposits/ or /diluted shares/. On META the KPI is named 'Diluted share count', so the regex missed it, and its source_role is still the model's ('Income statement, Q2 2026 10-Q; Class B share count not reviewed'). So 0 of 9 monitoring current levels came from code. The levels match the reviewer's list: capex 0.495, operating margin 0.309, FCF 1746 (OCF 31,862 - capex 30,116), RL -4619. In addition, latest_reported_metrics (:128-137), which the prompt (:228) tells the model to use, keeps the first row per metric_key regardless of segment. For us_gaap_CommonStockSharesOutstanding that gives the Class A row only (2,206m), and the same happens for 5 other keys (SBC, restricted cash, restructuring...).

### RQ-ANA-10: Unused and incorrect analytics helpers in diagnostics.ts and normalizer.ts invite wrong reuse

Severity **low**, effort **S**, verdict **confirmed**

**Problem.** Several exported helpers are never called by the pipeline. Some are wrong, so wiring them in would produce bad numbers. computeIncrementalMargins sorts by fiscal_year only and pairs revenue and profit by array index rather than by period, so a gap in either series misaligns every later pair. computeWorkingCapitalMetrics uses the wrong denominators (RQ-ANA-6). perShare and computeGrowthRate (growth 0 for the first element) are untested and unused. buildMELIAdjustedFCFBridge and separateMELIRevenueDefinition are test-only, issuer-specific helpers.

**Evidence.** src/lib/research/history/diagnostics.ts:65-67, :91-113 (sort by fiscal_year only; profits[i] paired with revs[i]), :164-183; src/lib/research/history/normalizer.ts:251-281. Grep: no src caller outside the defining files; only tests/historical-record.test.ts:7-8,143-150 uses the MELI helpers.

**Recommendation.** Delete computeGrowthRate, computeIncrementalMargins, computeWorkingCapitalMetrics and perShare when financial_analytics lands. Delete the MELI helpers together with their test cases. Verify with npm run lint, npx tsc --noEmit and npm run test:unit.

**Verifier check.** diagnostics.ts:65-67 (computeGrowthRate returns 0 for the first element), :91-113 (computeIncrementalMargins sorts by fiscal_year only and pairs profits[i] with revs[i] by index), :164-183 (wrong denominators, perShare). Grep finds no src caller outside the defining files; perShare matches only an unrelated perShareUnit in method-protocol.ts. buildMELIAdjustedFCFBridge and separateMELIRevenueDefinition are used only in tests/historical-record.test.ts:7-8,143-150. detectInflections is still used by diagnosis.ts:50, so it stays until RQ-ANA-3 is done.

## RQ-VAL: Valuation engine depth and sanity

The valuation engine is deterministic and well tested on arithmetic, but it is shallow and has blind spots that decide the answer. Its whole economic content is a 3-year driver DCF whose terminal value is one NOPAT multiple the LLM picks freely. In META that terminal value was 99-129% of enterprise value. With the same packet, the multiple moved from 18x to 14x between two attempts 7 minutes apart, and base value per share fell from $514 to $395. The $378 weighted value against a $743 price is partly an artefact. A 14x multiple after 2028 implies about 2.4% perpetual growth and 10% reinvestment, while 2028 itself has 12% growth and 75% reinvestment. Fixing the terminal value with a fade (the forecast years between the explicit horizon and the terminal year), the dating/stub-period conventions and the equity bridge moves the base value to roughly $504-626. A 3x3 discount-rate x terminal-growth grid then spans $445-748, so "expensive at a 9% cost of capital" survives but "-49%" does not. The discount rate is not the driver. The pieces the JD example relies on are missing or left to the model: a no-rerating return (null in META), a reverse DCF in FCF-growth or implied-multiple terms (the engine reports a meaningless 64% margin), own-history and FCF-yield cross-checks, the operating x valuation-assumption matrix, below-bear stress cases, segment SOTP, and FX/ADS handling (JD would be valued in RMB per ordinary share against a USD ADS price). The required "multiple" and "cash_flow" lenses and the exit_multiple_dcf and reverse_dcf modules pass their gates with placeholder rows. The smallest high-leverage set of changes: (1) a value-driver terminal value with code-generated fade years; (2) a code-computed cross-check block (no-rerating return, implied terminal multiple and growth, own-history multiples and FCF yield, terminal-value share of EV, value/price gap attribution) that also feeds real lens signals; (3) valuation-assumption sets separated from operating cases, giving a 3x3 grid plus an r x g grid; (4) date/stub and bridge fixes; (5) FX and ADS conversion.

<details><summary>Measurements</summary>

All figures in USD millions unless noted. They come from read-only SELECTs on research_artifacts and research_tasks for run 4fae0fb1, reproduced in /private/tmp/claude-501/-Users-japardinathaniel-Documents-GitHub-Investing-Research-Pipeline/fdaaf424-0588-4f7e-be73-9b055f9db53a/scratchpad/scripts/meta_val.py, meta_rev.py and meta_combo.py. Artifact dumps are in /private/tmp/claude-501/-Users-japardinathaniel-Documents-GitHub-Investing-Research-Pipeline/fdaaf424-0588-4f7e-be73-9b055f9db53a/scratchpad/val/.

Stored META valuation:
- Value today: bear $119.05, base $395.17, bull $603.67; weighted 25/50/25 = $378.3 vs $742.96 price.
- FY2028 anchors: 216.17/528.69/768.04; weighted_target 510.40.
- Base: EV 1,036,060; explicit PV -28,526; TV PV 1,064,585 (102.8% of EV; bear 128.7%, bull 99.3%); bridge -22,058; 2,566m shares.
- Base 2028: NOPAT 98,476; capex 103,211; D&A 28,996; reinvestment 75% of NOPAT; growth 12%.

Market and multiples:
- Market cap 1,906,435; EV 1,928,493; EV/NOPAT FY25 28.8x; the price implies 25.7x 2028 NOPAT.
- Own-history market cap / NOPAT, approximate: 29.6, 24.5, 13.5, 24.1, 26.6, 25.0x for 2020-25.
- 14x NOPAT at 9% implies g = 2.4% at 25% RONIC.

Reverse valuation:
- Stored: implied margin 64.0%, implied growth 43.2%.
- Alternatives: 9.8%/yr 10-year growth from FY25 NOPAT (14.7% from OCF-capex), or 5.8% perpetual growth at 25% RONIC.
- No-rerating base: $1,087, +46% over 3 years (13.5%/yr).

Variants on the base case:
- Date/stub fix: +$37.
- Drop operating-lease double count: +$11.2.
- Add non-marketable equity investments: +$11.8.
- Fade to 2035 with value-driver terminal: $441/$514/$555 at RONIC 15/25/40%.
- All fixes combined: $504/$582/$626.
- r x g grid at RONIC 25%: $445 (10%, 2%) to $748 (8.5%, 4%).
- Matrix cells: bear ops x base valuation $196.5; base ops x bear valuation $260.9.
- RL drag inside TV: -$74.5/share.

Instability between attempts (7 minutes apart, the only input difference a team request): multiples 14/18/20x -> 10/14/16x; base PV $513.71 -> $395.17; weighted about $491 -> $378.

D&A:
- Engine: 22.7/25.9/29.0bn for 2026-28.
- PP&E roll-forward at 14-15% of opening net PP&E: about 27.0/43.9/54.8bn. Net PP&E: 176,400 FY25, 225,724 Q2-26.

Gates: valuation_signals for dcf, multiple and cash_flow all equal 528.687, 'inconclusive', 0.5. 13 module tasks were auto-completed.

Model calls: valuation-analyst made 6 calls, 377,657 input and 25,758 output tokens, $0.051. Neither a CAPM beta nor an ERP was in this run: cost-of-capital.ts landed 2026-10-14, and no stored market_price_history has a beta yet.

</details>

### RQ-VAL-1: Terminal value is an unanchored LLM-chosen NOPAT multiple after a 3-year horizon; it decides the valuation and is unstable

Severity **high**, effort **M**, verdict **corrected**, JD trait: JD s12-13 normalized FCF 2026-2031 per scenario feeding the DCF; framework 5.8 moat-to-model translation (forecast fade period, terminal margin, terminal growth); Gate 13 reinvestment

**Problem.** The FCFF schedule has 3 explicit years (forecastHorizon default 3), then either a NOPAT multiple the model chooses with only a nonnegative check, or a Gordon growth value on the last year's raw FCFF. During a capex peak, Gordon on raw FCFF capitalises peak capex forever, so the model always picks the multiple. A low multiple at year 3 counts the full cost of the capex in 2026-28 but almost none of the growth it buys after 2028. Nothing ties the multiple to the terminal year's growth, reinvestment, ROIC, the stock's own multiple history or the CAPM rate, so a re-ask can move value 23% with no new evidence.

**Evidence.** engine.ts:26 (Terminal type), engine.ts:149-151 (multiple x final-year NOPAT), engine.ts:302-305 (multiple only .nonnegative()), engine.ts:330-338 (only checks r>rf and g<r), engine.ts:355-357 (default 3 years), schedules.ts:30 (perpetuity on years.at(-1).cash_flow). META valuation_scenario_set.method_schedules: base TV 1,378,669 = 14 x 98,476 NOPAT; TV PV 1,064,585 vs EV 1,036,060, so TV is 102.8% of EV (bear 128.7%, bull 99.3%). Base 2028: revenue growth 12%, capex 103,211 vs D&A 28,996, net reinvestment 74,215 = 75% of NOPAT. 14x NOPAT at r=9% implies g=2.4% and reinvestment 10% at 25% RONIC (2.6%/13% at 20%). Own history (market_price_history market_cap / (OI x (1-0.1965)), approximate): 2020 29.6x, 2021 24.5x, 2022 13.5x, 2023 24.1x, 2024 26.6x, 2025 25.0x, so 14x sits at the 2022 trough. Current EV/NOPAT FY25 is 28.8x, and the price implies 25.7x 2028 NOPAT. Instability: research_tasks valuation-analyst:valuation:0ff25d81 (14:51) chose multiples 14/18/20x and rates 10/9/9%. valuation-analyst:valuation:8ab1e740 (14:58) chose 10/14/16x and 11/9/8.5%. Diffing input_json shows the only change was team_context.requests (a reviewer asking to reconcile PV vs undiscounted returns and state the TV share). Base PV went $513.71 to $395.17, and the weighted PV went about $491 to $378. Those first-attempt numbers are the '190.56, 513.71, 745.09 earlier draft' figures in the report. Variant run (scratchpad/scripts/meta_val.py): fade 2029-2035 (growth 12% to 3%, margin flat, reinvestment = g/RONIC x NOPAT, Gordon value-driver terminal) gives base $441/$514/$555 at RONIC 15/25/40% vs $395, with TV share 73-79%.

**Recommendation.** Add a value_driver terminal to engine.ts: {type:'value_driver', growth_rate, ronic, fade_years}, the default for FCFF. Code appends the fade years: growth interpolates to g, the margin is held (or a terminal_margin is given), reinvestment = g_t/RONIC x NOPAT_t. TV = NOPAT_T+1 x (1 - g/RONIC)/(r - g).

Code pre-computes a RONIC default from the explicit period's incremental ROIC (change in NOPAT / cumulative net reinvestment, lagged one year) and the history ROIC (metric-catalogue roic). The model may depart from it only with a stated rationale, and the rationale and both numbers are stored.

Keep the NOPAT multiple as a reported cross-check. For any multiple, report the implied g and reinvestment at the default RONIC. Warn when the implied reinvestment differs from the final explicit year by more than 25 points, or when the multiple is outside the own-history range. Validate g <= risk-free rate.

Verify:
(a) A unit test: fade_years=0 and RONIC -> infinity reduces to Gordon on NOPAT.
(b) A META replay test: the stored implied reinvestment equals g/RONIC in every fade year, and the TV share is reported (no value band).
(c) Replaying both stored packets with the same (g, RONIC) gives identical values, so value moves only through visible, stored parameters.

**Verifier check.** Code claims hold. engine.ts:26 and :149-151: the terminal value is the multiple times final-year NOPAT. engine.ts:303 only checks that the multiple is nonnegative. engine.ts:330-338 only checks r > rf and g < r. schedules.ts:30 bases the perpetuity on the raw last-year FCFF. The horizon comes from operating-scenarios.ts:62 via forecastHorizon (engine.ts:356, default 3). The prompt does say 'Calibrate it to each scenario's growth, margins and reinvestment' (asset-valuation.ts:38), but no code check enforces it.

Stored META method_schedules: base TV 1,378,669 = 14 x 98,476; TV PV 1,064,585; explicit PV -28,526. That makes TV 102.8% of EV (bear 128.7%, bull 99.3%). 2028 net reinvestment is 103,211 - 28,996 = 74,215, or 75% of NOPAT.

Instability: research_tasks ec90ff8e (14:51) chose 14/18/20x at 10/9/9%. Task 628edb46 (14:58) chose 10/14/16x at 11/9/8.5%. Diffing val_in1/val_in2 shows only team_context.requests changed (0 to 5 items; request-1-1 asks for PV reconciliation and the TV share). Across runs, META base value was $376 (02c8d48b, 10-08), $478 (7fa1f00a, 10-11) and $395 (4fae0fb1). Both code-built runs picked multiples.

Correction on magnitude: I reran meta_val.py. The fade value depends heavily on RONIC. The stored drivers' own incremental ROIC is about 11-15%: NOPAT +31,566 FY25-28 on 278,309 of net reinvestment, or +29,689 FY26-28 on 204,094. At RONIC 11/12/15% the reviewer's fade gives $375/$396/$441, which is about the stored $395. Only RONIC 25-40% gives $514-555. At RONIC 12%, 14x implies about 4% growth and 34% reinvestment, not 2.4%/10%. The 'artefact' framing is therefore overstated: the robust defects are an unanchored and unstable multiple, TV about 100% of EV, and no consistency check. Verification (b), a $440-560 band, bakes in an assumption and is not a valid test. Also, RESEARCH_FORECAST_YEARS (max 10) exists, but lengthening the horizon alone just carries the 25.8% history capex ratio (history_ratios) into later years.

### RQ-VAL-2: No-rerating return and multiple/FCF-yield cross-checks are left to the model (null in META) though code has every input

Severity **high**, effort **S**, verdict **confirmed**, JD trait: JD s15 FCF-yield cross-check (6.4-8.9x, 13-16% yield) and s16 no-rerating 5-year outcome per case; framework Stage 21

**Problem.** Framework Stage 21 requires 'expected return without multiple expansion' and 'if the current premium remains unchanged'. JD s15-16 lead with an FCF-yield cross-check and per-case no-rerating CAGRs. Here no_rerating_return, weak_stock_outcome and permanent_loss_limit are model 'judgment' fields, and the engine computes no current or historical multiple. In META the model returned null for no-rerating and copied the bear return into the other two. The single most informative fact went unstated: the DCF conclusion is a de-rating from about 29x to 14x NOPAT.

**Evidence.** decision/finalize.ts:29 JUDGMENT_KEYS = no_rerating_return, weak_stock_outcome, permanent_loss_limit (model-owned); handlers/decision-synthesis.ts:225 asks the model to 'Judge no_rerating_return...'. META expected_return_matrix: no_rerating_return null, weak_stock_outcome = permanent_loss_limit = bear_return = -0.709049. Computed (scratchpad/scripts/meta_val.py): market cap 1,906,435 and EV 1,928,493 give EV/NOPAT 28.8x FY25 and 28.0x FY26. Holding 28.8x on base FY28 NOPAT plus cumulative FCFF gives $1,087, a +46% 3-year return (13.5%/yr), against the DCF's -28.8% FY2028 return. Market FCF yield on FY25 OCF-capex (115,800 - 69,691) = 2.4%. The engine's own FY25 FCFF basis (NOPAT + D&A - capex) = 15,835, because SBC (20,427) is treated as a cash cost. That is defensible but nowhere disclosed. The data already exists: financial_inputs carries market_cap per period (financial-inputs.ts:30, 113-120), and reporting/metric-catalogue.ts:265 and :284-309 already compute price/operating income, P/FCF, EV and FCF yields deterministically.

**Recommendation.** As proposed. Add a code-owned cross_checks block in engine.ts, called from asset-valuation.ts after assembleValuation, containing:
- current EV/NOPAT, EV/EBIT, P/FCF and FCF yield, on both the OCF-capex and NOPAT+D&A-capex bases, with the SBC treatment stated;
- the own-history min/median/max over at least 5 years, read from market_price_history market_cap or by raising the financial_inputs years for this purpose;
- per scenario, the no-rerating value = (current EV/NOPAT x NOPAT_N + bridge + cumulative FCFF)/shares, with its return and CAGR;
- implied_multiple_change = terminal multiple / current multiple.

Pass no_rerating_return into finalize as code-owned and remove it from JUDGMENT_KEYS. Keep weak_stock_outcome as judgment.

Verify: the META replay gives EV/NOPAT 28.8x and no-rerating about +46%. A tests/decision-finalize.test.ts case asserts that no_rerating_return is non-null whenever valuation is complete and a market price exists.

**Verifier check.** decision/finalize.ts:29 makes no_rerating_return, weak_stock_outcome and permanent_loss_limit model judgments. Code sets only status, bear/base/bull and weighted (finalize.ts:134-142). decision-synthesis.ts:225 tells the model to judge them.

Stored expected_return_matrix: no_rerating_return null; weak_stock_outcome = permanent_loss_limit = bear_return = -0.709049. Report line 2791 admits 'No-rerating return is not computed in the stored matrix (the field is null)'. The report never states META's current multiple.

Reran meta_val.py: market cap 1,906,435, EV 1,928,493, EV/NOPAT FY25 28.8x. The no-rerating FY28 value is (28.8 x 98,476 - 22,058 - 27,748)/2,566 = $1,086.7, so +46.3% (13.5%/yr). The price implies 25.7x 2028 NOPAT. The FY25 FCF yield is 2.4%.

The inputs exist: financial_inputs has a market_cap column (financial-inputs.ts:30, :113-120), and metric-catalogue.ts:254-293 has EV, price/operating income and P/FCF.

Caveat: financial_inputs carries only 4 annual years (financial-inputs.ts:127, years ?? 4), so the own-history range would be 2022-25 (13.5/24.1/26.6/25.0x). The 2020-21 points came from market_price_history.

### RQ-VAL-3: Reverse valuation solves for a uniform 3-year margin or growth under the model's own terminal multiple, so its answer is uninterpretable

Severity **high**, effort **S**, verdict **confirmed**, JD trait: JD s14 reverse DCF in FCF-growth terms (price implies ~2.7% FCF growth; flat FCF -> ~$31); framework Stage 19, Gate 14

**Problem.** impliedOperatingMargin and impliedRevenueGrowth replace one driver in all 3 years while holding the chosen 14x terminal. The solver has to fit the entire price gap into 3 years, so it returns numbers no business could produce (64% margin, 43% growth). The report then concludes the price is implausible, which is circular: the price looks implausible only because of the assumed terminal value. Framework Stage 19 and JD s14 express market expectations as implied FCF growth, terminal growth or an implied multiple, and translate them into operating requirements.

**Evidence.** engine.ts:257-272 (reverseValue overrides one field in every driver year, keeps assumptions.terminal), asset-valuation.ts:534 and :548-552. META reverse_valuation: implied_margin 0.640418, implied_growth 0.432409, against FY25 margin 41% and Q2-26 31%. The report (lines 13 and 2785) uses these to call the price implausible. Interpretable alternatives computed in scratchpad/scripts/meta_rev.py: the price needs 25.7x 2028 NOPAT (vs 14x assumed); or 5.8% perpetual growth after 2028 at 25% RONIC (5.5% at 40%); or 9.8%/yr owner-earnings growth for 10 years then 3% from FY25 NOPAT 66,910 (14.7%/yr from FY25 OCF-capex 46,109). A flat NOPAT perpetuity at 9% gives $281.

**Recommendation.** Extend ReverseValuation (contracts.ts:70-74, nullable fields) and compute in engine.ts:
- implied_terminal_multiple (closed form: (price x shares - bridge - PV explicit) x (1+r)^N / NOPAT_N);
- implied_perpetual_growth at the default RONIC under the RQ-VAL-1 terminal (reuse solve());
- implied_fcf_growth_10y on a normalized FCF base (NOPAT - (capex - D&A)), plus the OCF-capex variant, then the base terminal growth.

Keep margin/growth as secondary fields. Add code-computed own 3-5 year revenue and FCF CAGRs from financial_inputs, so the model only classifies the result (easy ... operationally inconsistent, framework Stage 19). Update valuation-summary.ts to lead with the implied multiple and growth.

Verify: a closed-form unit test, and the META replay gives about 25.7x and about 10% for 10 years.

**Verifier check.** engine.ts:257-272: reverseValue overrides one driver field in every year and keeps assumptions.terminal (14x). asset-valuation.ts:534 and :548-552 store the result.

Stored: implied_margin 0.640418, implied_growth 0.432409.

Reran meta_rev.py and checked the closed form: (1,928,493 + 28,526) x 1.09^3 / 98,476 = 25.7x. The price implies 5.8% perpetual growth at 25% RONIC, or 9.8%/yr for 10 years from FY25 NOPAT 66,910 (14.7% from OCF-capex).

The circularity reaches the reader. The report's executive section concludes 'The gap is far larger than any plausible difference in discounting basis, so the conclusion does not depend on how the reverse calculation is framed'. That is false, because the frame fixes the 14x terminal. valuation-summary.ts:252-271 shows the same margin/growth as 'price implies' on the summary page.

### RQ-VAL-4: Valuation assumptions are welded to operating cases, so there is no 3x3 operating x valuation matrix and no sensitivity grid

Severity **high**, effort **M**, verdict **corrected**, JD trait: JD s13 DCF matrix: operating case (bear/base/bull) x valuation assumptions (conservative 15%/1.5%, base 13.5%/2%, aggressive 12%/2.5%); JD s1 seven-cell valuation table; framework Stage 17

**Problem.** Each scenario_type carries its own discount rate and terminal value. The bear case therefore stacks valuation pessimism (11%, 10x) on operating pessimism, and the bull case stacks optimism. The framework explicitly forbids this and requires a 3x3 matrix. A single point estimate per case is also against 'present a DCF as a range'. The reader cannot tell how much of the bear gap is business and how much is the discount rate.

**Evidence.** engine.ts:27 (ValuationAssumption = {scenario_type, discount_rate, terminal}), engine.ts:306-313 (exactly one per bear/base/bull), assembleValuation engine.ts:175-234 (one schedule per scenario). docs/research-framework-v2.1.md:1618 'Produce a 3 x 3 operating-versus-valuation matrix', :1620-1623 'Do not automatically combine Bear operations with the highest discount rate', :1664 range not point. META stored: bear 11%/10x = $119.05, base 9%/14x = $395.17, bull 8.5%/16x = $603.67. Recomputed (meta_val.py): bear ops x base valuation (9%, 14x) = $196.5; base ops x bear valuation (11%, 10x) = $260.9; bull ops x base valuation = $520.2. So about 40% of the bear case's distance from base is valuation pessimism, not operations. Sensitivity grid on corrected base (meta_combo.py, RONIC 25%): r 8.5% -> $572/$644/$748 at g 2/3/4%; r 9% -> $524/$582/$664; r 10% -> $445/$485/$538. The $742.96 price sits at the aggressive corner.

**Recommendation.** Replace the per-case assumptions with three valuation sets {conservative, base, aggressive}, each {discount_rate, terminal}. Code pre-fills CAPM +1pt / CAPM / -1pt, with debt weights applied when material, otherwise labelled 'CAPM cost of equity used as WACC'. The model may adjust a set only with a stated rationale.

In assembleValuation compute:
- a 9-cell value-today grid (operating case x valuation set);
- an r (+/-1pt) x g (+/-1pt) grid on base operations, at the stored RONIC default.

Store both as valuation_matrix and sensitivity_grid. Keep anchors and the probability weighting on the base valuation set, so downstream contracts don't change.

Verify:
- A unit test: 9 finite cells, and with equal sets the base row reproduces today's anchors.
- The META replay: bear ops x base valuation = $196.5.

**Verifier check.** engine.ts:27 and :306-313: exactly one {discount_rate, terminal} per operating case. assembleValuation (engine.ts:175-234) builds one schedule per case. The framework requires a 3x3 matrix, forbids pairing bear ops with the highest rate (research-framework-v2.1.md:1618-1623) and asks for a range (:1664). META stored bear 11%/10x, base 9%/14x, bull 8.5%/16x.

Reran meta_val.py: bear ops x base valuation $196.5; base ops x bear valuation $260.9; bull ops x base valuation $520.2. Valuation pessimism accounts for 28% (77.5 of 276.1) to 49% (134.3) of the bear-base gap depending on order. 'About 40%' is only the average.

The r x g grid ($445-748) is computed at RONIC 25% with all fixes. At the drivers' own incremental ROIC (about 11-15%) it shifts down, so the summary's claim that '-49% does not survive' is not established.

CAPM (cost-of-capital.ts:171-176) is a cost of equity; for FCFF it is a WACC approximation. That is fine for META (debt about 4% of EV) but should be labelled.

Effort is closer to M: model contract, engine, handler, summary page and report writer all change.

### RQ-VAL-5: Required valuation lenses and modules pass the gates with placeholder rows; reconciliation flags are hard-coded true

Severity **medium**, effort **S**, verdict **corrected**, JD trait: Framework Stage 18 'use at least two valuation methods'; JD s15 independent cross-check

**Problem.** The operating_company profile requires dcf, multiple and cash_flow lenses plus exit_multiple_dcf, reverse_dcf, roic and working_capital modules. asset-valuation writes one 'inconclusive' signal per required lens, each with the same base FY2028 anchor and cheapness 0.5. The workflow validator only checks that a row exists for each lens. Modules count as covered by any completed asset_valuation task. The run therefore 'passes' a multiples lens while omitted_methods says peer multiples were not done. Separately, assembleValuation always writes uses_adjusted_fcf:true and segments_reconciled:true, so the FCF and SOTP blocking checks in validation.ts can never fire.

**Evidence.** asset-valuation.ts:622-643 (requiredLenses.map -> current_value_text String(baseAnchor), signal 'inconclusive', cheapness 0.5); workflow/validators.ts:571-589 (lens check = row exists); validators.ts:546-560 (exit_multiple_dcf, reverse_dcf -> any completed asset_valuation task); asset-valuation.ts:702-716 (module tasks auto-completed 'covered_by asset_valuation'). DB: valuation_signals for run 4fae0fb1 has dcf, multiple and cash_flow all at 528.6870492933305, 'inconclusive', 0.5. The profile's required_valuation_lenses_json is [dcf, multiple, cash_flow]. research_tasks shows 13 module tasks (business_segments ... reverse_dcf) completed 14:51:22-14:58:44 with no content. engine.ts:204 hard-codes the flags that validation.ts:58-68 tests.

**Recommendation.** Once RQ-VAL-2 exists, write real lens values:
- dcf = weighted value today;
- multiple = own-history-median EV/NOPAT x forward NOPAT, plus bridge, per share;
- cash_flow = value at the own-history FCF yield.

Derive signal and cheapness from value/price. When a lens cannot be computed, write 'not_applicable' with the reason, and have validators.ts:575-589 report a not_applicable required lens as a gap.

Create module tasks only for modules actually produced. Set segments_reconciled from operating_model (segment OI sums to consolidated within 0.5%) and leave uses_adjusted_fcf as is.

Verify: the META replay gives three distinct lens values, and a unit test with no multiple inputs makes the profile gate report the gap.

**Verifier check.** Confirmed:
- asset-valuation.ts:633-642 writes one 'inconclusive'/0.5 signal per required lens, all carrying the base FY2028 anchor (not value today).
- The DB shows dcf, multiple and cash_flow all at 528.6870492933305, 'inconclusive', 0.5.
- research_profiles operating_company requires [dcf, multiple, cash_flow].
- validators.ts:575-589 checks only that a row exists; validators.ts:545-570 maps exit_multiple_dcf and reverse_dcf to any completed asset_valuation task.
- 13 profile_module tasks completed at 14:58:44 with only {module_key, covered_by}.

Corrections:
- uses_adjusted_fcf:true (engine.ts:204) is accurate by construction on the FCFF path, which is always NOPAT + D&A - capex and never CFO-capex, so that half of the claim is wrong.
- segments_reconciled:true does have an effect: it suppresses the valuation-summary.ts:233 issue line.
- The signals feed only the gate and the asset UI (the valuation-signals API), not the report, so high overstates the impact. This is gate integrity, mostly fixed for free once RQ-VAL-2 exists.

### RQ-VAL-6: No FX or ADS conversion: a JD run would compare RMB per ordinary share with a USD per-ADS price

Severity **high**, effort **M**, verdict **corrected**, JD trait: JD s2 ownership chain ADS -> Cayman holdco -> residual per ADS

**Problem.** The engine takes currency from the financial statements, and market_price_currency is set to the same value, so the currency-mismatch validator can never fire. There is no exchange rate and no ADS ratio anywhere in the valuation path. JD, the user's benchmark, reports in RMB and trades as a USD ADS equal to 2 Class A shares. Every value per share, return and reverse result would be off by about 2/7.1 (0.28x) with no error raised. Every asset valued so far reports in USD, so this has never surfaced.

**Evidence.** engine.ts:213 (market_price_currency: currency); asset-valuation.ts:409 (currency = financialInputs.currency || price currency); validation.ts:31-33 (the C11-T10 currency check is unreachable because both fields are equal); grep for exchange_rate, fx_rate, ADS or depositary in src/lib/research/valuation, asset-valuation.ts and src/lib/market-data returns nothing. DB: annual_price_target_path currencies across all valued assets are USD only (mercado-libre, meta-platforms, nuscale-power, sofi).

**Recommendation.** When the statement currency differs from the price currency:
- Require an FX rate at the cutoff (FRED, for example DEXCHUS, fetched like DGS10) and an ADS ratio (an asset field, or the dei/20-F cover fact; 1 only for ordinary listings).
- Add both to valuationReadiness (engine.ts:278-289) so the valuation is withheld rather than wrong.
- Convert value per share to price currency x ADS ratio, and set market_price_currency from the price source, so validation.ts:31 is live.
- Apply the same conversion (or a per-ADS share basis) when computing market_cap in price-history.ts and before any multiple in financial-inputs/metric-catalogue.

Verify:
- A unit test: CNY statements, a USD price and ratio 2 give a USD per-ADS value.
- A mock JD run shows matched currencies, correct market-cap multiples, and a readiness gap when FX is absent.

**Verifier check.** Confirmed. asset-valuation.ts:409 takes the currency from financial_inputs first. engine.ts:213 sets market_price_currency equal to it, so the validation.ts:31-33 check cannot fire. grep finds no exchange_rate, fx_rate, ADS or depositary handling in src (only an fx_rate driver key in archetypes/registry.ts:626). The FPI path exists (corpus.ts:599-605 handles 20-F and 6-K), so a JD run is reachable and would compare RMB per ordinary share with USD per ADS (2 shares).

The reviewer missed a second impact. market_cap history is USD close x ordinary shares, currency taken from the bar (price-history.ts:223). financial-inputs.ts:90 does not currency-filter the market rows, while statements are filtered to the revenue currency (:87-89). So own-history multiples (RQ-VAL-2) and metric-catalogue price ratios would also mix USD market caps with RMB profits and double-count the ADS ratio.

### RQ-VAL-7: Timing conventions: full-year discounting from the valuation date, the whole first year counted against a mid-year bridge, constant-bridge price path

Severity **medium**, effort **S**, verdict **corrected**, JD trait: Framework Stage 21 expected return = value growth + cash yield + valuation change - dilution

**Problem.** Discount factors are whole years (1/(1+r)^(i+1)) whatever the valuation date. The first fiscal year's full FCFF is counted although the bridge is already at the latest quarter end. The yearly price path adds today's bridge to every year-end value and ignores the cash generated or consumed in between, with dividends set to 0. The result is a spurious year-end jump and returns that leave out interim FCF: overstated for cash burners, understated for normal cash generators. Value today, FY-end anchors and the weighted target are on different bases, and the report and decision prose mixed them.

**Evidence.** schedules.ts:28 (discount_factor 1/(1+r)^(i+1)); engine.ts:160-169 (path adds calc.equity_bridge unchanged each year), :191 (anchors = terminal-year path), :196-197 (weighted_target from anchors). META: valuation date 2026-10-12, bridge period_end 2026-06-30, FY2026 FCFF -46,006 counted in full and discounted a full year. annual_price_target_path base FY2026-12-31 = $449.44 vs value today $395.17, +13.7% in 80 days. weighted_target 510.40 (FY2028) vs report headline 378 (today) vs thesis -31.3%. The report writer noticed this itself (report line 2799: 'discounts the full FY2026 cash flow for a full year'). Recomputed (meta_val.py): t_i = 0.22 + i years and only the H2 portion of FY2026 counted give base $432.2 (+$37) under the same 14x terminal.

**Recommendation.** In calculateValuationSchedule accept valuation_date and fiscal year ends:
- discount at year fractions t_i from the valuation date (optionally mid-period);
- set year 1's remaining cash flow to FY1 FCFF minus the reported year-to-date FCFF through the bridge date, from financial_inputs quarterly OI, D&A and capex; pro-rate by days only when YTD is missing.

In valuationPricePath roll each year's FCFF into the bridge, or report it as a distribution. Store value_today per case, weighted_value_today and an annualized IRR to the terminal year as code fields, and make the report and decision cite those.

Verify:
- A unit test: with zero cash flows the path grows exactly at r.
- The META replay gives base about $425 with no year-end jump, and FY2028 anchors that include the cumulative FCFF.

**Verifier check.** Confirmed:
- schedules.ts:28 uses whole-year discount factors.
- engine.ts:160-169 adds the unchanged bridge every year; anchors come from the terminal-year path (:191) and the weighted target from the anchors (:196-197).
- annual_price_target_path base: FY2026 $449.44 vs value today $395.17. FY2026 FCFF -46,006 is counted in full against a 2026-06-30 bridge.
- Constant-bridge error at FY2028: (1,378,669 - 49,806)/2,566 = $517.9 vs the stored $528.69.

Correction to the stub method: pro-rating year 1 by days assumes H2 = 50% of FCFF. META's reported H1 2026 (OI 41,647, D&A 12,355, capex 49,113) gives H1 FCFF about -3,296, so the remaining H2 is about -42,710, not -23,003. The stub fix is therefore about +$29 (base about $425), not +$37.

### RQ-VAL-8: Equity bridge double-counts operating leases and omits non-operating investments, minority interests and restricted cash

Severity **medium**, effort **S**, verdict **corrected**, JD trait: JD s2 scope table and s13 cash adjustment haircut (RMB115bn used vs 128bn computed; >RMB100bn long-term investments excluded; listed subsidiaries)

**Problem.** The bridge is cash + securities - debt - all lease liabilities, taken from one latest row. Under US GAAP, operating lease cost is already inside operating income, so subtracting the operating lease liability double-counts it. Equity-method and non-marketable investments are never added, noncontrolling interests are never subtracted, and restricted or escrowed cash is not separated. For JD this matters a great deal: listed subsidiaries carry minority interests, and the JD example excludes over RMB100bn of long-term investments and applies a cash haircut. The row choice takes the latest-dated row even when it carries fewer items, so a quarter missing a debt tag would silently drop debt.

**Evidence.** engine.ts:79-82 (BRIDGE_ITEMS: no investments, NCI or restricted cash), engine.ts:87-91 (sort by period_end then item count, at(-1)); financial-inputs.ts:21-26 (no column for investments, NCI or restricted cash). META 2026-06-30: operating lease liabilities 28,654 subtracted (+$11.2/share if removed); meta_NonmarketableEquitySecuritiesCarryingValue 30,157 captured but excluded (+$11.8/share); us_gaap_RestrictedCashAndCashEquivalentsNoncurrent 13,107 (escrow) not identified; current debt and finance lease not captured (bridge.missing). Corrected bridge = -22,058 + 28,654 + 30,157 = +36,753 (+$22.9/share).

**Recommendation.** Drop operating leases from BRIDGE_ITEMS, or keep them and add lease interest back to EBIT, and say which in the bridge explanation. Add financial-inputs columns for non-operating investments (us_gaap_LongTermInvestments, EquityMethodInvestments, company *NonmarketableEquitySecurities*) and noncontrolling interest (us_gaap_MinorityInterest, MinorityInterest-in-equity tags). Let the valuation analyst set a haircut per non-operating line, with a rationale.

Pick each item's latest value on or before the bridge date instead of a single row, and keep the missing-item note.

Verify:
- A unit test: when the latest quarter lacks debt, debt falls back to the prior period with a note.
- The META replay: bridge = +36,753.

**Verifier check.** Confirmed:
- BRIDGE_ITEMS (engine.ts:79-82) subtracts operating_lease_liabilities and has no investments or NCI.
- financial-inputs.ts:21-26 has no investment or NCI columns.
- The packet bridge at 2026-06-30 is: cash 15,462, securities 74,798, LT debt 83,664, operating leases 28,654, with current_debt and finance_lease missing.
- The financial_statement_set has meta:NonmarketableEquitySecuritiesCarryingValue 30,157 at 2026-06-30.
- Corrected bridge = -22,058 + 28,654 + 30,157 = +36,753 (+$22.9/share).

Corrections:
- Not 'silently': missing items are listed in bridge.missing and in valuation source_gaps (asset-valuation.ts:541). The META artifact shows 'Equity bridge items not captured: current_debt, finance_lease_liabilities'.
- Restricted cash is already excluded, because the cash alias is only us_gaap_CashAndCashEquivalentsAtCarryingValue (financial-inputs.ts:21). The 13,107 escrow is not in the bridge, so a restricted-cash column is unnecessary.
- NCI matters for JD (listed consolidated subsidiaries), not META.

### RQ-VAL-9: D&A is a fixed revenue ratio unrelated to capex, so a capex surge leaves margins and FCFF internally inconsistent

Severity **medium**, effort **M**, verdict **confirmed**, JD trait: JD s5 cash-conversion diagnosis (FCF/NI 106% -> 33%, reinvestment by line); framework Stage 15 reinvestment economics, Gate 13

**Problem.** D&A and capex are each revenue x a ratio (a 3-year mean unless overridden). Capex can go to 54% of revenue while D&A stays at 9%. Either FCFF is understated (if margins already include the coming depreciation) or the operating margin is overstated (if they don't), and the engine cannot tell which. The reinvestment_model contract is two bare arrays, so there is no invested capital, maintenance vs growth capex, ROIC or incremental ROIC, although framework Stage 15 and Gate 13 require them and the operating-model prompt asks for incremental ROIC with no field to hold it.

**Evidence.** engine.ts:120-121 (D&A and capex = revenue x ratio), engine.ts:53-77 (3-year mean ratios: D&A 8.99%, capex 25.8%); forecast/contracts.ts:96-100 (ReinvestmentModel = capex_forecast[], working_capital_forecast[]); handlers/operating-model.ts:126 asks for return on incremental capital. META reinvestment_model: capex_forecast [137,500,000,000], working_capital_forecast []. Net PP&E is captured (us_gaap_PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAsset...: 121,346 FY24, 176,400 FY25, 225,724 Q2-26) but is not a financial_inputs column. D&A / opening net PP&E: FY25 18,616/121,346 = 15.3%; H1-26 annualised 24,710/176,400 = 14.0%; Q2-26 D&A 6,356 = 10.5% of revenue (+46% YoY vs revenue +28%). A roll-forward gives 2026-28 D&A of about 27.0/43.9/54.8bn vs the engine's 22.7/25.9/29.0bn; 2028 base FCFF 50.1bn vs 24.3bn if margins hold (meta_val.py).

**Recommendation.** As proposed. Add a net_ppe column to financial-inputs.ts and roll PP&E forward in buildScenarioStatements: D&A_t = historical D&A/opening net PP&E x opening PP&E, closing = opening + capex - D&A. Output maintenance and growth capex, invested capital, ROIC and incremental ROIC per year; incremental ROIC feeds the RQ-VAL-1 RONIC default. Warn when the implied D&A/revenue rises by more than 3 points while the margin driver also rises, so the operating-scenarios model must confirm that the margin includes the depreciation.

Verify: a roll-forward unit test, and the META replay shows 2028 D&A of about 50-55bn plus the warning.

**Verifier check.** engine.ts:120-121 sets D&A and capex as revenue x ratio. history_ratios: D&A 8.99%, capex 25.79%. forecast/contracts.ts:96-100 makes ReinvestmentModel two bare arrays. The META reinvestment_model is capex_forecast [137,500,000,000] (whole units, not millions) and working_capital_forecast []. The operating-model prompt asks for return on incremental capital at operating-model.ts:123, not :126; no field holds the answer. Q2-26 D&A 6,356 is 10.5% of revenue, +46% YoY against revenue +28%. The roll-forward reproduces 27.0/43.9/54.8bn.

The value effect is ambiguous in sign, which is the point. If margins already embed the depreciation, the explicit-year add-back understates FCFF: the PP&E variant gives $410.4, +$15. If they don't, 2028 NOPAT is overstated by about 20.7bn, which costs about -$87/share through the 14x TV (25,810 x 0.80 x 14 / 1.295 / 2,566).

### RQ-VAL-10: No sanity gate: a valuation that is 99-129% terminal value and half the market price is accepted as complete with no gap attribution

Severity **medium**, effort **S**, verdict **corrected**, JD trait: JD s17 permanent-loss analysis below bear (severe impairment, moat decay, tail); JD 'what would change my mind'; framework 'Present a single fair-value estimate as certain' prohibition

**Problem.** Nothing in code computes the terminal value's share of EV, the value/price ratio, or which assumption explains a large value/price gap. When a reviewer asked for exactly these numbers, the model could only answer by changing its free parameters (RQ-VAL-1). A gap of 2x against a liquid mega-cap is far more likely to be a modelling issue than a market error, and it should force a code-computed explanation before the decision stage. There are also no stress cases below bear: permanent_loss_limit is just the bear return.

**Evidence.** grep for 'diverg', 'terminal_value_share', 'sensitivity' or 'stub' in src/lib/research finds no valuation check (only operating-scenarios wording). META valuation_status 'complete' with TV share 102.8/128.7/99.3% (computed by the report writer, report lines 13 and 2789) and weighted value today / price = 378/742.96 = 0.51. The team request in research_tasks input_json for 8ab1e740 asked the valuation analyst to 'state the terminal value share of enterprise value'; its output format (engine.ts:306-313) has no field for it. expected_return_matrix.permanent_loss_limit = bear_return.

**Recommendation.** In assembleValuation compute sanity_flags:
- tv_share_of_ev per case (flag above 0.85);
- value_to_price (flag outside 0.6-1.6);
- terminal multiple vs own-history range.

When a flag fires, attach a one-at-a-time attribution: terminal multiple to the own-history median, discount rate to CAPM, the RQ-VAL-1 fade, and the bridge and stub fixes, each as a per-share delta. Add one code-built stress row: bear ops x conservative valuation x RONIC = r. Expose all of this in the decision packet as a flag plus decomposition, not a hard block.

Verify: the META replay flags TV share and value/price, and the attribution shows the terminal multiple as the largest delta (about +$326/share from 14x to 25x).

**Verifier check.** Confirmed:
- grep finds no terminal_value_share, tv_share, value_to_price or valuation sensitivity code in src/lib/research. The only 'sensitivity' hits are in operating-scenarios funding text.
- valuation_status is complete, with TV share 102.8/128.7/99.3% and weighted value today / price = 0.51.
- request-1-1 asked for the TV share; the output format (engine.ts:306-313) has no field for it.
- permanent_loss_limit = bear_return.

Factual error: moving the base terminal multiple from 14x to 25x adds about +$326/share (11 x 98,476 / 1.09^3 / 2,566), not +$190. 25.7x reproduces the $742.96 price. The terminal multiple is still the largest single delta, so the conclusion stands.

### RQ-VAL-11: No segment SOTP path: loss-making segments are capitalised into perpetuity inside the consolidated terminal multiple

Severity **medium**, effort **M**, verdict **confirmed**, JD trait: JD s1 'two economic engines' (core segment profit vs new-business losses ~82% of it) and s2 scope table assigning each segment a treatment

**Problem.** Segment operating income exists in operating_model but is never valued separately. The model omitted SOTP because segment balance sheets are missing, but a segment operating-income SOTP needs none. As a result, the hidden assumption that Reality Labs loses about 22bn a year forever is priced at the terminal multiple. JD's decisive insight is exactly this split: core engines vs a cash-burning new business.

**Evidence.** META operating_model.segments: Family of Apps FY26 OI 104,759; Reality Labs -19,147; numeric_assumptions reality_labs_operating_loss -22,000 in 2028 (base). RL drag at 14x after tax, discounted: -22,000 x (1-0.1965) x 14 / 1.09^3 / 2,566 = -$74.5/share (meta_val.py). omitted_methods: 'Sum-of-the-parts ... Not permitted ... Segment balance-sheet and return measures are not disclosed'. validation.ts:64-68 SOTP check unreachable because engine.ts:204 hard-codes segments_reconciled:true.

**Recommendation.** Add optional structured per-year segment operating income to yearly_drivers (operating-scenarios contract), reconciled to consolidated OI within 0.5%. Code sets segments_reconciled from that check.

Add a cross-check function in engine.ts:
- profitable segments: valued with the RQ-VAL-1 terminal on segment NOPAT;
- loss-making segments: an explicit after-tax loss stream with an analyst path (persists, or fades to zero by year N);
- corporate costs from the reconciling line.

Report core value, investment-segment value, and value per share under both loss paths.

Verify: the META replay shows the RL drag at about -$74/share when persistent and smaller when fading, and a unit test confirms the parts sum to the consolidated value.

**Verifier check.** Confirmed:
- operating_model.segments: Family of Apps OI 104,759, Reality Labs -19,147 (FY2026 only).
- Base numeric_assumptions reality_labs_operating_loss is -19,147/-21,000/-22,000 for 2026-28 (bear 2028 -22,000, bull -18,000).
- RL drag at 14x = -22,000 x 0.8035 x 14 / 1.295 / 2,566 = -$74.5/share, 19% of the base value.
- omitted_methods rules out SOTP for lack of segment balance sheets, which a segment-OI SOTP does not need.
- segments_reconciled is hard-coded (engine.ts:204).

Implementation note: segment forecasts are structured for one year only (operating_model). Per-year segment losses exist only as free-form numeric_assumptions with model-chosen driver_keys, so code cannot read them reliably without a contract field.

## RQ-BIZ: Business, moat, management, governance and capital allocation analysis

The qualitative branch (company_genesis, business_process_analysis, moat_analysis) runs as three single-shot Haiku calls that write prose strings into typed shells. Nothing frames the 1-3 questions that decide the case before the analysis starts: research_plan holds two template questions, the team brief is a data checklist, and the thesis, mispricing and falsifiers are written only at decision_synthesis. The numbers the JD example is built on are already in the META run's database but never reach these stages. historical_record has 25 quarters of Family of Apps and Reality Labs revenue and operating income, Class A and Class B share counts, buybacks, SBC withholding and SBC. The 10-K chunks state the 10-votes-per-share Class B and the CEO's majority voting control, and name TikTok as a competitor. Business and moat get no historical inputs (team-plan.ts:46-47), the filing-passage selector drops risk-factor and Competition sections (score of zero or below), and no stage or artifact covers ownership, management scoring or the capital-allocation ledger. As a result, the report blocks 'ownership' and 'management' coverage, and coverage was never 'satisfied' in any of the five runs checked. It calls segment history 'not verified' and omits TikTok, and it treats the decisive capex and Reality Labs return question as a 'Speculative option'. The highest-leverage fixes are mostly code-computed tables added to the deterministic historical_diagnosis stage (segment economics, capital-allocation ledger, ownership structure). They should be paired with two small model artifacts, investment_debate and management_assessment, plus routing fixes (dependencies, passage needs, archetype composition, peer facts) and a per-stage model override, so the judgment-heavy calls can use a stronger model without the stage count going above 24.

<details><summary>Measurements</summary>

All figures are from the META run 4fae0fb1 via read-only SELECTs.
(1) Cost by stage (model_call_logs joined to research_stages):
- ai_reviewer: 26 calls, $0.613 of the $1.045 total (59%).
- company_genesis: 6 calls, $0.047 (founder-motivation repairs).
- business_process_analysis: 1 call, 63,563 input / 20,456 output tokens, $0.018.
- moat_analysis: 1 call, 58,997 / 10,782 tokens, $0.013.
- operating_model: 1 call, $0.018.
(2) Packet contents (research_tasks.input_json): upstream_artifacts were company_genesis, founder_profile, strategic_dna and strategic_history_timeline for business_process_analysis; the five business_process_analysis outputs for moat_analysis; neither got historical_record. Both had 14 filing passages, and every section was MD&A, metrics or outlook.
(3) historical_record segment and share-class observations:
- meta:FamilyOfAppsMember and meta:RealityLabsMember revenue and operating income: 25 observations each.
- CommonClassA/B shares outstanding: 22 observations each.
- Family of Apps operating income FY21-25: 56.9 / 42.7 / 62.9 / 87.1 / 102.5bn.
- Reality Labs operating loss FY21-25: 10.2 / 13.7 / 16.1 / 17.7 / 19.2bn. Cumulative $77.0bn, equal to 17.9 / 32.2 / 25.6 / 20.4 / 18.7% of Family of Apps operating income.
(4) Capital-allocation ledger, computed from annual observations for 2021-2025:
- Operating cash flow $386.4bn, capex $183.9bn.
- Buybacks $148.6bn, SBC tax withholding $48.3bn, SBC $72.3bn.
- (Buybacks + withholding) / SBC: 5.46 / 2.63 / 1.91 / 2.63 / 2.19x.
- Class A+B shares: 2,741m to 2,530m (-7.7%) from end-2021 to end-2025, then +1.3% from June 2025 to June 2026 after buybacks paused.
(5) Ownership at 2026-06-30: Class B 342m of 2,548m shares is 13.4% of economic ownership. At 10 votes per Class B share it is 60.8% of votes (computed). The 10-K chunks 43, 103, 140 and 326 state this.
(6) passageScore from the repo's own function (run with tsx on stored chunks):
- 10-K Competition (chunk 24): 0.
- Risks Related to Ownership (chunk 43): -3.
- CEO voting control (chunk 103): -3.
- Competition risk (chunk 68): -4.
selectFilingPassages drops every passage scoring 0 or less.
(7) Other counts:
- 150 accepted evidence claims; only 1 has claim_type 'governance', and it is about Snap's board.
- 'TikTok' appears 0 times in report.md and 2 times in the 2025 10-K chunks.
- Five runs had a report_outline: ownership and management coverage were 'qualified' in four and 'blocked' in the latest, never 'satisfied'.
- research_plan composed_archetypes is ['operating_company_core'] in 11 of the latest 12 runs; the other is a bank/lender run. assets.industry for META is 'Internet Content & Information', which the existing KPI classifier maps to advertising_platform.
(8) Stage timing: historical_record and company_genesis both completed at 14:44:35, so adding historical inputs to business_process_analysis costs about 0 s on the critical path.

</details>

### RQ-BIZ-1: No mechanism frames the central investment debate early; the thesis, mispricing and falsifiers appear only at decision_synthesis

Severity **high**, effort **L**, verdict **corrected**, JD trait: One central reframing insight; 'what would change my mind'; variant perception vs market; thesis breakers with numeric thresholds

**Problem.** The JD example opens by reframing the case ('will management let core economics accrue to shareholders') and organizes every later section around that question. Research OS has nothing that picks the 1-3 questions that decide the case and steers research toward them. Its only questions are two template strings, and the team brief is a checklist of data checks. The thesis, market_mispricing, must_be_true and disproving_evidence are written in decision_synthesis, after every analysis stage has finished, so they steer nothing. In META the decisive question is whether the $130-145bn capex and the ~$19bn a year Reality Labs burn earn above the cost of capital, under a founder shareholders cannot outvote. It appears only as a 'Speculative option' paragraph deep in the management chapter. The executive judgment instead centres on an unverified price and a 3-year DCF.

**Evidence.** research-plan.ts:40-41: questions are fixed templates ('What determines the value accruing to holders of X?', 'Which operating constraints and capital-allocation choices...').
team.ts:46: BRIEF_CONTRACT is {approach, checks, information_needed}. The META business brief (agent_brief scope_key=business) has 12 checks such as 'Confirm that quarterly income statement... reach at least 20 quarters' and no investment question.
decision/contracts.ts:7-16: InvestmentThesis with market_mispricing, must_be_true and disproving_evidence, produced by decision_synthesis (team-plan.ts:51).
report.md:2606: 'Speculative option. Whether the reinvestment earns a return is the decisive question for capital allocation, and the evidence does not answer it.'
question_register: 15 questions, 12 of them blocked. They are data gaps (price, bridge, peer filings, proxy), not investment debates.
No debate, variant or 'change my mind' construct exists: grep -i 'variant|change my mind|key debate|consensus' in src/lib/research only matches dashboard-series.ts.

**Recommendation.** Add a small model-written `investment_debate` artifact (1-3 debates: id, question, why_it_decides_value, valuation_inputs[] keyed to driver_tree/assumption keys, bull_answer, bear_answer, evidence_needed, falsifier {metric_key, threshold, direction}). Produce it as the first call inside business_process_analysis, after RQ-BIZ-2's dependency change, from historical_diagnosis, the segment/capital-allocation tables and company_genesis. A user-supplied `key_debates` in run metadata seeds or overrides it, so the research_plan human gate can edit it. Add it to the team_context query next to team_requests (run-context.ts:407-409) so moat, operating_model, valuation and decision all receive it. In decision_synthesis, have code close the loop instead of failing: any debate id the thesis does not address is recorded as 'blocked', and each falsifier metric_key is appended to monitoring_dashboard when it is missing. Defer the reverse_valuation 'market_implied' fill and the outline check until reverse valuation is reliable (no_rerating_return is null in this run). Verify: the mock pipeline (npm run test:sofi-v3) asserts 1-3 debates linked to driver_tree keys and a decision_record carrying their statuses. On a META rerun, the executive judgment names the capex-return, Reality Labs-burn and control debates with numeric falsifiers.

**Verifier check.** Confirmed on main. research-plan.ts:40-41 holds two questions. The first is ctx.researchQuestion when one is supplied, but for META it was the generic default from scripts/new-equity-run.ts:61 ('Evaluate ...'s origins, business model, ... valuation under bear, base, and bull scenarios'). team.ts:46 BRIEF_CONTRACT is {approach, checks, information_needed}, and the META business agent_brief has 12 checks that are all data-completeness items. decision/contracts.ts:7-16 InvestmentThesis is written only at decision_synthesis (team-plan.ts:51). report.md:2606 puts 'Whether the reinvestment earns a return is the decisive question...' under 'Speculative option'. question_register has 15 questions: 12 blocked, 2 qualified, 1 answered, all data gaps. No debate or variant-perception construct exists in src/lib/research. Two parts needed correcting. Effort is L, not M: the change touches a new artifact, run-context injection, reverse-valuation fill, a decision validator, an outline check and run metadata. And a hard decision_synthesis validator that fails when a debate id is not closed adds another failure path to a stage that already exhausts retries (prior audit: 32k truncation, RO2).

### RQ-BIZ-2: Segment engines are never separated: business and moat stages get no segment numbers although historical_record holds 25 quarters of them

Severity **high**, effort **S**, verdict **confirmed**, JD trait: Two economic engines: who earns vs who burns (segment operating profit, losses as % of core profit); scope table assigning each segment a treatment

**Problem.** The JD example's central insight is arithmetic: the profitable segments' operating profit versus the losses of New Businesses (~82% of core profit). META has the same structure, Family of Apps versus Reality Labs, and the exact figures sit in historical_record. business_process_analysis depends only on company_genesis, and moat_analysis only on business_process_analysis, so neither packet contains historical_record or the reported segment history that operating_model already extracts. SegmentDetails has no numeric fields at all; every field is a string. So the model wrote that Reality Labs revenue 'is not in the cited claims'. The report writer then refused the FY2025 Family of Apps operating income figure because it was 'not traced to a supplied claim'. The report never computes RL losses as a share of Family of Apps profit or their cumulative total.

**Evidence.** team-plan.ts:46-47:
- business_process_analysis: ["company_genesis"]
- moat_analysis: ["business_process_analysis"]
run-context.ts:412-414 loads only dependency output types; historical_record is added only when it is a direct dependency.
research_tasks.input_json (META): business_process_analysis upstream_artifacts = company_genesis, founder_profile, strategic_dna, strategic_history_timeline.
business/contracts.ts:21-36: SegmentDetails is all z.string().
operating-model.ts:73-79 already builds reported_segment_history from segment members, but only for operating_model.
historical_record: meta:FamilyOfAppsMember and meta:RealityLabsMember revenue and operating income, 25 observations each.
- Family of Apps operating income FY2025: $102.469bn.
- Reality Labs: -$19.193bn on $2.207bn revenue.
- Reality Labs losses FY21-25 total $76.95bn, equal to 17.9 / 32.2 / 25.6 / 20.4 / 18.7% of Family of Apps operating income.
segment_model text: 'RL revenue levels for 2025 and 2026 are not in the cited claims'.
report.md:161-162: 'Quarterly segment revenue and operating income... are not verified'; 'The FY2025 Family of Apps operating income figure of 102,469 million... is not traced to a supplied claim and is not used here'.
report.md:121 sums RL losses only for 2020-2022 ($30.5bn).

**Recommendation.** As proposed. (1) Compute `segment_economics` in historical-diagnosis.ts from the historical_record segment rows, using the same filter as operating-model.ts:72-76. It holds per-segment FY and TTM revenue, operating income, margin, YoY, profit-pool share, burner losses as a % of earner operating income, cumulative loss, a code-set role (earner/burner) and observation ids. Add it to HISTORICAL_DIAGNOSIS_CONTRACT.requiredKeys. (2) Change team-plan.ts:46 to business_process_analysis: ["company_genesis", "historical_diagnosis"]. (3) Add an optional economic_role enum to SegmentDetails, plus a prompt rule that segment_model restates the segment_economics figures by artifact path. (4) Add segment_economics to moat_analysis's inputs. Keep the artifact small (well under 20 KB) so the report outline can select it for the business chapter. Verify: a unit test on the stored META observations yields 18.7% for FY2025 and 76.95bn cumulative. On a META rerun, segment_model cites RL FY2025 revenue of 2.207bn and operating income of -19.193bn, and report.md loses the 'not verified' and 'not traced' gaps.

**Verifier check.** team-plan.ts:46-47 deps confirmed. run-context.ts:412-414 adds historical_record only when it is a direct dependency. The META business_process_analysis packet's upstream_artifacts are company_genesis, founder_profile, strategic_dna and strategic_history_timeline. business/contracts.ts:21-36 SegmentDetails is all strings. In historical_record, meta:FamilyOfAppsMember and meta:RealityLabsMember revenue and operating income each have 5 annual and 20 quarterly observations. FoA operating income FY21-25: 56.946 / 42.661 / 62.871 / 87.109 / 102.469bn. RL: -10.193 / -13.717 / -16.120 / -17.729 / -19.193bn, a sum of 76.95bn and ratios of 17.9 / 32.2 / 25.6 / 20.4 / 18.7%. FY2025 RL revenue was 2.207bn. segment_model says 'RL revenue levels for 2025 and 2026 are not in the cited claims'. report.md:161-162 has the gaps 'not verified' and 'not traced to a supplied claim'. report.md:121 sums only 2020-2022. operating-model.ts:72-76 already extracts segment rows. One nuance: the business packet did contain the Q2/H1 2026 'Segment profitability' passage (FoA 23,394; RL -4,619), so only the multi-year history and the RL revenue level were missing. Timing: historical_diagnosis took 14 ms (task 14:44:35.332 to .346), and the metric-normalizer call finished about 19 s after company_genesis. Under the deferred lockstep scheduler (P7) the dependency costs about 0 s today, and about 20 s if P7 is fixed. Side effect: a historical_record rerun from a team request will now also rerun business and moat (dependentStages).

### RQ-BIZ-3: 'What the investor owns' is never analysed: share classes, voting control and holdco/VIE chain are in the corpus but filtered out

Severity **high**, effort **M**, verdict **corrected**, JD trait: What the investor owns (ADS -> Cayman holdco -> VIE -> residual per ADS); founder 12.5% economic / 71.8% voting

**Problem.** The report blocks 'ownership' coverage and states that the sources contain 'no ... share-class description, voting-control disclosure'. Both are false for this corpus: the 2025 10-K chunks and historical_record contain everything needed. Four mechanisms remove them:
(a) the filing-passage selector penalizes every 'Risks Related to...' section, and passages scoring 0 or less are never chosen;
(b) the evidence-extraction query for regulatory filings has no ownership terms, and unlike founders there is no ownership need or pass;
(c) the SEC fetcher never takes the DEF 14A proxy, and the proxy role is optional and mapped to blockedArtifacts ['company_genesis'];
(d) asset_identity's described job ('resolve instruments, listings, and legal entities') is not implemented.
For JD-type issuers (ADS, Cayman holdco, VIE) the same gaps would hide the whole claim chain.

**Evidence.** Filing passages: filing-passages.ts:53 gives /risk factors|risks related to/ a -4 section score, and :100 skips score <= 0. Measured with the repo's passageScore on stored chunks: chunk 43 ('Risks Related to Ownership of Our Class A Common Stock') = -3, chunk 103 (CEO majority voting control) = -3.
Corpus text: chunk 140: 'Our Class B common stock has ten votes per share and our Class A common stock has one vote per share'. chunk 326 (Notes / Common Stock) says the same.
Share classes in historical_record: us-gaap:CommonClassAMember 2,206m and CommonClassBMember 342m at 2026-06-30, 22 periods each. That gives 13.4% economic vs 60.8% voting (computed).
Evidence extraction: needs.ts:23 regulatory_filing query has no ownership or voting terms. evidence_claims has 150 accepted, and the only 'governance' claim is about Snap's board.
SEC fetch and proxy role: corpus.ts:594-621 selects only 10-K, 10-Q and 8-K item 2.02. registry.ts:17 lists proxy_and_governance as required:false, blockedArtifacts:['company_genesis']. No DEF 14A appears in the META source_documents.
asset_identity: asset-identity.ts only writes a profile assignment.
Outputs: founder_profile.control_evolution says the sources 'do not document the company's share classes, voting arrangements'. report.md:27 and :2615 block the ownership claim. report_outline coverage ownership = blocked in the latest run, and 'qualified' in the four earlier runs checked.

**Recommendation.** Make the existing data reachable first, then add the artifact. (1) In filing-passages.ts sectionScore, give risk subsections whose text matches /dual class|votes per share|voting power|controlled company|variable interest entit|depositary share/ a positive score (+3) instead of -4, and give 'Common Stock' or equity-note sections +2, so the selector picks chunks 140/326. (2) Compute `ownership_structure` in code in historical_diagnosis from the XBRL share-class members. A small source-reader pass, or a regex over the selected passages, extracts votes per class, the controlling holder, and ADS ratio / VIE statements. Code computes economic % vs voting %. (3) In selectResearchFilings, add the newest DEF 14A for domestic issuers from the submissions list already fetched (20-F Items 6-7 cover foreign filers). Change the proxy role's blockedArtifacts to ['ownership_structure']. (4) Fix team request retrieval (missed issue 1). Update docs/system.md and the architecture data-flow views. Verify: on a META rerun, Class B shows about 13% economic and 61% voting, cited to the 10-K equity note, with ownership coverage at least 'qualified'. A unit test on a fixture 20-F chunk set yields an ADS-to-holdco-to-VIE chain.

**Verifier check.** Confirmed. Running passageScore on the stored 10-K chunks (scratchpad score.ts) gives: chunk 43 (Risks Related to Ownership of Class A) -3, chunk 103 (CEO majority voting control) -3, chunk 140 (ten votes per share) -4, chunk 326 (equity note 'Common Stock') 0. filing-passages.ts:53 and :100 drop every passage scoring 0 or below. needs.ts:23 regulatory_filing query has no ownership terms. corpus.ts:594-621 takes only 10-K/10-Q/8-K 2.02. registry.ts:17 has proxy required:false with blockedArtifacts ['company_genesis']. None of the 156 META source_documents is a DEF 14A. asset-identity.ts only writes a profile assignment, against the stage description at stages.ts:46. The XBRL share counts at 2026-06-30 are A 2,206m and B 342m, giving 13.4% economic and 60.8% voting. founder_profile.control_evolution and report.md:27/53/92 claim no share-class or voting disclosure exists. Ownership coverage is 'blocked' in 4fae0fb1 and 'qualified' in the other four runs. Corrections: (a) 'Exempt this need from the risk-factor penalty' does not apply, because evidence-extraction retrieval (memory/needs.ts evidenceNeeds) never uses sectionScore. The penalty matters only for filing_passages, and removing it alone still leaves chunk 140 at 0, which is still dropped. (b) The reviewer missed the most direct mechanism. The report asked twice for this exact information (request-1-5 and request-2-5, role business, source_role proxy_and_governance) and got 'unavailable' both times, because team.ts:335 restricts retrieval to the request's source role and team.ts:355 sends the request prose as the web query (source_retrieval_attempts: fetched_documents 0, twice). See missed issue 1.

### RQ-BIZ-4: No management or capital-allocation analysis: no cash-use ledger, no per-share outcomes, no separately scored management axes

Severity **high**, effort **M**, verdict **corrected**, JD trait: Management scored separately (execution, balance sheet, buybacks, capital allocation, governance); capital allocation from cash-flow uses with per-share outcomes; net share count in monitoring

**Problem.** Framework Stage 16 and §4.10 require capital allocation on a per-share basis: buybacks and dividends as a % of FCF, net share-count change, SBC as a % of revenue and FCF, and the buyback offset ratio. No stage or artifact implements this. The report's 'Management and capital allocation' chapter is built only from founder_profile and strategic_dna strings. It lists data gaps, including 'capital allocation series are not stored as a single comparable observation set', even though historical_record holds every input. Management is never scored on separate axes, so a weak governance score cannot coexist with strong execution the way it does in the JD example (4/5 execution, 1.5-2/5 governance). Meanwhile the pipeline spends its qualitative budget on founder psychology: a mandatory motivation enum, a run-failing founder gate and 6 genesis calls.

**Evidence.** stages.ts: no management or capital-allocation stage. team-plan.ts:6 assigns 'management, incentives, capital allocation' to the business role, but no contract covers it.
report_outline (META): the section 'Management and capital allocation' has coverage [management, ownership] and artifact_ids = founder_profile, strategic_dna only. report.md:2621 has the 'not stored as a single comparable observation set' gap.
historical_record annual values (2021-2025):
- buybacks 44.5 / 28.0 / 19.8 / 30.1 / 26.2bn;
- SBC tax withholding 5.5 / 3.6 / 7.0 / 13.8 / 18.4bn;
- SBC 9.2 / 12.0 / 14.0 / 16.7 / 20.4bn;
- operating cash flow total $386.4bn, capex $183.9bn.
Derived:
- (buybacks + withholding) / SBC: 5.46 to 2.19x;
- Class A+B shares -7.7% from end-2021 to end-2025 ($196.9bn spent for 211m net shares);
- +1.3% from June 2025 to June 2026 once buybacks paused.
The report gives none of these per-share figures.
Founder gate: evidence-extraction.ts:47-49, 111-130 and 409 make founder or origin evidence run-failing. company_genesis = 6 calls ($0.047) vs business_process_analysis 1 call ($0.018) in model_call_logs.

**Recommendation.** (1) Compute `capital_allocation_ledger` in code in historical_diagnosis from historical_record. Annual and TTM rows cover: sources (operating cash flow, debt raised); uses (capex, buybacks, SBC withholding, dividends, acquisitions, burner-segment losses), each as a % of OCF and FCF; SBC as a % of revenue; the offset ratio; outstanding and diluted share change; per-share vs aggregate CAGR for revenue, OCF and FCF; and computed net cash. Every cell carries observation-id paths. (2) Add one small model call in business_process_analysis producing `management_assessment`. Axes: operating_execution, balance_sheet_discipline, capital_returns, capital_allocation, governance_alignment. Each axis is {score 1-5 or 'unscored', rationale, ledger_paths[], claim_ids[]}. Validator: a scored axis must cite a ledger path or claim, and governance_alignment stays 'unscored' without ownership_structure. (3) Add 'net share count' and 'burner-segment loss' to the default monitoring KPIs when present. Drop the cost argument about genesis. Optionally relax the run-failing founder gate to a qualified gap, as a separate decision. Verify: the META management chapter shows the 2021-2025 ledger (2025: buybacks + withholding of 44.6bn vs SBC of 20.4bn; +1.3% share drift since buybacks paused) and five scored axes, and the 'not stored as a single comparable observation set' gap disappears.

**Verifier check.** The core finding holds. No stage or artifact computes a capital-allocation ledger or scores management. The report outline's 'Management and capital allocation' section has artifact_ids strategic_dna (5f017fe3) and founder_profile (3975d785) only. report.md (around line 2622) has the gap 'capital allocation series are not stored as a single comparable observation set'. I recomputed the historical_record annual values: buybacks 44.537 / 27.956 / 19.774 / 30.125 / 26.248bn (sum 148.6); SBC tax withholding 5.515 / 3.595 / 7.012 / 13.770 / 18.400bn (sum 48.3); SBC 9.164 / 11.992 / 14.027 / 16.690 / 20.427bn (sum 72.3); operating cash flow sum 386.4bn; capex (PaymentsToAcquirePropertyPlantAndEquipment) sum 183.9bn. Offset ratios are 5.46 / 2.63 / 1.91 / 2.63 / 2.19x. Shares were 2,741m to 2,530m (-7.7%) from end-2021 to end-2025, and 2,516m to 2,548m (+1.3%) from June 2025 to June 2026. Framework §4.10 (line 746) and Stage 16 (line 1572) require this analysis. The founder gate is confirmed at evidence-extraction.ts:47-49 and 400-410. Factual error: 'company_genesis = 6 calls ($0.047) ... founder-motivation repairs' is wrong. Joining model_call_logs to research_tasks shows one company_genesis task call ($0.0152). The other five calls charged to that stage are the business team_brief ($0.0021) and four team_answer calls ($0.0297). So the 'qualitative budget spent on founder psychology' argument does not rest on cost.

### RQ-BIZ-5: Archetype composition always falls back to operating_company_core, so ad-platform, marketplace, logistics, holdco and emerging-market modules never run

Severity **medium**, effort **S**, verdict **corrected**, JD trait: Business and value-chain maps per engine (Retail, Logistics, Food delivery); cross-border capital/VIE; local competition

**Problem.** The registry defines specific archetypes and an overlay with the process nodes a JD-style analysis needs:
- marketplace: buyer_acquisition, take_rate_realization;
- logistics_network: capacity_planning;
- holding_company: subsidiary_governance, capital_allocation;
- emerging_market_multi_country: cross_border_capital, local_competition.
Archetype composition ignores the asset's classification and maps every non-financial profile to operating_company_core. META therefore ran with five generic nodes (demand_generation through reinvestment) instead of audience_building, ad_inventory_creation, targeting_and_optimization, advertiser_spend_capture and measurement_and_attribution. A JD run would get none of the marketplace, logistics or cross-border nodes. A classifier that would pick the right archetypes already exists, but by design it is used only for KPI search.

**Evidence.** archetype-composition.ts:19-29: the 'financials' profile maps to bank+lender; everything else, including the explicit 'Default to operating company core' branch, maps to operating_company_core.
needs.ts:72-73: 'Used for KPI selection only: the v3 archetype composition is unchanged'.
needs.ts:76-90 maps 'internet content' to advertising_platform and 'internet retail|e-commerce' to marketplace.
assets row for META: industry 'Internet Content & Information'.
research_plan.composed_archetypes = ['operating_company_core'] in 11 of the latest 12 runs; the other is a bank/lender run.
business_process_map (META) process nodes: demand_generation, value_delivery, revenue_recognition, cash_collection, reinvestment.
registry.ts:332-363 (advertising_platform nodes), 522-550 (holding_company), 600-630 (emerging-market overlay with cross_border_capital).

**Recommendation.** In archetype-composition.ts, when run metadata names no archetypes, compose operating_company_core plus kpiArchetypes([], assets {sector, industry, sicDescription}). Add the emerging_market_multi_country overlay when the normalized home_country is outside a short developed-market list and a composed archetype is in its applies_to. Before enabling, set advertiser_count to required:false in the advertising_platform metrics and drivers, or confirm it degrades to a gap. Then run the mock pipeline (npm run test:sofi-v3 / test:db) to confirm the new required metric families and roles add no hard failures. Verify: composition unit tests map META to [operating_company_core, advertising_platform], MELI to marketplace plus the EM overlay, and Exor to holding_company. On a META rerun, business_process_map covers the five advertising nodes.

**Verifier check.** Confirmed. archetype-composition.ts:19-29 maps everything except 'financials' to operating_company_core. needs.ts:72-73 says 'Used for KPI selection only'. The rules at needs.ts:76-90 map 'internet content' to advertising_platform and 'internet retail|e-commerce' to marketplace. Asset rows: META 'Internet Content & Information'; MercadoLibre 'Internet Retail and Fintech', home Uruguay; Exor 'Investment Holding Company'. composed_archetypes is ['operating_company_core'] in 11 of the latest 12 research_plans. That includes the MELI marketplace run d6f3fbee, which strengthens the finding. META business_process_map nodes are the five generic ones. The registry nodes are confirmed at registry.ts:332-363, 522-550 and 601-619. Caveat the reviewer missed: composing advertising_platform also adds required historical metric families (ad_impressions and cpm_or_cpc at 20 quarters, advertiser_count at 12, which Meta does not report). It also adds a required customer_or_channel source role, which means more discovery searches, and a required advertiser_count scenario driver. Missing process nodes degrade to 'blocked' (business-process-analysis.ts:74-89). The added required metrics instead become uncovered_required_metrics for the metric-normalizer, with coverage gaps. home_country values are inconsistent ('US' vs 'United States').

### RQ-BIZ-6: Competition is not grounded in peer numbers, and the competitor set ignores the issuer's own Competition section (TikTok absent)

Severity **medium**, effort **M**, verdict **corrected**, JD trait: Competitor numbers (PDD Q1 revenue/op profit, Alibaba CMR growth); mandatory attack table grounded in named attackers

**Problem.** Competitors are limited to whatever web 'peer' documents discovery retrieved. In META those were an aggregator page for Alphabet and a Snap PDF, so every market_share is null, Alphabet has no comparable metrics, and the moat chapter concludes 'Peer evidence cannot yet test share shift'. Meta's 10-K names TikTok as having 'reduced some users' engagement', yet TikTok never appears in the competitive matrix, the attack matrix or the report. The 10-K 'Competition' section scores 0 in the passage selector and is never sent to moat_analysis. The pipeline already resolves CIKs and parses SEC companyfacts for the subject, but never for listed peers.

**Evidence.** competitive_response_matrix (META): 3 competitors (Alphabet, Snap, 'AI assistants'), all market_share null. Alphabet main_advantages: 'which the sources do not quantify for Alphabet'.
source_documents: 'Alphabet Inc. (GOOGL) 10K Annual Reports & 10Q SEC Filings | last10k.com'.
document_chunks for the 2025 10-K: chunks 29/44 'competitive products and services, such as TikTok, that have reduced some users' engagement'. grep -c TikTok report.md = 0.
passageScore(['PART I','Competition'], chunk 24) = 0, and filing-passages.ts:100 drops score <= 0. FILING_PASSAGE_TASKS (filing-passages.ts:7) uses one selection for business, moat, operating_model and report sections.
corpus.ts:763-773 resolveSecCik plus companyfacts and submissions fetch exist for the subject only.
report.md (moat chapter): 'Meta's 12% price growth therefore cannot be set against rival pricing for the same period.'

**Recommendation.** (1) Passage routing: in sectionScore, give risk subsections whose text matches /compet|such as [A-Z]/ a positive score instead of -4, so the TikTok and competition-risk passages reach business, moat and report. (2) A deterministic `peer_benchmark`: take up to 3 listed peers from the moat or business output (add an optional `ticker` to CompetitorEntry), resolve them with resolveSecCik, make one capped companyfacts fetch each, and compute consolidated 8-quarter revenue growth, operating margin and capex/revenue next to the subject. Private or non-SEC peers are recorded as gaps. (3) Contract: CompetitorEntry gains `named_in_issuer_filing: boolean` and `peer_metrics_path | gap`. Add a prompt rule to include every competitor the supplied filing passages name, as a warning-only check, not a hard validator. Verify: on a META rerun, the matrix contains TikTok (private, with a gap) and Alphabet's margin from SEC companyfacts rather than last10k.com, and the moat chapter compares growth and margin against peers.

**Verifier check.** Mostly true. competitive_response_matrix has 3 competitors (Alphabet, Snap, 'AI assistants'), all with market_share null. The prior audit's RM8 placeholder-zero is fixed. The peer sources in the run corpus are the last10k.com Alphabet page and the Snap 10-K PDF. grep -ci tiktok on report.md returns 0. The resolveSecCik plus companyfacts fetch (corpus.ts:763-775) serves the subject only. Factual correction: TikTok is not in the 10-K Competition section. Chunk 24 ('PART I / Competition', score 0) names no company at all. The only TikTok mention is in 'Risks Related to Our Product Offerings' (chunk 44 in the structured parse, chunk 29 in the raw parse), which scores -4. So recommendation (1), 'peers named in the issuer's Competition section', returns nothing for Meta. Recommendation (3)'s code check, which lists the companies named in Competition passages and fails validation, needs named-entity extraction from prose. That is brittle and would add a new failure path. Also, companyfacts has no dimensional data, so peers can be compared on consolidated growth, margin and capex only, not on ad-segment figures.

### RQ-BIZ-7: Moat assessment is unscored, uncited and has no return-on-capital or peer inputs; validators are keyword checks

Severity **medium**, effort **S**, verdict **confirmed**, JD trait: Moat rated per source (strong / moderate-strong / moderate / weak) plus attack table with residual-moat conclusion

**Problem.** Framework §7.6 requires each moat to be scored 0-5 and classified Unproven, Weak, Moderate, Strong or Exceptional. The contract instead has free-text current_strength and durability, no classification enum, and no supporting_claim_ids or artifact paths. Moat claims therefore cannot be citation-checked, unlike process nodes. The packet has no historical_record, ROIC or peer data. The model concedes 'no peer pricing data is in the corpus to test it against rivals' and 'segment capital and return measures are not disclosed', even though group ROIC and incremental returns are computable. The validators fire only on substrings ('high margin', 'no spend', 'none'), so they cannot tell a tested moat from an asserted one.

**Evidence.** moat/contracts.ts:7-23: MoatAssessmentEntry has string current_strength and durability, and no claim ids.
moat/validation.ts:31-50 and 66-72: substring checks.
moat-analysis.ts:15-26: packet lacks historical inputs. research_tasks (META): moat_analysis upstream_artifacts = the 5 business_process_analysis outputs only.
moat_assessment (META): 4 entries with confidence 0.5 / 0.4 / 0.3 / 0.25. current_strength values include 'Moderate for 2026 to date...' and 'Not demonstrated'. The ad-pricing source says 'no peer pricing data is in the corpus to test it'.
research-framework-v2.1.md:948-976 (scoring dimensions and classification).

**Recommendation.** As proposed. Add a classification enum, a reduced 0-5 `scores` object, and supporting_claim_ids plus artifact_paths per moat entry. Add historical_diagnosis, segment_economics, capital_allocation_ledger and a code-computed group ROIC / incremental ROIC series to moat inputs, and peer_benchmark once it exists. Replace the keyword validators with structural ones: 'strong' or 'exceptional' needs at least one history path and one peer path, otherwise it is capped at 'moderate'; each moat_attack_matrix residual_moat must reference a moat_assessment entry. Verify: on a META rerun, every moat entry has a classification, scores and citations, and the moat chapter renders a per-source rating table.

**Verifier check.** moat/contracts.ts:7-23: MoatAssessmentEntry has free-text current_strength and durability, no classification enum and no claim ids. moat/validation.ts uses only substring checks ('high margin', 'no spend', 'none', and fewer than 5 characters). The META moat_analysis upstream_artifacts are the 5 business outputs only, with no history, returns or peer data. Framework §7.6 (lines 948-976) requires 0-5 scores and the Unproven to Exceptional classification. §7.7 adds that 'Every moat claim must be tested against the 20-quarter record', which the packet makes impossible. The recommendation is sound, provided its peer-path requirement waits for RQ-BIZ-6's peer_benchmark.

### RQ-BIZ-8: No end-demand constraint: industry market-size claims are extracted but no code computes share or relative growth; top-down blocks when either bound is missing

Severity **medium**, effort **S**, verdict **corrected**, JD trait: End-demand constraint from national statistics -> forecast assumes no consumption boom

**Problem.** The JD example limits its forecast by end-demand: national retail sales +1.3% and online +4.8%. META's corpus holds the equivalent from IAB/PwC: US internet advertising $294.6bn (+13.9%) and social $117.7bn (+32.6%). These live only as free-text claims with no numeric fields, so no stage computes Meta's implied share or growth versus the market. In operating_model the model returned both bounds null, and normalizeReconciliation blocks top-down if either TAM or customer budget is missing. As a result, top_down_bottom_up_reconciliation is 'blocked_source_gap', and business and moat analysis never ask whether 22% growth against a 13.9% market is share gain or pricing. This may overlap with the forecast reviewer, but the missing structured market claim belongs to the business stage.

**Evidence.** evidence_claims (META), claim_type industry_market_size or industry_growth:
- 'U.S. internet advertising revenues increased 13.9%... reaching a record $294.6 billion';
- 'social media advertising revenue reached $117.7 billion in 2025... (32.6% YoY)'.
metadata_json.agent_output holds only text, quoted_text and char offsets, with no value, unit or geography.
top_down_bottom_up_reconciliation: tam_limit null, customer_budget_limit null, status blocked_source_gap, bottom_up 252.6bn.
operating-model.ts:31-40: normalizeReconciliation nulls top_down and sets blocked when tam <= 0 OR budget <= 0 (Number(null) = 0).
Illustration: 37% US-based revenue x $200.97bn ≈ $74bn, about 25% of US internet advertising.

**Recommendation.** (1) Add optional numeric fields {value, unit, currency, period, geography} to any market-size or market-growth claim, keyed on the claim's content rather than the free-form claim_type, or normalize claim_type first. (2) Compute a `demand_constraint` block in code in business_process_analysis: company revenue in the same geography (US and Canada revenue by user geography from filing passages or claims) divided by market size, company growth minus market growth, and the range of market growth across sources. Feed it to segment_model and the moat test. (3) Change normalizeReconciliation to mark 'partial' when only one bound exists, and record the geography mismatch instead of a null. Verify: on a META rerun, the business chapter states the implied US share and the growth gap (about 22% vs 13.9%) citing the IAB claims. Do not use 'reconciliation not blocked' as the test.

**Verifier check.** Claims confirmed. 'U.S. internet advertising revenues increased 13.9% ... $294.6 billion' is industry_market_size; the social $117.7bn claim is typed industry_segment_size, not industry_market_size. metadata_json.agent_output holds only text, quote and offsets, with no numeric fields. top_down_bottom_up_reconciliation: tam_limit null, customer_budget_limit null, status blocked_source_gap, bottom_up 252.6bn. operating-model.ts:31-40 blocks when either bound is 0 or below. Corrections: (a) IAB covers US only while Meta's bottom-up is global, so tam_limit null is partly right, and recommendation (3), keeping top-down when only TAM exists, would not unblock META. The verification 'reconciliation is no longer blocked' is therefore unrealistic. (b) The demand constraint needs matching-geography company revenue, but Meta's revenue by user geography is not in historical_record (0 observations), so it must come from claims or filing passages. (c) Typing is free-form (67 distinct claim types across 150 claims), so numeric fields keyed on claim_type would miss the social-ad claim. This overlaps the forecast dimension.

### RQ-BIZ-9: Judgment-heavy qualitative calls cannot be routed to a stronger model; each is one Haiku pass while report review takes 59% of spend

Severity **medium**, effort **S**, verdict **corrected**, JD trait: Higher-definition analysis overall (depth of reasoning in business, moat and management judgments)

**Problem.** Each qualitative judgment stage is one call with no second pass. business_process_analysis emits all five artifacts in 20K output tokens, and moat_analysis all three in 10.8K. Model choice is per agent name, and RESEARCH_ALL_AGENTS_MODEL overrides even that. The `modelTier` argument handlers pass only labels budget and escalation records; it does not pick a model. Business, moat, genesis, operating_model and scenarios all run as 'asset-analyst', so the user cannot buy depth where judgment matters without upgrading every asset-analyst call. Spend is concentrated downstream instead: ai_reviewer is 26 calls and $0.613 of $1.045, while business_process_analysis and moat_analysis together cost $0.031.

**Evidence.** model_call_logs joined to research_stages (META):
- business_process_analysis: 1 call, 63,563 / 20,456 tokens, $0.018173;
- moat_analysis: 1 call, 58,997 / 10,782 tokens, $0.012766;
- company_genesis: 6 calls, $0.047;
- ai_reviewer: 26 calls, $0.613.
All calls ran on claude-haiku-5-5.
registry.ts:758-762: resolveAgentModel precedence is override, then RESEARCH_ALL_AGENTS_MODEL, then RESEARCH_<AGENT>_MODEL.
run-context.ts:447 and runner.ts:114 call it without an override.
run-context.ts:479: modelTier is used only for the escalationReason label and the budget reservation.
Handlers pass modelTier 'mid' (9 handlers) or 'cheap' (7).

**Recommendation.** Read an optional RESEARCH_STAGE_<STAGE_KEY>_MODEL in callResearchAgent and pass it as modelOverride to resolveAgentModel (run-context.ts:447). Pass it through runResearchAgent into modelCandidates (runner.ts:113-121) so the primary and the fallback list both honour it, with precedence stage, then all-agents, then agent. The model already sits in the request hash, so cached tasks stay correct. Document it in docs/local-agent-harness.md. Use it for business_process_analysis, moat_analysis and the new management_assessment and investment_debate calls after the input fixes land. Drop the optional split. AGENTS.md requires a small user-approved paid live test before merge. Verify: a unit test shows the stage env changes request.model and the task key, and model_call_logs for a mock run show the override only on those stages.

**Verifier check.** Mechanism confirmed. resolveAgentModel (registry.ts:758-762) accepts modelOverride, but no caller passes one (run-context.ts:447, runner.ts:114 via modelCandidates). modelTier is used only for the escalationReason label, the budget reservation and the logged tier (run-context.ts:479, 502, 514, 567). Handlers pass 'mid' 9 times and 'cheap' 7 times. Business, moat, operating_model, scenarios and genesis all run as asset-analyst. The business call cost $0.018 and the moat call $0.0128. Corrections: (a) The ai_reviewer stage's $0.613 is mostly report writing, not review: 20 report_section calls $0.333, team_requests $0.097, report_outline $0.054, ai_review $0.127. (b) Splitting business_process_analysis for output budget is not needed: it used 20,456 of the 32,768-token cap. (c) A stronger model will still write 'not in the cited claims' until the input fixes (RQ-BIZ-2/3/4) land, so this is an enabler to sequence after them.

## RQ-RPT: Report synthesis, review and export

The report layer turns a broad set of artifacts into a report that hedges a lot and is hard to read. The writer gets raw artifact JSON but none of the numbers that code already computes for the UI (valuationSummary, metricCatalogue). So it does arithmetic in prose, mixes present-value and undiscounted bases, and cannot produce the computed statistics that make the JD example good. The markdown export, which is the deliverable, dumps tables generically. 12 of 32 tables are raw JSON, including every valuation table and a 1.78 MB, 2,311-row dump under a "Quarterly revenue and operating income" heading. The headings are not empty: each sits over a single row of raw JSON, and the app's Reading view never shows these tables, so the UI hides the problem. The report boundary leaves out the full filing statements (financial_statement_set) that the doctrine requires. That one exclusion causes false "statements not parsed" and "bridge incomplete" gaps, and those gaps contribute to the mechanically withheld conclusion. The exec section leads with Q2 facts and spends 57% of its words on limitations; it has no classification, scorecard or "what would change my mind". The reviewer checks accuracy and format, not depth, and is told to conditional_pass "transparently qualified" reports. Because conditional_pass counts as a pass and both team-request rounds are used up before drafting, the review findings (1 critical, 13 high in round 0; 1 critical, 11 high in the final round) never sent any analysis back. The human review page also does not show them.

<details><summary>Measurements</summary>

Report markdown (createReport re-run on stored report_document via tsx, read-only): 2,030,144 bytes, of which 1,845,211 (91%) are table rows. Re-rendering without the observations table gives 246,391 bytes (-88%). createReport takes about 96 ms and its hash matches the stored one. The history table is 2,312 rows and 1,781,228 bytes (2,311 observations, 142 metric_keys) for a title that promises revenue plus operating income. 12 of 32 '###' tables carry JSON cells. 'Not disclosed' appears 10,276 times, mostly null table cells. report_document v2 = 5,185,267 chars (artifacts 2,782,985, incl. historical_record 2,392,742; markdown 2,132,635; sections 180,829; evidence 67,389), and the superseded v1 is 5,165,545, so about 10.4 MB per run. The 6 report_documents in the DB total 35.27 MB. The /report endpoint payload for this run is about 9.88 MB of other artifacts (financial_statement_set 6.6 MB) plus 5.19 MB of report_document. financial_statement_set: 136 tables, 2,488 observations, every filing 'extracted' with missing [], balance-sheet reconciliation passed, yet it is excluded from report inputs. Exec section: 13 paragraphs and 1,333 words; 762 words are in limitation-heavy paragraphs (regex-tagged) plus 217 words in 10 gap bullets. The judgment is paragraph 13. Across the report, about 5,400 of 16,500 paragraph words are limitation-heavy, plus 2,709 gap words. Review: round 0 conditional_pass at q=0.55 with 27 reviewer findings (1 critical, 13 high) plus 3 substance findings; only the substance findings were repaired. Round 1 conditional_pass at q=0.45 with 28 findings (1 critical, 11 high), none acted on. Team-request rounds were used at 14:57:36 and 15:01:37; the outline came at 15:02:44 and the reviews at 15:35:43 and 15:40:16. 0 of 10 requests set requires_rerun. Substance probe (scratchpad substance-probe.ts): checkReportSubstance finds 1 issue in the final sections, versus 13 further leak phrases in fields it scans and 23 in fields it does not scan (11 in gaps, 2 in visual captions, 10 in questions). Cost (model_call_logs): outline+sections+review = $0.514 of $1.045 (49%). Team briefs, requests and answers = $0.20. Writer input tokens: valuation section 104k, history section 277k, evidence-gaps section 356-366k. Each review is about 476-481k tokens on claude-haiku-5-5. Scratch files: /private/tmp/claude-501/-Users-japardinathaniel-Documents-GitHub-Investing-Research-Pipeline/fdaaf424-0588-4f7e-be73-9b055f9db53a/scratchpad/substance-probe.ts, /private/tmp/claude-501/-Users-japardinathaniel-Documents-GitHub-Investing-Research-Pipeline/fdaaf424-0588-4f7e-be73-9b055f9db53a/scratchpad/rerender-probe.ts, /private/tmp/claude-501/-Users-japardinathaniel-Documents-GitHub-Investing-Research-Pipeline/fdaaf424-0588-4f7e-be73-9b055f9db53a/scratchpad/doc-sections.json, /private/tmp/claude-501/-Users-japardinathaniel-Documents-GitHub-Investing-Research-Pipeline/fdaaf424-0588-4f7e-be73-9b055f9db53a/scratchpad/report-document.json

</details>

### RQ-RPT-1: Markdown export dumps section tables as raw JSON: valuation tables are unreadable and a 1.78 MB observation dump fills 88% of the report

Severity **high**, effort **M**, verdict **confirmed**, JD trait: Readable exhibits: JD section 4 twenty-quarter table and section 13 operating-case x valuation-assumption DCF matrix

**Problem.** The '### Bear/Base/Bull case FCFF build...' headings are not empty. Each one sits over a single 17-column row whose cells are raw JSON, 5,700-6,000 characters per line, which renders as an unreadable strip. The cause is an export rendering bug, not visuals that exist only in the UI. createReport renders every section table with a generic tableMarkdown that JSON.stringifies any nested value and prints null as 'Not disclosed'. A table spec is only {title, artifact_id, path}, with no column or metric filter. So a writer asking for 'Quarterly revenue and operating income' gets every historical_record observation, all 142 metrics with metadata_json. The UI hides this. The Reading view does not render section.tables at all (they appear only in Analysis view as collapsible records), and the valuation chapter draws from ValuationDashboard/valuationSummary. The reviewer is given no rendered markdown either. So the exported deliverable is the only place the defect shows, and nothing checks it. Nulls rendered as 'Not disclosed' also mislead: no_rerating_return was not computed, yet the table shows it as 'Not disclosed', as if the company withheld it.

**Evidence.** src/lib/research/reporting/report.ts:52 (cell: null->'Not disclosed', object->JSON.stringify), :53-62 (tableMarkdown), :129 (every s.tables entry rendered this way); src/lib/research/reporting/contracts.ts:49 (table = {title, artifact_id, path}); src/lib/research/reporting/report.ts:26-29 and runtime.ts:117 (reviewer gets no markdown); src/components/research-report.tsx:74,114 (tables only in 'analysis' mode), :106 (ValuationDashboard). report.md:2799-2815 rows of 6,036/5,971/5,749 chars; :35-38 the exec section's first exhibit is the same JSON blob; :2845 'no_rerating_return ... Not disclosed'. Per-heading scan: 12 of 32 tables have JSON cells (all FCFF builds, driver inputs, annual schedules, per-share path, top-ten backtest). The history table under :187 is 2,312 rows and 1,781,228 bytes. SQL: 2,311 observations and 142 distinct metric_keys in historical_record. Table rows are 91% of markdown bytes. Re-rendering via createReport without observation tables gives 246 KB vs 2.03 MB. Code-built visuals (Revenue by case, Base case bridge, PV per share) render cleanly because they go through buildVisual (report.ts:137).

**Recommendation.** As proposed. In createReport, send 'observations'/'ttm_series' paths to a pointer line or a capped historyMatrix pivot (optional metric_keys, at most 8, last 20 periods). Render method_schedules/method_inputs years as rows with calculateValuationSchedule (NOPAT, D&A, capex, dNWC, FCFF, discount factor, PV). Flatten other objects through readerValue/label. Print null as an em dash, not 'Not disclosed'. In section validation, reject tables whose rendered cells start with '{'/'[' or that exceed about 40 rows. Bump STANDARD_VERSION and branch the renderer on the stored document.standard_version so the four reports now waiting at review keep passing getReportState. Verify with a unit test that re-renders the stored META document under the new version: no JSON cells, markdown at most 300 KB, FCFF tables with 3 year rows. Under the old version all four pending documents must still match their content_hash.

**Verifier check.** Confirmed on main. report.ts:52 cell() prints null as 'Not disclosed' and JSON.stringifies objects; :53-62 tableMarkdown; :129 renders every section table that way; contracts.ts:49 table spec is {title, artifact_id, path} only. Parsing the stored report_document gave 30 section tables, 13 with nested-JSON cells (12 plus the history table): exec + 3 FCFF builds (method_schedules.N, 1 row each), 3 driver-input tables, 3 annual schedules, the per-share path and backtest top_ten. report.md:2803/2809/2815 are single rows of 6,036/5,971/5,749 chars, and :2845 shows no_rerating_return as 'Not disclosed' while the DB value is null. The table at :187 is historical_record.observations: 2,311 rows, 142 metric_keys, about 1.78 MB. Table lines total 1,846,291 of 2,031,417 bytes (91%), and 'Not disclosed' occurs 10,276 times. research-report.tsx:114 shows tables only in analysis mode and filters out observations; reviewDocument (report.ts:26-29) drops markdown before the review. I re-ran createReport read-only on all four pending report_documents (02c8d48b, 1d427f3f, 7fa1f00a, 4fae0fb1): each still passes the hash and markdown integrity check. That confirms the versioning caveat in the recommendation is necessary, because any renderer change would make every pending report fail getReportState (store.ts:90-93). The severity holds because the hashed, approved and exported artifact is this markdown.

### RQ-RPT-2: Writers get raw artifacts but no code-computed facts, so they do valuation and history arithmetic in prose, mix bases, and cannot produce JD-style statistics

Severity **high**, effort **M**, verdict **corrected**, JD trait: JD sections 4-5 computed history statistics and current-vs-median positioning, cash conversion; section 1 segment profit pools; section 14 reverse DCF in FCF growth; section 15 FCF-yield cross-check; section 16 no-rerating return

**Problem.** The product requirements say the writer explains stored schedules and must not recompute model outputs. In practice, the numbers a reader needs are not stored anywhere the writer can see. The weighted PV (378), PV-basis returns (-84/-47/-19%), terminal value as a share of EV, cumulative FCFF, FCF yield and implied multiple at the price, history medians and current-vs-median, and segment profit pools are all missing from its inputs. valuationSummary computes several of them, but only for the UI. metricCatalogue computes 39 ratios (operating margin, FCF margin, ROIC, SBC, P/FCF), but only for the Financials tab. historical_diagnosis has operating_margin_gaap with 1 observation, although historical_record holds 20 quarters of revenue and OperatingIncomeLoss. The writer therefore derives figures itself, and the reviewer then flags them as 'derived by the writer', 'two bases' and 'TV share stated inconsistently'. Two artifacts mislead it directly. reverse_valuation is computed on present value today, but its basis string never says so, which produced the leaked sentence 'does not state whether it runs on a present-value or undiscounted basis'. expected_return_matrix holds undiscounted, cumulative FY2028 returns with no basis label. no_rerating_return is left to the model to judge and came back null.

**Evidence.** src/lib/research/reporting/runtime.ts:86-89 (writer packet = common + selected artifacts + section_plan + outline + feedback); src/components/report/valuation-summary.tsx:32 is the only caller of valuationSummary (reporting/valuation-summary.ts:75); src/lib/research/reporting/metric-catalogue.ts:274-325 is used only by the Financials UI. src/lib/research/handlers/asset-valuation.ts:551 basis text has no 'present value', while valuation/engine.ts:257-261 computes 'Today's value per share'. decision-synthesis.ts:150-157: returns = (FY2028 price_target - price)/price, undiscounted and not annualized; :225 'Judge no_rerating_return...'. DB: expected_return_matrix.no_rerating_return = null; historical_diagnosis operating_margin_gaap observation_count = 1; historical_record quarterly revenue 60 rows and us_gaap_OperatingIncomeLoss 60 rows. Round-1 review findings: 'cumulative free cash flow totals ... are not in any stored artifact; they are derived by the writer'; 'Return figures are presented on two bases'; 'terminal value share ... stated as 99% to 129% in some places and as 102.8%...'. docs/research-product-requirements.md, Valuation section, last bullet. Report prose has 'FCF yield' once, 'median' once, and no no-rerating figure.

**Recommendation.** Add reporting/facts.ts, which builds report_facts deterministically from stored artifacts. It computes per-case PV/share, the probability-weighted PV, PV-basis returns (cumulative and annualized), labelled undiscounted FY-terminal returns, TV % of EV, the explicit FCFF sum, implied EV/NOPAT and TTM FCF yield at the price, a uniform-FCF-growth reverse solve (bisection over calculateValuationSchedule, like impliedOperatingMargin) and a code-computed no-rerating return. It also computes 20-quarter median/min/max/current for revenue YoY, operating margin, FCF margin, capex/revenue and SBC/revenue (reusing metricCatalogue), plus segment operating-income shares. Pass it to writers, the reviewer and the valuation UI so all three use one labelled basis. Add 'present value per share today' to the asset-valuation.ts:551 basis string and a basis field to expected_return_matrix. Verify with a unit test on the stored META artifacts: weighted PV 378.27, base TV share 102.8%, and FoA/RL Q2 2026 operating income 23,394/-4,619. On the next run the review should contain no 'derived by the writer' or 'two bases' findings.

**Verifier check.** The core claim holds. The writer packet is common plus selected artifacts (runtime.ts:86-89). No computed facts are supplied, and the reviewer flagged 'derived by the writer' (round 1, forecast-scenarios), 'two bases' and TV-share inconsistency (round 1 high). expected_return_matrix has no basis field and no_rerating_return is null. decision-synthesis.ts:150-157 computes undiscounted terminal-year returns, and :225 leaves no_rerating to the model. historical_diagnosis operating_margin_gaap has observation_count 1, while historical_record holds 20 consolidated quarters each of revenue and OperatingIncomeLoss (2021Q3-2026Q2). The basis string at asset-valuation.ts:551 does not say 'present value'. Correction: valuationSummary does not compute the weighted PV (378.27), PV-basis returns or the TV share. Its weighted value is valuation.weighted_target = 510.40, the undiscounted FY2028 weighted target, and its scenario values are the terminal anchors 216/528/768. It only copies per-case value_per_share (PV). So facts.ts has to compute these itself, from method_schedules (PV = 0.25*119.05 + 0.5*395.17 + 0.25*603.67 = 378.27; base TV PV 1,064,585 over EV of about 1,036k = 102.8%). The UI hero on the valuation chapter shows 'weighted target per share for 2028' of 510 while the prose leads with PV 378, so the basis split also reaches the Reading view. metricCatalogue's only consumers are Financials components and chart-series (confirmed).

### RQ-RPT-3: The full filing statements are excluded from report inputs although the doctrine demands them, creating false 'not parsed' and 'bridge incomplete' gaps that help force a withheld conclusion

Severity **high**, effort **S**, verdict **corrected**, JD trait: JD section 10 balance-sheet net cash computed from statements; framework section 8.3 twenty-quarter dataset

**Problem.** loadReportInputs deliberately drops financial_statement_set to save context. RESEARCH_DOCTRINE item 1, sent to the planner, writers, reviewer and team owners, says the complete issuer-reported primary statements are the deliverable and must be checked. Every report agent therefore concludes the statements were never parsed. The META run did capture them: 136 tables and 2,488 observations, every filing 'extracted' with nothing missing, and the reconciliation checks passed. Team requests 1-3 and 2-1 came back 'unavailable'. includeUnansweredQuestions turned them into material blocked questions, which createReport counts toward 'withheld'. The reviewer raised it as its only critical finding. The equity-bridge gap is also partly false. Team answer 2-2 read the 10-Q and found no current-debt line and no current finance-lease line, yet the exec and valuation chapters still list 'bridge omits current debt and finance lease liabilities' as unresolved.

**Evidence.** src/lib/research/reporting/store.ts:5-9 ('financial_statement_set' in the excluded products list); src/lib/research/reporting/contracts.ts:107 (doctrine 1); runtime.ts:72,99,114 (doctrine sent to planner, writer and reviewer); team.ts:509-515 (unanswered material request -> blocked question); report.ts:118 (blocked -> withheld). SQL on financial_statement_set (validated): 136 tables, 2,488 observations; coverage entries form 10-Q/10-K status 'extracted' missing [] unresolved_facts 0; reconciliation 'assets = liabilities + equity' passed. team_requests request-1-3/2-1 status 'unavailable' ('The supplied passages are cover pages, tables of contents...'); request-2-2 answer: 'The balance sheet shows no separate current debt line, and no current finance lease liability line'. Round-1 review: historical-performance research_gap critical ('The required Financials deliverable ... is not presented'). report.md:3189-3213 shows these as blocked research questions; report.md:46,2903 'bridge is therefore incomplete'.

**Recommendation.** Keep the 6.6 MB artifact out of packets. Add a code-built financial_statement_summary of a few KB to loadReportInputs, which reaches writers, the reviewer and team owners. It holds expected versus captured filings (form, period end, status, table count, missing list), reconciliation results, and the latest balance-sheet line labels with explicit 'line not presented' flags for current debt and finance leases. Give the same summary to decision_synthesis. Reword doctrine 1 for these agents: the statements live in Financials, and only gaps the summary shows (for META, the three uncaptured 10-Qs) may be reported. Add a substance rule that flags 'not parsed' or 'did not contain the statement tables' when the summary shows extracted filings. Verify on a META replay: one qualified question naming the 2021Q3/2022Q1/2022Q2 10-Qs, no 'statements not parsed' text in decision_record or the report, and no current-debt bridge gap.

**Verifier check.** store.ts:9 excludes financial_statement_set, and team owners also load inputs through loadReportInputs (team.ts:377), so neither writers nor owners see it. The DB shows 136 tables, 2,488 observations and 17 coverage entries, all 'extracted' with missing [] and unresolved_facts 0, and 34/34 reconciliations passed. The requests at request-1-3 and 2-1 are 'unavailable' ('supplied passages are cover pages...'). Request-2-2 found no current-debt line. Two corrections. (1) The 17 captured filings run 10-K 2021-12-31 then 10-Q 2022-09-30 to 2026-06-30. The 10-Qs for 2021Q3, 2022Q1 and 2022Q2 were never captured, so that part of the gap is real. Only the claim that the statements were not parsed at all ('reviewed filings did not contain the statement tables') is false. (2) The false narrative starts upstream too. decision_record.rationale (decision synthesis, agent asset-analyst, which gets RESEARCH_DOCTRINE automatically via run-context.ts:337) already says 'the 20-quarter primary statement history is not parsed', and every writer reads it. The bridge gap is code-generated by the valuation engine ('Equity bridge items not captured: current_debt, finance_lease_liabilities') and is only half false: there is no current-debt line, but a finance-lease balance exists (1,184m at 2025-12-31), so that gap is real. Withholding does not depend on this alone: ownership and management coverage, q-price-verification and q-equity-bridge are also blocked.

### RQ-RPT-4: The report leads with process and caveats, not a thesis: no classification, decisive insight, value table, scorecard or 'what would change my mind', and the withheld status is set mechanically

Severity **high**, effort **M**, verdict **corrected**, JD trait: JD section 1 executive conclusion with decisive reframing, valuation table and decision/confidence; section 2 what the investor owns; final scorecard and 'what would change my mind'

**Problem.** The JD example opens with one reframing insight (two economic engines), a valuation table, the decision with its confidence, what the investor owns, a scorecard and what would change the analyst's mind. META's executive section opens with Q2 revenue figures and puts the judgment in paragraph 13 of 13. 57% of its words sit in limitation-heavy paragraphs, followed by 10 gap bullets, and its first exhibit is a raw JSON FCFF dump. Chapter 2 is 932 words on Thefacebook's origins. The report has no scorecard and no 'what would change my mind'. A cross-check is used once. The reframing the data supports is never stated: the Family of Apps earns about 23.4bn of operating income a quarter, Reality Labs loses about 4.6bn, and AI capex absorbs 77% of operating cash flow. The causes are structural. The outline rule only says 'First section should summarize the eventual judgment'. The decision schema has approve/reject/pending, and the decision model is told the decision 'must remain pending', so the analyst's own classification is never recorded. createReport sets 'withheld' whenever any coverage key or material question is blocked, and every unanswered team request becomes a blocked question. A standalone evidence chapter got past the validator by also listing 'conclusion', and the reader UI hides only legacy SoFi section ids.

**Evidence.** Section order (report_document.sections): executive-judgment, origins-and-founder, business-model..., historical-performance, ..., backtest-timing-evidence, evidence-gaps-and-unresolved. Exec paragraph kinds f,a,f,a,a,a,a,a,a,f,a,s,a; paragraph 1 'Meta's advertising engine is still growing...'; paragraph 13 'Judgment: I do not find the shares supported...'. Word tally: exec 1,333 paragraph words, 762 limitation-heavy, 217 gap words; whole report about 5,400 of 16,500 paragraph words limitation-heavy plus 2,709 gap words. grep on prose: 'scorecard' 0, 'change my mind' 0, 'FCF yield' 1, 'median' 1. runtime.ts:73 outline rule; decision/contracts.ts:139 decision enum approve|reject|pending; decision-synthesis.ts:227 'The decision must remain pending'; report.ts:118 withheld rule; team.ts:512-514; contracts.ts:84 validator only rejects coverage limited to history/evidence (this chapter is [evidence, conclusion]); data-views.ts:31-32 and presentation.mjs:169-177 hard-coded SoFi ids. The round-1 reviewer flagged the standalone evidence chapter as high.

**Recommendation.** Add a thesis block to the Outline: decisive_insight, a classification from framework §12's five values with confidence, and what_would_change_my_mind (3-5 metric_key + threshold items linked to thesis_breakers). Record that classification in decision_record separately from the human approval enum, and drop the 'must remain pending' coupling for the analyst view. Fix the first section's order: classification line (approval status shown separately), insight, value table from report_facts, what you own, scorecard from confidence_assessment, what would change my mind, and at most 3 decision-critical gaps. Move the rest to an appendix. Withhold only when coverage is blocked or a question with materiality 'critical' is blocked. Unanswered team requests enter as 'material' and do not withhold. Reject non-first sections whose coverage is a subset of {history, evidence, conclusion}, and remove the SoFi id lists. Verify on the next run: exec paragraph 1 carries the classification and insight, the exec has at most 3 gaps, there is one conclusion section, and gap words are under 15% of the report.

**Verifier check.** Confirmed. The exec section has 13 paragraphs (f,a,f,a,a,a,a,a,a,f,a,s,a): paragraph 1 is Q2 revenue and paragraph 13 is the judgment. It runs 1,333 words plus 10 gaps (217 words). 'scorecard' and 'change my mind' each occur 0 times, and 'FCF yield' and 'median' once each. origins-and-founder is 932 words. runtime.ts:73 is the outline rule; decision/contracts.ts:139 limits decision to approve/reject/pending; decision-synthesis.ts:227 says it 'must remain pending'; report.ts:118 is the withheld rule; contracts.ts:84 is the validator escape (evidence-gaps-and-unresolved = [evidence, conclusion]); data-views.ts:31-32 and presentation.mjs:169-177 hard-code SoFi ids. Corrections. (1) Framework §12 'Decision Standard' (docs/research-framework-v2.1.md:2303-2310) requires exactly one of Attractive / Watchlist / Fully valued / Speculative / Avoid. The classification should use that enum, not attractive|neutral|unattractive|avoid; the pipeline currently never produces any framework classification. (2) Question.materiality already has 'critical', so no new decision_critical field is needed. (3) Even with the narrower rule, META stays withheld: q-price-verification and q-equity-bridge are critical/blocked, and the planner blocked ownership and management coverage. The fix improves structure, not this run's status. (4) The 77% capex/OCF figure does appear (exec paragraph 4). What is missing is the two-engine framing as the lead (Q2 2026 FoA operating income 23,394m vs RL -4,619m, confirmed in historical_record).

### RQ-RPT-5: The AI reviewer judges citation accuracy and format, not analytical depth, and is told to conditional_pass hedged reports

Severity **high**, effort **M**, verdict **corrected**, JD trait: All JD traits as a review rubric (framework section 8 items 9, 16, 18, 20, 23, 24)

**Problem.** The reviewer's rules cover entailment, unsupported numbers, contradictions, consistency, visuals and backtest disclosure. None asks whether the report contains the framework's required analyses or the traits that make the JD example good. The output schema is free-form: one quality_score and an unconstrained verdict. The prompt says 'A transparently qualified report may receive conditional_pass', and compose.ts treats conditional_pass as a pass. A report that hedges everything therefore passes, while confident analysis risks 'fail' for 'unsupported recommendations'. On META the reviewer called the missing FCF-yield and multiple cross-check 'acceptable'. It passed the report at quality 0.55 and then 0.45 despite 1 critical and 11-13 high findings. It also raised a high-severity false positive, because the instructions contradict each other on where the exec judgment goes. The reviewer runs on claude-haiku-5-5 over about 480k input tokens per review, which thins its attention further.

**Evidence.** src/lib/research/reporting/runtime.ts:115-119 (reviewer rules; :118 'A transparently qualified report may receive conditional_pass'); src/lib/research/stage-contracts.ts:84-88 (findings z.record free-form, single quality_score, free verdict); compose.ts:47 (pass includes conditional_pass). report_review rounds: q=0.55 then 0.45, both conditional_pass. Round-1 finding on valuation: 'No P/E, EV/EBITDA or FCF yield cross-check is presented... This is acceptable'. Contradiction: contracts.ts:113 'write the executive judgment last' vs runtime.ts:73 'First section should summarize'; round-1 high finding 'The executive judgment is placed as the first section rather than written last'. model_call_logs: research-reviewer input 476,438 and 481,362 tokens, model claude-haiku-5-5.

**Recommendation.** Add a fixed depth_checks array to AI_REVIEWER_CONTRACT, keyed to framework §8/§11 and the JD traits. Each item records status met|partial|missing|data_unavailable|not_applicable, plus section_id, why and owner_stage. Derive verdict and quality_score in code: 'missing' (the stored data supports it but the report lacks it) on a decision-critical check, or an open high/critical calculation or evidence finding, gives needs_more_work. 'data_unavailable' gives at most conditional_pass, so approval stays possible. Replace the 'transparently qualified -> conditional_pass' sentence with 'Hedging does not substitute for analysis the stored data supports.' Reword doctrine 7 to 'draft the executive judgment after the body; place it first'. Give the reviewer a compact packet (report + report_facts + referenced artifacts). If a stronger reviewer model is wanted, let per-agent model keys take precedence over RESEARCH_ALL_AGENTS_MODEL. Verify offline by re-scoring the stored META report: no-rerating, FCF yield and what-would-change-my-mind come back 'missing', voting control comes back 'data_unavailable', and the verdict is needs_more_work.

**Verifier check.** runtime.ts:115-119 holds the reviewer rules (:118 'A transparently qualified report may receive conditional_pass'), and compose.ts:47 counts conditional_pass as passed. The reviewer gave q=0.55 then 0.45, both conditional_pass, with 1 critical and 13/11 high findings. The 'acceptable' cross-check finding is real (round 1, medium research_gap). The doctrine conflict is real: contracts.ts:113 says 'write the executive judgment last' and runtime.ts:73 says the first section summarizes it, which produced a high finding in round 1. The reviewer calls used 476,438 and 481,362 input tokens on claude-haiku-5-5. Corrections. (1) review_verdict is a z.enum of 4 values (stage-contracts.ts:87), not free; only findings are free-form records. (2) Haiku came from the run's RESEARCH_ALL_AGENTS_MODEL, and registry.ts:761 gives that override precedence over per-agent keys, so 'a stronger tier for this one call' cannot be set by env today. (3) Deriving needs_more_work in code from missing depth checks would deadlock approval. review/route.ts:70 accepts only pass/conditional_pass, and a human 'needs_more_work' only rewrites prose (route.ts:129-131), so a check that is missing because the data does not exist (for example no proxy for voting control) would block approval permanently.

### RQ-RPT-6: Review findings cannot send the analysis back: conditional_pass drops them, team-request rounds are spent before drafting, human 'needs more work' only rewrites prose, and findings are hidden from the human reviewer

Severity **high**, effort **M**, verdict **corrected**, JD trait: Iterating the analysis itself (JD sections 12-17 scenarios, DCF matrix, reverse DCF, no-rerating, impairment) rather than only the prose

**Problem.** Five mechanisms combine. (1) With conditional_pass, compose repairs only the deterministic substance findings. In round 0, 27 reviewer findings (1 critical, 13 high) were never repaired, and the final round's 28 findings were stored but never acted on. (2) Reviewer research_gap, calculation and evidence findings go to requestMissingResearch, which silently returns once two rounds exist. draftAndReviewReport spends both rounds before the outline is written, so for this run the reviewer's route was a no-op. (3) Even when requests run, owners 'answer from the run's documents without rerunning their analysis'. A rerun happens only if the owner model sets requires_rerun, which 0 of 10 did. (4) A human 'needs_more_work' resets only ai_reviewer, human_review, export and refresh_schedule, so valuation and scenarios never rerun. (5) Approval is allowed at conditional_pass whatever the score or open findings, and the /review page shows the report but none of the AI findings. The result is that neither the AI reviewer nor the human can get the analysis redone, only the writing.

**Evidence.** compose.ts:47-50 and :68 (passed => researchFindings=[], writingFindings=substance), :48 (round 1 returns unconditionally); runtime.ts:49 (pre-draft requestMissingResearch), :120-121 (post-review); team.ts:149 ('if ((previous?.round || 0) >= 2) return;'), :158 ('Owners answer ... without rerunning their analysis'). Timeline (model_call_logs): team:requests:0 14:57:36, team:requests:1 15:01:37, report:outline 15:02:44, report:review 15:35:43 and 15:40:16; no team_requests version after 15:01:48 (v9, round 2). team_requests: 0/10 responses with requires_rerun. review/route.ts:129-131 (stage reset list), :70 (approval allowed for pass|conditional_pass). src/app/review/page.tsx:113 renders only <ResearchReport>; grep shows no UI reference to findings, review_summary or quality_score. report_review severity counts: round 0 critical 1 / high 13 / medium 12 / low 1 plus substance 3; round 1 critical 1 / high 11 / medium 15 plus substance 1.

**Recommendation.** (1) In compose.ts, treat conditional_pass with open high or critical findings as needs_more_work, and run one scoped repair using all of that round's findings. (2) Reserve one team-request round for after the review, counting pre-draft and post-review rounds separately. Do not throw from inside review(): save the review first, then queue the requests, and on resume feed the answers only as feedback to the sections the findings name. Keep specialist_requests out of the packets (and task-key hash) of unaffected sections so the outline and untouched sections reuse their outputs. (3) Add an analysis_rework category with owner_stage that maps to a requires_rerun team request through rerunRequestStages, at most once per run, in auto or approval mode. (4) Let a human 'Request more work' name stages to rerun through the same function. (5) Show verdict, quality and findings by severity on /review, and require acknowledgement before approving with open high or critical findings. Verify with a mock-provider DB test: a conditional_pass with a high calculation finding triggers one repair round; a post-review request regenerates only the named sections (count report:section tasks); analysis_rework on asset_valuation reopens that stage once.

**Verifier check.** All five mechanisms are confirmed on main. compose.ts:68 sets writingFindings = substance when the review passed, and :48 returns at round 1. team.ts:149 skips when the round is 2 or more. Both rounds were spent before the outline (team:requests at 14:57:36 and 15:01:37, outline at 15:02:44): each re-entry of draftAndReviewReport calls requestMissingResearch again at runtime.ts:49. All 10 requests lack requires_rerun. route.ts:129-131 lists the stages a human 'needs_more_work' resets, and :70 is the approval gate. src/app and src/components have no consumer of findings, review_verdict or quality_score (the read model ships report_review and findings artifacts that nothing renders). The finding counts are right: round 0 has 27 reviewer findings + 3 substance, round 1 has 27 reviewer findings + 1 substance. Correction to recommendation (2), the post-review round as currently wired. requestMissingResearch throws ResearchRequestsPending inside review() (runtime.ts:121) before the report_review is saved. Every outline and section packet includes common.specialist_requests (runtime.ts:57), and the task key hashes the request (run-context.ts:361-362; reuse at :466-467). On resume the outline and all 12 sections therefore miss their cached outputs and are regenerated, roughly a second full report (about $0.45 on META), and the throw at runtime.ts:82 after the outline does the same to the outline.

### RQ-RPT-7: Pipeline narration reaches the reader: the substance check scans too few fields with too few patterns, and code itself inserts UUID 'Citations removed' notes and verbatim team work orders

Severity **medium**, effort **S**, verdict **corrected**, JD trait: Analyst voice without process narration (product requirements: Report writing and organization)

**Problem.** checkReportSubstance scans only the title, paragraphs, counterevidence and implication of each section, and only for a short list of terms. It misses 'an earlier draft', 'the model's note', 'the stored matrix (the field is null)', 'does not state whether ... present-value' and 'stored FCFF cases'. It never looks at gaps, visual captions, table titles, research questions or coverage rationales. Code creates some of the leaks itself. keepUsableReferences appends 'Citations removed because their source is undated or outside the report inputs: <uuid>, <uuid>' to reader-facing gaps. includeUnansweredQuestions copies internal team work orders ('Parse the full issuer-reported primary statements...') verbatim as reader research questions, with the owner's answer ('The supplied passages are cover pages...'). Writers are also fed process transcripts: every writer gets specialist_requests, and decision_record.rationale narrates the reconciliation ('Figures of 190.56, 513.71 and 745.09 USD cited in the reconciliation request...'). Substance findings from the final round are never repaired. The 190.56/513.71/745.09 figures were the first valuation's outputs, overwritten in place before PR #68 (supersede on save, artifacts/repository.ts:71-117), so that part is fixed. The leakage paths remain.

**Evidence.** src/lib/research/reporting/substance.ts:4-13 (INTERNAL_TERMS), :33-34 (scanned fields only); runtime.ts:38 (code-inserted 'Citations removed ...' gap with raw IDs), :57 (specialist_requests in every writer packet); team.ts:509-515 (team requests -> reader questions verbatim); compose.ts:48 (final round not repaired). Probe (scratchpad substance-probe.ts on the final sections): checkReportSubstance = 1 finding, plus 13 further leak phrases in scanned fields and 23 in unscanned ones (gaps 11 incl. 5 'Citations removed', visual captions 2 incl. 'Code rebuilds the base case from stored FCFF', questions 10 incl. 'The packet has no proxy'). report.md:2789 'The reverse valuation does not state whether it runs on a present-value or undiscounted basis'; :2791 'No-rerating return is not computed in the stored matrix (the field is null)'; :2793 'The model's note says escrow is excluded'; :2903 'earlier draft figures'; :3189-3219 work-order questions. The round-1 reviewer also flagged this as medium writing findings on origins and business.

**Recommendation.** (1) Extend checkReportSubstance to gaps, visual captions, table titles, questions (question, answer, follow_up) and coverage rationales. (2) Add narrow patterns only, for example \b(earlier|previous|prior) (draft|version|run)\b, \bthe model'?s note\b, \bstored (matrix|outputs?|FCFF|cases)\b, \bthe field\b, \bcode (rebuilds|computes)\b, \b(reviewed|supplied) passages\b, \bthe packet\b, and run each pattern against the stored reports of all four pending runs as a false-positive check before adoption. (3) Record dropped citations in report_review metadata, never in section.gaps. (4) Stop appending team requests verbatim. Have the planner map each unanswered request to a reader question (it already receives specialist_requests). (5) Give writers only {answer, status, evidence_ids} from specialist_requests. (6) After the final round, run the check once more and list remaining hits for the human reviewer instead of silently returning. Verify: the scratchpad probe on a regenerated report returns 0 hits, with no new hits on the four stored reports' clean prose.

**Verifier check.** substance.ts:4-13 and :33-34 confirmed: only title, paragraphs, counterevidence and implication are scanned. runtime.ts:38 appends 'Citations removed ...: <uuids>' to reader gaps. team.ts:509-515 copies unanswered requests in verbatim. compose.ts:48 never repairs the final round. Re-running the scratch probe gives 1 checkReportSubstance finding and 13 probe hits in scanned fields, 12 beyond the one it catches, not 13 further. Unscanned fields have 23 hits (gaps 11, captions 2, questions 10). report.md:2791 has 'the field is null' and :2904 'earlier draft figures'. Correction to the patterns. A substance finding forces a repair round even on a passed review (compose.ts:48: passed && !substance.length). The proposed broad patterns would flag ordinary analyst prose and buy needless paid repairs: \bthe model'?s\b ('the model's base case'), \bthe (packet|request|record)\b ('the historical record'), \bis null\b. The PR #68 remark is accurate.

### RQ-RPT-8: The coverage map is set before any section is written and never reconciled, so the completeness table contradicts the chapters

Severity **medium**, effort **S**, verdict **confirmed**, JD trait: JD section 20 confidence/completeness gates per area

**Problem.** composeReviewedReport saves the planner's coverage statuses and rationales and copies them into the final document unchanged. They describe what the planner expected the writers to do, not what they did. On META the completeness table claims 'downside: Bear and no-rerating downside are quantified'. The valuation chapter says no-rerating is not computed, and expected_return_matrix.no_rerating_return is null. 'monitoring: satisfied' stands even though the final reviewer raised a high research_gap that the monitoring thresholds cannot be tested. A reader who trusts the completeness table is misinformed, and the withheld/qualified status is derived from these unreconciled statuses.

**Evidence.** compose.ts:21-23 (outline incl. coverage planned and saved first), :40 (createReport({...input, ...outline, sections})); SQL: report_outline.content_json->'coverage' = report_document.content_json->'coverage' returns true (1 outline version). Coverage row 'downside | qualified | Bear and no-rerating downside are quantified...' vs report.md:2791 and DB expected_return_matrix.no_rerating_return null. Coverage 'monitoring | satisfied' vs round-1 finding monitoring-and-thesis-breakers research_gap high. report.ts:118-119 derive conclusion_status from coverage and questions.

**Recommendation.** As proposed. Let the last conclusion writer (which already gets every completed section, runtime.ts:88) return a final coverage array, validate it through createReport, and use it in place of the planner's provisional coverage. Add a code check: 'downside' may be satisfied or qualified only if report_facts has a non-null no-rerating return or a section gap states its absence, and 'monitoring' cannot be satisfied while a review finding marks thresholds untestable. Verify with a compose unit test using mocked actions in which the conclusion writer downgrades a status, and on a META replay check that 'downside' no longer claims no-rerating is quantified.

**Verifier check.** compose.ts:21-23 plans and saves the coverage, and :40 passes the outline coverage unchanged into createReport. SQL comparing report_outline.coverage with report_document v2 coverage returns true. Coverage 'downside | qualified | Bear and no-rerating downside are quantified' contradicts report.md:2791 ('No-rerating return is not computed ... the field is null') and DB expected_return_matrix.no_rerating_return = null. 'monitoring | satisfied' stands despite the round-1 high research_gap on monitoring-and-thesis-breakers. report.ts:118-119 derive conclusion_status from these statuses.

### RQ-RPT-9: report_document is 5.2 MB per version because it embeds copies of all input artifacts plus the dumped markdown, and the Report tab loads about 15 MB

Severity **medium**, effort **M**, verdict **corrected**

**Problem.** Each saved report_document carries the full content of every input artifact (2.78 MB, 2.39 MB of it historical_record, which also exists as its own row) plus 2.13 MB of markdown, 1.78 MB of which is the observation dump. compose saves a full document every round, so a run stores two (10.4 MB). The /report read model returns all non-superseded artifacts (9.88 MB, including the 6.6 MB financial_statement_set) and the report_document again, about 15 MB per Report-tab load. getReportState re-renders the whole document on every review, chat and export call, and its integrity check needs the embedded artifacts.

**Evidence.** SQL jsonb_each on report_document v2: artifacts 2,782,985; markdown 2,132,635; sections 180,829; evidence 67,389 (total 5,185,267). v1 superseded 5,165,545. All 6 report_documents in the DB = 35.27 MB. The run's non-superseded non-report artifacts = 9.88 MB. compose.ts:41 (save each round); artifacts/read-model.ts:107-112,146-147 (artifacts + report_document in one payload); store.ts:90-93 (re-render and integrity check). Measured: createReport about 96 ms; markdown without the observation tables 246,391 bytes. artifacts/repository.ts:71-117 inserts versions with stable ids, and scripts/storage-gc.ts has no DELETE on research_artifacts, so referencing by id is safe.

**Recommendation.** Store artifact_refs [{id, artifact_type, artifact_version}] in report_document instead of artifact content. Hydrate them by id in getReportState, the read model and the reader before the integrity check, keeping input_hash as is; together with RQ-RPT-1 this brings a version to about 0.45 MB. Load financial_statement_set only when the Financials tab opens. Stop the 60 s /report poll on the view page once the run status is not running, re-arming it after review or rerun actions. Verify: length(content_json::text) of the next report_document is under 600 KB, the integrity check passes, the /report response for that run is under 3 MB, and no /report requests appear in the network log of an idle tab on a waiting run.

**Verifier check.** jsonb_each on report_document v2 gives artifacts 2,782,985, markdown 2,132,635, sections 180,829 and evidence 67,389 (total 5,185,267); v1 (superseded) is 5,165,545. The 6 report_documents total 35.27 MB. The run's other non-superseded artifacts total 9.88 MB (financial_statement_set 6,617,393). read-model.ts:106-112 returns all non-superseded artifacts plus report_document, and model_call_logs adds another 0.75 MB of metadata. Only artifact content is mutated in place at team.ts:277, and that is team_requests, which is excluded from report inputs; nothing deletes research_artifacts, so reference-by-id is safe. The research-store sync (PR #74) copies every table, so these 5 MB documents also go into the git-backed store. Addition: the asset view page polls /report every 60 s whenever the tab is visible, even for finished or waiting runs (view/page.tsx:148). That means about 15 MB per minute per open tab for META. The prior audit noted this in P1 part (4), but the fix only stopped run-page polling, so that part is still open (previously deferred/partially fixed, P1).

### RQ-RPT-10: Downloadable memo and research package are built from legacy relational rows and can contradict the approved report; the export stage's 200-line artifact mapping is unused

Severity **low**, effort **M**, verdict **corrected**

**Problem.** For v3 runs, the export stage maps about 30 artifact types into a ResearchReportData object. generateMarkdownReport then ignores that object and returns report_document.markdown verbatim, so the mapping is dead code. POST /api/research-runs/:id/export builds the memo and the 1,793-line research package from legacy tables (theses, risks, valuation_signals, scenarios), not from typed artifacts or the approved report. For META, the scenarios rows hold the undiscounted FY2028 anchors (216.17/528.69/768.04), so the package's valuation file reports a scenario range of 216-768 USD. The approved report's headline is present value 119/395/604 (weighted 378). AGENTS.md says typed research_artifacts are the report source of truth.

**Evidence.** src/lib/research/handlers/export.ts:50-247 (reportData mapping) vs src/lib/export/report-generator.ts:157 ('if (data.report_document) return data.report_document.markdown'); src/app/api/research-runs/[id]/export/route.ts:30-40; src/lib/export/memo-generator.ts:24-73 (legacy table queries); src/lib/export/research-package-generator.ts:230-263 (theses, valuation_signals, scenarios), :592,:609,:632-636 (scenario value range from scenarios.value_anchor); asset-valuation.ts:664 (INSERT INTO scenarios). SQL: scenarios for the run = bear 216.165, base 528.687, bull 768.042, matching the undiscounted annual_price_target_path FY2028 values, not PV.

**Recommendation.** For runs with a report_document, build the memo from the exec section plus the report_facts value table. In the research package, include report.md and render the thesis and valuation files from investment_thesis, valuation_scenario_set and report_facts, labelling PV versus FY-terminal targets. Restrict the export.ts reportData mapping to runs without report_standard, or delete it if none remain. Verify by calling POST /export on the META run and diffing every per-share figure against report_document (PV 119.05/395.17/603.67, weighted 378.27; FY2028 targets labelled as such).

**Verifier check.** Confirmed. report-generator.ts:157 returns report_document.markdown, so the export.ts reportData mapping (lines 50-247) is unused whenever research_plan.report_standard is set. POST /export (route.ts:30-40) builds the memo from legacy tables (memo-generator.ts: theses, risks, valuation_signals, source_gaps) and the package from theses, scenarios and valuation_signals with no reference to research_artifacts or report_document. The scenarios rows for META are 216.165/528.687/768.042 (undiscounted FY2028), against PV 119.05/395.17/603.67 in the report. Severity corrections. No UI code calls POST /export (no fetch in src/app or src/components outside the route), so the contradictory package is reachable only through the API. The export stage itself writes report_document.markdown correctly. '1,793 lines' is the size of research-package-generator.ts, not of the package. Downgraded to low.

## RQ-EVAL: Measuring research quality and reliability

Research quality is not measured anywhere in a repeatable way. There is no fixed eval set and no depth rubric, the docs/meli-v3-acceptance-rubric.md checklist is manual and only checks that artifacts exist, the tests are unit or mock-provider, and 14 PRs (#61-#74) merged after the last paid run with no before/after comparison. The one live quality signal, the AI reviewer, gives a verdict that does not gate: every META run since 2026-10-08 got conditional_pass (quality_score 0.42-0.50) while carrying 0-3 critical and 10-18 high findings, and none of 60 real runs failed for an analytical-quality reason. Code-level checks on the stored artifacts find several reliability defects the gates miss: a bug that leaves historical_record TTM series and statistics empty in every recent run, about a quarter of the larger numbers in report prose that can't be traced to the cited inputs (some are recomputed valuation outputs), terminal value at 99-129% of enterprise value with no plausibility check, and very different valuations between repeated runs of the same asset. A light harness would close most of this without new dependencies: five fixed assets with dated reference reports, offline code checks scored on every stored run, an opt-in per-dimension LLM judge based on the JD traits and the framework's 30 Research Standard questions, and a forward-looking calibration CSV that compares each run's call with realised prices. Historical-cutoff runs should be used only to test data hygiene, because the model's own knowledge contaminates them as a measure of skill.

<details><summary>Measurements</summary>

All queries were SELECT-only on research_os; the scratch scripts are in /private/tmp/claude-501/-Users-japardinathaniel-Documents-GitHub-Investing-Research-Pipeline/fdaaf424-0588-4f7e-be73-9b055f9db53a/scratchpad/eval/.

- **Runs:** 66 total, 6 of them never-run MSFT test residue. Failure reasons across the 60 real runs: 22 provider/transport, 14 evidence/source coverage, 4 output schema, 1 valuation anchors, 0 analytical quality. 11 waiting_for_human, 1 completed.
- **Review verdicts (final report_review):** 02c8d48b 0.42 (1 critical, 18 high); 7fa1f00a 0.50 (3 critical, 10 high); 1d427f3f 0.45 (0, 11); 4fae0fb1 0.45 (1, 11), all conditional_pass. dca55615 got needs_more_work at 0.32. For 4fae0fb1, round 0 scored 0.55 with 30 findings and round 1 scored 0.45 with 28; round 1 was kept.
- **Reviewer cost:** 2 calls of about 476-481K input tokens (1.12 MB packet), 7-7.6K output tokens, $0.063 each, no reasoning tokens.
- **historical_record:** 2,311 observations, 0 statistics keys and 0 TTM rows in 4fae0fb1, and in 6 other recent META/MELI runs. Older SOFI runs had 170 TTM rows. Record counts: 77 quarterly revenue, 77 operating income, 23 capex observations. The diagnosis rates operating margin from 1 observation.
- **Number traceability** (trace_numbers2.py on report_document 2b0e670a, 1.6 s): 437 figures with 3 or more significant digits; 334 (76%) traced to the paragraph's cited inputs at displayed precision, against a 5% chance-match baseline. 30 unmatched figures sit in 'fact' paragraphs, and 18 of those appear in no input at all. There are 11 process-leak phrases.
- **Valuation consistency (4fae0fb1):**
  - TV share of EV: 128.7% bear, 102.8% base, 99.3% bull.
  - Terminal capex/D&A: 4.45, 3.56, 3.34. Terminal FCFF/NOPAT: -43%, 25%, 41%.
  - Base TV is 56.8x terminal FCFF.
  - Reverse valuation implies a 64% margin or 43% growth.
  - no_rerating_return is null, and permanent loss equals the bear return (-70.9%).
- **Stability:** META FY2028 base anchors were 563.5, 631.0 and 528.7 and bull anchors 672, 1,062 and 768 over 5 days, with terminal multiples 18/18/18, 10/20/22 and 10/14/16. SOFI base anchors across 6 runs ranged from 1.87 to 28.0.
- **Report size:** 4fae0fb1 has 16,523 prose words in 12 sections, 116 gap bullets (2,709 words) and 51 hedge phrases. The references are 5,844 words (Deckers) and 4,994 words (SoFi), with 25 and 22 tables.
- **JD traits** clearly present in the META prose: 2 of 12 (segment split, what-would-change). Regex hits were checked by hand.
- **Human review:** 1 decision ever, by test-harness.
- **Price bars:** META covers 2020-10-12 to 2026-10-12 (1,507 bars).

</details>

### RQ-EVAL-1: No repeatable evaluation set or score history, so depth changes can't be measured across commits

Severity **high**, effort **M**, verdict **corrected**, JD trait: Whole-report depth; the JD example as a fixed reference point

**Problem.** Nothing scores a run's research quality against a fixed baseline. The MELI rubric is a manual checklist of artifact presence, the tests are structural or use the mock provider (its reviewer always returns pass/0.95), and no script compares runs. So nobody can tell whether a prompt, model or contract change made reports deeper or shallower. Run-to-run differences also mix code changes with model noise. The repo already has what an eval set needs: dated reference reports and a fixed-cutoff run script.

**Evidence.** package.json scripts: no eval or score command. docs/meli-v3-acceptance-rubric.md: checkbox items such as '`moat_assessment` exists'; referenced only from docs/research-os-v3-spec.md (grep). src/lib/agent-harness/providers/mock.ts:65: the mock reviewer returns quality_score 0.95, verdict pass, used by tests/sofi-research-e2e.test.ts. Last model call 2026-10-13 14:36 (SELECT max(created_at) FROM model_call_logs); PRs #61-#74 merged 2026-10-15/16 (git log --merges), so no run measures them. Reference reports with fixed dates: Deckers and SoFi .docx dated 2026-07-17 (reference prices $109/$17; 5,844/4,994 words; 25/22 tables, parsed from word/document.xml); MercadoLibre_Framework_v3_Full_Initiation_Report.md:6 valuation date 2026-08-06, price $1,835; the JD example. scripts/new-equity-run.ts:88 already supports RESEARCH_ACCEPTANCE_CUTOFF_AT. Length is not the gap: META 4fae0fb1 has 16,523 prose words (3x the references) and 116 'Evidence gaps' bullets (2,709 words), but its historical-performance chapter has 753 words over 2,311 stored observations.

**Recommendation.** Add evals/eval-set.json with fixed cases: SOFI and DECK @2026-07-17 (docx references), MELI @2026-08-06 (md reference, plus the existing rubric items turned into code checks where possible), and META @2026-10-13 (four prior runs). Seed the DECK asset first. Keep JD as an explicit coverage stress case that is expected to fail until 20-F/6-K statements are supported, and don't use it as a depth score. Add scripts/eval-research.ts (npm run eval:score -- <runId|--latest>): SELECT-only and no model calls. It applies the code checks (RQ-EVAL-3/5/6 and the table lint from the missed items) and writes evals/results/<asset>/<runId>.json plus a row in evals/scores.csv. First record the code version on each run (see missed item), so rows can be attributed to commits. Before and after a prompt, model or contract PR, and only with the user's approval (AGENTS.md paid-run rule), run the set through new-equity-run.ts. That is about $1 and 1 hour per asset on Haiku. Quote the CSV deltas in the PR. It is done when scores.csv has one row per asset per measured commit.

**Verifier check.** Core claim holds. package.json has no eval or score script, and scripts/ holds only mock acceptance and smoke scripts. mock.ts:65 returns pass/0.95 for research-reviewer. The last model call was 2026-10-13 15:40; PRs #61-#74 merged 2026-10-15/16. new-equity-run.ts:88 reads RESEARCH_ACCEPTANCE_CUTOFF_AT. The Deckers/SoFi .docx and the MercadoLibre .md references exist. Four corrections. (1) The MELI rubric does not only check that artifacts exist. It also has substantive items, e.g. line 62 'Historical percentile and TTM calculations are present', line 109 'does not infer moat solely from growth' and line 166 strong-business/weak-stock. But it is manual, MELI-specific and never applied, since line 62 would have caught RQ-EVAL-3. (2) The DB has no Deckers or JD asset (assets: apple, bitcoin, exor-nv, mercado-libre, meta-platforms, microsoft-corp, nuscale-power, sofi), and new-equity-run.ts throws 'Asset not found'. (3) JD is a 20-F/6-K filer. filing-store.ts:15 loads only 10-Q/10-K forms for statements, so a JD run would likely stop at historical_record. It is a coverage stress case, not a depth benchmark. (4) The proposed scores.csv 'commit' column has no source: research_runs.metadata_json for 4fae0fb1 has no commit key. That run started 14:36 on 10-13, before #57/#58 (analysis-depth prompts, charts) merged at 16:29, so which code produced it can only be guessed.

### RQ-EVAL-2: No depth rubric: the reviewer is one rubric-less call over 476K tokens and never asks for the JD-style analytical moves

Severity **high**, effort **M**, verdict **corrected**, JD trait: All key traits: reframing insight, segment economics, history statistics, cash conversion, ownership, valuation matrix, reverse DCF in FCF growth, FCF-yield cross-check, no-rerating return, tail scenarios, what would change my mind

**Problem.** The only judge is one research-reviewer call per round. It gets the whole report plus every artifact, about 1.1 MB, on claude-haiku-5-5 with no reasoning. Its prompt asks for consistency, citation and disclosure checks, and quality_score has no defined scale or anchors. It reliably catches inconsistencies, but its research_gap findings are about missing exhibits, never missing analysis. Measured against the JD traits, the META report lacks most of the moves that make the example good, and nothing scores that.

**Evidence.** model_call_logs for 4fae0fb1, agent research-reviewer: 2 calls, 476,438 and 481,362 input tokens, request_metadata input_bytes 1,124,328, reasoning_tokens 0, $0.063 each. Prompt: src/lib/research/reporting/runtime.ts:115-119 (no rubric); contract stage-contracts.ts:84-88 (quality_score: z.number 0..1, no definition). Final review findings (round 1): 9 writing, 10 evidence, 4 calculation, 5 research_gap. The research_gap items are the statements deliverable, the org chart, peer filings and the no-moat value; none asks for history statistics, cash conversion, an FCF-growth reverse DCF or a tail case. JD-trait check on 4fae0fb1 paragraphs (regex, then hand-checked): present are the segment split (FoA op income 23,394 vs RL loss 4,619) and 'what would change'. Absent: history statistics (0 hits for median/percentile/range), FCF/NI conversion (0), working-capital days (0), a computed net cash figure (all 5 'net cash' hits are 'net cash from operating activities'), share-count change (0), reverse DCF in FCF-growth terms (0), FCF yield (0), and a tail below bear. No-rerating appears only as 'not computed in the stored matrix (the field is null)'.

**Recommendation.** Write evals/rubric.md with the 10 dimensions as proposed, each scored 0-4 and mapped to framework §11 questions. Anchor 3 on the JD example ('preliminary but complete' in the user's words) and reserve 4 for depth beyond it, so the user's standard is not capped at JD. Code pre-checks run first and are free: statistics non-empty, no_rerating_return non-null, FCF-growth reverse valuation present, etc. The LLM judge is opt-in (RUN_PAID_EVAL=1) and runs in eval-research.ts only, not in the pipeline. It makes one call per dimension, given only the sections and artifacts that dimension covers (30-60K tokens), on a higher tier than the writer. It must quote the passage behind each score. Calibrate it on the JD example and the Deckers docx before scoring app runs.

**Verifier check.** Confirmed: 2 research-reviewer calls of 476,438 and 481,362 input tokens (input_bytes 1,124,328), $0.063 each, on claude-haiku-5-5. quality_score is z.number 0..1 with no anchors (stage-contracts.ts:86). runtime.ts:115-119 has no scoring rubric. Round-1 findings: 5 research_gap, 4 calculation, 10 evidence, 9 writing. The framework does have §11 with 30 questions (docs/research-framework-v2.1.md:2262-2295). Overstatements: (a) the reviewer is not purely consistency-focused. RESEARCH_DOCTRINE (reporting/contracts.ts:106-118) asks it to examine permanent impairment and returns without rerating and to trace forecasts. (b) One research_gap finding asks for missing analysis, not an exhibit: 'No P/E, EV/EBITDA or FCF yield cross-check is presented'. A high finding also says the trailing four-quarter operating-margin trigger 'cannot be computed', which is a direct symptom of RQ-EVAL-3. (c) Cash conversion is partly present: report line ~190 says capex absorbed about 0.77 of operating cash flow, against 0.59 a year earlier. FCF/NI, working-capital days, a computed net cash figure and an FCF-growth reverse DCF are indeed absent. The gap stands: nothing scores depth against the JD moves.

### RQ-EVAL-3: historical_record TTM series and statistics are empty in every recent run (family names passed as metric keys); no invariant caught it

Severity **high**, effort **S**, verdict **corrected**, JD trait: Computed history statistics with current-vs-history positioning; TTM FCF; cash-conversion diagnosis

**Problem.** The research plan lists required history as metric families (income_statement, cash_flow, ...). historical-record.ts passes those names to buildTTMSeries, which looks up observations by exact metric_key, so it finds none. ttm_series comes out [] and computeHistoricalStatistics (TTM only) returns {}. Downstream, historical_diagnosis rates GAAP operating margin as 'insufficient_history' from 1 observation, although the record holds 77 quarterly revenue and 77 operating-income observations. That removes the computed-statistics layer the JD example depends on (median growth, margin range, TTM FCF, current vs median). No test or gate checks it, so the regression has been silent since older SoFi runs, which had 170 TTM rows.

**Evidence.** SQL on historical_record artifacts: META 4fae0fb1 has 2,311 observations, 0 statistics keys, 0 ttm_series rows. 7fa1f00a, 1d427f3f, d6236111, 50d91067, 02c8d48b and MELI dca55615 are the same (0/0). SOFI 59d6397b and 77eef6e2 had 10 stats and 170 TTM rows. 4fae0fb1 research_plan.required_historical_metrics = [income_statement, balance_sheet, cash_flow, share_count, capital_allocation]. Code path: handlers/historical-record.ts:110-112 builds requiredMetricKeys from metric_family. history/normalizer.ts:59-66 calls buildTTMSeries(canonical, requiredMetricKeys, ...). diagnostics.ts:25-38 calls findObservation, an exact metric_key match (normalizer.ts:220-228). diagnostics.ts:69-88 computes statistics from TTM only. belongsToFamily already exists (normalizer.ts:85-110) but isn't used there. historical_diagnosis for 4fae0fb1: 17 metrics; operating_margin_gaap observation_count 1, trend insufficient_history; no capex, FCF, SBC or opex ratios.

**Recommendation.** In historical-record.ts:218, build the TTM key list from observed consolidated flow keys: unit equal to a currency code, metric_category not balance_sheet, not in STOCK_METRICS, and excluding per-share, ratio and *_yoy_* keys. Union these with any planned key that is itself a metric key. Keep the families for the coverage matrix only. Add a regression test that passes family names (['income_statement','cash_flow']) with 8 quarters of revenue and expects TTM revenue rows and statistics.revenue. Add an invariant in validateStageArtifacts('historical_record'): with 12 or more consolidated quarterly revenue observations, ttm_series must contain revenue. To verify, rebuild 4fae0fb1's record offline from its stored observations and expect 17 TTM revenue and operating-income rows and non-empty statistics. reconcileTTMToAnnual, skipped today, should then run.

**Verifier check.** The bug is confirmed. historical-record.ts:110-112 builds requiredMetricKeys from the plan's metric_family values. Line 218 passes them to buildHistoricalRecord. normalizer.ts:59-66 then calls buildTTMSeries with them, and findObservation does an exact metric_key match (normalizer.ts:220-228), so ttm_series is [] and computeHistoricalStatistics returns {} (diagnostics.ts:69-88). DB: 4fae0fb1, 7fa1f00a, 1d427f3f, d6236111, 50d91067, 02c8d48b, dca55615, 9af5c76c and d6f3fbee all have 0 stats and 0 TTM rows. Root cause of the regression: 77eef6e2 and 59d6397b had no required_historical_metrics, so line 218 fell back to all observed keys and produced 170 TTM rows. dd02bb41 got 3 stats only because 3 family names (net_interest_income, credit_losses, non_interest_income) equal metric keys. tests/historical-record.test.ts uses only requiredMetricKeys ['revenue']. Corrections: (1) The record holds 20 consolidated quarterly revenue and 20 us_gaap_OperatingIncomeLoss rows (60 each with segment/geography rows) and 18 capex rows, not 77. (2) historical_diagnosis is NOT downstream of this bug. historical-diagnosis.ts:26-41 reads metric_observations, not the historical_record artifact (see missed item), so fixing TTM will not change the 1-observation operating margin. (3) A plain belongsToFamily expansion would sum non-flow keys. For example, the share_count pattern matches us_gaap_CommonStockParOrStatedValuePerShare (21 quarterly rows), and income_statement matches family_of_apps_other_revenue_yoy_change.

### RQ-EVAL-4: Review verdict and quality_score don't gate: conditional_pass with critical findings reaches approval, and a worse repair round is kept

Severity **medium**, effort **S**, verdict **corrected**, JD trait: Confidence/completeness gates per area

**Problem.** Downstream code reads only the verdict string, and the reviewer is told that a 'transparently qualified report may receive conditional_pass'. The verdict therefore measures how openly gaps are disclosed, not how deep or correct the analysis is. Critical and high calculation findings never block. Nothing reads quality_score. compose.ts always returns the second round, even when it scored lower. The MELI rubric's blocking rule 'AI review has no unresolved critical findings' is not implemented. Of all real runs, none stopped for an analytical-quality reason.

**Evidence.** Final report_review per run (SQL over research_artifacts): 02c8d48b conditional_pass 0.42, 1 critical/18 high (9 high calculation); 7fa1f00a conditional_pass 0.50, 3 critical/10 high; 1d427f3f conditional_pass 0.45, 0/11; 4fae0fb1 conditional_pass 0.45, 1 critical/11 high; only MELI dca55615 got needs_more_work (0.32). 4fae0fb1 round 0 scored 0.55 with 30 findings and round 1 scored 0.45 with 28; round 1 was returned (compose.ts:47-48). The open 4fae0fb1 critical finding is the Financials deliverable, plus high calculation findings on two return bases and on terminal share stated as 99-129%. Gates: quality-gates.ts:709-710 (conditional_pass is only a warning); app/api/research-runs/[id]/review/route.ts:70 accepts pass or conditional_pass. quality_score is only persisted (ai-reviewer.ts:15-30) and has drifted in scale (92, 95, 0.86, {score:7, scale:'0-10'} in older runs). runtime.ts:118 contains the 'transparently qualified ... conditional_pass' rule. Failure reasons over 60 non-test runs: 22 provider/transport, 14 evidence/source coverage, 4 output schema, 1 valuation anchors, none for analytical quality.

**Recommendation.** Add an effective-verdict function next to compose.ts. Any unresolved critical finding, or any high calculation finding that a code check confirms (RQ-EVAL-5/6), sets effective_verdict needs_more_work. Store it beside the model verdict. In review/route.ts, block approved_for_position (not approved_for_tracking) while effective_verdict is needs_more_work, as :71 already does for withheld conclusions, and show the critical and high counts on the review page. Stop showing quality_score, or replace it with the rubric mean once RQ-EVAL-2 runs. Leave round selection as it is. Verify with a unit test fed the stored 4fae0fb1 round-1 review: position approval returns 422 and tracking approval succeeds.

**Verifier check.** Mostly confirmed. compose.ts:47-48 treats conditional_pass as passed and always returns round 1. quality-gates.ts:709-710 turns conditional_pass into a warning only. review/route.ts:70 accepts pass or conditional_pass for both approvals, and :71 blocks position approval only for a withheld conclusion. runtime.ts:118 has the 'transparently qualified report may receive conditional_pass' rule. quality_score is read nowhere and has drifted in scale (95, 92, 88, 0.86, an object). Per-run critical/high counts reproduce: 02c8d48b 1/18 (9 high calculation), 7fa1f00a 3/10, 1d427f3f 0/11, 4fae0fb1 1/11. Refuted part: 'a worse repair round is kept'. 4fae0fb1 round 0 had 30 findings (1 critical, 13 high, 4 high calculation) and round 1 had 28 (1 critical, 11 high, 2 high calculation). By the reviewer's own proposed rule (fewer critical plus high findings), round 1 would still be kept. Only the uncalibrated quality_score fell, and that is noise between two calls. Minor: one run did stop for review quality, 200d3d5a (pipeline v2, 2026-07-16, 'AI review outcome is fail'), so 'none' holds only for v3/v4 runs. Severity is lowered because the human gate still sees the findings, and the LLM severity labels are noisy (9 high calculation findings in one run), so they are a weak gate on their own.

### RQ-EVAL-5: Numbers in report prose are not traced to artifacts; about 24% of the larger figures aren't in the cited inputs, including recomputed valuation outputs

Severity **medium**, effort **S**, verdict **corrected**, JD trait: Numerical discipline behind every computed statistic

**Problem.** createReport only checks that cited IDs exist and are dated before the cutoff, and the substance floor only requires 'a figure or a citation'. Nothing checks that a figure appears in the sources a paragraph cites. The product requirement says the writer 'does not invent or recompute model outputs in prose', yet the valuation chapter computes EV, explicit PV sums and terminal share itself, and the reviewer then flags those figures as inconsistent. Untraceable figures also travel between stages: three per-share values from a team request ended up in decision_record and in three report sections as disclaimers ('Earlier per-share figures ... cannot be traced'), along with process leaks such as 'The model's note says'.

**Evidence.** Scratch check (scratchpad/eval/trace_numbers2.py, read-only on the exported 4fae0fb1 report_document 2b0e670a, 1.6 s). Of 437 figures with 3 or more significant digits in paragraphs, 334 (76%) match the paragraph's cited evidence or artifacts at displayed precision (unit scales 1, 1e3, 1e-3, 1e6, 1e9). Perturbing every figure by x1.037 gives a 5% chance-match baseline. Of the 103 unmatched, 30 sit in 'fact' paragraphs and 18 appear nowhere in the report inputs, for example EV 1,036,059, explicit PV -94,163, TV share 102.8% and 128.7%, H2 capex 88,400. The valuation-and-downside chapter matches 66 of 96 figures, backtest 1 of 10. '190.56, 513.71 and 745.09 USD' appear only in team_requests v1-9 and decision_record, and in report lines 56, 2904 and 3113 as disclaimers. 11 process-leak phrases ('the model's note', 'earlier draft', 'stored valuation outputs', 'reconciliation record shows') are not in substance.ts:4-13. Code: report.ts:78-94 (ID and date checks only), substance.ts:29 (figure-or-citation), docs/research-product-requirements.md, Valuation section ('does not invent or recompute model outputs in prose').

**Recommendation.** Extend calculateValuationSchedule (valuation/schedules.ts) to return explicit_pv_total, enterprise_value (fcff only) and terminal_share_of_ev. They then land in method_schedules, and the writer cites them instead of computing them. Add checkFigureTrace to reporting/substance.ts: figures with 3 or more significant digits, years skipped, matched at displayed precision against the paragraph's cited inputs, with scales 1, 1e±2, 1e±3, 1e6 and 1e9. Report an unmatched figure in a 'fact' paragraph as a writing finding. Add the leak patterns ('earlier draft', "model's note", 'stored (matrix|valuation outputs|record)', 'reconciliation record', 'the field is null') to INTERNAL_TERMS. Record trace rate and unmatched-fact count in scores.csv. Baseline 4fae0fb1: 81% overall, 24 unmatched fact figures. Target: 0 'nowhere' fact figures.

**Verifier check.** Mechanism confirmed. report.ts:78-94 checks only that IDs exist, the passage/URL and the date. substance.ts:29 requires only a digit or a citation. docs/research-product-requirements.md:54 says the writer 'does not invent or recompute model outputs in prose'. 513.71 appears in team_requests (9), decision_record (1) and report_section (4). Leak phrases are present ('an earlier draft', 'The model's note says', 'the stored matrix (the field is null)', 'reconciliation record shows'), and none match INTERNAL_TERMS. The headline numbers are overstated, because the scratch script has no percent-to-fraction scale. Rerun with scales 1e-2 and 1e2 added (which the recommendation itself prescribes): 353 of 437 traced (81%), 6% chance baseline, 24 unmatched fact figures, 13 of them mis-cited and 11 found nowhere. Most of the 'nowhere' figures are sums of stored numbers: EV 1,036,059 = TV PV 1,064,585 + explicit PV -28,526, plus explicit PV totals and TV share. Location fix: method_inputs hold only inputs, but asset-valuation.ts:679 already stores method_schedules from calculateValuationSchedule (schedules.ts:24-36) with terminal_present_value, equity_value and per-year present_value. Only explicit_pv_total, enterprise_value and terminal_share_of_ev are missing, so the fields belong there, not in engine.ts or on method_inputs.

### RQ-EVAL-6: No cross-artifact plausibility checks: terminal value is 99-129% of EV, and terminal economics contradict the history

Severity **high**, effort **M**, verdict **corrected**, JD trait: Reverse DCF in FCF-growth terms; FCF-yield cross-check; no-rerating return; impairment/tail scenarios below the bear case

**Problem.** No validator compares valuation inputs with the scenarios or the historical record, although framework Q30 asks 'Does the historical record support the terminal economics used in valuation?'. With the default 3-year horizon placed over META's capex peak, all three cases get their whole value from a NOPAT multiple applied to a year whose reinvestment is 3-4.5x D&A. The bear case values negative terminal FCFF at 10x NOPAT. The reverse valuation is solved in uniform-margin or uniform-growth space (implied 64% margin, 43% growth) instead of FCF growth from a normalised base. The expected-return matrix has no no-rerating return and no tail below bear. Each of these can be checked in code from stored artifacts, and none is.

**Evidence.** Computed from 4fae0fb1 valuation_scenario_set.method_inputs (scratch script). TV share of EV: bear 128.7%, base 102.8%, bull 99.3%. Terminal-year capex/D&A: 4.45, 3.56, 3.34. Terminal FCFF/NOPAT: -43%, 25%, 41%. Base TV = 56.8x terminal FCFF. Base capex/revenue drivers: 54%, 40%, 32% (2026-28), against history_ratios.capex_to_revenue 25.8% (FY2025 only). Horizon: engine.ts:355-357 (RESEARCH_FORECAST_YEARS default 3); operating_scenario_set.forecast_horizon = 2026-2028. reverse_valuation: implied_margin 0.640, implied_growth 0.432. expected_return_matrix: no_rerating_return null; permanent_loss_limit -0.709 equals bear_return -0.709. Validators: valuation/validation.ts:109-117 (reverse valuation: schema only), forecast/validation.ts (probabilities, blanket bear, segment sum, TAM only), no grep hits for terminal share or a history-range check. Cross-run instability in multiples (RQ-EVAL-7) follows from TV near 100% of EV.

**Recommendation.** Add valuation/consistency.ts, a pure function over stored valuation, scenario, history and expected-return artifacts. Flags: (1) terminal_share_of_ev above 0.8, a warning suggesting a longer horizon or a fade. (2) For a NOPAT multiple, terminal capex/D&A above 1.5 or terminal FCFF/NOPAT below 0.5, a high finding, since the multiple assumes steady-state economics the cash flows don't show. (3) Forecast margin, growth or capex/revenue outside the 20-quarter [min, max] from RQ-EVAL-3 statistics without a cited rationale. (4) no_rerating_return null, or permanent_loss_limit equal to bear_return. (5) No FCF-growth reverse valuation. Run it as warnings in asset_valuation and decision_synthesis, feed confirmed high flags into the RQ-EVAL-4 effective verdict, and score it in eval-research.ts. Verify that 4fae0fb1 raises at least 4 flags and that a 5-year fade fixture raises none.

**Verifier check.** Recomputed from 4fae0fb1 method_schedules. TV share of EV: bear 1.287, base 1.028, bull 0.993. Terminal capex/D&A: 4.45, 3.56, 3.34. Terminal FCFF/NOPAT: -0.43, 0.25, 0.41. Base TV/terminal FCFF: 56.8x. Value per share 119.05/395.17/603.67, about 378 weighted. reverse_valuation implied_margin 0.640 and implied_growth 0.432 in uniform-margin/growth space. expected_return_matrix: no_rerating_return null and permanent_loss_limit = bear_return = -0.709049. engine.ts:356 defaults the horizon to 3 years. validateReverseValuation (valuation/validation.ts:109-117) is schema-only, forecast/validation.ts has no history-range check, and grep finds no terminal-share check. Framework Q30 is at docs/research-framework-v2.1.md:2295. One fact is wrong: history_ratios.capex_to_revenue 0.258 is the mean of the last 3 fiscal years (engine.ts:55,68), not FY2025 only. One recommendation needs adjusting: TV share above 100% is arithmetically legitimate when explicit FCFF is negative during a capex peak, so it should not on its own block approval. The real defect is a NOPAT multiple applied to a terminal year whose reinvestment is 3-4.5x D&A.

### RQ-EVAL-7: Run-to-run stability is unmeasured; repeated runs of one asset give widely different values

Severity **low**, effort **S**, verdict **corrected**, JD trait: Valuation as an operating-case x valuation-assumption matrix (makes assumption-driven spread explicit rather than accidental)

**Problem.** Valuation-critical choices such as terminal multiples and discount rates are made by the model per run. With terminal value near 100% of EV, those choices largely set the answer. Repeated runs of the same asset days apart give very different anchors, and nothing records or compares them. Without a stability metric, model noise can't be told apart from real pipeline improvements, and a reader can't tell whether a value is robust.

**Evidence.** valuation_scenario_set for three complete META runs (SQL). 02c8d48b (10-08): FY2028 anchors 413.3/563.5/672.2, weighted 553.1, multiples 18/18/18, rates 9/9/9%. 7fa1f00a (10-11): 146.3/631.0/1061.8, weighted 617.6, multiples 10/20/22, rates 11/9.5/9%. 4fae0fb1 (10-13): 216.2/528.7/768.0, weighted 510.4, multiples 10/14/16, rates 11/9/8.5%. The price was $718-743 throughout. Base anchors for six non-mock SOFI runs, 2026-08-06 to 08-20: 1.87, 19.36, 27.03, 27.54, 11.85, 28.0. Commits differ between runs, so code and model effects are confounded, which is the point.

**Recommendation.** Fold this into eval-research.ts. For runs of the same eval asset, cutoff and commit, report per-case CV (bear, base, bull), the spread of probability-weighted return and permanent loss, and a diff of the terminal multiples and discount rates chosen. When a PR touches valuation or scenario prompts, run the affected asset twice (with user approval, about $2). Set targets on the tails, e.g. bear/bull CV under 25%, not on the base value.

**Verifier check.** META anchors reproduce: 02c8d48b 413.3/563.5/672.2 (multiple 18/18/18, rate 9%), 7fa1f00a 146.3/631.0/1061.8 (10/20/22), 4fae0fb1 216.2/528.7/768.0 (10/14/16). But the base anchor CV over the three runs is about 9%, the weighted target (553/618/510) about 10%, and base PV per share (376/478/395) about 13%. The proposed 'base CV under 15%' target is therefore already met and would detect nothing. The instability is in the tails: bear CV about 54%, bull about 24%, plus the model-chosen multiples and rates. The tails drive permanent_loss_limit and the expected return. The SOFI evidence is invalid. Those runs use different terminal years (2028-2031) and different providers (deepseek/qwen/glm/kimi mixes), and the 1.87 base comes from run 5995227e, which failed. Three META runs with different cutoffs and prices are thin evidence. This is a methodology add-on to RQ-EVAL-1 rather than a standalone finding.

### RQ-EVAL-8: No calibration loop; the point-in-time machinery has never run end to end, and historical cutoffs are contaminated

Severity **medium**, effort **M**, verdict **corrected**, JD trait: Thesis breakers with numeric thresholds; monitoring dashboard; what would change my mind (scored against outcomes)

**Problem.** Nothing compares a past call with what happened afterwards. refresh_schedule only sets a date. The six historical-cutoff runs in the DB never executed, so the point-in-time path (cutoff-filtered SEC facts, cutoff prices) has no real end-to-end run. Historical cutoffs also can't measure predictive skill for any date the model's training data covers, and undated web pages pass the cutoff filter into the claims the analysis stages use. The data needed for a forward-looking loop already exists.

**Evidence.** research_runs: 6 microsoft-corp runs with source_cutoff_at 2022-01-01 or 2023-12-30, created 2026-08-06, all 144 stages pending, 0 model_call_logs, 0 source_documents, 0 artifacts. refresh-schedule.ts:17-31 is date arithmetic only. grep for realized/calibrat/brier in research code: no calibration code. market_price_bars: META 2020-10-12 to 2026-10-12 (1,507 bars), SOFI to 2026-08-19. Valuations with a cutoff price exist for SOFI c2822589 (completed 2026-08-06) and four META runs. Cutoff handling: sec-companyfacts.ts:21-22 and :137-138 filter by filed <= cutoff (correct). role-discovery.ts:453 'if (publishedAt && cutoffAt && ...)' admits undated pages. runtime.ts:20-23: analysis stages see every accepted claim; only the report requires dated evidence (store.ts:34).

**Recommendation.** First, for any run whose cutoff is more than 7 days before creation, treat undated non-SEC pages as post-cutoff: drop them at role-discovery.ts:453, or keep them out of analysis packets. Add a hygiene check to eval-research.ts: 0 observations, documents or claims dated after the cutoff, and 0 undated non-SEC claims. Run a past-cutoff eval case only after that check passes. Later, add scripts/eval-calibrate.ts (no model calls). It reads stored valuation and decision artifacts, syncs prices with syncAssetPriceHistory at +90, +180 and +365 days, and appends realised return, whether the price stayed inside [bear, bull] and which thresholds fired to evals/calibration.csv. Report hit rates only once there are 10 or more calls. Don't use historical-cutoff runs as skill scores.

**Verifier check.** Confirmed: the six microsoft-corp runs (cutoffs 2022-01-01 and 2023-12-30) are pending with 0 calls, 0 artifacts and 0 started stages. Every other run has a cutoff within 7 days of creation. refresh-schedule.ts only adds 90/180 days. There is no calibration code. sec-companyfacts and filing-store filter by cutoff. role-discovery.ts:453 admits pages with no publishedAt. store.ts:34 restricts only report citations. Stronger evidence the reviewer didn't quote: in 4fae0fb1, 4 of 33 run sources are undated, and 43 of 150 accepted claim links point to undated documents (29%). The analysis stages see all of them. This matters now because RQ-EVAL-1's eval cases use past cutoffs (2026-07-17, 2026-08-06). The calibration part is lower priority. The stored artifacts already hold cutoff price, per-case values and thesis-breaker thresholds, so nothing is lost by writing the script later, and with 1 completed and 11 waiting runs, hit rates would mean little for a long time. The prior audit's G1 (live price in cutoff runs) is fixed (#51) and not re-reported here.

### RQ-EVAL-9: The human gate records no structured quality judgement, so the user's 'too shallow' verdict is lost

Severity **low**, effort **S**, verdict **confirmed**, JD trait: Final scorecard (business quality, moat, balance sheet, capital allocation, governance, valuation, risk/reward)

**Problem.** The human review is the best quality signal available, but it stores only a status and free text, and in practice it has never been used on a real run. Without per-dimension human ratings, the LLM judge (RQ-EVAL-2) can't be checked against the user's own standard, and a complaint such as 'too shallow' never becomes a tracked number.

**Evidence.** review_decisions: 1 row ever (c2822589, approved_for_tracking, reviewed_by 'test-harness', 2026-08-06). research_runs with metadata_json ? 'report_revision_request': 0. review_decisions columns: status, conviction, priority, watchlist_reason, position_sizing_note, what_would_change_mind, open_questions, reviewed_by; no per-dimension field. META runs 4fae0fb1, 7fa1f00a, 1d427f3f and 02c8d48b are all still waiting_for_human.

**Recommendation.** Add optional 0-4 ratings for the RQ-EVAL-2 dimensions to the human-review form. Store them in research_runs.metadata_json.review_rubric (no migration), with the report content_hash. eval-research.ts writes them beside the judge scores and reports agreement (the share of dimensions within 1 point). It works when the user can rate the four waiting META reports in under five minutes each.

**Verifier check.** review_decisions has 1 row (c2822589, approved_for_tracking, reviewed_by 'test-harness', 2026-08-06). Its columns are status, conviction, priority, watchlist_reason, position_sizing_note, what_would_change_mind, open_questions and reviewed_by; there is no per-dimension field. 0 runs have metadata_json.report_revision_request. 11 runs are waiting_for_human, including the four META runs. Without human ratings, an LLM judge can't be checked against the user's standard.

## AR-PERF: Performance and resource use

Most of the latest paid META run's time and money went to things the pipeline does not need to spend them on. Of its 3,825 s wall clock, 1,583 s (41%) were four export-writer calls whose 90 s and 720 s deadline timers fired 5 to 15 minutes late, all at the same instant, which means the process was suspended. 25 of 79 calls (5.74M input tokens) went over Claude Haiku 5.5's 100K-token price tier. That happened mostly because a 455 KB raw historical_record slice rides in every report-stage prompt, and the cost ledger ignores the 5x tier, so the run's recorded $1.05 is probably about $3.74. On the UI side, the asset view downloads 16 MB of JSON on every load and again every 60 s, including 6.6 MB of financial statements and 2.1 MB of markdown that the visible tab does not use. The new git research-store sync takes 3.6 GB of RAM to export document_chunks, writes 1.08 GB of JSONL whose 69 MB shards will hit GitHub's 100 MB limit in roughly 10 runs, and has already put 604 MB into the main repo's object store. Smaller wins: no per-stage effort control (Haiku 5.5's hidden adaptive thinking appears to be about half of all output tokens), a 32,768 output cap that decision_synthesis routinely exceeds, a fan-out pool of 3 set in .env.local, and stale passage and index bloat. Prior audit items P1, P7, M2 (the duplication part), M5, M8, M9 and M10 are fixed and are not re-reported.

<details><summary>Measurements</summary>

All measurements are read-only (SELECTs on the dev DB, du, git count-objects, and read-only tsx scripts in /private/tmp/claude-501/-Users-japardinathaniel-Documents-GitHub-Investing-Research-Pipeline/fdaaf424-0588-4f7e-be73-9b055f9db53a/scratchpad/perf/: measure-report.mts, measure-store.mts, measure-pool.mts).

DATABASE: 632 MB total. document_chunks 446 MB (150,599 rows; heap 227 MB, TOAST 115 MB, text_fts GIN 63 MB, search_tsv GIN 22 MB). research_tasks 87 MB (1,843 rows; per run now 6-15 MB stored). research_artifacts 30 MB. model_call_logs 8.5 MB. document_embeddings has 0 rows; embeddings are disabled, and the local server lists no 'vector' extension in pg_available_extensions, so pgvector work is premature.

ARTIFACT SIZES (4fae0fb1, text bytes): financial_statement_set 6,621,999 (tables 4.05 MB, observations 2.56 MB). report_document 5,187,747 (artifacts snapshot 2.78 MB including historical_record 2.39 MB; markdown 2.13 MB). historical_record 2,393,648. The report markdown's raw observation table is 1,784,737 of 2,031,417 bytes.

/REPORT PAYLOAD: 15,981,136 bytes of JSON (1,502,436 gzipped). Queries 154-177 ms, stringify about 50 ms, gzip about 230 ms. A fresh postgres pool costs 12.2 ms vs 0.4 ms on a shared pool.

STORAGE: storage/ 1.0 GB (sources 908 MB in 1,540 files, parses 97 MB, backtests 52 MB). research-store/ 2.3 GB (tables 1.5 GB, files 832 MB). Main .git size-pack 604 MiB. 151 duplicate SEC documents remain (64,104 chunks, about 124 MB), kept by design.

RUN WALL CLOCK, 4fae0fb1 (Haiku 5.5 on every agent; 3,825 s from start to human gate): plan gate about 51 s, source_discovery 65 s, evidence_extraction 244 s (26 batches, pool 3), analysis chain about 531 s, decision_synthesis 344 s (161 s truncated attempt), team-request round and reruns 278 s, report composition about 770 s of productive time, and suspended/stalled calls 1,583 s (41%). Comparison runs: 7fa1f00a ai_reviewer 732 s; 1d427f3f ai_reviewer 831 s and moat_analysis 342 s. 4fae0fb1 predates the P7 dataflow scheduler (PR #67), so its paired-stage timings are still batch-coupled.

CALLS (4fae0fb1): 79 calls, 2 repair passes, 5 retries, 5 failed calls (3,858 s of call time, $0.076). Recorded cost $1.045; repriced with Haiku 5.5's >100K tier, $3.736 (24 calls, 5.74M tokens, over 100K).

PROMPT CACHE HIT RATE (cache_read / input tokens): 4fae0fb1: export-writer 24.0%, asset-analyst 27.8%, metric-normalizer 60.2%, source-reader 41.4%, valuation-analyst 18.8%, research-reviewer 0.4% (writes about 477K tokens per review that are never read back). 7fa1f00a: export-writer 30.7%, the others 0-4%. Report sections share a 79,003-token cached prefix.

OUTPUT TOKENS VS STORED OUTPUT: 0.53-1.8 bytes per output token vs about 2.4 bytes/token on input, an estimated 36-60% hidden thinking per agent.

RESEARCH-STORE EXPORT (document_chunks only): SELECT 11.2 s, 1,084 MB JSONL, largest shard 69 MB, max RSS 3.61 GB.

WORKER: one run per worker process; this run executed in-process with no research_run_jobs row. research_worker_heartbeats holds 38 rows, 16 of them stale but still 'healthy'.

</details>

### AR-PERF-1: 41% of the latest paid run was a suspended process: deadline timers fired 5-15 minutes late

Severity **high**, effort **S**, verdict **confirmed**

**Problem.** In run 4fae0fb1, four export-writer report calls ran 1,103 s, 1,012 s, 1,008 s and 574 s and returned no output. The configured limits are 90 s inactivity (runner.ts:36, .env.local RESEARCH_INACTIVITY_TIMEOUT_MS=90000) and 720 s total (.env.local RESEARCH_AGENT_TIMEOUT_MS=720000). Three calls with independent deadline controllers, started at 07:02:44, 07:04:15 and 07:04:19Z, were all aborted between 07:21:07.351 and 07:21:07.364Z. That is 4.8-6.4 minutes after their total deadlines and within 13 ms of each other. The only explanation is that the Node process ran no timers from about 07:04:19 to 07:21:07 (host sleep or process suspension, for example App Nap or a suspended terminal), and again from about 07:25 to 07:33 for the executive-judgment call. The retries then finished in 21-70 s. Nothing in the app prevents sleep or detects that it happened, so the stall looks like provider latency. The run also had no research_run_jobs row: it ran in-process from the acceptance script, so no worker heartbeat recorded the gap.

**Evidence.** Query: SELECT created_at, latency_ms, error_message, response_metadata_json->>'started_at' FROM model_call_logs WHERE research_run_id='4fae0fb1-...' AND status='failed'. Result: 'Request inactivity timeout' at 1102991, 1011943, 1008187 and 574290 ms; provider completedAt 07:21:07.350Z, .360Z, .364Z. Stage table: ai_reviewer 15:01:05 to 15:40:16 = 2,351 s, against 732 s in run 7fa1f00a. Dead windows: 15:04:19 to 15:21:08 (1,009 s, no call in flight made progress) and 15:23:48 to 15:33:23 (574 s), 1,583 s of 3,825 s in total. By contrast, run 02c8d48b's six genuine inactivity timeouts took about 94 s each. Code: deadlines.ts:13-40 (setTimeout-based total and inactivity timers); runner.ts:477. SELECT * FROM research_run_jobs WHERE research_run_id='4fae0fb1...' returns 0 rows. pmset log does not reach back to 2026-10-13, so the sleep itself cannot be confirmed from the OS.

**Recommendation.** (1) On darwin, have the worker and scripts/new-equity-run.ts / resume-research-run.ts spawn `caffeinate -i -w <pid>` (add -s when on AC power). Note in docs/local-development.md that closing the lid on battery still sleeps the machine. (2) Add a 5 s setInterval watchdog in the worker and run scripts. When wall time between ticks exceeds 30 s, record the gap and the process.cpuUsage() delta: CPU time near the gap means a blocked event loop, near zero means suspension. Write suspended_ms or blocked_ms into in-flight calls' response_metadata_json and into the run notes, so these stalls are no longer read as provider latency. (3) To verify: on the next paid run, SELECT count(*) FROM model_call_logs WHERE research_run_id=... AND latency_ms > 720000 returns 0, ai_reviewer takes roughly 750-900 s, and the watchdog logs show no gaps.

**Verifier check.** Re-ran the failed-call query for 4fae0fb1. Four export-writer report_section calls failed with timeout_type 'inactivity' at latencies of 1,102,991, 1,011,943, 1,008,187 and 574,290 ms. Three started at 07:02:44.360Z, 07:04:15.417Z and 07:04:19.177Z and all completed at 07:21:07.351/.360/.364Z. No call finished anywhere between 07:04:19.027Z and 07:21:07Z. deadlines.ts:31/38 uses setTimeout for both deadlines. No policy override exists (grep for totalTimeoutMs finds only types.ts). .env.local:17 sets RESEARCH_AGENT_TIMEOUT_MS=720000, so the 07:02:44 call's total timer was due at 07:14:44 but was reported as an inactivity abort at 07:21:07. The timers therefore did not run on time. The executive-judgment call at 07:23:48 ran alone, so it carries no simultaneity evidence, but it fits the same pattern. research_run_jobs has 0 rows for the run. pmset log starts at 2026-10-14 15:22, so the sleep itself cannot be confirmed. Nothing in src/scripts/docs mentions caffeinate or suspension. The pattern is not one-off: August runs show timeout failures at 1.0-4.6M ms (5a2c75e8 max 4,601,934; 77eef6e2 2,309,968; b9d9929c 2,083,817), against configured limits of 240-600 s. One correction to the wording: 'the only explanation' overclaims. An event loop blocked by synchronous CPU work produces the same signature, although with only three idle streams in flight, suspension is far more likely.

### AR-PERF-2: Cost ledger ignores Haiku 5.5's >100K-token rate card: the recorded spend is probably about 3.6x too low

Severity **high**, effort **S**, verdict **confirmed**

**Problem.** Claude Haiku 5.5 bills $0.10/$0.50 per MTok when the prompt is 100K tokens or fewer and $0.50/$2.50 above that, with cache rates scaled to match (from Anthropic's model docs in the claude-api skill). The repo's own pricing table notes this ('Prompts up to 100k tokens; longer prompts cost 5x', telemetry.ts:18), but calculateCost (telemetry.ts:48-61) always applies the base rate. All recorded costs, budget reservations and run-budget checks (model-calls.ts:71-157 sum recorded costs) therefore under-count every long-prompt call. The budget guard on paid runs, and the '$1.05 per run' figure the user plans around, are both too optimistic.

**Evidence.** Query on run 4fae0fb1: 79 calls, all cost_source='unknown' (computed locally), 24 with input_tokens > 100,000 (5,742,134 tokens). Recorded sum(cost_usd) = $1.045. Repricing the same token, cache-read and cache-write counts at 5x for calls over 100K gives $3.736. The calls over 100K are report_section 10, team_answer 4, decision_synthesis 3, ai_review 2, team_requests 2, report_outline 1, operating_model 1 and operating_scenarios 1. Code: telemetry.ts:18-19, 48-61; runner.ts:264 and anthropic-compatible.ts:209 are the only cost computations.

**Recommendation.** Add longPromptThresholdTokens: 100_000 and longPromptMultiplier: 5 to the claude-haiku-5-5 entry in PRICING_DB. In calculateCost and oneHourCacheWriteSurcharge, multiply every rate (input, output, cache read, cache write) when the total prompt (inputTokens, which already includes cache reads and writes) exceeds the threshold. Add a unit test for a 150K-token call with cache reads. Optionally backfill: UPDATE nothing, but report the repriced totals in a one-off read-only script so past runs can be compared. To verify: compare the 2026-10-13 Anthropic Console usage, or the Usage and Cost Admin API, against about $3.74 for 4fae0fb1. This changes no request, so no paid test is needed.

**Verifier check.** telemetry.ts:18-19 notes the 5x long-prompt rate but calculateCost (48-64) and oneHourCacheWriteSurcharge (39-45) always apply base rates. runner.ts:264 and anthropic-compatible.ts:209-210 are the only cost computations. The claude-api skill's models.md and model-migration.md confirm Haiku 5.5 bills $0.10/$0.50 per MTok when the prompt is 100K tokens or fewer and $0.50/$2.50 above, with cache reads at 0.1x, 5-minute writes at 1.25x and 1-hour writes at 2x of the applicable input rate. Query result for 4fae0fb1: 79 calls, cost_source 'unknown', recorded $1.045337. 24 calls are over 100K (5,742,134 tokens), and repricing them at 5x gives $3.735821. Across all 7 Haiku runs: $7.00 recorded vs $24.52 repriced. Budget enforcement (src/lib/agents/model-calls.ts:66-103) sums the recorded cost_usd and actual_cost_usd, so run budgets under-count by the same factor. The prior audit noted the gap only inside P4's evidence and never fixed it, so this is not a re-report.

### AR-PERF-3: A 455 KB raw historical_record slice (about 190K tokens) rides in every report-stage prompt and pushes 25 calls over the 100K price tier

Severity **high**, effort **M**, verdict **corrected**, JD trait: Computed twenty-quarter history table with medians, ranges and current-vs-history positioning (JD section 4)

**Problem.** The report stage builds its packets from the full artifact set. `common.artifacts` holds all artifacts (reporting/runtime.ts:56-59). The outline, review and team-request packets carry all of it, and a section writer gets its selected artifacts on top of a shared prefix of about 79K tokens (cache_read_tokens=79,003). historical_record enters as 455,004 bytes of observation rows, roughly 190K tokens at the measured 0.42 tokens/byte. That sends report_outline to 403K tokens, ai_review to 476-481K, team_requests to 380-383K, and the historical-performance and evidence-gaps sections to 277K and 356K. With only about 21K tokens of headroom above the shared prefix, any section with more than a few artifacts crosses 100K. The same rows are what the writer referenced as a table (path 'observations'), so 1.78 MB of 21-column raw rows, metadata_json included, landed in the report markdown (lines 187-2516). The prompt pays for the bytes, and the report becomes unreadable for the reader. The JD example instead uses a 20-quarter table with computed medians and current-vs-history positioning.

**Evidence.** Query: per-task packet artifact sizes. Every team_requests, report_outline and ai_review packet and the historical-performance and evidence-gaps section packets include historical_record:455004, strategy_combination_catalog:83568 and valuation_scenario_set:47665. Calls over 100K tokens by task type in 4fae0fb1: report_section 10/20, team_answer 4/10, decision_synthesis 3/3, ai_review 2/2, team_requests 2/2, report_outline 1/1. report_document table 'Quarterly revenue and operating income' resolves to historical_record path 'observations' (tables.ts:4-16, report.ts:129). awk over report.md lines 187-2516 gives 1,784,737 bytes of a 2,031,417-byte report. historical_diagnosis, which already holds computed statistics, is only 20,772 bytes.

**Recommendation.** (1) Build a compact history view: historical_diagnosis plus a pivoted matrix of about 15 headline metrics x the last 20 quarters plus annual totals (about 10-20 KB), saved as an artifact such as historical_summary_table. Pass that to report-stage packets instead of historical_record.observations, and change the packet.ts note so writers cite it rather than 'observations'. (2) In createReport/resolveTable, reject a table whose resolved value has more than about 60 rows or 10 columns. (3) Scope the outline, review and request packets: the review gets only the artifacts the report_document cites, and requests and outline get artifact summaries (id, type, key fields) instead of full content_json. (4) Give each section only the evidence_claims referenced by its selected artifacts. This trims the shared prefix, which today sits about 21K tokens below the 100K tier. To verify: on a mock run, then the user-approved small paid check (this is a prompt-layout change), SELECT count(*) FILTER (WHERE input_tokens>100000) per run falls from 24 to 6 or fewer, report.md falls below about 250 KB, and with AR-PERF-2 fixed the repriced run cost falls by 50% or more.

**Verifier check.** Packet breakdown confirms historical_record at 453,952 bytes in the outline, both reviews, both team_requests, both historical-performance attempts, both evidence-gaps sections and 3 financials team answers. researchPacketForModel (packet.ts:6-40) already compacts it to a series_table but 'retains every original observation' and tells writers to use canonical_table_path 'observations'. The report then resolves that path verbatim (tables.ts:4-16, no row cap): report.md lines 187-2516 hold 1,787,067 of 2,031,417 bytes. Three facts need correcting. (a) 24 calls are over 100K, not 25. (b) historical_record is in only 12 of those 24. The rest cross 100K for other reasons: the outline, review and requests packets carry about 390 KB of other artifacts even without history (strategy_combination_catalog 83 KB, valuation_scenario_set 48 KB, operating_scenario_set 43 KB and others). Every section and answer carries evidence_claims (67 KB) plus team_context (40 KB), outline (29 KB), filing_passages (22.5 KB) and specialist_requests (16.7 KB), which together make the 79K-token shared prefix. decision_synthesis carries latest_reported_metrics (160 KB). executive-judgment and evidence-gaps carry completed_sections (140-178 KB). (c) Removing historical_record alone brings only about 5 of the 12 history-carrying calls under 100K (historical-performance x2 and team answers x3). The outline (403K tokens), reviews (476-481K) and requests (380-383K) would still be at roughly 190-290K tokens. The 'from 25 to under 5' target is therefore unreachable with this fix alone. Repriced cost by task type: report_section $1.19, ai_review $0.63, team_requests $0.48, decision_synthesis $0.46, report_outline $0.27 of $3.74.

### AR-PERF-4: Asset view downloads 16 MB of JSON per load and again every 60 s, mostly data the open tab never reads

Severity **medium**, effort **S**, verdict **corrected**

**Problem.** view/page.tsx fetches /api/research-runs/[id]/report on load and every 60 s while the tab is visible (page.tsx:147-149, 178-181), whatever the run's status. getResearchRunReport (read-model.ts:101-207) returns every non-superseded artifact with full content_json and report_document in full. That includes the 2.1 MB `markdown` field, which no UI component reads, and the 2.8 MB artifact snapshot, a second copy of historical_record. It also runs SELECT * on model_call_logs and backtest_runs. financial_statement_set (6.6 MB) and historical_record (2.4 MB) are used only by the Financials and KPI tabs (page.tsx:272, data-views.ts:7-13). M2's fix removed artifacts_by_type and the report_document duplicate but left this payload in place. Each request also opens a fresh postgres pool (read-model.ts:102, one of 47 files that do this).

**Evidence.** Measured with a read-only script (scratchpad/perf/measure-report.mts) calling getResearchRunReport for 4fae0fb1: 15,981,136 bytes of JSON (1,502,436 gzipped). Parts: artifacts 9,221,451; report_document 5,044,829; read_models 1,712,643 (model_calls 793,108, backtests 384,222, metrics 272,664, evidence 195,270). Server cost per request: 154-177 ms queries, about 50 ms stringify, about 230 ms gzip; Node heap grew 104 to 225 MB over 3 calls. A fresh pool costs 12.2 ms vs 0.4 ms for 15 queries on a shared pool (measure-pool.mts). grep finds no reader of report_document.markdown in src/app or src/components; research-report.tsx:63,106-107 reads document.artifacts and sections.

**Recommendation.** (1) Omit report_document.markdown from getResearchRunReport. (2) Return financial_statement_set and historical_record rows without content_json, and have the Financials and KPI tabs fetch /api/research-runs/[id]/artifacts/[artifactType] when opened. (3) Store resolved table rows in the report document at compose time, or strip historical_record from the snapshot once AR-PERF-3 lands, so the report tab no longer needs the raw artifact. (4) Poll every 60 s only while the run status is running, pending or queued. (5) Select only the metadata columns of model_call_logs, and use the shared client from src/db/index.ts. To verify: rerun scratchpad/perf/measure-report.mts and expect about 5 MB after steps 1, 2 and 4, and under 2 MB after step 3. The browser network tab should show no repeated multi-MB transfers on an idle waiting_for_human run.

**Verifier check.** view/page.tsx:148 polls loadResearch every 60 s while the tab is visible, whatever the run status, and line 179 fetches /report each time. read-model.ts:102 opens a fresh postgres() pool per request (51 files in src now do this, not 47). Lines 108-130 SELECT full artifact content and SELECT * on model_call_logs, whose metadata JSON is 754 KB for this run. SQL confirms 15.07 MB of non-superseded artifact text: financial_statement_set 6.62 MB, report_document 5.19 MB (markdown 2.03 MB, artifacts snapshot 2.78 MB) and historical_record 2.39 MB. No component in src/app or src/components reads .markdown. The /artifacts/[artifactType] route exists. One correction: report_document.artifacts, the snapshot the report tab renders and that viewArtifacts merges at page.tsx:262, itself holds the full historical_record (2,392,742 bytes), because the report's quarterly table resolves from it. Keeping the snapshot in the overview payload as proposed therefore leaves about 5 MB, not under 2 MB, until AR-PERF-3 shrinks history or the tables are pre-resolved.

### AR-PERF-5: No per-stage effort control: Haiku 5.5's default hidden thinking appears to inflate output tokens, the main latency driver, about 2x on mechanical calls

Severity **medium**, effort **S**, verdict **corrected**

**Problem.** The harness never sends output_config.effort or a thinking setting (anthropic-compatible.ts:98-108; grep for 'effort' in src/lib finds nothing). Claude Haiku 5.5 therefore runs adaptive thinking at its default 'medium' effort on every call. Thinking text is omitted from the stream but billed as output tokens. Generation speed, about 200 output tokens/s, bounds every call's latency, so mechanical calls (source-reader extraction, metric normalization, team answers, source review) pay for thinking they do not need. The analyst stages, where the user wants deeper work, cannot be turned up either.

**Evidence.** Stored output bytes per reported output token in 4fae0fb1: report_section 0.73-1.59, operating_scenarios 0.81, decision_synthesis 1.09-1.16, source-reader batches 0.53-1.20. On the same model, input runs about 2.4 bytes/token (277,509 tokens / 658,335 wire bytes), and reasoning_tokens is reported as 0. At about 2.6 bytes/token, an estimated 60% of source-reader's 174,729 output tokens (26 calls, 710 s of call time), 55% of export-writer's 216,895 and 51% of asset-analyst's 189,264 do not appear in stored outputs. This is an estimate: post-processing may also drop fields. Example: a 24,888-output-token section call took 119 s and stored 18,054 bytes.

**Recommendation.** Add an optional `effort` to ExecutionPolicy, set from the call site by task type (input.policy, already spread in runner.ts:71), with RESEARCH_<AGENT>_EFFORT / RESEARCH_EFFORT as the fallback. In anthropic-compatible.ts, send output_config: { ...(effort ? { effort } : {}), ...(format ? { format } : {}) }. Starting points: low for evidence_extraction_batch, metric_normalization, source_review and team_answer; keep medium for report sections; try high only for analysis stages the user wants deeper, and raise their output cap with AR-PERF-6. Keep each task type's value constant so the cache prefixes still match. This changes model requests, so run the user-approved small paid test first. To verify: per task type, avg(output_tokens) and avg(latency_ms) in model_call_logs. evidence_extraction should drop about 30-50% with claims per batch in evidence_claims steady.

**Verifier check.** anthropic-compatible.ts:97-108 sends only model, prompt fields, max_tokens and output_config.format. grep finds no effort or thinking setting in src/lib/agent-harness. Per the claude-api skill, Haiku 5.5 runs adaptive thinking by default at effort 'medium', and thinking display defaults to omitted while thinking tokens are still billed. Stored output bytes per output token: report_section 1.15, source-reader 1.05, decision_synthesis 1.12, against 2.4-3.0 for outline and review outputs. This is consistent with roughly 50% hidden thinking on the large consumers. Two caveats. operating_scenarios' 0.81 is distorted by a repair pass (generation 25,895 + repair 22,208 tokens in one row). And the proposed per-agent env cannot give 'low for team answers' and 'high for asset-analyst analysis', because team answers run as asset-analyst, valuation-analyst and metric-normalizer.

### AR-PERF-6: The 32,768 default output cap is below decision_synthesis's normal output, so its first attempt is truncated and discarded

Severity **low**, effort **S**, verdict **corrected**

**Problem.** DEFAULT_OUTPUT_TOKENS is 32,768 (runner.ts:18), and .env.local sets RESEARCH_MAX_OUTPUT_TOKENS=0, which selects that default. decision_synthesis (asset-analyst) normally emits 30-39K output tokens with hidden thinking, so its first attempt hits the cap. The RM1 fix then retries with a doubled limit (runner.ts:690), but the truncated attempt's time and tokens are already lost. Calls are streamed and Haiku 5.5 allows 128K output, so a higher cap costs nothing unless it is used.

**Evidence.** 4fae0fb1: decision_synthesis attempt 1 failed with 'The response was cut off at the output limit (32768 tokens)' after 161 s ($0.036). Attempt 2 produced 39,292 tokens in 183 s; the rerun produced 30,104. The same failure hit 1d427f3f asset_valuation (32,768 tokens, 143 s). Query: SELECT ... FROM model_call_logs WHERE error_message ILIKE '%output limit%'.

**Recommendation.** Set RESEARCH_ASSET_ANALYST_MAX_OUTPUT_TOKENS=65536 and RESEARCH_VALUATION_ANALYST_MAX_OUTPUT_TOKENS=65536 now. If AR-PERF-5 raises effort on analysis stages, raise DEFAULT_OUTPUT_TOKENS to 65,536 for Claude models (modelOutputCap already clamps to 128K). To verify: no 'output limit' or 'whole output limit' failures in model_call_logs on the next paid run, and decision_synthesis completes in one attempt.

**Verifier check.** runner.ts:18 DEFAULT_OUTPUT_TOKENS=32,768, and .env.local:26 RESEARCH_MAX_OUTPUT_TOKENS=0 selects it. In 4fae0fb1, decision_synthesis attempt 1 failed with 'cut off at the output limit (32768 tokens)' after 161,568 ms. The doubled-limit retry (runner.ts:689-691) succeeded at 39,292 tokens with max_output_tokens 65,536. Correction: the 1d427f3f asset_valuation failure was a different mode, 'used its whole output limit (32768 tokens) before writing an answer', meaning thinking consumed the cap. Across the 5 Haiku runs only these 2 output-limit truncations occur, and the retry recovers each at a cost of about 140-160 s and $0.03. Budget reservation is a fixed $0.10 (run-context.ts:503), so a higher cap adds no reservation cost. Severity lowered to low: the failure is infrequent and self-healing.

### AR-PERF-7: Fan-out pool is pinned to 3 in .env.local, and several timeout knobs there are never read

Severity **low**, effort **S**, verdict **corrected**

**Problem.** RESEARCH_AGENT_CONCURRENCY=3 in .env.local overrides the default of 4 (pipeline-helpers.ts:273-276). The 26 source-reader batches therefore ran 3 at a time in 9 waves, and the 10 report body sections in about 4 waves. Tool use is off and each call is independent, so the two fan-out phases are limited only by this pool. .env.local also sets RESEARCH_ATTEMPT_TIMEOUT_MS, RESEARCH_REPAIR_TIMEOUT_MS, RESEARCH_SOURCE_READER_ATTEMPT_TIMEOUT_MS and RESEARCH_VALUATION_ANALYST_ATTEMPT_TIMEOUT_MS, which no code reads. They suggest a 6-minute attempt cap that does not exist (the 18-minute calls in AR-PERF-1 were bounded only by the timers). Each variable also appears twice in the file.

**Evidence.** model_call_logs 4fae0fb1: three source-reader calls start at 14:38:28, and each later batch starts when one finishes. evidence_extraction took 14:38:27 to 14:42:31 = 244 s for 26 batches of 18-36 s. grep -rln for RESEARCH_ATTEMPT_TIMEOUT_MS / RESEARCH_REPAIR_TIMEOUT_MS / ATTEMPT_TIMEOUT_MS over src and scripts finds nothing. docs/local-agent-harness.md:139 projects body sections at 94 s with a pool of 4.

**Recommendation.** For the next paid check, set RESEARCH_AGENT_CONCURRENCY=6 in the worker's environment. Expected: evidence_extraction about 120-130 s instead of 244 s, and the body sections in 2 waves. Watch for 429s in model_call_logs.error_message. Delete the four unused *_ATTEMPT_TIMEOUT_MS / *_REPAIR_TIMEOUT_MS lines from .env.local so they no longer suggest a 6-minute attempt cap. To verify: research_stages durations for evidence_extraction and ai_reviewer, plus the 429 count.

**Verifier check.** pipeline-helpers.ts:273-276 defaults to 4. .env.local:33 sets RESEARCH_AGENT_CONCURRENCY=3, and the call timing confirms 3 concurrent source-reader calls starting about 14:38:27.7 and 3 concurrent sections at 07:02:44. evidence_extraction took 244 s. grep for RESEARCH_ATTEMPT_TIMEOUT_MS, RESEARCH_REPAIR_TIMEOUT_MS and *_ATTEMPT_TIMEOUT_MS in src, scripts, docs and .env.example finds nothing, so .env.local:18-19, 21 and 44 are dead knobs. Refuted part: 'each variable also appears twice in the file' is false; `cut -d= -f1 | sort | uniq -d` over .env.local returns nothing. .env.local is also the user's untracked local file.

### AR-PERF-8: Research-store sync exports 1.08 GB of chunk JSONL with 3.6 GB peak RAM; its shards are about 10 runs from GitHub's 100 MB file limit

Severity **medium**, effort **M**, verdict **confirmed**

**Problem.** exportStore (src/lib/maintenance/research-store.ts:139-191) loads every table whole (localRows, lines 104-107). It builds shards with an array spread per row (line 153, quadratic) and shards rows by the first hex character of the uuid (line 30). Every run's new rows therefore land in all 16 shards of each table, and each sync rewrites and commits every shard. The 95 MB guard applies only to mirrored storage files (line 174), not to table shards (line 160). document_chunks is already at 66.9-68.8 MB per shard and grows about 2.7 MB per shard per run. The branch lives on origin in the code repository, so its packs already make up the main checkout's .git object store and are downloaded by every full clone.

**Evidence.** du: research-store/ 2.3 GB (tables 1.5 GB: document_chunks 1.0 GB, research_tasks 246 MB, research_artifacts 184 MB; files 832 MB). git count-objects in the main repo: size-pack 604.30 MiB, packs of 292 MB, 199 MB and 140 MB, branch remotes/origin/research-store. Read-only measurement (scratchpad/perf/measure-store.mts) of the same SELECT and sharding for document_chunks: 150,599 rows, SELECT 11.2 s, shard append 0.8 s, join 2.6 s, 1,084 MB output, largest shard 69 MB, max RSS 3.61 GB. Growth: 10-13 added about 5.9K chunks, about 7.2 KB of JSONL each, so roughly 43 MB per run, or about 2.7 MB per shard.

**Recommendation.** (1) Shard append-mostly tables by created_at month plus the id's first character (for example tables/document_chunks/2026-10/3.jsonl), so old shards never change. Split any shard over 50 MB, and refuse to export when a shard would pass 90 MB. (2) Stream rows with sql`...`.cursor(1000) into a write stream on export, and read line by line on import. (3) Skip research-memory passages of non-current parser versions that nothing cites (AR-PERF-9). (4) Document `git clone --single-branch --branch main` for code-only clones, or move the store branch to its own repository. To verify: export peak RSS under 500 MB, `git -C research-store diff --stat` after one new run shows only new shard files, and the largest file stays under 50 MB.

**Verifier check.** research-store.ts:30 shards by the first id character. localRows (104-107) loads the whole table. Line 153 does an array spread per row. Line 159 rm-rf's and rewrites every shard on each export. MAX_FILE_BYTES (15) is checked only for mirrored files (177), not for table shards. On disk: research-store/tables 1.5 GB, files 832 MB, document_chunks shards up to 68,773,014 bytes. research-store/.git is a worktree file, the branch exists at remotes/origin/research-store, and the main repo's git count-objects reports size-pack 604.30 MiB. docs/operations.md:84 documents the 95 MB guard only for files. Chunk growth is lumpy: 17,084 chunks on 10-08, 19,260 on 10-10 and 5,930 on 10-13. The roughly 10-run headroom to GitHub's 100 MB hard limit holds, or fewer runs on SEC-heavy days, and the shards already exceed GitHub's 50 MB warning size. The 3.6 GB RSS figure is from the reviewer's script; I did not re-run it, but it is consistent with loading the 1.08 GB of to_jsonb text into JS strings. The import side (readStoreTable, 109-115) also reads whole tables.

### AR-PERF-9: Retrieval never reads 60K stale passages, but they still sit in the GIN index, alongside a 63 MB raw-text FTS index serving one search route

Severity **low**, effort **S**, verdict **confirmed**

**Problem.** A research-memory parser bump (MEMORY_PARSER_VERSION '2', indexing.ts:12) leaves every v1 passage in place with search_tsv set. Retrieval filters on the current version (retrieve.ts:100, 209, 387), so these rows only add bulk to document_chunks, its GIN index, the research-store export and backups. Separately, document_chunks_text_fts_idx is a GIN expression index over to_tsvector(text) on all 150,599 chunks, including 85K raw HTML system-source-payload chunks. Only /api/search uses it (route.ts:46-49), and every chunk insert pays for it.

**Evidence.** Query grouping document_chunks by parser: research-memory v1 has 60,230 rows (121 MB, all with search_tsv, 1,293 cited by source_locations); v2 has 5,259 rows (13 MB); system-source-payload v2 has 85,104 rows (137 MB). 28 documents carry both v1 and v2 parses (5,174 stale v1 rows). pg_stat_user_indexes: document_chunks_text_fts_idx 63 MB with 196 scans; document_chunks_search_tsv_idx 22 MB. document_chunks totals 446 MB of a 632 MB database. Separately, the 151 duplicate SEC documents still carry 64,104 chunks (about 124 MB), kept on purpose for citations (docs/operations.md:57; previously deferred RMEM3).

**Recommendation.** Add an opt-in, dry-run-by-default storage-gc step that deletes research-memory chunks of non-current parser versions with no source_locations or document_embeddings reference, plus the parses left empty. Change /api/search to query search_tsv with ts_rank_cd, joined to document_parses at the current MEMORY_PARSER_VERSION, then drop document_chunks_text_fts_idx in a Drizzle migration. To verify: pg_total_relation_size('document_chunks') before and after, /api/search still returns hits for a known term, and the retrieval unit tests pass.

**Verifier check.** Grouping document_chunks by parser gives: research-memory v1 60,230 rows (121 MB, all with search_tsv), v2 5,259 rows (13 MB), system-source-payload v2 85,104 rows (137 MB, no search_tsv). 5,174 v1 rows sit on documents that also have a v2 parse. retrieve.ts:100, 209 and 387 filter on MEMORY_PARSER_VERSION='2' (indexing.ts:12), so retrieval never reads v1 rows. Indexes: document_chunks_text_fts_idx 63 MB with 196 scans, search_tsv_idx 22 MB with 78 scans. /api/search/route.ts:46-49 is the code user of to_tsvector('english', dc.text). FKs from source_locations and document_embeddings use ON DELETE NO ACTION, so cited rows must be kept. storage-gc.ts handles only files. One caveat on the fix: search_tsv is populated only for research-memory parses, so pointing /api/search at it drops the 85K raw system-source-payload chunks from search results. That is arguably better, but it is a behaviour change, and the query also needs the current-version filter.

## AR-SEC: Security posture after the October fixes

On main, the security controls changed in October hold up when tested against the source. The SSRF guard in net.ts checks the resolved address at the socket for every hop. The backtest OS sandbox denies network, fork and reads of the home, repository and temp directories: I probed it with sandbox-exec, including the firmlink aliases /System/Volumes/Data/... and /Volumes/Macintosh HD/..., and every alias was denied. Provider fetches use redirect:"error", and `npm audit --omit=dev` reports 0 vulnerabilities. The serious new risk is the git research store from PR #74. Its exporter and importer follow symlinks, and the importer writes store files anywhere under the project root, not only under storage/. This has two consequences. First, sandboxed model-written backtest code can make the next `store:sync` push ~/.ssh keys or .env.local to GitHub, which undoes the sandbox's main protection. Second, anyone who can push to the unprotected research-store branch gets code execution on every machine that syncs. The store also sends the whole database (full prompt transcripts, task packets, filing text) to a branch of the code repository, with no check of where it goes. Its table shards are not size-capped and sit at about 68 MB against GitHub's 100 MB limit, so sync will start failing within a handful of runs. The rest is low severity for a local single-user tool: #8 is still open and the gate routes record whoever the caller says approved; backtest CSV rows are exported unescaped (the S7 fix is incomplete); SEC User-Agents use example.com placeholders; and there are unused runtime dependencies and a dead credential.

<details><summary>Measurements</summary>

- **Research store working tree** (du): 2.3 GB in total: tables 1.5 GB, files 832 MB. The largest tables are document_chunks 1.0 GB, research_tasks 246 MB, research_artifacts 184 MB, agent_session_messages 31 MB and model_call_logs 15 MB. All 16 document_chunks shards are 67.6-68.8 MB (find -size +50M). Last store commit: f4d184ae (2026-10-16), pushed to origin/research-store.
- **GitHub** (gh, read-only): repo is PRIVATE, one collaborator, research-store branch not protected, repo size about 215 MB.
- **DB size and growth**: document_chunks has 150,599 rows and 1,033 MB of to_jsonb text. Growth was 90 MB on 2026-10-08, 107 MB on 10-10 and 24 MB on 10-13.
- **Stored transcripts**: agent_session_messages has 771 rows. User messages average 76,236 chars, assistant messages 35,682 and system messages 6,830.
- **Secret scan of DB logs** (counts only): sk- long tokens 0 in model_call_logs, agent_session_messages, agent_session_events, agent_sessions and research_tasks. Bearer tokens 0 and postgres URLs with passwords 0 in model_call_logs; postgres URLs with passwords also 0 in research_tasks.
- **'api_key' text matches**: 3 in model_call_logs and 1 in research_tasks. Two of the model_call_logs rows are 'Direct provider requires RESEARCH_MODEL_API_KEY' messages (one in each table). The other two are OpenAI invalid_api_key bodies from 2026-08-06 showing a masked key tail.
- **Secret scan of the store files**: 0 files match sk-ant, sk-, sk-proj, AKIA, ghp_, bearer or postgres-URL-with-password patterns. 3 files contain the masked key tail.
- **Sandbox probes** (sandbox-exec with macProfile's rules): reading the repo directly, through /System/Volumes/Data/... and through /Volumes/Macintosh HD/... all failed (exit 1); /etc/hosts was readable (exit 0, positive control). Creating a symlink in writeDir that points at a denied file succeeded (exit 0); outside the sandbox, stat follows that link.
- **Node v24.3.0 behaviour**: readdir withFileTypes reports a symlink as isDirectory() false; fs.copyFile on a symlink writes a regular file with the target's content.
- **npm audit --omit=dev**: 0 vulnerabilities across 106 prod dependencies.
- **API surface**: 53 route.ts files with 61 handlers. All pages except the root layout are client components, so pages skipped by the proxy's static-extension rule render no data on the server. GET API handlers sampled (report, run, asset runs, metrics, quality) are read-only.
- **Listeners**: Next.js on 127.0.0.1:3000, Postgres on 127.0.0.1:5432 and [::1]:5432. A Colima ssh mux (pid 31865) also listens on *:5432 and other ports for another project, which is outside this repo.
- **SEC fetches**: 1,286 sec.gov retrieval attempts, all fetched, 0 failures.
- **Scratch files**: written only under /private/tmp/claude-501/-Users-japardinathaniel-Documents-GitHub-Investing-Research-Pipeline/fdaaf424-0588-4f7e-be73-9b055f9db53a/scratchpad (symtest/, sbx/, deps.sh).

</details>

### AR-SEC-1: Research-store sync follows symlinks and import writes outside storage/: sandbox bypass to GitHub, and code execution from a store push

Severity **medium**, effort **S**, verdict **corrected**

**Problem.** (a) No push access needed. The backtest sandbox stops model-written code from reading .env.local or ~/.ssh, but that code may still write anything into its own directory, including the output files the runner reports (docs/security.md Z4a). Creating a symlink there to a denied file is allowed. The next `npm run store:export`/`sync` runs unsandboxed: it stat()s and copyFile()s the referenced path, both of which follow the link. The target's bytes land in research-store/files/... and are committed and pushed. The secret then sits in the GitHub history. (b) With push access to the research-store branch (unprotected; any token with contents:write), importStore copies every file under files/ to projectRoot/<same path> when that path is missing, with no storage/ restriction. A pushed files/src/instrumentation.ts runs inside Next.js with every provider key. A pushed files/.env with BACKTEST_SANDBOX=off is loaded by the worker after .env.local and turns the backtest sandbox off. The next export deletes the planted file from the store, which hides it. A committed symlink also turns import into a local-file read that the following sync pushes (two syncs). docs/operations.md:83 says files are copied into storage/, which is not what the code does.

**Evidence.** src/lib/maintenance/research-store.ts:118-127: listFiles treats every non-directory Dirent, symlinks included, as a file. Lines 170-183 (export) check containment lexically with resolve()+startsWith, then call stat() and copyFile(), both of which follow links. Lines 263-275 (import): rel = relative(filesDir, file); target = resolve(projectRoot, rel), with no 'storage/' prefix check, then mkdir+copyFile. src/lib/backtesting/executor.ts:338: isInside is lexical, no realpath. Probe in the scratchpad using macProfile's rules (sandbox.ts:60-75): `sandbox-exec ... ln -s '<repo>/package.json' <writeDir>/link` exit 0; reading through the link inside the sandbox exit 1; outside, stat follows it (isFile true). Node v24.3.0 test: readdir withFileTypes gives isDirectory()=false, isSymbolicLink()=true for the link; fs.copyFile(link) wrote a regular file containing the target's content. The repo has no .env and no src/instrumentation.ts. research-worker.ts:36-37 loads .env.local then .env without overriding, .env.local doesn't set BACKTEST_SANDBOX, and sandbox.ts:101 honours 'off'. `gh api .../branches/research-store/protection` -> 404 'Branch not protected'. tests/research-store.test.ts has 8 tests, all on decideRow/orderTables; none covers files. Related row-level gap: corpus.ts:897-905 storedSecFiling reads join(cwd, storage_path) guarded only by LIKE 'storage/sources/%' ('storage/sources/../../x' passes), unlike filing-store.ts:19. The hash check makes this hard to exploit.

**Recommendation.** In src/lib/maintenance/research-store.ts: (1) listFiles: recurse on e.isDirectory(), push only e.isFile(), and skip symlinks and everything else. This also covers committed symlinks on import. (2) Export: for each referenced path, take top = realpath(projectRoot/storage/<first path segment after storage/>) and skip the file unless realpath(file) starts with top+sep. This is the same pattern storedBacktestFile uses, and it still works when storage/<dir> is a symlink in a worktree. (3) Import: compute rel with posix(), skip and report anything that doesn't start with 'storage/'. After mkdir, require realpath(dirname(target)) to be under realpath(projectRoot/storage/<first segment>). Copy with fs.constants.COPYFILE_EXCL. (4) executor.ts:338: drop artifacts whose realpath leaves artifactDir (reuse storedBacktestFile). In corpus.ts:899-903 storedSecFiling, add the resolve+startsWith check that filing-store.ts:19 already has. Add one unit test that builds a temp store with files/src/evil.ts and a symlinked files/storage/sources/x, plus a storage/backtests dir containing a symlink, and asserts that nothing is copied in either direction. Fix docs/operations.md:83 and the Z5 row (docs/security.md:36) to mention files. Verify: the new test passes, and `npm run store:export --no-push` with a planted symlink in a backtest dir reports it as skipped.

**Verifier check.** Re-read src/lib/maintenance/research-store.ts on main (cfcbdbfa). listFiles (:118-127) pushes every non-directory Dirent, symlinks included. Export (:170-183) does a lexical resolve+startsWith check, then stat() and copyFile(), and both follow links. Import (:263-275) does target = resolve(projectRoot, relative(filesDir, file)) with no storage/ prefix check. I reproduced the Node v24.3.0 behaviour in the scratchpad (verif-sec): readdir withFileTypes gives isDirectory false and isSymbolicLink true, and copyFile(link) writes a regular file holding the target's bytes. executor.ts:338 isInside is lexical. docs/security.md:88 already concedes that the strategy can patch the runner and write anything into its own directory. The runner's AST and import guards are in-process only, so a strategy that monkeypatches DataFrame.to_csv can leave trades.csv as a symlink, and export then mirrors it. The research-package generator is not affected: storedBacktestFile (research-package-generator.ts:1657-1664) uses realpath. No .env and no src/instrumentation.ts exist. research-worker.ts:36-37 loads .env after .env.local, and BACKTEST_SANDBOX is unset in .env.local. tests/research-store.test.ts has 8 tests, all on decideRow/orderTables. docs/operations.md:83 does say files are copied 'into storage/'. Three facts needed correcting. (1) Impact of (a): the secret lands in the user's own PRIVATE store branch history and in storage/ on every machine that syncs. Once copied it is a regular file, so later research packages on those machines would include it. The attacker still has no network channel to receive it, so 'undoes the sandbox's main protection' overstates it: it is a secret persisted to GitHub, not an exfiltration. (2) For (b), `gh api .../branches/main/protection` also returns 404, so anyone who can push to research-store can already push code. The extra risk of the store path is that it is never reviewed, sync applies it automatically, and the planted file disappears from the tip on the next export (:185). (3) The recommended realpath(projectRoot/storage) containment would break syncing from a worktree. In the user's worktree setup each storage/<dir> is a symlink to the main checkout (memory note worktree-runs-and-test-dbs), so realpath(source) falls outside realpath(worktree/storage) and every file would be skipped. Severity stays medium: it is a small code fix for a real trust-boundary leak.

### AR-SEC-3: Store table shards have no size cap; document_chunks shards are at ~68 MB and will hit GitHub's 100 MB push limit

Severity **medium**, effort **S**, verdict **corrected**

**Problem.** The 95 MB guard (MAX_FILE_BYTES) covers only mirrored storage/ files. Table rows go into 16 shards per table keyed by the first id character, with no size check. document_chunks already has every shard at 67.6-68.8 MB, above GitHub's 50 MB warning. Each run adds about 24-107 MB of chunks, roughly 1.5-7 MB per shard, so a shard will pass 100 MB within an estimated 5-20 runs. After that GitHub rejects every push, and pullStore's reset --hard drops the unpushed commit on each attempt, so sync stays stuck until the code changes.

**Evidence.** research-store.ts:15 and :177: the size check applies to storage files only. :30: shardOf = id.slice(0,1). :160: shards are written with no size check. `find research-store/tables -size +50M` lists all 16 document_chunks shards at 67,625,829-68,773,014 bytes. tables/document_chunks totals 1.0 GB (2.3 GB store overall). DB: document_chunks is 150,599 rows and 1,033 MB of to_jsonb text (839 MB text, 82 MB search_tsv). Daily adds: 90 MB (10-08), 107 MB (10-10), 24 MB (10-13, the META run).

**Recommendation.** Change shardOf to id.slice(0, 2).toLowerCase(), which gives 256 shards and about 4 MB per document_chunks shard today. readStoreTable (:109-116) already reads every *.jsonl in a table directory, and export rm's the table dir first (:158), so old-format stores still import and switch over cleanly. Before writing, make exportStore throw a clear error when any shard's byte length exceeds MAX_FILE_BYTES, so sync fails locally rather than at push. While editing, replace the spread at :153 with `(shards.get(shard) ?? shards.set(shard, []).get(shard)!).push(row.line)`. Verify: after `npm run store:export`, `find research-store/tables -size +50M` returns nothing, and importing the current one-character store into a scratch DB still succeeds.

**Verifier check.** `find research-store/tables -size +50M` lists all 16 document_chunks shards at 66,929,278-68,773,014 bytes. The minimum is 66.9 MB, not the 67.6 MB the finding states. shardOf = id.slice(0,1) (:30), and the shards are written with no size check (:160). MAX_FILE_BYTES applies only to mirrored files (:177). The store branch has a single commit, f4d184ae. The growth rate needed correcting. The 90/107/24 MB figures are daily totals, and 10-10 had 3 runs while 10-08 had 2. Grouping document_chunks by created_at gives about 2-47 MB per run: 25 MB for the META run on 10-13, 2 MB on 10-11, about 37 MB per run on 10-10 and about 47 MB per run on 10-08. That is roughly 0.1-3 MB per shard per run against about 31 MB of headroom per shard, so sync breaks after an estimated 10-20 more document-heavy (new-ticker) runs, not 5-20. The failure mode is confirmed: after the push is rejected, pullStore's reset --hard (scripts/research-store.ts:44-47) drops the commit, so every later sync fails the same way. The same loop has an O(n^2) pattern: :153 rebuilds each shard array with a spread on every row, which the fix should replace with push().

### AR-SEC-2: store:sync pushes the full database, prompt transcripts included, to a branch of the code repo with no check of where it goes

Severity **low**, effort **S**, verdict **corrected**

**Problem.** Every table except the job queue and heartbeats is exported, plus every storage/ file a row names. That includes full model transcripts (agent_session_messages, user messages averaging 76 KB), complete task packets, all filing text, user uploads and model-written backtest code. The destination is hard-coded to origin/research-store, so data access is tied to code access. Anyone given read access to the code (a collaborator, an installed GitHub App with contents access, a fork, or making the repo public later) also gets the research database. Nothing checks visibility before pushing. Today the repo is private with a single collaborator, so this is low severity, but the coupling is easy to forget. docs/security.md:23 names model_call_logs and the budget ledger but not transcripts, uploads or generated code.

**Evidence.** scripts/research-store.ts:36, 45-46, 86 hard-code origin and the research-store branch. research-store.ts:13 excludes only research_run_jobs and research_worker_heartbeats. Store size: tables 1.5 GB (document_chunks 1.0 GB, research_tasks 246 MB, research_artifacts 184 MB, agent_session_messages 31 MB, model_call_logs 15 MB); files 832 MB. DB: agent_session_messages has 771 rows (288 user messages, average 76,236 chars). `gh repo view` -> PRIVATE; collaborators: ToRRIIDeR97 only; GitHub reports the repo at about 215 MB. Secret scan of the store for sk-ant-/sk-/sk-proj-/AKIA/ghp_/bearer/postgres-URL-with-password patterns: 0 files. But 3 store files (model_call_logs d/f.jsonl, agent_output_staging b.jsonl) hold an OpenAI error body from 2026-08-06 that shows the masked tail of a key ('...UBfm'). The 2 matching model_call_logs rows are e.g. d37978ef.

**Recommendation.** Add an optional RESEARCH_STORE_REMOTE (a separate private repository URL). scripts/research-store.ts should fetch from and push to it instead of origin, and the docs should recommend that setup. When `gh` is available, refuse to push unless `gh repo view --json visibility` returns PRIVATE. Don't rewrite rows. Before `git push`, scan the exported lines for configured secret values (the SECRET_ENV values) and bearer/sk-/AKIA/ghp_ patterns, and refuse to push with the table and id. Update docs/security.md:23 to list transcripts, task packets, uploads and generated code. Verify: sync to a scratch private remote works, the push is refused against a public test repo, and the refusal fires when a planted test secret appears in a row.

**Verifier check.** scripts/research-store.ts:36, 45-46 and 86 hard-code origin and the research-store branch, and EXCLUDED_TABLES (:13) holds only the job queue and heartbeats. `gh api repos/.../Investing-Research-Pipeline` returns visibility 'private' and size 215,215 KB. I re-ran the transcript query: agent_session_messages has 288 user messages averaging 76,236 chars, 247 system averaging 6,830, and 236 assistant averaging 35,682. docs/security.md:23 already records the store as a medium risk and says 'The repository must stay private', so this is a documented risk; the gap is that nothing enforces it. One part of the recommendation is wrong. Running redact() over exported lines conflicts with the three-way merge: base hashes are computed from the unredacted local line (research-store.ts:151). On the next import, a redacted store line therefore differs from base while local still equals base, so decideRow returns 'update' (:46) and overwrites local rows with the redacted text. The secret scan found 0 live tokens, so the mutation buys little.

### AR-SEC-4: Previously deferred (#8): API open to any local process by default, and the human gates record whatever approver the caller names

Severity **low**, effort **S**, verdict **corrected**

**Problem.** RESEARCH_OS_API_TOKEN is unset in .env.local, so any local process can pass both human gates, start paid work or cancel runs, provided it adds 'Sec-Fetch-Site: same-origin'. Several local coding agents are installed on this machine (Cline, Command Code, OpenCode, Claude Code), and a prompt-injected agent only needs one curl. The fix for #13 stopped trusting a caller-supplied reviewed_by on evidence review only. The plan gate and the final-review gate still record body.approved_by / reviewed_by / requested_by, so the gate audit trail can be forged. The token doesn't stop a process running as the same user, which can read .env.local, so keep this fix small.

**Evidence.** The .env.local key names don't include RESEARCH_OS_API_TOKEN. lsof shows node pid 80614 on 127.0.0.1:3000. src/proxy.ts:36-44 lets a non-browser request through by sending Sec-Fetch-Site; with no token, line 44 returns next(). src/app/api/research-runs/[id]/approve-plan/route.ts:21,25,27 and request-plan-changes/route.ts:15 use the body's identity; review/route.ts:31 sets reviewed_by from body.reviewedBy ?? body.reviewed_by and passes it to approveHumanReview (:161) and enqueueResearchRun (:151,167,176). `gh issue list`: #8 is still open.

**Recommendation.** In approve-plan, request-plan-changes, research-runs/[id]/review and thesis/[id] PATCH, ignore identity fields in the body. Record `apiToken() ? 'api:token' : 'api:unauthenticated'`, since the proxy has already enforced the token when one is set, and drop reviewed_by from the thesis allowedFields. Print a one-line warning at startup in scripts/dev-with-db.cjs and research-worker.ts when RESEARCH_OS_API_TOKEN is unset. Add a case to tests/api-state-guards.test.ts that posts approved_by:'attacker' and asserts the stored value is 'api:unauthenticated'.

**Verifier check.** Key names in .env.local don't include RESEARCH_OS_API_TOKEN. src/proxy.ts:36-44 lets a non-browser POST through with Sec-Fetch-Site: same-origin, and with no token line 44 calls next(). This is by design and documented in the comment at :4-11. approve-plan/route.ts:21,25,27, request-plan-changes/route.ts:15 and research-runs/[id]/review/route.ts:31 (used at :103, :123 and :151) all record the caller-supplied identity. The prior audit fixes handover lists #8 as still open. Two corrections. First, the evidence-review route (evidence/[id]/review/route.ts:9,24) always records the constant 'api:unauthenticated' and never 'api:token', so 'as the evidence-review route does' is inaccurate. A handler can't see the proxy's verdict without re-checking the token. Second, the reviewer missed one route: thesis/[id]/route.ts:15-27 PATCH also accepts reviewed_by and a free-text status from the body. Severity stays low: a same-user process can read .env.local, including the DB password, and write to Postgres directly.

### AR-SEC-5: Backtest equity_curve/trades CSV rows are still copied into exports unescaped (S7 fix incomplete)

Severity **low**, effort **S**, verdict **confirmed**

**Problem.** csvEscape now neutralises formula cells, but prefixCsvRows passes backtest CSV rows through as they are. docs/security.md justifies this with 'The runner writes only dates and numbers there'. The same document says the strategy can write anything into its own directory, including the outputs the runner reports. So model-written code, which a hostile page can steer through strategy design, can put =HYPERLINK(...) cells into data/backtest_outputs/trade_log.csv or equity_curves.csv.

**Evidence.** src/lib/export/research-package-generator.ts:1675-1680: prefixCsvRows escapes only the backtest_run_id and appends `row` unchanged. :1623-1629 feed equity_curve and trades artifacts into it. csvEscape (:1689-1693) is not applied. docs/security.md 'Research-package export' row lists this as an open gap, and its Z4a row says the strategy can write the outputs the runner reports.

**Recommendation.** In prefixCsvRows, split the header and every row on ',' and pass each cell through csvEscape, or drop any data row whose cells aren't all numeric or ISO dates. Add a case to tests/backtest-export-guards.test.ts with a trades.csv cell '=HYPERLINK("https://x")' in both a header and a data row, and assert that the exported cells start with "'=". Update docs/security.md:89 to remove the 'only dates and numbers' justification.

**Verifier check.** research-package-generator.ts:1675-1680: prefixCsvRows escapes only backtest_run_id and appends each row unchanged. The header is passed through raw as well (`backtest_run_id,${header}`). :1623-1629 feed equity_curve and trades artifacts into it. csvEscape (:1689-1693) isn't applied to these rows. docs/security.md:89 justifies the gap with 'The runner writes only dates and numbers there', while :88 says the strategy can patch the runner and write the outputs it reports. The two statements contradict each other. The prior audit's S7 verifier noted this pass-through and it stayed open, so this is a remaining part of S7, not a new defect. The trades and equity outputs are pandas to_csv of numeric and date columns (run_backtest.py:366-368), so splitting on ',' is safe for legitimate output.

### AR-SEC-6: SEC and data-source User-Agents are example.com placeholders, hard-coded in 14 places, and the email form is sent to arbitrary hosts

Severity **low**, effort **S**, verdict **corrected**

**Problem.** SEC's fair-access policy expects a declared, reachable contact in the User-Agent. Every EDGAR request declares research-pipeline-test@example.com or a variant at a reserved domain, so SEC can't contact the operator and may block the tool without warning. That would break the whole SEC-based history. The strings are scattered across files, so they can't be configured. Role discovery sends a UA with an email address to every page it fetches. Swapping in a real address there would leak it to arbitrary sites.

**Evidence.** corpus.ts:638 SEC_USER_AGENT = 'ResearchOS/0.1 research-pipeline-test@example.com'. Inline variants at corpus.ts:376, 866, 957, 1011, 1051, 1124, 1153, 1199, 1224, 1248, 1474; role-discovery.ts:505 (sent to discovered URLs); price-history.ts:28; stooq.ts:46. DB: 1,286 sec.gov source_retrieval_attempts, all 'fetched' and none with a 403 failure_reason, so nothing is blocked yet.

**Recommendation.** Add secUserAgent() to src/lib/net.ts, reading RESEARCH_SEC_USER_AGENT (for example 'Research OS name@your-domain'), and use it for every *.sec.gov request in corpus.ts. Use one generic UA with no email for role-discovery, Yahoo (price-history.ts:28) and Stooq. Warn once when the variable is unset, and add it to .env.example. Verify: `grep -rn example.com src` returns nothing outside tests, and an SEC fetch in the mock or unit tests sends the configured string.

**Verifier check.** corpus.ts:638 SEC_USER_AGENT = 'ResearchOS/0.1 research-pipeline-test@example.com'. Inline example.com UAs are at corpus.ts:376, 866, 957, 1011, 1051, 1124, 1153, 1199, 1224, 1248 and 1474, plus role-discovery.ts:505 (sent to discovered URLs) and price-history.ts:28, which makes 14 strings. One citation is wrong: stooq.ts:46 sends 'ResearchOS/0.1 market-data' with no email, so it isn't a placeholder-email site. The point about leaking a real email through role discovery holds. This is SEC fair-access compliance and reliability more than a security defect, so low is right.

### AR-SEC-7: Dependency and secret hygiene: four unused runtime packages, a dead API key in .env.local, and large untracked folders that aren't ignored

Severity **low**, effort **S**, verdict **corrected**

**Problem.** Unused production dependencies add supply-chain surface for nothing. A credential that no code reads stays in every process environment (worker, Next, the test runner) and is not in redact()'s list. A `git add -A` would commit a 219 MB nested clone of a third-party repository and the private handover notes.

**Evidence.** npm audit --omit=dev --json: 0 vulnerabilities across 106 prod dependencies. Import count in src/scripts/tests: marked 0, nanoid 0, date-fns 0, pg 0 (src/db uses postgres-js; @types/pg is also in dependencies). TAVILY_API_KEY is set in .env.local (key name only checked) but has 0 references in src, scripts, docs or .env.example, and is absent from SECRET_ENV (runner.ts:188-189). `git check-ignore` matches none of 'Temp Download/' (219 MB, nested git clone of a third-party repo), 'handover files/' or '.claude/launch.local-3200.json.bak'. Tracked root files are public datasets (CPIAUCSL_2.xlsx 765 KB, two CFTC zips at 2.4 MB) and the repo's own docs: nothing sensitive.

**Recommendation.** Remove marked, nanoid and date-fns from dependencies. Move pg and @types/pg to devDependencies; drizzle-kit uses pg when present and otherwise postgres-js. Delete TAVILY_API_KEY from .env.local, or add it to SECRET_ENV if it will be wired in. Add 'Temp Download/', 'handover files/' and '*.bak' to .gitignore. Verify: npm ci, npm run build, npm run test:unit and `npm run db:migrate` against a scratch DB pass, and `git status --ignored` lists the folders as ignored.

**Verifier check.** I found no imports of marked, nanoid, date-fns or pg in src, scripts or tests (precise import regex). TAVILY_API_KEY is set in .env.local (key name only), has 0 references in src, scripts, docs, tests or .env.example, and isn't in SECRET_ENV (agent-harness/runner.ts:188-189). git check-ignore matches none of 'Temp Download/', 'handover files/' or the .bak file. Two corrections. First, 'Temp Download/' contains its own .git, so `git add -A` would add it as an embedded gitlink (git prints 'adding embedded git repository') and would not commit its 219 MB of content. The handover notes and the .bak file would be committed. Second, pg is not dead weight for tooling: drizzle-kit's bin.cjs:78878 tries `import('pg')` first and falls back to postgres-js at :78949. Removing it is safe, but moving it to devDependencies is the lower-risk change. @types/pg belongs in devDependencies either way.

## AR-REL: Run reliability, data model and test health

I looked at run outcomes, orchestration, the data model and test health. None of the 12 v3 runs created in October completed: 8 ended needs_more_work and 4 have been waiting at the human-review gate for 7 to 12 days. The only run that ever completed was c2822589 on 2026-08-06, so the export stage has not run on a real operating-company run. Transient provider failures are now retried, but the stage failure policy in stages.ts does not hold. Every stage marked skip_and_continue except the last one actually ends the run, because a skipped stage is stored as 'failed' and that blocks the stages that depend on it, and an error thrown by a handler skips the policy entirely. That is why one missing founder-history document stops the whole valuation chain. The data model hides how thin the output is: every forecast artifact of the latest META run is 'validated' even when it is blocked or empty. The reinvestment model has one capex number and no working capital in all 6 Anthropic-direct runs. The operating model holds a single year. The prompt asks for return-on-incremental-capital analysis the schema has no field for. The quality gate checks only that artifacts exist. Test health is mixed. `npm run test:unit` passes: 533 tests, 493 pass, 0 fail, 40 skipped because they need a database, 24 s. The required `npx tsc --noEmit` check fails with 29,125 errors, all in an untracked folder. There is no mock end-to-end test for an operating company. The dev database has drifted: it carries two migrations from an abandoned v4 branch, the pipeline_version column defaults to 4, 5 extra tables exist and 40 runs can never run again. Paid runs also stalled on laptop sleep (26 of the 39 minutes in ai_reviewer on 4fae0fb1) and sometimes ran outside the job queue.

<details><summary>Measurements</summary>

Run outcomes (SELECT on research_runs, research_run_jobs, research_stages). Since 2026-10-01 there were 12 v3 runs: 0 completed, 8 needs_more_work, 4 waiting_for_human (02c8d48b 12 d, 1d427f3f 10 d, 7fa1f00a 10 d, 4fae0fb1 7 d). Across the database, 11 runs wait at gates, the oldest for 95 days. One run has ever completed (2026-08-06), and the exports table has 1 row. Jobs per gate-reaching run: 02c8d48b 9, 1d427f3f 5, 7fa1f00a 1, 4fae0fb1 0 (it ran outside the queue).

Repairs (model_call_logs.response_metadata_json.repair_attempted), as calls with a repair / all calls and the cost of those calls / run total:
- 4fae0fb1: 2/79 calls, $0.034 of $1.045, 14 locally coerced
- 7fa1f00a: 4/56 calls, $0.143 of $0.936
- 1d427f3f: 30/141 calls, $0.752 of $2.076
- 02c8d48b: 41/174 calls, $1.455 of $2.614

4fae0fb1 had 5 failed calls: 1 output_exhausted at 32,768 tokens and 4 inactivity timeouts lasting 1,103 / 1,012 / 1,008 / 574 s, against limits of 90 s inactivity and 720 s total. October provider timeouts: 10 calls, 71 minutes of call time.

Stage timing for 4fae0fb1: 64 minutes from intake to the human gate. ai_reviewer took 39.2 minutes, of which about 26 minutes were stalls with zero database writes.

Migrations: the journal has 13 entries; the dev database has 15 migration rows, the pipeline_version default is 4, and there are 5 tables not in the schema. rr_paidcheck matches the dev database (15 rows, default 4). research_os_test has 10 migrations (default 3). The 3 largest tables are document_chunks 446 MB, research_tasks 87 MB (1,843 rows) and research_artifacts 30 MB.

Thin artifacts: reinvestment_model in the 6 Anthropic-direct runs has 0-1 capex values and 0 working-capital values; reconciliation is blocked_source_gap in 6 of 7 recent runs.

Tests and type check:
- `npx tsc --noEmit`: exit 1, 29,125 errors, all in 'Temp Download/'; 0 errors in project code; 7.0 s.
- `npm run test:unit` (mock provider): 533 tests, 493 pass, 0 fail, 40 skipped (all DB-gated), 24.2 s wall, 132 s user CPU.
- test:db and test:sofi-v3 were not run, as instructed.

Report rendering: in scratchpad meta-run/report.md, 4 table rows (lines 39, 2803, 2809, 2815) render raw JSON, 23,745 characters in total.

</details>

### AR-REL-1: The stage failure policy is not applied: skip_and_continue stages and thrown gate errors end the whole run

Severity **high**, effort **M**, verdict **corrected**

**Problem.** stages.ts marks 12 stages skip_and_continue: source_discovery, source_ingestion, company_genesis, historical_diagnosis, business_process_analysis, moat_analysis, operating_model, operating_scenarios, asset_valuation, decision_synthesis, export and refresh_schedule. In practice every one of them except refresh_schedule ends the run. When retries run out, advanceStage stores the stage as 'failed', not 'skipped'. readyStages only accepts dependencies that are 'completed' or 'skipped', so the stages that depend on it never start. startNextStage then calls failRun with 'Stage X failed and blocks the remaining stages'. Errors that handlers throw for deterministic checks never reach advanceStage. Examples are 'Company genesis blocked by evidence coverage' and contract rejections after a repair. pipeline-runner retries only transient provider errors (the RM2 fix); anything else becomes failRun(needs_more_work). As a result, one optional input stops the whole serial chain from company_genesis through asset_valuation to decision_synthesis. The founder-history document is the clearest case: it matters little for valuation, and the JD example simply names its missing evidence and carries on.

**Evidence.** src/lib/workflow/stages.ts:102,166,198,214,230,262 (failureState skip_and_continue); src/lib/workflow/orchestrator.ts:358-370 (skip_and_continue sets status='failed'); src/lib/research/team-plan.ts:41-60 (STAGE_DEPENDENCIES, readyStages requires completed|skipped); orchestrator.ts:657-664 (failRun 'failed and blocks the remaining stages'); src/lib/research/pipeline-runner.ts:208-234 (non-transient rejection -> failRun needs_more_work); src/lib/research/handlers/company-genesis.ts:52-56 (throws on a missing founder_and_company_history role). DB: SELECT status, failure_reason FROM research_runs WHERE pipeline_version=3 AND created_at>='2026-10-01' -> 0 completed, 4 waiting_for_human, 8 needs_more_work. Failure classes: 2 provider quota or availability (d6f3fbee: 429 Go 5-hour limit; 11965a65: 400 model unavailable); 3 contract rejection after repair (dd02bb41 founder motivation, 52fc33ee no JSON, 66637bdb evidence_claims 0<5); 1 coverage gate (50d91067 founder_and_company_history); 1 valuation anchors (d6236111); 1 NUL persistence bug (15158c84, since fixed in ab647c07). Runs 8cbf3524, dd02bb41 and 50d91067 (3 of 16 v3 runs since 2026-09-01) ended on founder or company-history coverage. 8cbf3524's reason reads 'Stage "source_discovery" failed and blocks the remaining stages: Failed after 3 retries: Required source role founder_and_company_history ...'. Runs that did reach the gate needed several manual re-queues: SELECT count(*) FROM research_run_jobs GROUP BY research_run_id -> 02c8d48b 9 jobs, 1d427f3f 5 jobs.

**Recommendation.** Do it in two steps. Step 1 (S), the cheapest fix with the most effect: honour blockedArtifacts for founder_and_company_history. Make source_discovery record the uncovered role as a source_gap without failing validation (role-coverage.ts:206 / source-discovery.ts:79). In company-genesis.ts:52-56, replace the throw with a gap and have the agent mark founder fields unknown. Let genesis/validation.ts:39 accept an unknown motivation when such a gap is recorded. Step 2 (M): in orchestrator.ts:358-370, write status 'skipped' (which readyStages and validators.ts:637 already accept) with validation_result_json.degraded=true and a source_gaps row. Add a typed StageCoverageGap error that the company_genesis, historical_diagnosis, business_process_analysis and moat_analysis handlers raise, and route it to the same branch. Switch stages that cannot degrade, such as source_discovery with no primary filings, to fail_run so the stages.ts table and docs/architecture.md:43-56 are truthful. addV3ArtifactCoverage then lists each degraded stage's artifacts as missingCoverage with requiredForCompletion=false and caps readiness at review_ready. Verify with a DB-backed mock test that removes the founder_and_company_history role assignment: the run should reach human_review with a company_genesis gap, not end at needs_more_work. Also add a unit test for the skip_and_continue branch.

**Verifier check.** Holds on main (cfcbdbfa). stages.ts marks 12 stages skip_and_continue. In the skip_and_continue branch, orchestrator.ts:358-370 writes status='failed'. readyStages (team-plan.ts:57-61) only accepts dependencies that are completed or skipped, and startNextStage then calls failRun 'failed and blocks the remaining stages' (orchestrator.ts:657-664). Only refresh_schedule has no dependents. Handler throws such as company-genesis.ts:52-56 skip advanceStage and reach failRun(needs_more_work) at pipeline-runner.ts:226-230; only transient errors are retried (retryTransientFailures:92-112). This contradicts the spec: docs/research-os-v3-spec.md:78 says skip_and_continue stages 'do not block downstream stages'. grep finds no test for the branch. Corrected facts: 4 of 15 v3 runs since 2026-09-01 ended on founder-history coverage, not 3 of 16. They are 9af5c76c and 8cbf3524 (source_discovery 'Required source role founder_and_company_history is not covered'), dd02bb41 (genesis validator 'Founder motivation is entirely unknown') and 50d91067 (company_genesis throw). 02c8d48b had 10 jobs, not 9. The October failure classes are as stated: 12 runs, 8 needs_more_work and 4 waiting_for_human. Extra evidence: archetypes/registry.ts:18 declares founder_and_company_history with blockedArtifacts ['company_genesis','strategic_dna'], so the data model already says this gap should block two artifacts, not the run.

### AR-REL-2: 'validated' does not mean complete: forecast contracts accept single-year, empty or blocked models, and the gate only checks that artifacts exist

Severity **high**, effort **M**, verdict **corrected**, JD trait: Cash-conversion and working-capital diagnosis (JD sections 5 and 12: inventory and receivable days, modeled normalized FCF 2026-2031 per scenario); no-rerating return (section 16); per-area confidence and completeness gates (section 20)

**Problem.** An artifact that passes zod is stored as 'validated' and counts as present for the quality gate, however little it holds. OperatingModel stores one revenue and operating-income number per segment, for a single forecast year. ReinvestmentModel takes capex_forecast and working_capital_forecast as unbounded arrays, so one number and an empty array are accepted. The TopDownBottomUp validator only checks against TAM when tam_limit is not null, so a 'blocked_source_gap' reconciliation passes. The operating-model prompt asks the model to 'Tie reinvestment to growth: compare incremental operating income with incremental invested capital' and to label units and horizon in 'optional explanatory fields'. The schema has no such fields. Anthropic structured output (PR #46) enforces that schema, so the analysis is never generated. The valuation then uses change_in_net_working_capital = 0 in every year. This is a direct structural cause of the shallow output: the JD example's cash-conversion and working-capital diagnosis and its 2026-2031 FCF per scenario have nowhere to live in this data model.

**Evidence.** src/lib/research/forecast/contracts.ts:70-100 (SegmentForecast is a single value; ReinvestmentModel z.array(z.number()) with no min or length); src/lib/research/forecast/validation.ts:109-127; src/lib/workflow/quality-gates.ts:446-461 (addV3ArtifactCoverage only checks status IN validated/accepted); src/lib/research/handlers/operating-model.ts:122-131 (prompt rules with no matching schema fields). DB, run 4fae0fb1: every artifact is status 'validated', including reinvestment_model {capex_forecast:[137500000000], working_capital_forecast:[]}, top_down_bottom_up_reconciliation {reconciliation_status:'blocked_source_gap', top_down_forecast_total:null}, operating_model (424 bytes, one value per segment), expected_return_matrix.no_rerating_return null, confidence_assessment moat 0.25, history 0.3, valuation 0.3, quality_score 0.45, review_verdict 'conditional_pass'. The valuation_scenario_set has change_in_net_working_capital 0 in FY2026-FY2028 for all cases. Across runs, SELECT jsonb_array_length(content_json->'capex_forecast'), jsonb_array_length(content_json->'working_capital_forecast') FROM research_artifacts WHERE artifact_type='reinvestment_model' AND status='validated' -> 4fae0fb1, 7fa1f00a, d6236111, 02c8d48b: 1/0; 1d427f3f: 0/0. Older runs had dca55615 5/5 and 77eef6e2 3/3. Reconciliation is blocked_source_gap in all 6 recent runs. The operating_model call's raw excerpt contains no 'incremental' text (position()=0).

**Recommendation.** (1) Make working capital real where the engine actually computes it. Add working-capital columns to financial-inputs.ts COLUMNS: us_gaap_IncreaseDecreaseInOperatingCapital, or AccountsReceivableNetCurrent, InventoryNet and AccountsPayableCurrent. Compute an nwc_to_revenue_change history ratio in historyRatios (engine.ts:53) and use it as the fallback at engine.ts:123. When both the driver and the history are null, push a source gap into valuation_scenario_set.source_gaps instead of silently using 0. Expose receivable, inventory and payable days to historical_diagnosis (JD sections 5 and 12). (2) Fix ReinvestmentModel: either drop it from OPERATING_MODEL_CONTRACT, or require per-year arrays with .length(forecastHorizon) and read capex from it. Do not add a parallel per-year OperatingModel, because yearly_drivers already holds the path. (3) Either add roiic_history, roiic_forecast and units to the OperatingModel schema, or delete the prompt rules at operating-model.ts:124,128 that structured output cannot carry. (4) Add a pure completeness() function (complete, partial or blocked) per artifact type and store its result in validation_result_json, which needs no migration. Cases: blocked_source_gap gives blocked; a null judgment key or all-zero NWC years gives partial. addV3ArtifactCoverage lists partial and blocked artifacts as non-blocking missingCoverage, and the report gets a short completeness table. (5) Consider defaulting RESEARCH_FORECAST_YEARS to 5. Verify: the gate over 4fae0fb1 lists reinvestment_model, top_down_bottom_up_reconciliation and expected_return_matrix as partial or blocked, and a unit test shows that a null NWC driver with history produces a non-zero ΔNWC, or a recorded gap when history is missing.

**Verifier check.** These facts hold. For 4fae0fb1, every artifact is 'validated'. reinvestment_model is {capex_forecast:[137500000000], working_capital_forecast:[]}. The reconciliation is blocked_source_gap with null totals, operating_model is 424 bytes, and no_rerating_return is null. Confidence is moat 0.25, history 0.3, valuation 0.3; quality_score is 0.45 with verdict conditional_pass. Across runs, capex/NWC array lengths are 3/3, 3/3 and 5/5 for the opencode runs, against 1/0, 1/0, 0/0, 1/0 and 1/0 for the 5 anthropic-direct runs (5 runs, not 6). The reconciliation is blocked in 6 of 7. addV3ArtifactCoverage (quality-gates.ts:446-461) checks presence only. The operating-model prompt asks for ROIIC and 'optional explanatory fields' (operating-model.ts:124,128) that the schema lacks, and anthropic-schema.ts:82 forces additionalProperties:false. The raw excerpt contains neither 'incremental' nor 'roic'. The causal chain is partly wrong, though. (a) The multi-year forecast does exist: operating_scenario_set.yearly_drivers holds 3 years per scenario, valuation_scenario_set.method_inputs[].years holds per-year FCFF builds, and operating_model is a single year by design because it pins the base year. So 'per-scenario FCF has nowhere to live' is false; the horizon is just RESEARCH_FORECAST_YEARS, default 3 (engine.ts:356), against JD's 2026-2031. (b) NWC=0 does not come from ReinvestmentModel. The engine never reads reinvestment_model. ΔNWC = (driver.nwc_to_revenue_change ?? 0) × Δrevenue (engine.ts:123), every 4fae0fb1 yearly driver has nwc_to_revenue_change null, StatementRatios has no NWC history ratio (engine.ts:20), and financial-inputs.ts:11-29 has no receivable, inventory, payable or operating-capital column. The zero is silent: valuation source_gaps does not mention it.

### AR-REL-3: No operating-company end-to-end test, and export has never run on a real operating-company run

Severity **medium**, effort **M**, verdict **confirmed**

**Problem.** Every real run since 2026-10-06 is META, an operating company valued with FCFF. The only full DB-backed end-to-end test runs SOFI, composed as bank plus lender and valued with FCFE. The lifecycle DB tests use the 'financials' profile. So the operating-company path through asset_valuation, decision_synthesis, ai_reviewer, approval, export and refresh has no automated coverage. The 2026-10-11 handover recorded this gap ('The mock operating-company pipeline stops at historical_record') and nothing has closed it. Only one run has ever completed (2026-08-06), and the exports table holds one row. Defects in the FCFF path therefore surface only in paid runs, by eye. The 14 PRs (#61-#74) merged on 2026-10-15/16 have not been followed by a real run on any local database: the newest run is a845ff09 on 2026-10-14 in rr_paidcheck.

**Evidence.** tests/sofi-research-e2e.test.ts:270 (composed_archetypes ['bank','lender']), :484-521 (export assertions exist only for SOFI); tests/run-lifecycle-db.test.ts:57 (profile 'financials'); grep -rln operating_company_core tests -> only unit-level files (evidence-depth, research-v3-contracts, backtesting-persistence-integration). 'handover files/2026-10-11-deterministic-pipeline-handover.md' Known issues: 'The operating-company FCFF path has no mock e2e coverage.' DB: SELECT status, count(*) FROM research_runs WHERE status='completed' -> 1 (c2822589, 2026-08-06, opencode); exports: 1 row; 11 runs at waiting_for_human (oldest 95 days). SELECT max(created_at) FROM research_runs in research_os and rr_paidcheck -> 2026-10-13 and 2026-10-14; the last merges are 2026-10-15/16 (git log --merges).

**Recommendation.** Add tests/operating-company-e2e.test.ts, modelled on sofi-research-e2e and run by test:db with the mock provider. Seed an operating_company_core asset with two segments and drive it through the queue: plan approval, asset_valuation (FCFF from yearly_drivers), decision_synthesis, ai_reviewer, approveHumanReview, export and refresh_schedule. Assert: the run is completed; the valuation's years equal forecastHorizon(); no report table cell starts with '{' or '[{'; report_document stays under a size bound (see the missed table-size item); the export completes. It works when test:db passes with it and a deliberately broken FCFF contract makes it fail.

**Verifier check.** sofi-research-e2e.test.ts:270 asserts composed_archetypes ['bank','lender'], and the export assertions at 484-521 exist only there. run-lifecycle-db.test.ts:57 uses the 'financials' profile. operating_company_core appears only in evidence-depth, research-v3-contracts and backtesting-persistence-integration. The 2026-10-11 deterministic-pipeline handover, line 34, records 'The operating-company FCFF path has no mock e2e coverage'. The DB has exactly 1 completed run (c2822589, 2026-08-06, opencode) and 1 exports row. The latest runs are 2026-10-13 (research_os) and 2026-10-14 (rr_paidcheck), while PRs #61-#74 merged on 2026-10-15/16, and research_os_test has 0 runs. The mock provider already serves valuation_assumptions for operating companies (mock.ts:614-626), and processNextResearchRunJob({runId}) exists for in-test queue driving.

### AR-REL-4: Report tables print nested objects as raw JSON, so the four FCFF bridge tables are unreadable

Severity **medium**, effort **S**, verdict **confirmed**, JD trait: Valuation shown as a readable operating-case x valuation-assumption DCF matrix (JD section 13)

**Problem.** The valuation chapter headings in the META report that look empty actually contain one-row tables whose cells are serialized JSON. The section writer chose table path 'method_schedules.N', which is an object holding a nested years array. tableMarkdown turns every object cell into JSON.stringify. Neither the section contract nor the report builder rejects a table path that does not resolve to an array of flat rows. The only end-to-end guard checks for the string '[object Object]'. The most important tables in the report, the per-case FCFF build and present-value bridge, are the ones that cannot be read.

**Evidence.** src/lib/research/reporting/report.ts:52 (cell(): typeof value === 'object' ? JSON.stringify(value)), :53-61 (tableMarkdown wraps a single object as one row). DB: SELECT t->>'title', t->>'path' FROM research_artifacts a, jsonb_array_elements(a.content_json->'tables') t WHERE research_run_id='4fae0fb1...' AND artifact_type='report_section' -> 'Bear/Base/Bull case FCFF build and present-value bridge' | method_schedules.0/.1/.2. scratchpad meta-run/report.md lines 39, 2803, 2809 and 2815 are cells that start with \[{"build":{"starting_profit":..., 23,745 characters of raw JSON in total. tests/sofi-research-e2e.test.ts:504 only asserts !report.includes('[object Object]').

**Recommendation.** In resolveTable or createReport, reject a table path whose value is not an array of rows with primitive or one-level-nested values. Name the nearest array child in the error (e.g. 'use method_schedules.1.years') so the existing repair pass can fix it. In tableMarkdown, flatten one nesting level (build.capital_expenditures becomes a column) and render anything deeper as 'see source artifact' instead of JSON. Add a unit test that renders the 4fae0fb1 report_section tables and asserts that no cell matches /^\\?\[?\{"/. Fix this together with the missed row and column bound below, since they share the code path.

**Verifier check.** report.ts:52 cell() JSON.stringifies any object, and tableMarkdown (53-62) wraps a non-array as a single row. resolveTable (tables.ts:4-17) only checks that the path exists, not its shape. In the DB, the 4fae0fb1 report_section tables 'Bear/Base/Bull case FCFF build and present-value bridge' use paths method_schedules.0/.1/.2. In scratchpad report.md, lines 39, 2803, 2809 and 2815 start with '\[{"build":{"starting_profit"...', 23,727 characters in total, which matches the reported figure. The only e2e guard is !report.includes('[object Object]') at sofi-research-e2e.test.ts:504.

### AR-REL-5: The dev database has drifted from main: two v4-branch migrations, pipeline_version default 4, extra tables, 40 runs that can never run, and a stale test database

Severity **low**, effort **S**, verdict **corrected**

**Problem.** The dev database was migrated by the abandoned 'research harness v4' branch. drizzle.__drizzle_migrations has 15 rows, but drizzle/meta/_journal.json has 13 entries. The extra two (created_at 1786108800000 and 1786406400000) are 0007_harness_integrity_v4 and 0008_opencode_harness_backend, which exist only in commits 2e2b8072 and 8060ee7d. They set research_runs.pipeline_version DEFAULT 4, while the schema and CURRENT_PIPELINE_VERSION are 3. They added cost_source columns and 5 tables that main's schema doesn't define. 34 v4 runs and 6 v2 runs are rejected by every code path. 5 of them sit at waiting_for_human (62-95 days) and 6 at 'pending', and the review queue hides them. Any insert that leaves out pipeline_version would create a run that cannot execute. The kept test database research_os_test has only 10 migrations and lacks 0012-0014 (budget_reservation_usd, search_tsv), so test:db against it would fail in confusing ways, and scripts/test-db.cjs never checks migration state. docs/system.md still says 'migrations 0000–0006 and 0009–0012', and nothing documents that 0007/0008 were withdrawn.

**Evidence.** SELECT id, created_at FROM drizzle.__drizzle_migrations -> 15 rows; drizzle/meta/_journal.json -> 13 entries (no 0007/0008); git log --all -- 'drizzle/0007*' 'drizzle/0008*' -> 2e2b8072, 8060ee7d; git show 2e2b8072:drizzle/0007_harness_integrity_v4.sql -> 'ALTER COLUMN "pipeline_version" SET DEFAULT 4'. SELECT column_default FROM information_schema.columns WHERE table_name='research_runs' AND column_name='pipeline_version' -> 4 (research_os and rr_paidcheck), 3 (research_os_test). src/db/schema/workflow.ts:34 default(3); src/lib/research/version.ts:7. A table diff of pg_tables against the pgTable() names in src/db/schema shows agent_sessions (247 rows), agent_session_messages (771 rows, 10 MB), agent_session_events, agent_permission_requests and model_budget_reservations (746 rows) in the database only. SELECT pipeline_version, status, count(*) FROM research_runs -> v2: 5 needs_more_work, 1 waiting; v4: 8 failed, 16 needs_more_work, 6 pending, 4 waiting. research_os_test: 10 migrations, last 1791676800000 (0011). docs/system.md:19.

**Recommendation.** (1) In scripts/test-db.cjs, before spawning the suites, compare drizzle/meta/_journal.json (each entry's 'when', plus a hash if cheap) with drizzle.__drizzle_migrations. Refuse on a missing or extra row with 'run npm run db:migrate on <db>'. This catches the stale research_os_test. (2) Optionally ship migration 0015 'ALTER TABLE research_runs ALTER COLUMN pipeline_version SET DEFAULT 3'. It is a no-op on fresh databases and repairs the drifted ones. (3) With the user's approval and after a pg_dump, archive or cancel the v2/v4 rows and drop the v4-only tables. This extends previously deferred M10. (4) Correct docs/system.md:19 to '0000–0006 and 0009–0014' and note that 0007/0008 belong to the abandoned v4 branch. Done when the check passes on research_os and research_os_test.

**Verifier check.** The drift is real. research_os and rr_paidcheck each have 15 __drizzle_migrations rows and a pipeline_version default of 4. The journal has 13 entries. The extra rows have created_at 1786108800000 and 1786406400000, which are 0007/0008 from commits 2e2b8072 and 8060ee7d; 2e2b8072:drizzle/0007_harness_integrity_v4.sql line 1 sets DEFAULT 4. research_os_test has 10 migrations (through 0011) and default 3. The five tables exist only in the DB and are referenced nowhere in src or scripts. Version counts: v4 has 8 failed, 16 needs_more_work, 6 pending and 4 waiting; v2 has 5 needs_more_work and 1 waiting. docs/system.md:19 says '0009–0012' while 0013 and 0014 exist. Two corrections. (a) The default-4 risk is latent: every research_runs INSERT in src, scripts and tests sets pipeline_version explicitly. (b) The unmanaged tables are already known: prior audit M10, and docs/operations.md:59 documents agent_sessions, agent_session_messages and model_budget_reservations. Drizzle applies migrations by created_at, so the drift does not block future migrations. Impact is mainly confusion and a stale test DB, so low rather than medium.

### AR-REL-6: Laptop sleep stalls paid runs: calls hang for 9-18 minutes and time out on wake

Severity **low**, effort **S**, verdict **corrected**

**Problem.** Paid runs execute on a MacBook. When the host sleeps, the process is suspended, setTimeout-based deadlines stop counting, and in-flight model calls hang until wake. They then fail as 'inactivity' and are retried. In 4fae0fb1, three parallel report_section calls started at 15:02:44, 15:04:15 and 15:04:19 and all ended at 15:21:07, after 1,103, 1,012 and 1,008 s. The configured limits are 90 s inactivity and 720 s total. Nothing was written to the database in between. A second 574 s stall followed. About 26 of ai_reviewer's 39.2 minutes were lost this way. On 2026-10-14 the power log shows the Mac entering 'Low Power Sleep' at 20:17:50 and waking at 20:27:09; run a845ff09's asset-analyst call failed at 20:27:13 after 560 s. When this happens under the worker, a sleep longer than 5 minutes also expires the job lease, which costs a requeue.

**Evidence.** model_call_logs for 4fae0fb1 where error_category='provider_timeout': export-writer, latency 1102991/1011943/1008187 ms all at 15:21:07 (+08), 574290 ms at 15:33:23, timeout_type inactivity. .env.local: RESEARCH_INACTIVITY_TIMEOUT_MS=90000, RESEARCH_AGENT_TIMEOUT_MS=720000. Zero rows in research_tasks, model_call_logs, research_artifacts, research_stages and model_budget_reservations updated between 07:04:30 and 07:21:00 UTC and between 07:24:00 and 07:33:20 UTC. By contrast, 02c8d48b's six inactivity timeouts lasted 91-107 s, i.e. genuine. rr_paidcheck a845ff09: asset-analyst inactivity at 20:27:13 after 560 s. `pmset -g log`: '2026-10-14 20:17:50 Entering Sleep state due to Low Power Sleep ... (Charge:1%)', '20:27:09 Wake from Hibernate'. src/lib/agent-harness/deadlines.ts:31-39 (setTimeout timers); src/lib/research/run-queue.ts:7 (5-minute lease).

**Recommendation.** Detect first, then mitigate. In deadlines.ts, when the inactivity or total timer fires, compare Date.now() with the time it was scheduled to fire. If it is more than 30 s late, abort with a distinct 'host_suspended' reason, classified as transient, and do not count that attempt toward agent attempts. In the worker heartbeat interval (research-worker.ts:165), log 'host suspended ~N s' and record it in research_worker_heartbeats.metadata_json. Then document in docs/local-development.md that paid runs should run on AC with `caffeinate -s` (or -i) and the lid open, and add an npm alias. Done when a simulated clock jump in a unit test yields host_suspended instead of inactivity, and the next stall can be attributed from the DB.

**Verifier check.** The DB evidence holds. In 4fae0fb1, three export-writer calls that started at 07:02:44, 07:04:15 and 07:04:19 UTC all failed at 07:21:07.35-.36, within 13 ms of each other, with latencies of 1,102,991, 1,011,943 and 1,008,187 ms. A fourth call failed at 574,290 ms. ai_reviewer ran 39.2 min (15:01:05-15:40:16 +08). Timers are setTimeout-based (deadlines.ts:31-39), the lease is 5 min (run-queue.ts:7), and the failed calls cost $0.076. pmset confirms 'Low Power Sleep ... Using AC (Charge:1%)' at 2026-10-14 20:17:50 and 'Wake from Hibernate' at 20:27:09, and the rr_paidcheck a845ff09 asset-analyst call failed at 20:27:13 after 559,575 ms. Corrections. (a) The pmset log starts on 2026-10-14 at 15:31, so the 10-13 stall is inferred from the simultaneous completions, which is consistent with suspension but not proven. (b) `caffeinate -i` only prevents idle sleep. It does not prevent clamshell sleep on battery, which the log shows at 16:56 and 17:09 on 10-14, or the 1%-battery Low Power Sleep that caused the 10-14 failure. So the proposed main fix would not have prevented the one sleep we can prove. (c) Both runs still reached the gate, and the transient retry recovered, so the impact is wall time plus a small retry cost. Low, not medium.

### AR-REL-7: Paid runs started from scripts skip the job queue, so they have no lease, cannot be cancelled and are not reconciled

Severity **low**, effort **S**, verdict **confirmed**

**Problem.** AGENTS.md says runs execute only through research_run_jobs. scripts/new-equity-run.ts, the paid-run entry point, calls runSystemResearchPipeline(runId) directly with no AbortSignal. Such a run has no job row, no lease renewal and no heartbeat. cancelRun cannot stop it, because cancellation works by closing the active job. If the script dies, reconcileOrphanedResearchRuns ignores the run because it only requeues runs that already had a job, so the run stays 'running' forever. Ctrl-C also kills in-flight calls without recording them. The latest paid run, 4fae0fb1 ($1.05), has no job rows at all. Separately, scripts/resume-research-run.ts sets RESEARCH_MODEL_PROVIDER only in its own process, while the worker's environment decides the provider. The run's metadata acceptance_provider is never used for that, so the provider used on a resume is whatever the worker was started with.

**Evidence.** scripts/new-equity-run.ts:131,143 (runSystemResearchPipeline(runId) called directly, no signal); src/lib/research/run-queue.ts:293-302 (reconcile requires EXISTS a pipeline job); src/lib/workflow/orchestrator.ts:933-936 (cancel closes the active job); scripts/resume-research-run.ts:21-24; src/lib/agent-harness/providers/provider.ts:13 (provider from process.env only); grep acceptance_provider src -> only quality-gates.ts:785. DB: SELECT acceptance_provider, count(*), count(*) FILTER (WHERE NOT EXISTS job) FROM research_runs WHERE pipeline_version=3 AND created_at>='2026-09-01' -> anthropic-direct 7 runs, 1 without a job ($1.05, 4fae0fb1); opencode 8 runs, 2 without a job (9af5c76c, 8cbf3524).

**Recommendation.** In new-equity-run.ts and new-meli-run.ts, keep the setup, then call enqueueResearchRun(runId, 'cli') and loop processNextResearchRunJob({ runId, signal }) (research-worker.ts:77) in-process, with SIGINT wired to an AbortController, as sofi-research-e2e already does. In resume-research-run.ts, warn or refuse when the requested provider differs from the run's metadata.acceptance_provider. Verify: after a mock script run, research_run_jobs has at least 1 row; Ctrl-C leaves the job requeueable; POST /cancel stops a script-driven run at the next lease renewal.

**Verifier check.** scripts/new-equity-run.ts:127,138 and new-meli-run.ts:61,75 call runSystemResearchPipeline, which is a re-export of runResearchPipeline (system-pipeline.ts:1), directly with no signal. The reviewer's line numbers 131/143 are slightly off. The reconcile path requires an existing pipeline job (run-queue.ts:292). cancelRun works by closing the active job (orchestrator.ts:933-945). resume-research-run.ts:23-24 sets RESEARCH_MODEL_PROVIDER only in its own process and then only enqueues, so the worker's environment picks the provider (provider.ts:13). acceptance_provider is read only at quality-gates.ts:785. 4fae0fb1 has 0 job rows, and 9af5c76c and 8cbf3524 also have 0. The advisory lock still prevents concurrent execution, so the impact is lost cancellation, lease and reconciliation, not double runs. No v3 run is currently stuck in 'running'.

### AR-REL-8: The required `npx tsc --noEmit` check fails in the main checkout because tsconfig includes untracked folders

Severity **low**, effort **S**, verdict **corrected**

**Problem.** One of the four required merge checks fails in the main working copy. Every error comes from the untracked 'Temp Download/' folder, a 219 MB opencode clone. tsconfig.json includes **/*.ts and excludes only node_modules, so it also compiles the agent worktrees under .claude/worktrees/ and the research-store/ worktree inside the repo. ESLint already ignores these folders. The check passes or fails depending on what happens to be in the folder, which wastes time and can make a clean change look broken. The unit suite itself is healthy.

**Evidence.** npx tsc --noEmit -> exit 1, 29,125 'error TS' lines; grep -v '^Temp Download/' -> 0 errors in project code; 7.0 s wall. tsconfig.json:31-40 (include **/*.ts, exclude only node_modules); eslint.config.mjs:6-19 ignores .claude/**, prototype/** and others; `git worktree list` shows .claude/worktrees/valuation-inputs-cd02ef and research-store inside the repo; du -sh 'Temp Download' -> 219M. npm run test:unit (RESEARCH_MODEL_PROVIDER=mock, no paid flags): 533 tests, 493 pass, 0 fail, 40 skipped (all RUN_DB_INTEGRATION-gated), 24.2 s wall, 132 s CPU.

**Recommendation.** Add "Temp Download" to tsconfig.json exclude, or move that clone outside the repo, which the user should decide. Optionally also exclude prototype and storage to match the eslint.config.mjs ignores. Done when `npx tsc --noEmit` exits 0 in the main checkout and `tsc --listFilesOnly` lists no Temp Download files.

**Verifier check.** Reproduced with `npx tsc --noEmit --incremental false`: exit 2, 29,122 'error TS' lines, all under 'Temp Download/', 0 in project code. tsconfig.json:31-40 includes **/*.ts and excludes only node_modules. Correction: `tsc --listFilesOnly` shows the program contains Temp Download (3,340 files), src (277), tests (99), Implementations (62), .next (17) and scripts (16). It does not contain .claude/worktrees (TypeScript wildcards skip dot-directories) or research-store. So the only offender is the untracked 219 MB 'Temp Download' clone. PRs pass because they are checked in worktrees where that untracked folder doesn't exist. Not verified: whether `npm run build`'s type check in the main checkout fails the same way.

### AR-REL-9: Legacy v1/v2 code and mirror tables are still maintained, and the export API reads the mirrors instead of the typed artifacts

Severity **low**, effort **M**, verdict **confirmed**

**Problem.** AGENTS.md makes typed research_artifacts the report's source of truth. Yet decision_synthesis and asset_valuation still copy the thesis, risks, catalysts, scenarios and valuation_signals into legacy relational tables. The export API's memo and research-package generators read those tables, not the typed artifacts, so the two can disagree; the earlier RO2 stale-thesis bug was of this kind. Every quality-gate evaluation still imports v2-contracts and loads analysis_sections and valuation_model_runs. No code writes analysis_sections any more (last row 2026-07-18), and only v3 runs can execute. 17 tables in the database have zero rows.

**Evidence.** src/lib/research/handlers/decision-synthesis.ts:38,45,64 (INSERT INTO theses/risks/catalysts); src/lib/export/memo-generator.ts:29,41,48 and src/lib/export/research-package-generator.ts:230-263 (SELECT FROM theses/risks/catalysts/valuation_signals/scenarios), called from src/app/api/research-runs/[id]/export/route.ts:2-3; src/lib/workflow/quality-gates.ts:3 (v2-contracts import), :309-313 (v2 branch), :403-404 (loads analysis_sections, valuation_model_runs); grep 'INSERT INTO analysis_sections' src -> none. DB: theses 26 rows (latest 2026-10-13), risks 234, catalysts 154, scenarios 80, valuation_signals 83 (all still written); analysis_sections 190 rows, latest 2026-07-18; pg_stat_user_tables shows 17 tables with n_live_tup=0 (research_assumptions, valuation_artifacts, notebooks, note_blocks, stage_validation_results, task_dependencies, ...).

**Recommendation.** Point memo-generator and research-package-generator at the typed artifacts (investment_thesis, risk_register, catalyst_register, valuation_scenario_set) through src/lib/research/artifacts/read-model.ts. Then remove the mirror writes in decision-synthesis and asset-valuation, and remove the v2 branch and the analysis_sections and valuation_model_runs loads from quality-gates. Leave the tables in place, because dropping them needs a migration and the user's approval. Done when the export e2e (SOFI plus the operating-company test from AR-REL-3) passes with the mirror tables empty for the run, and grep finds no INSERT INTO theses, risks or catalysts in src.

**Verifier check.** decision-synthesis.ts:34-64 still updates or inserts theses and deletes and rewrites risks and catalysts. RO2 is fixed: persistDecisionRows now replaces rows inside one sql.begin, so drift between attempts is gone, but there are still two sources of truth. memo-generator.ts:29,41,48 and research-package-generator.ts:230-263 read theses, risks, catalysts, valuation_signals and scenarios, and the export route (export/route.ts:2-3) calls them. quality-gates.ts:3 imports v2-contracts, has a v2 branch at 309-313, and loads analysis_sections and valuation_model_runs at 403-404. Nothing in src inserts into analysis_sections (last row 2026-07-18). theses and risks were last written 2026-10-13. pg_stat_user_tables shows 22 tables with n_live_tup=0; the estimate has moved from the reviewer's 17. Note that persistDecisionRows falls back to the literal 'Thesis statement' when the field mapping misses, which the memo would print.

## AR-QOL: Operator and developer quality of life, code health

For a single operator, the main costs are friction and blind spots around the pipeline, not the pipeline itself. Two of the four required merge checks fail in the main checkout because of untracked third-party trees: tsc reports 29,122 errors, all in "Temp Download/", and eslint exits 1 with 3,505 errors from "Temp Download/" and ".cache/". Project code alone is clean, and the checks take 10 s instead of 37 s and 9 s instead of 157 s. The UI cannot resume a failed run, re-run one stage, show which provider or model the worker will use, estimate cost before a run, alert anyone when a run waits at a gate, or compare runs. The dev DB shows the result: 66 runs, 1 completed, 11 waiting at gates (the oldest since July), 4 near-identical META runs at review whose base anchors range from $529 to $631 plus one withheld, and 37 pipeline failures labelled "needs more work", the same word as the reviewer verdict. The cheapest lever for depth is a deterministic valuation what-if and sensitivity tool. The FCFF engine is already pure and its inputs are stored, yet changing one discount rate today costs a paid re-run of asset_valuation, decision_synthesis and ai_reviewer (about $0.76 and 42 minutes on run 4fae0fb1). The remaining code-health items are low severity: about 2,000 lines of legacy v2 export code, 24 of 53 API routes with no caller, fixtures and hardcoded company facts in corpus.ts, and root clutter.

<details><summary>Measurements</summary>

Checks (read-only; no repo writes): `npx tsc --noEmit --incremental false` exit 2, 29,122 errors, all in "Temp Download/", 37.1 s. `npx tsc --showConfig` lists 3,737 files, 3,263 of them in "Temp Download/". The same tsc limited to src/tests/scripts through a scratch tsconfig: 0 errors, 10.7 s. `npx eslint . -f json`: exit 1, 157 s, 6,695 files; errors come from "Temp Download/" (3,301 files, 1,861 errors) and ".cache/" (2,994 files, 1,644 errors). `npx eslint src tests scripts *.ts *.mjs`: 399 files, 0 errors, 120 warnings, 9.2 s.

DB queries (SELECT only): runs by status are needs_more_work 37, failed 11, waiting_for_human 11, pending 6, completed 1. By pipeline_version: v2 6, v3 26, v4 34. The research_runs.pipeline_version column default is 4. drizzle.__drizzle_migrations has 15 rows against 13 journal entries. There is 1 exports row (2026-08-06). model_budget_limits has 0 rows.

META runs waiting at review: 4fae0fb1 $1.05, 79 calls, 64 min; 7fa1f00a $0.94, 56 calls, 27 min; 1d427f3f $2.08, 141 calls, 196 min; 02c8d48b $2.61, 174 calls, 210 min. Their base anchors are 528.7, 631.0, withheld and 563.5 (in that order).

Per-stage rollup for 4fae0fb1 (model_call_logs.stage_id joined to research_stages): ai_reviewer $0.613, 26 calls, 2,351 s wall; evidence_extraction $0.098, 244 s; moat_analysis $0.013 from 1 call; operating_model $0.018 from 1 call.

Env vars: 65 real RESEARCH_* variables are read in src (regex over src, excluding 2 error-code constants); 59 are documented in docs/*.md, .env.example or AGENTS.md, 6 are not. .env.local sets 33 variables, 30 of them RESEARCH_*.

API routes: 24 of 53 route files have no caller in src/app pages, src/components, src/lib or scripts (grep per route path); 8 of them are mutating.

Sizes: Temp Download 219 MB, .cache 177 MB, .claude/worktrees/valuation-inputs-cd02ef 882 MB, research-store checkout 2.3 GB. `git rev-list --disk-usage`: main 14 MB, research-store branch 279 MB, all refs 293 MB. Local branches: 26, 25 of them merged into main.

</details>

### AR-QOL-1: Required lint and tsc checks fail in the main checkout because of untracked third-party trees

Severity **high**, effort **S**, verdict **corrected**

**Problem.** AGENTS.md says all four checks must pass before a merge, but two of them fail in the main checkout for reasons unrelated to project code. tsconfig includes **/*.ts with only node_modules excluded. The ESLint flat config does not read .gitignore and does not ignore 'Temp Download/' or '.cache/'. Both commands therefore scan an untracked copy of another monorepo (an opencode/sst checkout). Checks only pass in clean worktrees, so the developer either works around the failures or stops trusting them, and each run is 4x to 17x slower than it needs to be.

**Evidence.** `npx tsc --noEmit --incremental false`: exit 2, 29,122 'error TS' lines, every one under 'Temp Download/' (for example 'Temp Download/sst.config.ts(37,9): error TS2304'). `tsc --showConfig` lists 3,737 files, 3,263 of them in 'Temp Download/'. Limited to src/tests/scripts through a scratch tsconfig: 0 errors, 10.7 s instead of 37 s. `npx eslint . -f json`: exit 1, 157 s, 6,695 files, with 1,861 errors in 'Temp Download/' (3,301 files) and 1,644 in '.cache/upstream/opencode' (2,994 files); src/tests/scripts have 0 errors. `npx eslint src tests scripts *.ts *.mjs`: 399 files, 0 errors, 9.2 s. tsconfig.json:30-37 (include **/*.ts, exclude only node_modules). eslint.config.mjs:6-19 ignore list has no 'Temp Download/**' or '.cache/**'. .gitignore lists .cache/ but not 'Temp Download/'. 'Temp Download/' is 219 MB and dates from Aug 11.

**Recommendation.** Ask the user before moving 'Temp Download/' and '.cache/upstream/' out of the repo, since they are the user's files. Whatever they decide, harden the configs. In tsconfig.json, either add "Temp Download" to exclude, or narrow include to next-env.d.ts, src/**/*, tests/**/*, scripts/**/*, Implementations/**/*, *.ts and the two .next types globs, so Implementations stays covered or is dropped on purpose. In eslint.config.mjs, add '.cache/**', 'Temp Download/**', 'research-store/**' and 'output/**' to ignores. Add 'Temp Download/' to .gitignore. Verify in the main checkout that `npx tsc --noEmit` exits 0 in about 11 s, `npm run lint` exits 0 over about 400 files, and `npm run build` completes.

**Verifier check.** Re-ran `npx tsc --noEmit --incremental false` in the main checkout. It exited 2 after 35 s with 29,122 'error TS' lines, all under 'Temp Download/'. `tsc --showConfig` outside Temp Download covers src 277, tests 99, Implementations 62, .next 17, scripts 16, plus 3 root files. `npx eslint 'Temp Download/sst.config.ts' .cache/upstream/opencode/sst.config.ts` exits 1 and reports a triple-slash-reference error in each file, so both trees are linted. eslint.config.mjs:6-19 ignores neither tree. 'Temp Download/' is untracked and not in .gitignore; .cache/ is gitignored, but flat-config ESLint does not read .gitignore. The reviewer missed one thing: `npm run build` almost certainly fails in this checkout too. Next 16 type-checks every tsconfig file (node_modules/next/dist/lib/typescript/runTypeCheck.js:35,110) and filters only __tests__/spec/test files, and 20,934 of the errors are in non-test files. .next has manifests from Oct 13 but no BUILD_ID. I did not run the build, to avoid writing .next under the live dev server. That makes three of the four required checks fail. One problem with the recommendation: the proposed tsconfig include drops Implementations/**, which tsc checks today (62 files).

### AR-QOL-2: Failed runs cannot be resumed or re-run from the UI, and the resume CLI's provider gate does nothing

Severity **high**, effort **S**, verdict **corrected**

**Problem.** When a run stops on a quota 429, a validator failure or a code bug fixed later, the operator's only path is `RESEARCH_RUN_ID=... npm run run:research:resume`. The backend already supports resuming such runs. The CLI also misleads: it refuses to run unless RUN_PAID_RESEARCH=1 and rewrites RESEARCH_MODEL_PROVIDER in its own process, yet it only inserts a job row, and the worker's own env decides which provider runs. There is also no way to re-run from one stage after a prompt or code fix without hand-written SQL, so a $1 to $2.6 run is often recreated from scratch.

**Evidence.** The run page calls run-system-pipeline only inside createAndStartRun (src/app/assets/[id]/run/page.tsx:445). Its footer offers only 'Cancel run' and 'New research' (:821), with no resume or re-run control. enqueueResearchRun rejects only completed or cancelled runs (src/lib/research/run-queue.ts:90-96) and first calls resumeResearchRun, which handles 'needs_more_work' and 'failed' (src/lib/workflow/orchestrator.ts:1009-1054). scripts/resume-research-run.ts:23-29 checks RUN_PAID_RESEARCH, sets process.env.RESEARCH_MODEL_PROVIDER and then only calls enqueueResearchRun. The provider is read at call time from the executing process (src/lib/research/run-context.ts:448, src/lib/agent-harness/providers/provider.ts:13). .env.local sets RESEARCH_MODEL_PROVIDER=opencode-go-direct, so the script refuses without RUN_PAID_RESEARCH=1 even though it spends nothing itself. DB: 19 v3 runs stopped in needs_more_work or failed. Examples: d6f3fbee (MELI) failed on 'Provider HTTP 429 GoUsageLimitError' at historical_record, and dd02bb41 (SOFI) on the founder-motivation validator. dependentStages() already exists (src/lib/research/team-plan.ts:64).

**Recommendation.** (1) On the run page, show 'Resume run' when status is needs_more_work or failed, no job is active and the stopped stage is not a gate. It POSTs to the existing /api/research-runs/:id/run-system-pipeline, so no backend change is needed. (2) Move the stage, task, artifact, report_approval and source_gaps part of rerunRequestStages (team.ts:286-306) into a helper, reopenStages(tx, runId, stageKeys, note). Add POST /api/research-runs/:id/reopen {stage_key}. It refuses while a gate waits or a job is active, then calls reopenStages(dependentStages([stage_key])) and enqueues in one transaction. Show it as 'Re-run from here' on completed stages. (3) In resume-research-run.ts, delete the process.env override. Keep the RUN_PAID_RESEARCH check, but base it on the provider in the live worker's heartbeat (AR-QOL-3), and print that provider. Verify with the mock provider on a scratch DB: a failed stage resumes from itself, and reopening operating_model resets only operating_model and its dependents and marks their artifacts needs_more_work. Add a run-lifecycle-db test for the reopen path.

**Verifier check.** Confirmed. The run page calls run-system-pipeline only in createAndStartRun (run/page.tsx:445), and the footer (:821) has only Cancel run and New research. enqueueResearchRun (run-queue.ts:64-96) calls resumeResearchRun first, which handles needs_more_work and failed (orchestrator.ts:1009-1054), and the POST route just calls enqueue. scripts/resume-research-run.ts:23-27 sets process.env.RESEARCH_MODEL_PROVIDER, but neither run-queue.ts nor research-worker.ts reads provider, so the override has no effect. The DB has 19 v3 runs in needs_more_work or failed. The recommendation needs two fixes. (a) The CLI's RUN_PAID_RESEARCH gate is not useless: enqueueing makes the worker spend money, and AGENTS.md requires an explicit flag for paid runs. Keep the gate, but test it against the worker's provider, not the CLI's env. (b) A generic reopen has to do more than reset stages and tasks. rerunRequestStages (team.ts:286-314) also marks the dependent artifacts needs_more_work, clears report_approval and resolves stale source_gaps. Reuse that logic rather than rewriting it.

### AR-QOL-3: Provider, models and research-shaping settings come only from the worker's env and are never recorded or shown

Severity **high**, effort **M**, verdict **confirmed**

**Problem.** Which provider and model a run uses, its forecast horizon, its evidence cap and similar settings are whatever the executing process's env says when each stage starts. Nothing records them on the run or shows them before or during it. The launch scripts store metadata.acceptance_provider, but nothing executes on it. new-equity-run.ts runs the stages up to the plan gate in-process on its own provider, and after UI approval the worker continues on its own env, which by default is opencode-go-direct. Runs are therefore hard to reproduce and compare, a paid run can quietly switch provider halfway, and research-quality knobs such as the 3-year horizon (the META report's main limitation) are invisible.

**Evidence.** Model resolution: src/lib/agent-harness/registry.ts:760-761 (RESEARCH_ALL_AGENTS_MODEL, then RESEARCH_<AGENT>_MODEL, then the default). Provider: run-context.ts:448, provider.ts:13. metadata.acceptance_provider is read only at quality-gates.ts:785, to detect synthetic runs. scripts/new-equity-run.ts:26-30 sets the provider in-process and :127 calls runSystemResearchPipeline directly. Worker heartbeat metadata holds only {pid, mode} (src/workers/research-worker.ts:164; DB row 'Japardis-MacBook-Pro.local:35887' metadata {"pid":35887,"mode":"poll"}). .env.local has RESEARCH_MODEL_PROVIDER=opencode-go-direct, while the META paid runs ran on direct-anthropic-compatible/claude-haiku-5-5 (model_call_logs), which means the worker was restarted with overrides. forecastHorizon defaults to Number(RESEARCH_FORECAST_YEARS)||3 (src/lib/research/valuation/engine.ts:356). 65 RESEARCH_* env vars are read in src, and 6 appear in no doc or .env.example: RESEARCH_BACKTEST_AGENT and RESEARCH_BACKTEST_MODEL (backtest-coder.ts:127, executor.ts:233), RESEARCH_MODEL_TIER (executor.ts:208), RESEARCH_PIPELINE_EVIDENCE_CAP (corpus.ts:1734), RESEARCH_SOURCE_SEED_URLS and RESEARCH_SOURCE_ROLE_SEEDS (corpus.ts:1612-1623).

**Recommendation.** Keep the reviewer's plan. (1) On claim, merge an allowlisted effective_config (provider, base-URL host, resolved model per agent, RESEARCH_FORECAST_YEARS, concurrency, evidence cap, timeouts, max tokens, git HEAD) into research_runs.metadata_json, and append when a later job differs. Never dump the env. (2) Put provider, default model and git HEAD in the heartbeat and show them on the intake and plan screens. (3) Fail a job whose metadata.acceptance_provider differs from the worker's provider. (4) Document the 6 variables in .env.example. Verify on a mock run that effective_config is written on the first claim, and that a worker with a mismatched provider refuses the job with a clear failure_reason.

**Verifier check.** Confirmed, and the DB has stronger evidence than the reviewer cited. registry.ts:758-762 resolves models from env, and run-context.ts:448 and provider.ts:13 read the provider from env at call time. Heartbeat metadata holds only {pid, mode} (research-worker.ts:164, DB row 35887). acceptance_provider is read only at quality-gates.ts:785. forecastHorizon defaults to 3 (engine.ts:356). The 6 RESEARCH_* variables appear in no doc or .env.example (grep). Real configuration drift found in model_call_logs: run 50d91067 (2026-10-10, acceptance anthropic-direct) sent deepseek-v4-flash, deepseek-v4-pro and kimi-k2.7-code to the Anthropic endpoint and got 5 'HTTP 404 not_found_error model: ...' responses before claude-haiku-5-5 calls started. Runs 4f9ceba5 and d55cba25 (2026-08-06) switched provider mid-run: direct-openai-compatible calls failed with 401 or 'host is not allowlisted', and opencode-go-direct calls followed in the same stage. So provider and model drift within a run is observed, not hypothetical.

### AR-QOL-4: No deterministic valuation what-if or sensitivity, although the engine is pure and its inputs are stored

Severity **high**, effort **S**, verdict **corrected**, JD trait: Valuation as an operating-case x valuation-assumption matrix (§13), reverse DCF in FCF-growth terms (§14), and impairment and tail cases below the bear case (§17)

**Problem.** For FCFF assets the model supplies only a discount rate and a terminal assumption per scenario. Code builds the statements, the FCFF schedules, the anchors and the reverse valuation. Even so, testing 'what if the base discount rate were 10%', 'what if the terminal multiple were 18x' or 'what if the horizon were 6 years' requires resetting asset_valuation and its dependents, which means paying again for decision_synthesis and ai_reviewer. The product requirements ask for sensitivities and reviewable assumption changes. The JD example's valuation is an operating-case × valuation-assumption matrix, which this engine could compute for free.

**Evidence.** src/lib/research/handlers/asset-valuation.ts:28-41: the prompt asks only for valuation_assumptions. :484-533: code calls buildScenarioStatements, buildFcffSchedule, assembleValuation, impliedOperatingMargin and impliedRevenueGrowth. These come from src/lib/research/valuation/engine.ts, a pure module that imports only zod and schedules. The stored 4fae0fb1 valuation_scenario_set holds valuation_assumptions (bear 11%/10x NOPAT, base 9%/14x, bull 8.5%/16x), history_ratios, method_inputs and current_market_price, and operating_scenario_set holds forecast_horizon and the yearly drivers (SELECT on research_artifacts). The base rationale says terminal year 2028 capex of 103,211 against D&A of 28,996, and that the 'terminal value share of enterprise value is not yet computed'. These are exactly the swing factors an operator would flex. Cost of a re-run downstream of valuation in 4fae0fb1: decision_synthesis $0.093 plus ai_reviewer $0.613, with 2,351 s wall time in ai_reviewer. docs/research-product-requirements.md:53 asks to keep sensitivities, reverse expectations and no-rerating returns together, and :59 asks to keep proposed assumption changes and reruns reviewable.

**Recommendation.** Add a pure helper, valuationSensitivity(valuationScenarioSet, overrides), that clones method_inputs, applies discount-rate or terminal overrides, and calls calculateValuationSchedule and assembleValuation. It returns, per scenario, the anchor, the present-value per share, the terminal-value share of equity value, the weighted target and the upside. Use it in two places. (1) asset_valuation stores a default grid (discount ±1pp × terminal multiple ±2x, or growth ±0.5pp) in valuation_scenario_set, so every report gets the operating-case × assumption matrix without a model call. (2) A read-only scripts/valuation-whatif.ts RUN_ID --scenario base --discount-rate 0.10 --terminal-multiple 18 [--grid]. Do not offer a horizon flag; that needs new drivers. Later, serve the same helper as a GET 'Sensitivity' panel. Verify with a unit test on a fixture exported from 4fae0fb1: no overrides reproduces the stored anchors 216.17, 528.69 and 768.04 and the weighted target 510.40, and a +1pp discount rate changes the present-value per share but not the multiple-based anchor.

**Verifier check.** The core claim holds. valuationPrompt asks only for valuation_assumptions (asset-valuation.ts:28-41), and code builds the statements, schedules and anchors (:484-533) with the pure engine.ts and schedules.ts. A downstream re-run on 4fae0fb1 costs asset_valuation $0.051 + decision_synthesis $0.093 + ai_reviewer $0.613, about $0.76, and 22 + 140 + 2,351 s of stage wall time (SQL rollup). Three corrections. (a) No extraction or new snapshot is needed. Every stored valuation_scenario_set.method_inputs[i] already holds years with cash-flow builds, discount_rate, terminal including metric_value, equity_bridge (-22058) and diluted_shares, and the set stores the probabilities and current_market_price. calculateValuationSchedule and assembleValuation (schedules.ts:23-36, engine.ts:175) can recompute directly from it. (b) The headline anchors are terminal-year prices, (terminal_value + bridge) / shares (engine.ts:160-169, 191). Under a terminal multiple they do not move with the discount rate at all, so a discount-rate axis changes only the present-value per share today. The tool has to show both values, or a discount-rate grid will look flat. (c) The `--forecast-years 6` flag cannot be deterministic, because operating_scenario_set has yearly drivers only for FY2026-2028 (forecast_horizon {years:[2026,2027,2028]}).

### AR-QOL-5: No cost or time estimate before a run, UI runs are uncapped by default, and spend is never broken down by stage

Severity **low**, effort **S**, verdict **corrected**

**Problem.** The intake form hides 'Budget (USD)' in a collapsed section and leaves it empty. An empty value is stored as NULL, and the budget guard enforces nothing when the limit is NULL. A UI-started paid run therefore has no cap, and there is no estimate to compare against. While a run is going, the page shows one total and a flat list of up to 174 calls. Latency is fetched but never rendered, and there is no rollup by stage or agent. The operator cannot see that most of the money and time goes to report writing rather than analysis.

**Evidence.** src/app/assets/[id]/run/page.tsx:785-786: the budget field sits inside a closed <details> and defaults to ''. :87 latency_ms is fetched, but the page renders only formatMoney(totalCost) (:279) and per-call cost. src/app/api/assets/[id]/research-runs/route.ts:62 stores budget_limit_usd ?? null. src/lib/agents/model-calls.ts:97 enforces the run limit only `if (runs[0]?.budget_limit_usd)`. model_budget_limits has 0 rows. The only UI-created run, 3abf201d, has a NULL budget. The scripts default to $10 (scripts/new-equity-run.ts:103). History an estimate could use: META runs at the gate cost $0.94, $1.05, $2.08 and $2.61, with 56 to 174 calls. Per-stage rollup for 4fae0fb1 (JOIN model_call_logs.stage_id): ai_reviewer $0.613 of $1.045 (59%) and 2,351 s of about 3,830 s; moat_analysis $0.013 from 1 call; business_process_analysis $0.018 from 1 call; operating_model $0.018 from 1 call.

**Recommendation.** (1) Default the UI budget to $10, the scripts' value, and show the field open. (2) Add a 'Cost and time by stage' table to Run details (stage, calls, tokens, cost, wall time) from one GROUP BY on model_call_logs.stage_id joined to research_stages, returned by the existing run route. (3) Make the estimate optional: p50 and p90 cost and duration of the last 10 v3 runs of the same run_type that reached human_review, as one SQL query shown on the plan approval screen. Verify that the table for 4fae0fb1 shows ai_reviewer with 26 calls and $0.613, and that a UI-created run stores budget_limit_usd = 10.

**Verifier check.** Mostly true, but overstated. The budget field sits in a closed <details> with an empty default (run/page.tsx:321, :785-786). The route stores budget_limit_usd ?? null (research-runs/route.ts:62), and the run-level guard enforces only when a limit is set (model-calls.ts:97). latency_ms is fetched (:87) but never rendered. Two facts are wrong. (a) UI runs are not uncapped. Each stage gets maxBudgetUsd from stages.ts (run-service.ts:55), for example 4fae0fb1's stages total $70.6 with ai_reviewer $5 and asset_valuation $10. advanceStage checks these, but only after the stage finishes (orchestrator.ts:217-229). What is missing is a preventive run-level cap. (b) The exposure is small in practice: 1 of 66 runs was created from the UI (requested_by='user', 3abf201d, $0). Paid runs come from scripts with a $10 default. The per-stage rollup is accurate (ai_reviewer 26 calls, $0.613 of $1.045) and is the most useful piece.

### AR-QOL-6: Human gates are silent: no notification, the plan gate is missing from the review queue, and queue rows look identical

Severity **low**, effort **S**, verdict **corrected**

**Problem.** Runs take 27 to 210 minutes and stop at two human gates, but nothing tells the operator. The run page stops polling while its tab is hidden, the home page never polls, and nothing notifies. 'Awaiting review' lists only final-review runs, so a run waiting at the research-plan gate is invisible unless its run page is opened. Queue rows show only asset name, run type and an 8-character id, so four META runs waiting at review cannot be told apart. The result is a backlog: 11 runs wait at gates, the oldest since July, and only one run has ever completed.

**Evidence.** There is no Notification, document.title or OS notification anywhere in src or scripts (grep). src/lib/research/run-polling.ts:1-15 and run/page.tsx skip polls while document.visibilityState !== 'visible'. src/app/api/review/queue/route.ts:36-41 joins only stage_key='human_review' AND status='waiting_for_human' and selects no created_at or cost. src/app/page.tsx renders run_type only, and src/app/review/page.tsx:137 shows run_type · run_id.slice(0,8). DB: 11 runs in waiting_for_human, the oldest dac4339a from 2026-07-18. 3abf201d has waited at research_plan since 2026-07-24 and is absent from the queue (v3, 0 cost). Status counts: 1 completed run of 66, and 1 row in exports (2026-08-06). The worker knows when a run stops: research-worker.ts:102-107 receives result.status.

**Recommendation.** (1) After runSystemResearchPipeline returns waiting_for_human, needs_more_work or failed, the worker sends a best-effort notification on darwin with execFile('osascript', ['-e','on run argv','-e','display notification (item 1 of argv) with title "Research OS"','-e','end run', message]). Passing the message as argv means it is never interpolated into the script. (2) Include research_plan gates in /api/review/queue with a gate field, linking to /assets/:id/run?run=. (3) Add created_at, actual_cost_usd and the base anchor to queue rows. (4) Set document.title when the run on screen reaches a gate. Use the existing Cancel run for stale gated runs instead of adding an archive state. Verify with a mock run that a notification fires at both gates, including for an asset whose name contains a double quote, and that the queue lists 3abf201d as a plan gate.

**Verifier check.** There is no notification code anywhere (grep for Notification, document.title, osascript and notify finds nothing relevant). The queue joins only human_review (review/queue/route.ts:36-41), and the home and review rows show only run_type and id (page.tsx:36, review/page.tsx:137). The backlog story is overstated. Of the 11 waiting runs, 5 are legacy v2/v4 (dac4339a, 088dc993, 934134d1, 6574e2b5, 59d6397b) that cannot be reviewed and are already hidden. The 6 v3 runs are 3abf201d (plan gate, $0, July), 460c7a45 (NuScale) and 4 META paid acceptance checks, which the handover says were left at review on purpose. A plan-gated run is not invisible either: brief-presentation.ts labels it 'Awaiting input' on the asset brief, though not on the home page or in the review queue. The 'Archive' proposal duplicates the existing Cancel run button, which the run page shows for any status that is not completed or cancelled (:821, cancelRun handles waiting_for_human). The notifier as written is unsafe: interpolating the asset name into an `osascript -e 'display notification "..."'` string lets a quote in a user-entered name inject AppleScript, including `do shell script`.

### AR-QOL-7: No way to compare two runs of the same asset or see what changed since the last run

Severity **medium**, effort **M**, verdict **corrected**, JD trait: 'What would change my mind' and the monitoring dashboard (§18-19): tracking how the thesis and the valuation move between refreshes

**Problem.** The operator repeatedly re-runs the same company, with 10 META, 15 MELI and 32 SOFI runs. Choosing which report to approve, judging whether a prompt or code change helped, and spotting a valuation that swings for no reason all require SQL today. The reader shows one run at a time through a dropdown, and run history lists only date, id and status. Run-to-run variance is large and invisible in the UI.

**Evidence.** src/app/assets/[id]/view/page.tsx:357-364: run history is a single <select> plus a stage-status table. src/app/assets/[id]/page.tsx:174-178: run rows show run_type, date, id and status. A grep for compare, previous or diff finds nothing for runs in src/app or src/components. SELECT on valuation_scenario_set for the 4 META runs waiting at review: 02c8d48b bear/base/bull 413/564/672 ($2.61); 1d427f3f withheld ($2.08); 4fae0fb1 216/529/768 ($1.05); 7fa1f00a 146/631/1062 ($0.94). All have terminal_year 2028 and price 719 to 743.

**Recommendation.** Add a read-only /assets/[id]/compare?a=&b= page with a 'Compare with previous' link on the Runs tab. One API call loads the latest validated artifact of each type for both runs. Show (a) valuation_status, anchors, present-value per share, weighted target, price, implied growth and margin, and quality status; (b) discount rates, terminal assumptions, horizon and first-year drivers; (c) cost, calls, model and effective_config (AR-QOL-3); (d) per artifact type, changed, added or removed, using md5(content_json::text) computed in SQL, with a top-level key list for changed types. Verify that comparing 4fae0fb1 with 7fa1f00a shows base 528.7 against 631.0 and bear 216 against 146, and that no model call is logged.

**Verifier check.** Confirmed. There is no compare or diff UI (grep). Run history is a <select> plus rows (view/page.tsx, assets/[id]/page.tsx:178). The META anchors check out: 02c8d48b 413/564/672, 1d427f3f withheld (0/0/0), 7fa1f00a 146/631/1062, 4fae0fb1 216/529/768. All have terminal_year 2028 and a price of 719 to 743. Run counts are SOFI 32, MELI 15 and META 10. Corrections: research_artifacts has no content-hash column (information_schema lists none), so the 'changed per artifact by content hash' step needs a hash computed in the query. And because the anchors ignore the discount rate under a terminal multiple (see AR-QOL-4), the headline comparison should show present-value per share next to the anchors.

### AR-QOL-8: Pipeline failures are labelled 'needs more work', the brief opens on the newest run even if it failed, and failure reasons are hidden

Severity **medium**, effort **S**, verdict **corrected**

**Problem.** When the pipeline throws, the run's status becomes 'needs_more_work', the same word as the reviewer verdict. The brief shows it in a neutral tone instead of as an error. The research brief always opens the newest run by created_at, so an asset whose latest attempt died early shows an empty brief while a much further-along run is hidden. The reader's stage table reads fields that research_stages does not have, so failure reasons never appear. Legacy v2 and v4 runs (40 of 66) cannot be queued or reviewed but fill every run history. The dev DB still carries a column default of 4 from a branch migration; this was noted in audit G8's evidence and is still present.

**Evidence.** src/lib/research/pipeline-runner.ts:232 calls failRun(runId, reason, 'needs_more_work'). The review verdict uses the same value (src/app/review/page.tsx:25). src/lib/research/brief-presentation.ts:21-24 gives only 'failed' the error tone. DB: 37 runs in needs_more_work, including d6f3fbee (failed on a 429 quota) and d6236111 ('Valuation did not produce positive finite... anchors'). view/page.tsx:168 picks sortedRuns[0], so MELI opens d6f3fbee (7 stages completed, 45 artifacts) instead of dca55615 (20 stages, 78 artifacts). view/page.tsx:725,730 read stage.stage_name and stage.error_message/skip_reason/notes, but the research_stages columns are id, ..., failure_reason (information_schema), so the Notes column is always blank. Runs by pipeline_version: v2 6, v3 26, v4 34; SOFI has 32 runs, 23 of them legacy. The research_runs.pipeline_version column default is 4, and drizzle.__drizzle_migrations has 15 rows against 13 journal entries.

**Recommendation.** (1) When failure_reason is set and no review_decision exists, show 'Stopped: <first 120 chars>' in the error tone (brief-presentation.ts), with the Resume button from AR-QOL-2. Optionally, later, have pipeline-runner.ts:232 write 'failed', which resumeResearchRun already accepts. (2) Open the brief on the newest run that reached human_review or completed, falling back to the newest run. (3) Change view/page.tsx:730 to read stage.failure_reason. (4) Hide runs whose pipeline_version differs from CURRENT_PIPELINE_VERSION behind 'Show legacy runs'. (5) Ask the user before changing the dev DB column default or the branch-only migration rows. Verify that the MELI brief opens dca55615 and that the Sources-tab stage table shows failure reasons.

**Verifier check.** Confirmed with small fixes. pipeline-runner.ts:232 calls failRun(..., 'needs_more_work'). All 37 needs_more_work runs have a failure_reason and no review_decision (SQL), so none of them is a reviewer verdict. brief-presentation.ts:24 gives only 'failed' the error tone. view/page.tsx:168 opens sortedRuns[0], so MELI opens d6f3fbee (7 stages completed, 429 quota) rather than dca55615 (20 stages). The Notes column reads stage.error_message, skip_reason and notes (:730), none of which exist, so it is always blank. stage_name, however, falls back to stage_key (:725), so the stage label is fine. Skipped stages already store their reason in failure_reason (run-service.ts:62), so no completion_criteria fallback is needed. Confirmed: the pipeline_version default is 4, and the DB has 15 applied migrations against 13 journal entries (0007 and 0008 are missing from the journal).

### AR-QOL-9: Dev startup path is broken or stale: default launch config needs a missing .env, Windows-only shim and docs, no worker entry

Severity **low**, effort **S**, verdict **corrected**

**Problem.** Running the app means starting two processes, Next and the worker, each with the right env. The first launch configuration cannot start on this Mac. The docs still describe a Windows checkout and a 5433 test database that no longer exist. No launch entry or npm script starts the worker. next-env.d.ts is rewritten on every switch between dev and build, so git status is never clean.

**Evidence.** The committed .claude/launch.json 'research-os' runs `node --env-file=.env scripts/dev-with-db.cjs`. No .env exists (ls), and node exits with '<file>: not found' for a missing --env-file (verified). scripts/dev-with-db.cjs:2-6 only maps WINDOWS_DATABASE_ADMIN_URL. The working copy of launch.json has uncommitted edits adding research-os-3100 and ui-workshop, and .claude/launch.local-3200.json.bak sits untracked; neither file has a worker entry. Stale docs: docs/local-development.md:61 ('On this Windows checkout, PostgreSQL 18 ... port 5433') and docs/architecture.md:74 ('The port 5433 database used by npm run test:sofi-v3 is a Windows PostgreSQL service'), whereas package.json:19 runs test-db.cjs against DATABASE_URL. `git diff next-env.d.ts` shows it switching from ./.next/types to ./.next/dev/types. Doc spot-checks that are accurate: AGENTS.md 'pipeline version 3, 24 stages' (version.ts:7, stages.ts); system.md:10 '53 route files'; system.md:162 RESEARCH_FORECAST_YEARS default 3 (engine.ts:356); local-development.md 'renews its lease every 10 s' (research-worker.ts LEASE_RENEW_INTERVAL_MS).

**Recommendation.** Replace the 'research-os' configuration with `npm run dev`, which binds 127.0.0.1:3000, and add a 'research-worker' configuration that runs `npm run worker:research`. Delete scripts/dev-with-db.cjs and the Windows paragraph, correct docs/architecture.md:74, and commit or discard the launch.json edits and the .bak file. Either keep next-env.d.ts tracked and accept the churn, or untrack it and change the documented tsc check to `npx next typegen && npx tsc --noEmit` (next-typegen is in next 16.4). Verify that both launch configurations start from a fresh shell and that tsc passes in a fresh worktree.

**Verifier check.** Confirmed. The committed .claude/launch.json 'research-os' runs `node --env-file=.env scripts/dev-with-db.cjs`, and .env does not exist. dev-with-db.cjs maps only WINDOWS_DATABASE_ADMIN_URL. The second committed configuration (npx next dev on 3002) does work. There is no worker configuration. local-development.md:61 and architecture.md:74 still describe the Windows/5433 setup. `git diff next-env.d.ts` shows the .next/types to .next/dev/types flip. One part of the recommendation would cause a regression. If next-env.d.ts is untracked, a fresh worktree has no reference to next's global types until next dev, build or typegen runs. The app imports CSS modules (src/app/page.tsx, review/page.tsx, research/new/page.tsx), and *.module.css is declared only in node_modules/next/types/global.d.ts:27. So `npx tsc --noEmit`, the second required check, would fail in exactly the clean worktrees where the user runs checks.

### AR-QOL-10: Legacy v2 export code, 24 uncalled API routes and fixtures in production modules inflate the surface to maintain

Severity **low**, effort **S**, verdict **corrected**

**Problem.** About 2,000 lines of export code and 24 route files have no caller in the UI or scripts, and 8 of those routes are mutating. The research-package and memo generators read the v2 relational tables, not research_artifacts, which conflicts with the AGENTS.md invariant that typed artifacts are the report source of truth. corpus.ts, the largest file at 2,049 lines, mixes SEC, FRED and IR fetchers with a mock SoFi fixture and a hardcoded Exor fact sheet. That fact sheet presents typed claims (confidence 0.95, retrievalDate = now) as freshly retrieved. Small helpers are copied rather than shared.

**Evidence.** src/lib/export/research-package-generator.ts (1,793 lines) and memo-generator.ts (237) are reachable only from POST /api/research-runs/:id/export (export/route.ts:30-40), which nothing calls. The generator queries theses, thesis_drivers, risks, catalysts, scenarios and valuation_signals (:215-274). The newest *_research_package folder in storage/exports dates from 2026-07-10. Tests import only csvEscape and storedBacktestFile from it (tests/backtest-export-guards.test.ts:8). Routes with no caller in src/app pages, components, lib or scripts: 24 of 53. The mutating ones are evidence/[id]/review PATCH, export POST, generate-signals POST, refresh POST, stage-output POST, tasks POST, staging/[id]/accept POST and thesis/[id] PATCH. corpus.ts:684-760 returns a mock SoFi context inside fetchSecContext. corpus.ts:763-769 and 1331-1470 return a hardcoded Exor context with 'recentFacts' claims. loadEnvFile is copied in 15 files (scripts/*, src/db/migrate.ts, src/workers/research-worker.ts). There are 100 ad-hoc postgres(process.env.DATABASE_URL) clients in 51 src files next to the shared pool in src/db/index.ts. The largest components are RunResearchPage (517 lines, run/page.tsx) and ViewResearch (250 lines, view/page.tsx).

**Recommendation.** Make one deletion PR. Move csvEscape and storedBacktestFile to src/lib/export/csv.ts and update backtest-export-guards.test.ts. Delete research-package-generator.ts, memo-generator.ts, the export route and the other mutating legacy routes, along with their tests (api-state-guards' staging case, stage-output-persistence), or keep any route whose guard test protects a still-reachable path. Keep research-workers/health and the read-only GETs unless they read v2 tables. Move the mock SoFi context into a test fixture module, and route the Exor facts through a seed source document so they carry a real retrieval date. Add src/lib/env.ts with a single loadEnvFile. Verify that tsc, lint, test:unit, test:db and build all pass and that grep finds no imports of the deleted modules.

**Verifier check.** Re-ran the per-route caller grep: 24 of 53 routes have no caller in src/app pages, components, lib or scripts, and 8 of them mutate (staging accept, evidence review, thesis PATCH, tasks, refresh, generate-signals, stage-output, export). I found no dynamically built /api paths. research-package-generator.ts is 1,793 lines and memo-generator.ts 237. corpus.ts is 2,049 lines, with the mock SoFi context at :684-693 and hardcoded Exor facts at :763-769 and :1331+, which carry retrievalDate = now and confidence 0.95. loadEnvFile is defined in 12 files (15 counting other loadEnv* names). 100 ad-hoc postgres(DATABASE_URL) clients sit in 51 files. Correction: deleting these files breaks tests the reviewer did not account for. tests/api-state-guards.test.ts:28 imports staging/[id]/accept/route, tests/stage-output-persistence.test.ts covers stage-output, and tests/backtest-export-guards.test.ts:8 imports from research-package-generator. Also, the read-only GET routes cost little and are handy with curl, so the dead weight is mainly the mutating routes and the v2-table readers.

### AR-QOL-11: Repo hygiene: tracked data files, root-level stale plans, split handover history, ad-hoc scripts, branch and worktree buildup

Severity **low**, effort **S**, verdict **corrected**

**Problem.** The repository root mixes code with stale plans, data downloads and design QA notes. Half of the handover history, including the 967-line 2026-10-11 audit and its fixes handover, is untracked and exists only on this machine, even though the project now syncs research between machines. The ad-hoc debug scripts carry hardcoded ids, and one deletes data. Branches, stashes and an 882 MB stale worktree have piled up. The research-store branch lives in the code repository, so a default clone downloads about 20 times more than the code.

**Evidence.** Tracked but referenced by no code (grep over src, scripts, tests, python and docs): CPIAUCSL_2.xlsx (0.7 MB) and fut_disagg_txt_2024.zip plus fut_disagg_txt_2025.zip (4.6 MB), added in 84350329. Root plans: implementation.md (backend–UI stitching), research-depth-implementation-plan.md ('2026-07-09, proposed'), architecture.md (104 KB, marked as the original proposal), design-qa.md and a MercadoLibre report. A July follow-up plan sits inside source at src/lib/research/implementation.md. 'handover files/' has 17 tracked and 7 untracked files. scripts/monitor.ts:23 hardcodes run 76355c02, which matches 0 rows, and orders stages by UUID. scripts/db-smoke.ts deletes an asset. check-progress.ts, query-assets.ts and query-run-stages.ts are not in package.json. Git: 26 local branches, 25 merged into main, 21 named worktree-wf_*; 3 stashes from July branches; worktree .claude/worktrees/valuation-inputs-cd02ef (882 MB) on feat/valuation-financial-inputs. `git rev-list --disk-usage`: main 14 MB, research-store 279 MB, all refs 293 MB.

**Recommendation.** Make one housekeeping PR. Move the MercadoLibre report and its three input files together into 'Research References/' or the research-store branch. Move the root plans and src/lib/research/implementation.md into docs/archive/ with a status line each. Let the user choose between committing or gitignoring 'handover files/', and either way copy the 2026-10-11 audit and fixes handover into docs/archive/. Replace monitor.ts, check-progress.ts and query-*.ts with `npm run run:status -- RUN_ID`. After the user approves: `git branch -d` the 24 merged branches, `git worktree remove` the stale worktree, and drop the stashes. Document `git clone --single-branch --branch main` in AGENTS.md. Verify that git branch lists only active branches and that run:status prints the 4fae0fb1 stage summary.

**Verifier check.** Mostly confirmed. CPIAUCSL_2.xlsx and the two fut_disagg zips are tracked and referenced nowhere in code or docs. But they were added with the MercadoLibre report in 84350329 ('research: add MercadoLibre inputs and report'), so they are research inputs, not junk, and `git rm` would not shrink history anyway. 'handover files/' has 17 tracked and 24 files on disk. scripts/monitor.ts:23 hardcodes run 76355c02. db-smoke.ts:5 deletes only its own fixture asset (slug test-co-artifacts), so 'deletes data' overstates it. `git branch --merged main` lists 25 entries including main itself, so 24 branches are merged, 21 of them worktree-wf_*. There are 3 stashes. The stale worktree .claude/worktrees/valuation-inputs-cd02ef is on feat/valuation-financial-inputs, which is already in main. The default-clone size concern holds: main is 14 MB and research-store about 279 MB.

## GAP-1: The human plan gate can't steer the research: the plan is a fixed template and the 'request plan changes' notes are saved but never read

The human plan gate can't steer the research, and a single gate rework would add the asset-specific framing the JD example depends on. Today research_plan is a template with no model call (prompt_version deterministic-v1). Nothing in the pipeline implements framework Stage 1 ('Define the Asset': claim held, segments needing separate models, horizon), and the four team briefs are process plans, not investment debates. The approved plan never reaches an analytic prompt. Even the user's research question is missing from 49 of 79 META calls, including every analysis stage, valuation and decision synthesis. The gate's own controls do nothing. 'Request changes' notes are written and never read. Archetypes can't be chosen, so every META (10/10), MELI (4/4) and Exor run was composed as operating_company_core, even though the registry has advertising_platform, marketplace, logistics_network and holding_company modules. The horizon is a global 3-year env default. Recommended fix, small and without new dependencies: one cheap framing call in the plan stage, editable at the gate (central debate, what the investor owns, engines, key questions, peers, archetypes, horizon). Then inject the approved framing into every packet through callResearchAgent, inside the cached prefix, and add an outline validator that makes the report answer the framing questions.

<details><summary>Measurements</summary>

All numbers come from read-only SQL on the dev DB, META run 4fae0fb1-76b3-4d2b-b386-e48eb9547a75, unless noted.
- Calls without research_question in the packet: 49 of 79 model calls, 3,402,096 input tokens, $0.517 of $1.05. Calls with it: 30, 4,305,910 tokens, $0.529. Join: model_call_logs to research_tasks on input_json->'packet' ? 'research_question'.
- Tasks whose input contains the research_plan artifact: report_outline 1, ai_review 2, team_requests 2.
- research_plan artifact: 24,730 chars (research_team 3,497; report_standard 6,489; applicable_stages 5,874). report_outline packet artifacts: 844,195 chars; whole task input: 986,666.
- Plan-call cost proxy (team_brief on claude-haiku-5-5): 8.9k input / 2.0-3.6k output tokens, $0.0021-0.0029, 12.7-19.9 s each.
- Runs: 66 total, 26 v3, 5 distinct v3 research questions. requested_by: system-test-harness 58, investment-benchmark-v1 6, user 1, paid-meli-acceptance 1.
- research_plan_change_request present: 0 runs.
- Median creation-to-plan-approval: harness 0.49 s (n=9), user 22.9 s (n=7), META 51.1 s.
- Archetypes: Meta 10/10, MELI 4/4 and Exor 1/1 runs are operating_company_core with no overlays; the registry has 14 archetypes.
- META question_register: 15 entries, 0 from the plan.
- Stages 1-4 of the META run made no model calls.
- Side note (not a finding): RESEARCH_DOCTRINE appears twice in the report_outline and report_section prompt instructions (counted the substring 'The Financials deliverable is the complete issuer-reported' in prompt_instructions: 2 vs 1 for moat_analysis). exactJsonPrompt adds it for these agents and extraRules spreads it again (run-context.ts:338; reporting/runtime.ts:67,85).

</details>

### GAP-1-1: The research plan is a fixed template, and framework Stage 1 ('Define the Asset') has no implementation

Severity **high**, effort **M**, verdict **corrected**, JD trait: One central reframing insight; what the investor owns; segment-level economics (who earns vs who burns); framework Stage 1 'Define the Asset' and Stage 8 'Identify the Economic Engine'

**Problem.** buildResearchPlan is a pure function. Its only asset-specific content is the asset name and the free-text research question, and its 'questions' are that question plus one generic sentence. Framework Stage 1 requires: claim held by the investor, unit of analysis, 'major segments requiring separate models' and investment horizon. No stage produces these: asset_identity only assigns a profile. The only other planning step, the four team briefs written after source discovery, produces process plans ('Sequence collection and analysis...', 'rebuild the 20-quarter income statement') with no investment debate. As a result the META report is organized around consolidated numbers. Its decisive question, whether the reinvestment earns a return, appears only in paragraph form inside the management chapter. Of 15 question-register entries, none is a central debate and neither plan question appears. The ownership claim is blocked because nobody flagged dual-class control as decision-critical up front. META is structurally the same case as JD: Family of Apps earns, Reality Labs plus AI capex burns. A one-line framing ('value FoA separately; will management let core economics accrue to Class A holders') is exactly what the template can't produce.

**Evidence.** src/lib/research/handlers/research-plan.ts:11-77 (template); :40-41 (questions = researchQuestion + generic sentence); :97 prompt_version 'deterministic-v1'. src/lib/research/handlers/asset-identity.ts:5-43 (only a profile assignment). Framework 'Research References/Asset%20Research%20Agent%20Framework%20-%20Current.md':1051-1074 (Stage 1 list) and :2018-2020 ('What the investor owns and how value accrues'). src/lib/workflow/stages.ts:75-83: research_plan already allows tier 'mid', maxBudgetUsd 2.00, maxRetries 2, and its description says 'Generate the structured research plan'. src/lib/agent-harness/registry.ts:233-270: unused 'intake-planner' config with asset_hypothesis/approval_questions (grep finds no v3 caller). DB, META run 4fae0fb1: plan report_standard.questions = [the generic 'Evaluate ... origins, business model ... bear, base, and bull scenarios.', 'Which operating constraints and capital-allocation choices could change ...per-share economics?']. agent_brief.approach for business/financials/report/valuation are all work-order text. question_register: 15 entries (price verification, equity bridge, capex H2, peer moat, governance, discount rate...), none from the plan. report.md:2606 'Whether the reinvestment earns a return is the decisive question for capital allocation' (management chapter); report.md:2615 'the ownership claim is blocked'; report.md:92 'No proxy statement (DEF 14A) ... was retrieved'.

**Recommendation.** Keep the single framing call in research-plan.ts execute(), before buildResearchPlan. Use callResearchAgent, taskType 'research_framing', tier mid, with a small zod contract: central_question; what_investor_owns; engines[] of at most 5, each with value_treatment; key_questions[] of at most 8, each with a falsifier; named_peers; priority_documents; forecast_years; proposed_archetypes/overlays as a z.enum of registry keys. Label all of it as unverified hypotheses carried as packet data. Two additions make it effective. (a) Pass framing.priority_documents and engines into the source_review packet (source-discovery.ts:33-44), so the framing can steer collection before the corpus exists. Otherwise the field does nothing. (b) Add a mock-provider branch for output_contract 'research_framing' (providers/mock.ts, alongside the team_brief branch at :764). Update docs/system.md and the plan-gate step of docs/architecture.md. Verify: test:sofi-v3 produces plan.framing and the gate tests still pass. A small, user-approved paid run (required by AGENTS.md for model-request changes) should show META framing that separates Family of Apps from Reality Labs and names a central question about whether the reinvestment returns accrue to Class A holders. Fix the governance block separately (missed issue 1); framing alone won't fix it.

**Verifier check.** Most of it holds on main. research-plan.ts:11-77 is a pure template. questions (lines 40-41) are the research question plus one generic sentence, and prompt_version is 'deterministic-v1' (:97). asset-identity.ts:5-43 only inserts a profile assignment. stages.ts allows tier 'mid' and $2.00 for research_plan. The intake-planner config has no v3 caller (grep hits only the registry, the mock and tests). Framework lines 1051-1074 list 'Claim held by the investor', 'Investment horizon' and 'Major segments requiring separate models'. The DB matches: the META plan's questions are [the generic question, 'Which operating constraints...'], none of the 15 question_register entries comes from the plan, and the team briefs cost $0.0021-0.0029 and took 12.7-19.9 s each on Haiku.

Two factual claims are wrong. (1) 'Nobody flagged dual-class control as decision-critical up front' is false. The business agent_brief that reaches moat_analysis through team_context.brief lists 'Proxy statement (DEF 14A) ... to verify dual-class voting control' in information_needed, and a governance check. team_requests asked for the proxy twice (request-1-5, request-2-5) and both came back status 'unavailable' with source_searched true. The ownership claim is blocked because the source was never collected (see missed issue 1), not because of missing framing. (2) The briefs are not segment-blind. The brief says 'Confirm the segment model (Family of Apps vs Reality Labs...)', the report has a 'Base case FY2026 segment split' table, and it mentions Reality Labs 56 times. What is actually missing is a framing a human can review before spend: a central debate, and a decision to value the engines separately. The verification target 'should name the DEF 14A' is weak, because the existing briefs already do that. Also, AGENTS.md makes the paid live provider test mandatory, not optional, for a change to model requests.

### GAP-1-2: Neither the user's research question nor the approved plan reaches the analytic stages

Severity **high**, effort **S**, verdict **corrected**, JD trait: Every section answers the central reframing (core engine vs investment losses); the decision answers the framed question

**Problem.** callResearchAgent injects team_context (brief, requests, upstream artifacts) but not research_question or the plan. The analytic handlers build their packets without either. RUN_CONTEXT_KEYS puts research_question first for cache ordering, but only the collector review, team briefs and report outline/section/review packets set it. Moat, operating model, scenarios, valuation and decision synthesis never see the question their output is meant to answer. Even a user who typed a sharp framing into the question box today would only steer the collector, the briefs and the report writer. The plan artifact reaches five calls as one 24.7 KB blob inside an 844 KB artifacts array: research_team 3.5 KB, report_standard 6.5 KB that repeats RESEARCH_DOCTRINE already in the rules, applicable_stages 5.9 KB. No instruction says to answer it.

**Evidence.** src/lib/research/run-context.ts:306 (RUN_CONTEXT_KEYS) and :405-427 (team_context injection, no question or plan). research_question is set only at team.ts:83, reporting/runtime.ts:55-58 and handlers/source-discovery.ts:34. moat-analysis.ts:15-26 packet = asset, required_modules, output_contract, output_schema. DB, META run: packet keys for moat_analysis = asset,team_context,output_schema,evidence_claims,filing_passages,output_contract,required_modules. operating_scenarios, asset_valuation, decision_synthesis and company_genesis also have no research_question key. Query: select (t.input_json->'packet' ? 'research_question'), count(*), sum(m.input_tokens), sum(m.cost_usd) from model_call_logs m left join research_tasks t on t.id=m.task_id where m.research_run_id='4fae0fb1-...' group by 1 → false: 49 calls, 3,402,096 input tokens, $0.517; true: 30 calls, 4,305,910, $0.529. Calls without it: company_genesis, business_process_analysis, moat_analysis, operating_model, operating_scenarios, asset_valuation x2, decision_synthesis x3, team_answer x10, metric_normalization, evidence_extraction x26 (historical_diagnosis's packet also lacks it). Tasks whose input contains the research_plan artifact: report_outline 1, ai_review 2, team_requests 2. Plan artifact length 24,730 chars; report_outline packet artifacts length 844,195.

**Recommendation.** At approval (orchestrator.ts approveResearchPlan), write metadata.research_framing = {research_question, ...approved framing}. In loadRunContext, expose it as ctx.researchFraming from the metadata it already reads. In callResearchAgent, set packet.research_framing when it is absent, for every task except metric_normalization and source_review (which already has the question). Include evidence_extraction_batch, so that key_questions and engines steer what gets extracted. Add 'research_framing' to RUN_CONTEXT_KEYS right after 'research_question'. The block is identical across a run's calls, so the shared, cached prefix stays the same between sibling calls. Add one rule when the key is present: answer the key_questions your stage can answer, keep the named engines separate, and flag evidence that contradicts a framing hypothesis. Remove the duplicate RESEARCH_DOCTRINE spread in reporting/runtime.ts:67 and :85, because exactJsonPrompt already adds it for those agents. Stop sending report_standard.output_requirements inside the plan artifact. Verify: in test:sofi-v3, select task_type from research_tasks where research_run_id=$1 and task_type not in ('metric_normalization','source_review') and not (input_json->'packet' ? 'research_framing') returns 0 rows, and the 'The Financials deliverable is the complete issuer-reported' substring appears exactly once in the report_outline prompt_instructions. This changes model requests, so it needs the user-approved small paid test before merge.

**Verifier check.** I re-ran the join and got the same result: false, 49 calls, 3,402,096 input tokens, $0.517; true, 30 calls, 4,305,910 tokens, $0.529. Packet keys confirm that moat_analysis, operating_model, operating_scenarios, asset_valuation, decision_synthesis, company_genesis, business_process_analysis, team_answer and evidence_extraction_batch have no research_question key. A text search for the first 60 characters of the question also fails in those inputs. The team_context injection in run-context.ts (about lines 405-427) adds brief, requests and upstream_artifacts, but not the question or the plan. RESEARCH_DOCTRINE appears twice in the report_outline, report_section and ai_review instructions, plus once more in the packet through the plan's report_standard.output_requirements, so three times for outline and review.

Corrections: (1) The 49 calls include team_requests x2. These lack the key but do see the question text, because they carry the research_plan artifact; the reviewer's breakdown leaves them out. (2) 'A sharp question would only steer the collector, briefs and report writer' understates things. The team brief, which a model wrote from research_question, is injected as team_context.brief into every stage a role owns, so the question's intent does reach analytic stages, paraphrased into work orders. (3) The recommendation exempts evidence_extraction_batch. That is 26 of the 79 calls, and the stage decides which claims exist: META's 26 batches produced 169 claims and 150 were stored. Its packet carries team_context with brief null and the generic doctrine only, so excluding it leaves the evidence pool unsteered. (4) A simpler carrier: approveResearchPlan already writes metadata_json, and loadRunContext already selects metadata_json, so storing the approved framing there needs no extra SELECT. It also records exactly what the human approved.

### GAP-1-3: 'Request plan changes' saves notes that nothing reads; the run sits at the gate unchanged

Severity **high**, effort **S**, verdict **confirmed**, JD trait: Lets the user supply the asset-specific reframing (e.g., 'two engines') before any analysis spend

**Problem.** requestResearchPlanChanges only merges research_plan_change_request into research_runs.metadata_json and leaves the stage waiting_for_human. No code reads the key. The plan handler never re-runs and approveResearchPlan ignores it. The UI says 'Plan-change notes saved' and then clears the textarea. The notes are never shown again, so a user who then approves believes the feedback was applied. The same no-op is exposed twice (request-plan-changes route and approve-plan with action=request_changes), and no test covers it. The final gate can't steer the analysis either: needs_more_work at human_review resets only ai_reviewer, human_review, export and refresh_schedule. Its notes reach only the report writer. That leaves the plan gate as the only cheap place to steer the analysis, and it does nothing.

**Evidence.** src/lib/workflow/orchestrator.ts:579-610 (metadata write only). grep for research_plan_change_request across src: the only hit is the writer at orchestrator.ts:601. orchestrator.ts:400-452 approveResearchPlan reads no notes. research-plan.ts never reads metadata. src/app/assets/[id]/run/page.tsx:494-512 (message at :505, setPlanChangeNotes("") at :506). ResearchPlanCard :254-271 never renders notes. src/app/api/research-runs/[id]/approve-plan/route.ts:17-24 duplicates request-plan-changes/route.ts:12-16. grep of tests/ for requestResearchPlanChanges/request-plan-changes: no hits. DB: select count(*) from research_runs where metadata_json ? 'research_plan_change_request' → 0. Precedent: review/route.ts:131-135 resets only the tail stages and writes report_revision_request, which reporting/runtime.ts:58 reads as human_revision_request.

**Recommendation.** As proposed. In one transaction, append the notes to metadata.research_plan_feedback[], set the research_plan stage to 'pending' and the run to 'running'. The route then calls enqueueResearchRun. research-plan.ts passes the feedback as human_plan_feedback to the framing call, and the gate re-opens on plan version n+1. Let approve-plan accept an optional zod-validated framing object for direct edits. Save it as a new artifact version before acceptCurrentArtifacts, so small edits need no model call. Delete the action=request_changes branch. In the UI, show earlier feedback and a 'Redrafting plan' state. Add a DB test: request changes, run the worker, and assert that research_plan reaches version 2, the framing packet contains the notes, and the stage is waiting_for_human again. Update docs/system.md and the plan-gate step in docs/architecture.md.

**Verifier check.** orchestrator.ts:580-610 only merges research_plan_change_request, _by and _at into metadata and sets the run to waiting_for_human. A grep of src, tests and scripts for research_plan_change_request finds only that writer (:601). approveResearchPlan (:400-452) and research-plan.ts read nothing from metadata. In run/page.tsx, handleRequestPlanChanges shows 'Plan-change notes saved. The run remains at the research-plan gate.' and then clears the textarea, and ResearchPlanCard never renders the notes. Both approve-plan/route.ts:17-24 (action=request_changes) and request-plan-changes/route.ts call the same no-op. No test covers either path. DB: 0 runs have research_plan_change_request. The review-route precedent holds: review/route.ts resets only ai_reviewer, human_review, export and refresh_schedule, and writes report_revision_request, which reporting/runtime.ts:58 reads. upsertArtifact (artifacts/repository.ts) inserts artifact_version prior+1 and supersedes the prior version, so a redraft versions correctly. Severity stays high: this control silently discards input at the only pre-spend point where the user can steer.

### GAP-1-4: Archetypes can't be chosen or corrected at the gate; every UI or default run is composed as operating_company_core

Severity **medium**, effort **S**, verdict **corrected**, JD trait: Segment- and archetype-specific drivers (marketplace/logistics/ads), SOTP or look-through valuation where the business needs it

**Problem.** The v3 spec says the plan gate approves 'scope, archetypes, and source strategy', but no path lets anyone set them. UI-created runs insert metadata_json '{}', and the create schema has no archetype field. archetype_composition therefore defaults to operating_company_core for every profile except 'financials'. Archetypes are set only through the RESEARCH_ARCHETYPES env var in scripts/new-equity-run.ts. The registry's asset-specific modules (advertising_platform, marketplace, logistics_network, holding_company, emerging_market_multi_country, ...) carry the metric families, process nodes, scenario drivers and valuation methods that make analysis asset-specific, and they were never used for META, MELI or Exor. A JD run from the UI would get the same generic core, with no marketplace, logistics or EM modules.

**Evidence.** docs/research-os-v3-spec.md:176. src/lib/research/run-service.ts:35 ('{}'::jsonb). src/lib/api/validation.ts:37-43 (no archetype field). src/lib/research/handlers/archetype-composition.ts:14-30 (default operating_company_core). scripts/new-equity-run.ts:35,108. Registry src/lib/research/archetypes/registry.ts: advertising_platform :332 (metric families ad_impressions/cpm_or_cpc/advertiser_count at 20/20/12 quarters, 5 ad process nodes, ad scenario drivers, sotp allowed at :340-358), marketplace :130, logistics_network :294, holding_company :522, emerging_market_multi_country :601. Default methods :80-81 sotp 'Holding-company only' / nav disallowed. DB: select canonical_name, metadata_json->'v3_archetypes', count(*) from research_runs join assets where pipeline_version=3 → Meta ['operating_company_core'] x10, MercadoLibre ['operating_company_core'] x4, Exor ['operating_company_core'] x1. The Exor plan's valuation_methods have dcf required and sotp/nav disallowed, for a holding company. These modules feed downstream: historical-record.ts:104 reads the plan's required_historical_metrics, business-process-analysis.ts:40 reads required_process_nodes, operating-model.ts:101 reads required_scenario_drivers.

**Recommendation.** Let the framing call propose archetypes and overlays from a z.enum of registry keys, each with a one-line reason. Run composeProfile, which already reports conflicts, and persistV3Composition before buildResearchPlan. Show the archetypes as editable checkboxes at the gate. A change goes through the same recompose-and-rebuild path and is logged with reviewed_by and override_reason (spec section 6). Accept an optional archetypes/overlays field in createResearchRunSchema too, so scripts stop depending on a leaky env var. Don't promise SOTP: either make asset-valuation prefer composedProfile.valuation_methods when a composition exists, or state that a segment or SOTP valuation engine is separate work. Verify: on a mock META run the plan lists advertising_platform, and historical_record's uncovered_required_metrics includes ad_impressions.

**Verifier check.** Confirmed: run-service.ts inserts '{}'::jsonb. createResearchRunSchema (validation.ts:30-43) has no archetype field. archetype-composition.ts falls back to operating_company_core for every profile except financials. The only override is the RESEARCH_ARCHETYPES env var (new-equity-run.ts:35,108). DB: Meta 10/10, MercadoLibre 4/4 and Exor 1/1 runs are operating_company_core. The env-only path has already gone wrong: NuScale run e78f934f (2026-07-19) was composed with MELI's set (marketplace, payments_network, lender, logistics_network, advertising_platform plus emerging_market_multi_country) and re-run two minutes later as 460c7a45 with industrial_hardware. The archetypes do feed historical-record.ts:103-107 (plan required_historical_metrics), business-process-analysis.ts:40 and operating-model.ts:101.

The valuation part is overstated. asset-valuation.ts:205-215 takes required_lenses from research_profiles.required_valuation_lenses_json first. The operating_company row has ['dcf','multiple','cash_flow'], and META's valuation packet carries exactly that, so composedProfile.valuation_methods is ignored whenever the profile row has lenses. No SOTP or NAV engine exists either; 'sotp' appears only in valuation/validation.ts:64-67 and v2-contracts. So 'On an Exor run, sotp/nav become allowed' would change only the plan card, not the valuation, and the JD trait 'SOTP or look-through valuation' is not delivered by choosing an archetype. I lowered severity to medium. The gain is in metrics, process nodes and scenario drivers, and META's report already covers impressions and price-per-ad without the advertising archetype.

### GAP-1-5: The investment horizon is a global env default (3 years), not a plan decision

Severity **medium**, effort **S**, verdict **confirmed**, JD trait: Normalized FCF modeled 2026-2031 and a 5-year no-rerating return; framework Stage 1 'Investment horizon'

**Problem.** Framework Stage 1 makes the investment horizon part of defining the asset, but the plan neither shows nor sets it. forecastHorizon reads RESEARCH_FORECAST_YEARS (default 3) for every asset. For META that means three years of heavy capex: explicit FCFF is negative and terminal value is 99-129% of EV. The thesis is pinned to 'Through fiscal 2028', and the 3-year window drives the 'not supportive' call. This overlaps with valuation-horizon findings; the fix here is the per-run control at the gate.

**Evidence.** Framework :1053-1063 ('Investment horizon'). src/lib/research/valuation/engine.ts:355-356 (env default 3). Callers using the default: operating-scenarios.ts:62, operating-model.ts:91, asset-valuation.ts:412-413. docs/system.md:162. META investment_thesis.horizon = 'Through fiscal 2028'. report.md:17 'Terminal value is 99% to 129% of enterprise value in each case, because explicit cash flows are negative in aggregate'.

**Recommendation.** Make forecast_years a per-run value in [3,10]. It can ship before the framing call: add an optional forecast_years to createResearchRunSchema and run metadata, show it on the plan card, and let approve-plan edit it. Once GAP-1-1 lands, the framing call proposes it. Pass ctx.forecastYears as the second argument of forecastHorizon at operating-model.ts:91 and operating-scenarios.ts:62. Valuation follows through the stored forecast_horizon, and the env var stays as the fallback. Verify: a mock run with forecast_years=6 produces 6 yearly_drivers per scenario, validateScenarioDriverCoverage passes, and valuation_scenario_set has 6 explicit years.

**Verifier check.** engine.ts:355-357: forecastHorizon defaults to Number(RESEARCH_FORECAST_YEARS) || 3. It is called at operating-model.ts:91 and operating-scenarios.ts:62. asset-valuation.ts:412-413 uses the stored scenarioSetInput.forecast_horizon.years first and falls back to forecastHorizon. docs/system.md:161 documents the env default. META investment_thesis.horizon is 'Through fiscal 2028', and report.md:17 says 'Terminal value is 99% to 129% of enterprise value in each case, because explicit cash flows are negative in aggregate'. Framework line 1059 puts the investment horizon in Stage 1. This overlaps with any valuation-horizon finding in other dimensions. The per-run control is the part that belongs here.

### GAP-1-6: Nothing checks that the report answers the plan's questions or the central debate

Severity **medium**, effort **S**, verdict **confirmed**, JD trait: Executive conclusion built on the decisive insight; 'what would change my mind'

**Problem.** The outline validator checks only section structure: no standalone history chapter, one valuation chapter. The outline prompt asks for 'material investment questions' but never points at the plan, and the opening-section rule only says 'summarize the eventual judgment'. So a framing, even an excellent human-approved one, could be ignored without any error. The pipeline already forces unanswered team requests into outline.questions, so the machinery exists.

**Evidence.** src/lib/research/reporting/contracts.ts:82-89 (validateProductOutline). src/lib/research/reporting/runtime.ts:66-75 (outline rules, no plan reference). src/lib/research/team.ts:509-515 (includeUnansweredQuestions precedent). DB, META question_register: 15 entries, neither plan question present.

**Recommendation.** As proposed, using the includeUnansweredQuestions pattern rather than a hard failure, so Haiku does not get stuck in repair loops. After the outline call, insert any framing key_question id missing from outline.questions as status 'blocked' with follow_up. Add one outline rule: the conclusion section must state whether central_question held. decision_synthesis, which gets research_framing via GAP-1-2, records a short framing_verdict that ai_review can check. Verify: on a mock run every framing key_question id appears in question_register.

**Verifier check.** contracts.ts:82-89 validateProductOutline checks only for standalone history/evidence chapters and for a single valuation chapter. The outline rules at reporting/runtime.ts:66-75 ask for 'material investment questions' and an opening that summarizes the judgment, but never point at the plan's questions. includeUnansweredQuestions (team.ts:509-515) is a working precedent for forcing items into outline.questions without failing. DB: META question_register has 15 entries, and neither plan question is among them. The finding depends on GAP-1-1 existing.

### GAP-1-7: The plan gate is a rubber stamp in practice: the card hides the plan's questions, and paid runs use a canned checklist question

Severity **low**, effort **S**, verdict **corrected**

**Problem.** The plan card shows budget, profile, method, source, module and stage lists, but not the plan's questions, so there is nothing to decide. The intake quick-pick and the paid-run script fill in generic questions; the script's default is a coverage checklist, not a debate. Approvals take seconds. The only UI-created run has sat at the plan gate for three months. Once the framing exists (GAP-1-1), it must be the first thing on the card, or the gate will stay a formality.

**Evidence.** src/app/assets/[id]/run/page.tsx:254-271 (ResearchPlanCard; report_standard.questions not rendered); :783 quick-pick 'Research ${assetName} as a long-term compounder'. scripts/new-equity-run.ts:61 default question; :101 requested_by 'system-test-harness'. DB: 66 runs, 58 requested_by system-test-harness; 26 v3 runs with 5 distinct questions. Median seconds from creation to plan approval: system-test-harness 0.5 (n=9), 'user' 22.9 (n=7), META paid run 51.1 ('user-approved-paid-test'). 0 change requests. Run 3abf201d (Exor, the only requested_by='user' run, question = the quick-pick text) has been waiting_for_human at research_plan since 2026-07-24.

**Recommendation.** Fold this into GAP-1-3's UI change. Render the framing first as editable fields, move the static standard, method and stage lists into one collapsed details block, and drop the generic second question. Don't add approved_framing_hash; storing the approved framing in metadata (GAP-1-2) already records what was approved, and edits show up as a new artifact version. Optionally, let scripts/new-equity-run.ts take RESEARCH_FRAMING_FILE (JSON checked against the same zod contract) to pre-fill framing, and print the drafted framing before any auto-approve.

**Verifier check.** Mostly accurate. ResearchPlanCard (run/page.tsx:254-271) shows research_question as the lead line, which is report_standard.questions[0], but not the generic second question. So 'hides the plan's questions' is only half true. The quick-pick 'Research ${assetName} as a long-term compounder' and the default question in new-equity-run.ts:61 are confirmed. For v3 runs, the median time from creation to plan approval is 0.49 s for system-test-harness (n=9), 22.85 s for 'user' (n=7) and 51.07 s for META, and 7 more v3 approvals were made by agents ('via Claude Code', 'codex-user-authorized'). That is 16 of 25 approvals made by a harness or an agent, although spec line 172 says human review 'cannot be substituted by an AI or test harness in production'. Exor run 3abf201d (requested_by 'user', the quick-pick question) has been waiting_for_human at research_plan since it was created on 2026-07-24. The UI half of the recommendation duplicates GAP-1-1 and GAP-1-3, and approved_framing_hash plus edited:boolean adds tracking state nobody consumes. Severity lowered to low as a standalone item.

## GAP-2: Research doesn't build up across runs: each run starts from zero, and the 'refresh schedule' is a record that nothing executes

Each run starts from nothing. No run carries lineage (no parent column; the refresh route writes metadata_json '{}'), and no stage reads another run's artifacts: task reuse, evidence and gaps are all keyed on research_run_id. The prior run's blocked questions, unanswered team requests, failed searches and valuation are thrown away. The database shows the result. In the four META runs that reached the final gate, the same blocked questions came back (governance proxy in 3 of 4, ERP/beta in 3 of 4, the equity-bridge debt/leases in 2 of 4). The same proxy search failed 10 times across 4 runs, and no proxy document was ever linked. The weighted target went 553, then withheld, then 618, then 510 in five days, with no "what changed" note. The refresh schedule is a record nothing reads, the refresh route has no UI caller or test and was never used, and every "refresh" run type runs all 24 stages, valuation_refresh on a lower evidence target. Most of the pieces needed to build on earlier runs already exist and are unused: kpiHealth (a pure threshold evaluator), deterministic filing capture, stable EDGAR document rows (since the RMEM3 fix), evidence_claims.supersedes_id, research_assumptions versioning and review_decisions.follow_up_date. Caveat: most past runs were dev iterations with code changes between them, so any reuse must be keyed on pipeline and prompt version.

<details><summary>Measurements</summary>

All figures come from read-only SELECTs on the dev DB and greps of the repo, on 2026-10-21.
- v3 runs per asset (count, sum actual_cost_usd): meta-platforms 10, $7.62; sofi 9, $0.89; mercado-libre 4, $1.93; nuscale-power 2, $0.39; exor-nv 1, $0.00.
- All run statuses: 1 completed, 11 waiting_for_human, 37 needs_more_work, 11 failed, 6 pending.
- research_runs with requested_by='refresh': 0.
- refresh_schedule artifacts: 1 (SoFi c2822589, next_refresh_at 2026-11-03).
- research_artifacts with status 'accepted': 0. acceptCurrentArtifacts landed in commit 5e1c424c on 2026-10-14, after the last paid run on 10-13.
- review_decisions: 1 row (SoFi approved_for_tracking; what_would_change_mind, open_questions and follow_up_date all null).
- research_assumptions: 0 rows. evidence_claims.supersedes_id: set on 0 of 2,039 rows.
- META document reuse: 182 distinct documents, 81 linked to 2 or more runs, 31 to 4 or more. 4fae against 7fa1 by URL: 29 of 33 documents shared, 25 of 25 SEC filings shared.
- 4fae: 150 claims across 22 documents, 26 evidence_extraction calls ($0.098, 165k input / 175k output tokens). ai_reviewer cost $0.613 of the $1.05 total.
- META cost by stage across 10 runs: ai_reviewer 2.611, historical_record 1.189, evidence_extraction 0.769, decision_synthesis 0.617, asset_valuation 0.595, company_genesis 0.523, source_discovery 0.436.
- Recurring source-gap themes, by keyword, across the 8 META runs that have gaps: founder 7, segment/Reality Labs 6, capex 6, operating KPI 4, governance 3. Gap keys: 586 distinct in 591 rows, so they cannot be matched across runs.
- Proxy-related retrieval attempts: 10 across 4 META runs. Proxy documents linked to any META run: 0.
- Unavailable team requests per gate run: 02c8 8, 1d42 4, 7fa1 4, 4fae 6.
- META weighted_target by run: 553.13 (10-08), withheld (10-10), 617.56 (10-11), 510.40 (10-13), against prices 719.87, 718.67, 718.67 and 742.96.

</details>

### GAP-2-1: Refresh schedule is a stub: nothing reads next_refresh_at, the refresh route is unreachable, and the human's follow-up date is never written

Severity **medium**, effort **S**, verdict **corrected**, JD trait: Monitoring dashboard and thesis breakers (JD sections 18-19) only matter if something rechecks them

**Problem.** refresh_schedule writes automatic_refresh=true and next_refresh_at, but no code or script reads either. The AGENTS.md invariant ('Don't complete a run before export and refresh scheduling') therefore closes runs on a record with no effect. Product requirement line 25 ('Refresh when accepted research data changes and show freshness') is unmet. The one completed v3 run (SoFi, approved_for_tracking) is due on 2026-11-03, and nothing will happen. The refresh route has no UI caller and no test, and has never been used. review_decisions.follow_up_date, the reviewer's own follow-up date, has no writer.

**Evidence.** src/lib/research/handlers/refresh-schedule.ts:11-35 is the only file that matches next_refresh_at|automatic_refresh|refresh_after_days in src/ and scripts/. Query: select research_run_id, content_json from research_artifacts where artifact_type='refresh_schedule' -> 1 row: c2822589 (SoFi), next_refresh_at 2026-11-03T18:16Z, automatic_refresh true. Query: select requested_by, count(*) from research_runs group by 1 -> no 'refresh' rows (the route sets requestedBy 'refresh' at src/app/api/research-runs/[id]/refresh/route.ts:42). grep for '/refresh' in src/app and src/components finds only the label at src/components/charts/PipelineProgressChart.tsx:51. No test or script calls the route; tests/sofi-research-e2e.test.ts:493-507 checks only that the artifact exists. review_decisions.follow_up_date is defined at src/db/schema/thesis.ts:103; the INSERT at src/app/api/research-runs/[id]/review/route.ts:95-104 omits it, and grep finds no other writer. Overall run statuses: 1 completed, 11 waiting_for_human, 37 needs_more_work.

**Recommendation.** Do this after GAP-2-2 adds lineage, so the button starts a linked run. (1) Set automatic_refresh to false, or rename it to refresh_due_at, in refresh-schedule.ts:22. Paid runs must never start on their own (AGENTS.md). (2) Add a due query in a small src/lib/research/refresh-due.ts. Per asset, take the latest refresh_schedule artifact and mark it due when the earliest of next_refresh_at, review_decisions.follow_up_date, or a new 10-Q/10-K accession after the run's newest stored filing (the check from GAP-2-4) is in the past and the asset has no newer run. Show 'Refresh due since <date> (<reason>)' with a button on the asset page that calls the refresh route. (3) Accept follow_up_date in the review schema (src/lib/api/validation.ts) and write it at review/route.ts:94-104. Verification: a unit test on a test DB with a past next_refresh_at returns one row; the due check writes no model_call_logs rows; the review route stores follow_up_date.

**Verifier check.** The code claims hold. refresh-schedule.ts:20-32 is the only place in src/, scripts/ and tests/ that mentions next_refresh_at, automatic_refresh or refresh_after_days. read-model.ts:206 passes the artifact through, but no component renders it. The export's renderRefreshSchedule (research-package-generator.ts:1112-1124) is a fixed table that never reads the artifact. grep for '/refresh' in src, tests and scripts finds no caller of src/app/api/research-runs/[id]/refresh/route.ts. requested_by groups are user 1, investment-benchmark-v1 6, paid-meli-acceptance 1 and system-test-harness 58, with none 'refresh'. The e2e test (sofi-research-e2e.test.ts:493-507) only checks that the artifact exists. follow_up_date (thesis.ts:103) is missing from the INSERT at review/route.ts:94-104, while what_would_change_mind and open_questions are written. Severity is high in the finding, which overstates it. The one completed run, c2822589, has requested_by 'system-test-harness' and reviewed_by 'test-harness', was created 2026-08-06 on opencode models, and cost $0.38. None of the 11 waiting_for_human runs was ever approved, so no real research has reached refresh_schedule. A due trigger on its own also adds no depth: under the current code, a refresh it starts is another from-scratch run (see GAP-2-2). The flag automatic_refresh:true is still misleading, so medium is the fair rating.

### GAP-2-2: No run lineage and no carry-forward: a new run re-asks, from scratch, the blocked questions and unavailable requests the last run already identified

Severity **high**, effort **M**, verdict **corrected**, JD trait: Section 20 (confidence/completeness gates, 'largest missing evidence named') becomes a work queue for the next run instead of a dead end

**Problem.** A run's most useful leftovers are its question_register entries with status 'blocked' and a precise follow_up, its unavailable team requests (with source_role), the reviewer's open_questions and what_would_change_mind, and its decision and valuation. They are scoped to that run and never read again. The next run's plan is built only from the profile and the research question. The collector's first review sees only the current run's documents. So every run spends its budget rediscovering the same holes instead of filling them. That is the main reason depth does not build up from one run to the next.

**Evidence.** research-plan.ts:40-42: plan questions are only ctx.researchQuestion plus one generic question. source-discovery.ts:32-44: the collector packet's previous_rounds holds only this run's rounds. compose.ts:21-23 and runtime.ts:80-81: blocked questions go to requestMissingResearch for the same run only. run-context.ts:219-262: task reuse is WHERE research_run_id = runId. team.ts:170-178: keepCurrentReferences drops IDs from outside the run. refresh/route.ts:38-48 copies question, profile and budget only; run-service.ts:35 writes metadata_json '{}', so there is no prior_run_id. Query on question_register (validated) for the four META gate runs: proxy/governance blocked in 1d42, 7fa1 and 4fae; ERP/beta sourcing blocked in 02c8, 7fa1 and 4fae; current debt and finance leases in the equity bridge blocked in 7fa1 and 4fae; 20-quarter extension blocked in 7fa1 and requested again in 4fae. team_requests unavailable: 8/4/4/6 per run. source_gaps keyword themes across the 8 META runs with gaps: founder 7, segment/Reality Labs 6, capex 6, operating KPI 4, governance 3. Gap keys are slugs of model prose (586 distinct keys in 591 rows), so gaps cannot be matched across runs today.

**Recommendation.** (1) Lineage, with no migration: the refresh route and the asset create route write metadata_json.prior_run_id, defaulting to the asset's latest run that has a report_document, with fresh_start:true to opt out. Label a prior run 'unreviewed' when its artifacts are only validated. (2) First carry forward the prior run's documents, not just its questions (missed issue 1). That directly fixes the proxy and peer-filing repeats. (3) Add a deterministic prior_research block of about 10 KB in buildResearchPlan (research-plan.ts:11). It holds the prior run id, cutoff, decision, weighted_target, blocked and qualified questions with follow_up, unavailable team requests with source_role, and the human's open_questions and what_would_change_mind. The plan gate shows it to the human. Pass the same list to the round-1 collector packet and the outline call, and record carried_from_run_id on each question_register entry that repeats. (4) Count blockers that repeat across 2 or more runs and list them in the plan as 'repeat blockers' so the developer fixes the code behind them, such as the 10-Q cap or the missing DEF 14A, instead of expecting the model to solve them. Verification: in the mock e2e, run A has a blocked question, refresh B lists it in research_plan.prior_research, and B's question_register carries carried_from_run_id. Do not promise that repeated blockers drop on the next paid META run unless the deterministic fixes have landed.

**Verifier check.** The structure claims are correct. research_runs has no lineage column. run-service.ts:35 inserts metadata_json '{}' (acceptance scripts add keys later, but none of them is a prior run). research-plan.ts:40-41 builds its questions only from ctx.researchQuestion plus one generic question. The previous_rounds field in source-discovery.ts:43-45 holds only this run's rounds. Task reuse at run-context.ts:220-224 is keyed on research_run_id. Memory retrieval is run-scoped too (retrieve.ts:81-84; graph.ts:40,79). keepCurrentReferences is at team.ts:169-177. Unavailable team requests per run (8/4/4/6) and gap keys (586 distinct in 591 rows) are confirmed. Two facts need fixing. First, ERP/beta was blocked in all 4 gate runs, not 3: 1d42 asks for 'a documented beta'. Second, the causal claim that missing carry-forward is 'the main reason' depth does not build up is too strong. Most of the recurring blockers have deterministic causes that passing questions forward would not remove. The 20-quarter gap is the 12-10-Q cap at corpus.ts:612-615 (see missed issue 2). Beta/ERP sourcing was only added in bdd2d659 and #73 on 2026-10-14, after every run. The proxy was in fact fetched in 3 runs but filed under another role and never carried forward (see GAP-2-3 and missed issue 1). The collector already searched for these items, so telling it 'search for these first' mostly repeats the same searches.

### GAP-2-3: Failed searches don't escalate across runs: the governance proxy has been searched and missed in every recent META run, and EDGAR's DEF 14A is never fetched

Severity **high**, effort **S**, verdict **corrected**, JD trait: Section 10 governance: founder economic vs voting ownership; subsidiary RSU grants

**Problem.** With no cross-run memory, each run tries the same web search for the proxy statement, fails, and records governance as unsourced. Voting control versus economic ownership (a JD-example trait) is therefore missing from every META report. The deterministic EDGAR path already reads the submissions index, which lists DEF 14A, but selectResearchFilings keeps only 10-K, 10-Q and 8-K 2.02 for domestic issuers. The planner names DEF 14A as the expected document for proxy_and_governance. May overlap with governance-depth findings; it is included here for the run-to-run repetition evidence.

**Evidence.** Query on source_retrieval_attempts (META) matching proxy or DEF 14A: 02c8: 2 attempted; d623: 1; 1d42: 5 (including unavailable, no_substantive_source_fetched); 4fae: 2 unavailable, no_substantive_source_fetched. Query on research_run_sources joined to source_documents, title or url matching proxy/def 14a: 0 documents in all 10 META runs. src/lib/research/sources/corpus.ts:594-621: domestic branch returns annual + 10-Q + 8-K item 2.02 only. src/lib/research/sources/planner.ts:35: proxy_and_governance terms ['proxy statement','DEF 14A','board composition']. 4fae question_register: 'Who controls voting power, what share classes exist...' blocked, follow_up 'Retrieve the latest DEF 14A'.

**Recommendation.** (1) In selectResearchFilings' domestic branch, add the newest DEF 14A filed by the cutoff: eligible.filter(f => f.form === 'DEF 14A').slice(0,1), with semanticRole 'proxy_and_governance'. (2) In mapToSourceRole (role-coverage.ts, next to the earnings_release check at line 27), return 'proxy_and_governance' when metadata.semanticRole === 'proxy_and_governance', before the generic 'sec' branch. That is two small edits and no model call, and storedSecFiling reuses the bytes across runs. (3) Drop the 'previously_failed_queries' idea. The data shows good proxy queries succeeded; the real losses were carry-forward and prose queries (missed issues 1 and 3). Verification: a unit test of selectResearchFilings with a submissions fixture containing DEF 14A returns it with that role; mapToSourceRole on its metadata returns proxy_and_governance; on the next META run, source_role_coverage shows proxy_and_governance covered by a sec.gov Archives document, and the governance question_register entry is not blocked.

**Verifier check.** Confirmed: selectResearchFilings at corpus.ts:594-621 keeps only 10-K, 10-Q and 8-K item 2.02 for domestic issuers, and loadSubmissionFilings (corpus.ts:660-683) does not filter by form, so DEF 14A rows are already available. planner.ts:35 names 'DEF 14A' for proxy_and_governance. The retrieval-attempt counts (02c8 2, d623 1, 1d42 5, 4fae 2) are confirmed. Refuted: '0 proxy documents in all 10 META runs'. The title/URL match missed the document. sec.gov/Archives/edgar/data/1326801/000162828026025532/meta-20260416.htm (source_document 9341b593) is Meta's 2026 Definitive Proxy Statement. Its stored text begins 'SCHEDULE 14A ... Definitive Proxy Statement' and mentions 'Class B common stock' 20 times. Web search fetched it in 02c8, d623 and 1d42 and filed it as web_founder_and_company_history. It yielded 23 claims (12/6/5), for example 'Mark Zuckerberg is listed in the 2026 proxy as Founder, Chairman...'. It was never linked to 7fa1 or 4fae. The well-formed proxy queries in 02c8, d623 and 1d42 did find a document. The 4fae failures came from prose-as-query report requests (missed issue 3). A mapping gap also applies: filingSourcePayload sets sourceType 'sec_filing_def 14a', and mapToSourceRole (role-coverage.ts:27-33) sends anything containing 'sec' to regulatory_filing. So a DEF 14A added only to selectResearchFilings would not cover proxy_and_governance. 'Map it the same way as annual/quarterly' is therefore wrong, because those are mapped generically to regulatory_filing.

### GAP-2-4: Thesis breakers and the KPI dashboard are never checked against new filings, though a free deterministic check is mostly built

Severity **medium**, effort **M**, verdict **corrected**, JD trait: Section 18-19: thesis breakers with numeric thresholds; five-number monitoring dashboard

**Problem.** The monitoring_dashboard items are machine-checkable: metric_key, current_level, bear and bull thresholds, a quarterly 10-Q cadence. A pure evaluator already scores them against observations. Statement capture from stored filings is deterministic and already runs from a script against an existing run. Nothing runs them when a new 10-Q appears, so the monitoring the framework requires (Stage 22, Gate 15) exists only on the day of the run. A cheap check is also the right trigger for spending money on a paid refresh.

**Evidence.** 4fae monitoring_dashboard item: metric_key capex_pct_revenue_quarterly, current_level 0.495, bear_threshold 0.55, bull_threshold 0.4, reporting_frequency 'Quarterly (filing date; 10-Q)'. Ad impressions and price-per-ad items have the same structure. src/lib/research/reporting/kpi-health.ts:42-79: kpiHealth(artifacts) is pure and returns danger/caution/healthy per item. src/lib/research/reporting/data-views.ts:7-14: observations come from financial_statement_set, historical_record and market_price_history. src/lib/research/history/filing-store.ts:14-15 plus scripts/capture-filing-statements.ts capture statements deterministically for a run. thesis_breakers holds only free-text thresholds (for example 'Quarterly Reality Labs operating loss above 5,500 million...'), with no metric_key. The worker poll loop already claims two job kinds (research-worker.ts:80, 137, 173). store.ts:9 lists refresh_schedule among 'products' excluded from the report input hash.

**Recommendation.** First make dashboard items computable. In the monitoring_dashboard stage contract and validator, require metric_key to be either a captured observation key or a metric-catalogue key (metric-catalogue.ts already has operating_margin and fcf_margin; add capex_intensity = purchases of PP&E ÷ revenue). Mark the remaining items computable:false, typically MD&A operating KPIs such as ad impressions, price per ad and DAP. Then add scripts/monitor-check.ts <asset-slug>. It finds 10-Q/10-K accessions on EDGAR newer than the latest run's newest filing, exits with 'no new filings' when there are none, and otherwise stores the filing through the existing fetch/storedSecFiling path. It extracts statements with extractFilingStatements and computes each computable item through evaluateMetric/MetricBook, then kpiStatus. It saves a monitor_check artifact, listed in store.ts:9 products so the report hash is unchanged, and feeds 'danger' into the GAP-2-1 due badge. Add optional metric_key, operator and value fields to thesis_breakers. Verification: a unit test with a synthetic new quarter whose capex_intensity is 0.57 returns danger; the script creates no model_call_logs rows; items marked computable:false are reported 'not checkable', not 'healthy'.

**Verifier check.** Confirmed: kpiHealth (kpi-health.ts:42-79) is pure. researchObservations (data-views.ts:7-14) merges financial_statement_set, historical_record and market_price_history. captureFilingStatements (filing-store.ts:14-15) is deterministic. thesis_breakers are free text with no metric_key, for example 'Ad impressions delivered year over year below 8% for two consecutive quarters'. The worker loop handles run jobs and backtest tasks (research-worker.ts:77-80, 133-137, 172-175). The recommendation as written would not detect anything, though. The 9 dashboard metric_keys in 4fae (capex_pct_revenue_quarterly, operating_margin_gaap_quarterly, free_cash_flow_quarterly_derived, weighted_average_diluted_shares_millions, ad_impressions_yoy_growth, ...) are names the model made up. Not one matches a financial_statement_set observation key; those use us_gaap_* keys, such as us_gaap_PaymentsToAcquirePropertyPlantAndEquipment and us_gaap_OperatingIncomeLoss. Only 5 of the 9 keys have any observations, and all come from the model-written historical_record. After a deterministic capture of a new 10-Q, kpiHealth would find no new point for any item and fall back to the analyst's current_level (kpi-health.ts:59-61), so it would report the same status. The proposed 'reproduces today's states' check would pass trivially and prove nothing.

### GAP-2-5: Evidence, history and company-genesis work is redone on a corpus that is about 88% unchanged between runs

Severity **low**, effort **M**, verdict **corrected**

**Problem.** Evidence claims, task outputs and history artifacts are all run-scoped. A run two days after the last one re-reads every filing through the source reader, re-normalizes the same 20 quarters and re-writes company genesis (Meta's 2004 founding). At Haiku prices this is cents. At a frontier tier, the same share of spend goes to work that new filings did not change, and re-extraction from identical text also adds variance. Since the RMEM3 fix, EDGAR documents keep a stable source_documents row, which makes reuse by document safe.

**Evidence.** Docs by URL: 4fae has 33, of which 29 were also in 7fa1 (two days earlier); all 25 sec.gov/Archives filings were shared. 4fae still made 26 evidence_extraction calls (165k input / 175k output tokens) and wrote 150 new claims across 22 documents. Cost by stage across all 10 META v3 runs ($7.62): ai_reviewer 2.61, historical_record 1.19, evidence_extraction 0.77, decision_synthesis 0.62, asset_valuation 0.60, company_genesis 0.52, source_discovery 0.44. historical_record, evidence_extraction, company_genesis and source_discovery total 2.92, or 38%. Of 182 META documents, 81 were linked to 2 or more runs and 31 to 4 or more. evidence_claims.supersedes_id is set on 0 of 2,039 rows. run-context.ts:219-262: task cache keyed on research_run_id. Claims link to documents through source_locations.source_document_id and document_chunk_id.

**Recommendation.** Defer this until GAP-2-2 lineage exists and a higher-tier model is in use. Then start with the cheapest piece: reuse company_genesis, founder_profile and strategic_history_timeline from prior_run_id when no new 10-K or DEF 14A has arrived and the stage's prompt_version (model_call_logs.prompt_version) and pipeline_version match. After that, copy accepted claims per identical source_documents row under the same MEMORY_PARSER_VERSION (indexing.ts:12) and source-reader prompt version. Copy each claim's source_location and evidence_link, set supersedes_id to the old claim, and send only new documents to the source reader. Verification: a mock follow-up run with one added document calls the source reader only for that document's batches, and its claim count matches the prior run's plus the new document's claims.

**Verifier check.** The facts are confirmed. 4fae has 33 documents by URL, 29 of them shared with 7fa1, and 25 of 25 SEC Archives filings shared. It made 26 source-reader calls (165,475 input / 174,729 output tokens, $0.098). evidence_claims.supersedes_id is set on 0 of 2,039 rows. The task cache is run-scoped (run-context.ts:220-224). Prior runs' claims carry review_status 'accepted' (1,656 rows), so reuse has material to draw on. The 38% figure overstates current waste, though. It sums all 10 META runs, including dev iterations with costly historical_record repair loops (02c8 $0.32, 1d42 $0.38, 7fa1 $0.24). On the latest pipeline (4fae), company_genesis $0.047 + evidence_extraction $0.098 + historical_record $0.058 + source_discovery $0.005 = $0.21 of $1.05, about 20%. The user's complaint is depth, not cost, and nothing shows re-extraction adding variance. At Haiku prices this is a low-severity optimisation that matters only after a move to a frontier tier.

### GAP-2-6: No 'what changed since the last run': framework section 14 version control is unimplemented and its table sits empty

Severity **medium**, effort **S**, verdict **confirmed**, JD trait: Final section 'what would change my mind' becomes checkable: the next run states what actually changed

**Problem.** The framework requires a version table for every material assumption change (previous value, new value, new evidence, process and moat affected, valuation impact) and says prior assumptions must not be silently overwritten. The pipeline has a research_assumptions table built for this (assumption_version, supersedes_assumption_id) but never writes to it. META's headline valuation swung widely between runs with no explanation. The reader cannot tell new evidence from model noise, and the report cannot say 'our view changed because Q3 capex came in at X'.

**Evidence.** docs/research-framework-v2.1.md:2373-2382 (section 14 Version-Control Requirement). Query: select count(*) from research_assumptions -> 0. src/lib/research/artifacts/repository.ts:189-229 upsertAssumption: grep finds no caller outside the repository. valuation_scenario_set.weighted_target per META run: 02c8 (10-08) 553.13 at price 719.87; 1d42 (10-10) withheld; 7fa1 (10-11) 617.56 at 718.67; 4fae (10-13) 510.40 at 742.96. That is -17% from 7fa1 to 4fae while the price moved +3.4%. grep of the 4fae report for references to a prior run/report finds only 'The earlier draft figures of 190.56, 513.71 and 745.09 USD cannot be traced' (line 2904), which is the same run's first report round, not 7fa1.

**Recommendation.** As proposed: add a deterministic src/lib/research/decision/change-log.ts. When prior_run_id exists, it diffs a fixed field list: weighted_target, per-scenario value_per_share, discount rates, terminal anchors and probabilities; key operating drivers by year; monitoring_dashboard current_level by metric_key; and decision. It emits a version_change_log artifact with the section 14 columns, and the conclusion writer must explain each material change. Also record both runs' pipeline_version and per-stage prompt_version from model_call_logs, so a change with no new evidence (no claims from documents published after the prior cutoff) is labelled 'method/model change' instead of looking like a view change. Leave research_assumptions unused. Verification: a unit test on two fixture artifact sets; a mock follow-up run produces version_change_log and a 'Changes since <prior cutoff>' table.

**Verifier check.** docs/research-framework-v2.1.md section 14 (around lines 2373-2382) requires the version table and 'Do not silently overwrite prior assumptions'. research_assumptions has 0 rows, and upsertAssumption (repository.ts:189) is only defined and exported at :287, with no caller in src, scripts or tests. valuation_scenario_set.weighted_target: 02c8 553.125, 1d42 null, 7fa1 617.555, 4fae 510.395, which matches the finding. Nothing in the 4fae report compares against a prior run. As the reviewer notes, code changed between these runs (for example the #42 beta/ERP work on 10-14), so most of the swing is method change. That is exactly why a diff that names the cause is useful.

### GAP-2-7: Refresh run types are cosmetic: valuation_refresh re-runs all 24 stages on a lower evidence target, and the refresh route skips run-type validation

Severity **low**, effort **S**, verdict **confirmed**

**Problem.** The refresh route defaults to run_type 'valuation_refresh' and accepts any string. No stage is skipped for valuation_refresh, source_update or thesis_investigation, so a 'refresh' is a full re-initiation. It is also a weaker one: the evidence target drops from 40+3/doc to 20+3/doc, the quality gate needs only 10 claims, and the next schedule is 180 days instead of 90. A user who clicks 'refresh' on a full initiation gets a shallower copy, with no link to the original.

**Evidence.** refresh/route.ts:27-35: run_type taken from the body without zod, default 'valuation_refresh'. The asset route uses createResearchRunSchema.parse at src/app/api/assets/[id]/research-runs/route.ts:50 (enum at src/lib/api/validation.ts:27-36). Counting skipForRunTypes in src/lib/workflow/stages.ts gives backtest_only 20 and quick_scan 4, and nothing else. evidence-extraction.ts:56-62: deep (40 base, floor 25) only for deep_dive and full_initiation_report. quality-gates.ts:87-92: valuation_refresh minEvidenceClaims 10. refresh-schedule.ts:17-18: 180 days for anything other than deep_dive or full_initiation_report.

**Recommendation.** As proposed: parse run_type with createResearchRunSchema.shape.run_type.optional(), default it to originalRun.run_type, and write metadata_json.prior_run_id (shared with GAP-2-2). Until refreshes are incremental, either give valuation_refresh the deep evidence targets or remove it from the run/page.tsx:784 select. Verification: a route test rejects an unknown run_type with 400, and a refresh of a full_initiation_report creates a full_initiation_report run whose metadata_json.prior_run_id is the original id.

**Verifier check.** refresh/route.ts:26-35 destructures run_type from the raw body, with default 'valuation_refresh' and no zod check. The asset route parses with createResearchRunSchema (route.ts:50; enum at validation.ts:27-36). The skipForRunTypes values in stages.ts are only backtest_only (20 stages) and quick_scan (4), so valuation_refresh, source_update and thesis_investigation run all stages (getAllStagesForRun, stages.ts:425-440). evidenceTargets (evidence-extraction.ts:56-62) uses base 40 and floor 25 only for deep_dive and full_initiation_report. quality-gates.ts:87-92 gives valuation_refresh minEvidenceClaims 10, and refresh-schedule.ts:17-18 sets 180 days for every other type. The UI select at run/page.tsx:784 offers valuation_refresh. Low severity is right, because the route has no caller today.

## GAP-3: Analysts only receive fixed packets and can't query anything: the depth limits other reviewers found are fixed caps that a read-only corpus and analytics lookup would remove

The META run was shallow mainly because stages are fed, not because data was missing. Every analysis stage and all 13 report sections got the same code-picked slice: 14 filing passages (22.5 KB, about 0.3% of the 7.65M-character indexed corpus) and the same 106 claims. The prompt calls that slice "the complete working context", and the harness rejects any tool call. I checked eight things the report or artifacts called "not available" or "absent": founder voting control, Class B share counts, peer pricing, the US ad market size, Reality Labs revenue history, $278.99bn of leases not yet commenced, the November 2025 $30bn note issuance, and receivables. All eight are in this run's document_chunks, accepted claims or historical_record. Three cheap push-side defects explain most of it: a NULL published_at filter that drops all peer and industry evidence, team-request retrieval locked to one source role, and team-request web searches built from the question's prose (6 of 6 fetched nothing). The structural fix is two local, read-only, run-scoped lookup tools, search_passages and get_series. They need an explicit change to the AGENTS.md invariant, plus harness work: the request side, multi-turn messages, the loop, the task key and telemetry. Tool_use parsing is the only piece that already exists. Fix the three defects first, and use a free deterministic probe check, not raw input tokens, to measure the effect.

<details><summary>Measurements</summary>

All figures are for run 4fae0fb1-76b3-4d2b-b386-e48eb9547a75 unless noted, from SELECT queries in psql. For timing I used one session-scoped TEMP table to hold parse IDs; nothing persistent was written. Scratch SQL is under /private/tmp/claude-501/-Users-japardinathaniel-Documents-GitHub-Investing-Research-Pipeline/fdaaf424-0588-4f7e-be73-9b055f9db53a/scratchpad/gap3-*.sql.

Corpus:
- Latest research-memory parses, excluding primary_source_context: 32 documents, 5,259 chunks, 7.65M characters. That includes 17 10-K/10-Q filings, the Snap FY2025 10-K PDF (393 chunks) and the IAB/PwC ad revenue report (87 chunks).
- Every 10-K/10-Q has statement-table chunks addressable by section_path (balance sheet, cash flows, income statement).

What the stages were given:
- filing_passages: the same 14 passages, 22,541 bytes, md5 8c6821b6..., in moat, business_process, operating_model and all 13 report_section tasks.
- Accepted claims: 150 in the run. The moat, operating-model, valuation and report-section packets got the same 106 (md5 2d190a66...). That includes 0 of 21 peer-company claims, 0 of 13 industry claims and 0 of 8 IR claims.
- Replaying the loadReportInputs claim query with "published_at IS NULL OR published_at <= cutoff" returns 149 claims, 34 of them peer or industry.
- Pushed claim IDs that appear anywhere in the task output: moat 0/106, operating_model 0/106, valuation 0/106, scenarios 19/106, business_process 32/120. The moat and valuation contracts have no claim-ID field, so the zeros there partly reflect the schema.
- Packet sizes (input_json->packet): moat 136 KB, business 153 KB, operating model 241 KB, valuation 149 KB. Report-section task inputs: 215-890 KB.

Model usage (model_call_logs):
- asset-analyst: 14 calls, 1.76M input tokens, 0.49M of them cache reads.
- export-writer: 23 calls, 3.66M input tokens.
- research-reviewer: 2 calls, 0.96M input tokens.
- Wall clock 14:37-15:40, $1.05 total.

Existing pull paths:
- No source_requests artifact in the run, so stage request rounds used = 0.
- 6 team-request searches, all attempt_status 'unavailable' / no_substantive_source_fetched (source_retrieval_attempts with request_id).
- Replaying request-1-5's keyword retrieval without the proxy_and_governance role filter: 6 of the top 8 passages are 'Risks Related to Ownership of Our Class A Common Stock' chunks containing 'voting power'. 63 chunks across 17 filings match '"voting power" Zuckerberg'.

historical_record:
- 2,311 observations, 142 metric keys, 20 quarterly periods.
- Family of Apps and Reality Labs revenue and operating income: 20 quarters plus 5 years each.
- CommonClassBMember: 53 quarterly observations.
- AccountsReceivable: 17 quarters. Capex: 18 quarters.
- ttm_series has 0 rows and statistics is {}.
- The operating-model packet keeps 6 periods per metric. The valuation packet gets one base year (history_ratios, 224 bytes).

historical_diagnosis: 17 of 17 diagnoses are 'unexplained'/'unassigned', plus 8 unexplained_inflections. An example is financing_cash_flow 2025Q4 (z=2.81), explained by FY2025 10-K Note 10 ($30.0bn notes, November 2025).

Report prose (tables excluded): 0 mentions of 278.99, 294.6 or 'November 2025'. report.md:76 says the founder's control is not documented. report.md:2977 says Class B share data are not reviewed.

Lookup cost: run-scoped keyword passage queries took 3-29 ms, and parse-ID resolution 20 ms (psql \timing). That is negligible next to model calls.

</details>

### GAP-3-1: Push-only packets: every stage gets the same tiny code-chosen slice and is forbidden to look anything up

Severity **high**, effort **L**, verdict **corrected**, JD trait: Iterative lookups that follow up a surprising number, which runs through the JD example. In particular: ownership with voting vs economic control (section 10), the moat attack table with competitor numbers (sections 8-9), segment economics (sections 1 and 3).

**Problem.** Analysts cannot ask the corpus anything. What they see is fixed by code before the call, and the same slice goes to very different questions. The moat stage gets the passages chosen for the operating model. Every report section gets the same 14 passages. Ranking also excludes whole classes of evidence: risk-factor sections score -4, so ownership, control and competition text can never be pushed. The model is then told this is the complete context, so it reports 'not available' or 'absent' for things the run holds. That gap is the structural difference from how the JD example was produced. It cannot be fixed by tuning which slice goes where, because the slice that matters depends on what the model finds surprising mid-analysis.

**Evidence.** Code:
- runner.ts:84: 'Use the task packet below as the complete working context.'
- runner.ts:335: case 'tool.call' throws 'Research model calls do not permit tools'.
- tests/agent-harness.test.ts:440 locks that in.
- AGENTS.md:47, docs/system.md:209 and docs/architecture.md:39 state 'Model calls have no tool execution'.
- filing-passages.ts:7 and :9 set one run-wide 24 KB set for 4 task types. run-context.ts:428-437 explains it as 'the same for every call of a run', for caching.
- filing-passages.ts:53 scores 'risk factors|risks related to' at -4.

DB:
- filing_passages md5 8c6821b6 is identical in moat, business_process, operating_model and all 13 report_section tasks: 14 passages, 22,541 bytes.
- The corpus holds 32 documents, 5,259 chunks, 7.65M characters.

Present in the run but reported unavailable or absent:
(1) report.md:76 says the founder's control is not documented. 63 chunks in 17 filings state the founder controls a majority of voting power.
(2) report.md:2977 says Class B shares are not in the reviewed share data. historical_record has 53 quarterly us-gaap:CommonClassBMember observations.
(3) moat_assessment says 'no peer pricing data is in the corpus'. The Snap 10-K (393 chunks) and 21 accepted peer claims are there.
(4) top_down_bottom_up_reconciliation is blocked_source_gap with tam_limit null. An accepted claim reads 'U.S. internet advertising revenues ... reaching a record $294.6 billion'.
(5) report.md:121 says Reality Labs 'revenue levels are not in the reviewed claims'. historical_record has 20 quarters of Reality Labs revenue.
(6) The Q2 2026 10-Q 'Leases and Contractual Commitments' chunk lists approximately $278.99bn of leases not yet commenced. It appears in 0 claims, 0 artifacts and 0 report lines.

**Recommendation.** Do this in stages.

Stage 1, no invariant change:
- Fix GAP-3-2 and the missed claim-pool cap (needs.ts).
- Add a per-task deterministic need list built from the framework sections: governance/voting control, commitments and leases not yet commenced, debt notes, capital return, segment note.
- Resolve those needs with retrievePassages before the call. Turn matched passages into accepted claims through the existing source-reader path, so they are citable.
- Add a document index and a metric index to the shared packet prefix.
- Measure with the GAP-3-7 probes. Done when at least 6 of 8 probes are reflected for a META rerun.

Stage 2, only if probes still miss:
- Add bounded read-only lookup tools (GAP-3-5/3-6).
- Amend the AGENTS.md:47 / system.md:209 / architecture.md:39 invariant explicitly.
- Give tools a citation path. Either let the model cite {passage_id, verbatim quote}, which code verifies against document_chunks.text and stores as an accepted evidence_claim with an evidence_link, or reuse team_answer's source_ids citation. Without this, looked-up passages stay uncitable.
- Run the AGENTS.md paid eval before merge.

**Verifier check.** Checked on main against run 4fae0fb1. The core facts hold:
- The same filing_passages set (md5 8c6821b6, 14 passages, 22,541 bytes) is in business_process, moat, operating_model and all 16 report_section tasks.
- moat, operating_model, valuation, operating_scenarios, report_outline and all report_section packets carry the same 106 claims.
- The corpus is 32 docs, 5,259 chunks, 7,650,811 chars.
- filing-passages.ts:53 scores risk factors at -4. runner.ts:335 throws on tool.call. The test is at agent-harness.test.ts:440.
- AGENTS.md:47, system.md:209 and architecture.md:39 state the invariant.
- Probes: 63 chunks in 17 docs match '"voting power" Zuckerberg'. The 10-Q of 2026-06-30 says Zuckerberg 'is able to exercise voting rights with respect to a majority of the voting power'. 278.99 is in 2 chunks of that 10-Q. report.md:76 and :121 are as quoted.

Four corrections:
(1) The 'complete working context' sentence (runner.ts:84) is only in buildTaskPrompt's default path. 0 of the run's tasks contain it, because every stage uses exactJsonPrompt (run-context.ts:323-342). exactJsonPrompt says to record gaps. Specialists were also offered a pull path: the moat packet has team_context.source_requests = {allowed: true, max_rounds: 2, rounds_used: 0}. The model said 'The corpus has no Alphabet or other peer ... data' and never used it.
(2) The moat stage did see peer and industry facts. They reached it as upstream artifacts: competitive_response_matrix gives Snap revenue of $5.93bn, and customer_decision_map gives IAB programmatic $162.4bn. They were not citable claims.
(3) 'Cannot be fixed by tuning which slice goes where' is overstated. Six of the eight probes are facts the framework always requires: voting control, share classes, lease commitments, debt issuance, segment history and receivables. Fixed per-task retrieval needs would surface them with no invariant change.
(4) The proposed search_passages would not fix citation. FILING_PASSAGE_RULE (filing-passages.ts:146) says 'A passage without claim_ids supports reasoning but no citation'. Report paragraphs cite only evidence_ids and artifact_ids (reporting/contracts.ts:37,46). The voting-power, 278.99 and Note 10 passages have 0 claims, so tool results would carry empty claim_ids and writers would still mark them unsourced.

### GAP-3-2: Evidence from undated documents is silently dropped from every specialist and report packet (NULL published_at)

Severity **high**, effort **S**, verdict **corrected**, JD trait: Moat rated per source plus the mandatory attack table with competitor numbers (sections 8-9). End-demand constraint from external statistics (section 6).

**Problem.** loadReportInputs keeps a claim only when 'sd.published_at <= cutoff'. In SQL a NULL comparison is not true, so every claim from a document without a publication date is excluded. In the META run those were the IAB/PwC report, the Snap 10-K PDF and the earnings-transcript page. The moat, operating-model, valuation and report-section packets therefore had no peer, industry or IR evidence. The moat chapter concluded the moat 'cannot be tested against peers', and the top-down reconciliation was blocked even though accepted market-size claims existed. A push-only design hides this kind of filter completely: nothing tells the analyst the evidence exists.

**Evidence.** - src/lib/research/reporting/store.ts:34: 'AND sd.published_at <= ${cutoff}::timestamptz AND sd.url ~ ...'. It is unchanged since 2026-09-27 (git blame), and the prior audit does not mention it.
- DB: published_at IS NULL for the IAB report, the Snap 10-K and the statwonk transcript page.
- Of 150 accepted claims, the moat, operating-model, valuation and report-section packets carried 106 (md5 2d190a66). That is 0/21 web_peer_company_primary, 0/13 web_industry_primary and 0/8 web_company_investor_relations. The business-process and genesis packets, which build their own claim list, got 19/21 and 13/13.
- The same query with '(sd.published_at IS NULL OR sd.published_at <= cutoff)' returns 149 claims, 34 of them peer or industry.
- Consequences in the artifacts: top_down_bottom_up_reconciliation = {tam_limit: null, reconciliation_status: 'blocked_source_gap'}. Yet claims such as 'U.S. internet advertising revenues increased 13.9% ... $294.6 billion' were accepted.
- report.md:52 and moat_assessment.competitor_consequence say the corpus has no Alphabet or other peer data.

**Recommendation.** 1. In store.ts:34, use '(sd.published_at IS NULL OR sd.published_at <= ${cutoff}::timestamptz)'.
2. In store.ts:39, map a null published_at to null, not 1970. Make ReportEvidence.published_at nullable and render it as 'undated'.
3. Keep excluding undated documents only for point-in-time/backtest runs, gated on run type, where a page could postdate the cutoff.
4. Note in the PR that waiting runs must regenerate their report.

Verify:
- A unit/db test: a claim from an undated document reaches loadReportInputs.
- The read-only replay for 4fae0fb1 returns 149 claims.
- The next mock run's moat and operating_model packets contain peer and industry claim IDs.

**Verifier check.** Confirmed. store.ts:34 is 'AND sd.published_at <= ${cutoff}::timestamptz', unchanged since 86a449a9 (2026-09-27). The prior audit does not cover it.

Replaying the query with '(published_at IS NULL OR published_at <= cutoff)' returns 149 claims: the 106 dated ones plus 43 undated ones:
- 21 web_peer_company_primary (Snap 10-K PDF);
- 13 web_industry_primary (IAB);
- 8 web_company_investor_relations;
- 1 primary_source_context.
The claim 'U.S. internet advertising revenues increased 13.9% ... $294.6 billion' is accepted. top_down_bottom_up_reconciliation is {tam_limit: null, reconciliation_status: 'blocked_source_gap'}, from the operating_model task, whose packet lacks 294.6. The new Date(null) mapping is at store.ts:39, not :41.

Correction: 'the moat ... packets had no peer, industry or IR evidence' is too strong. Peer and IAB figures reached the moat stage through upstream artifacts, just not as citable claims.

The finding is wider than reported. Across the whole DB, 31 of 42 web_peer_company_primary, 7 of 9 web_proxy_and_governance and 24 of 26 web_market_data docs have NULL published_at. So the filter also silently cancels the existing pull paths: stage source_requests reruns, and the team-request collector searches. That is because ownerAnswer (team.ts:377) and callResearchAgent (run-context.ts:417) both load evidence through loadReportInputs.

Rollout caveats:
- The fix changes input_hash for every run with undated evidence. 4fae0fb1 is waiting_for_human, so approving it would return 409 STALE_REPORT_INPUT (review/route.ts:69) until the report is regenerated.
- Do not substitute COALESCE(published_at, retrieved_at). Snap was retrieved at 14:37:57, after the run cutoff of 14:36:31, so it would still be dropped.

### GAP-3-3: The two existing pull paths returned nothing: retrieval locked to one source role, web search built from question prose

Severity **high**, effort **S**, verdict **corrected**, JD trait: Management and governance scored separately with voting vs economic ownership, founder 12.5% economic / 71.8% voting (section 10). Competitor numbers.

**Problem.** In the paid run, specialists made no stage source request at all. The report-question path failed in two ways.

First, owner retrieval is limited to the request's single source_role. A governance request tagged proxy_and_governance therefore searched zero documents, even though the same facts sit in the 10-K/10-Q risk factors (regulatory_filing).

Second, the web search for a request is the company name plus the reviewer's whole question. team.ts adds the asset prefix itself, which bypasses constrainSearch's rule not to anchor peer, industry and regulator queries on the researched company. A peer request is therefore searched as '"Meta Platforms, Inc." META The moat conclusion cannot be tested...', truncated to 200 characters. Every search fetched nothing.

**Evidence.** Code:
- team.ts:335: retrievePassages(... sourceRoles: [request.source_role] ...).
- team.ts:355: query = `"${ctx.assetName}" ${ctx.symbol} ${request.question}`.slice(0, 300).
- Compare source-requests.ts constrainSearch: prefix = namesAsset || external ? '' : name+symbol. MAX_QUERY_CHARS is 200.
- docs/system.md:90 documents the role restriction.

DB:
- No artifact_type='source_requests' rows for 4fae0fb1, so 0 stage rounds were used.
- source_retrieval_attempts with request_id: 6/6 'unavailable' / no_substantive_source_fetched. They cover request-1-1, 1-3, 1-4, 1-5, 2-4 and 2-5, and the logged queries all begin '"Meta Platforms, Inc." META The ...'.
- request-1-5 response: 'The passages list is empty and source_search_attempted is true', status unavailable.
- Replaying the same OR keyword query over all roles puts 'Risks Related to Ownership of Our Class A Common Stock' chunks containing 'voting power' in 6 of the top 8 slots (10-Qs 2022-09-30 to 2026-06-30, 10-Ks 2021 and 2022).
- Effect on the report: report.md:76 says the founder's control is not documented.

**Recommendation.** 1. team.ts:335: if the role-scoped result has no keyword or vector passage, or a no_documents_for_role gap, retrieve once more. Use only the researched company's own documents: runDocuments roles regulatory_filing, earnings_*, company_investor_relations. Keep each passage's source_role.
2. retrievePassages: drop or demote passages whose section_path matches the filing-passages boilerplate set (table of contents, exhibit, signature, forward-looking, cover page). Do not demote risk factors here.
3. Build the request query from key terms, not the whole prose: the phrases field, or a requester-supplied search_query of 200 chars or fewer.
4. team.ts:355: pass that short query through constrainSearch with no hand-built prefix.

Verify:
- A db test: request-1-5's question returns an ownership risk-factor passage.
- A db test: request-1-3 returns no TOC or exhibit chunks.
- A unit test: a peer query with search_query 'Alphabet 2025 annual report' contains no 'Meta'.
- In the next run, more than 0 of the team-request searches have fetched > 0.

**Verifier check.** Confirmed:
- team.ts:335 passes sourceRoles: [request.source_role].
- team.ts:355 builds '"${assetName}" ${symbol} ${question}'.slice(0,300).
- runSearches (collector.ts:19) then calls constrainSearch. Because the query already names the asset, constrainSearch's no-prefix rule for external roles never matters.
- source_retrieval_attempts holds 6 rows with a request_id, all 'unavailable' / no_substantive_source_fetched, all starting '"Meta Platforms, Inc." META The ...'.
- Replaying request-1-5's OR query over all roles puts 'Risks Related to Ownership of Our Class A Common Stock' chunks in 6 of the top 8 slots. The other 2 are Snap's Table of Contents.

Two things the reviewer missed:
(a) Even in the correct role, the prose-OR query returns boilerplate. request-1-3's passages (regulatory_filing) were 2 TABLE OF CONTENTS, 3 Item 15 Exhibit indexes and 3 NOTE ABOUT FORWARD-LOOKING STATEMENTS. The owner answered 'The supplied passages are cover pages, tables of contents, forward-looking-statement notes, and exhibit indexes'. retrieve.ts has no boilerplate penalty, unlike filing-passages.ts:53. A role fallback alone would also mix in peers' own governance chunks (Snap TOC).
(b) request-1-4 (peer) did retrieve Snap 10-K Revenue and Cost of Revenue passages. The peer half failed on comparability and on a missing primary Alphabet filing, not on retrieval.

### GAP-3-4: Deterministic history exists in full but stages get fixed windows; add get_series (or at least a pushed history summary)

Severity **high**, effort **S**, verdict **corrected**, JD trait: Twenty-quarter table with computed medians and ranges, and current-vs-history positioning (section 4). Segment economics: who earns vs who burns (sections 1 and 3). Cash conversion and working capital (section 5). Framework section 4.11: five-year median, peak and trough per core metric.

**Problem.** historical_record holds 20 quarters of reported and segment data, but the precomputed ttm_series and statistics are empty, and each consumer gets a hard-coded cut:
- the operating model: the latest 6 periods per metric and 8 per segment metric;
- valuation: one base year;
- the business-model report section: no segment series at all.

Writers then say segment revenue, Class B shares or trailing series are unavailable. Five-year median, peak and trough, 'current vs history', and 'who earns vs who burns' all need on-demand slices that no fixed window anticipates.

**Evidence.** Code:
- operating-model.ts:75: recentByMetric(..., 6). operating-model.ts:79: recentByMetric(..., 8).
- operating-model.ts:105-107: historical_diagnoses reduced to 4 fields.
- asset-valuation.ts:501: history_ratios. The packet value is {tax_rate, base_year FY2025, da_to_revenue, capex_to_revenue}, 224 bytes, and reinvestment_model has capex_forecast [137500000000] only.
- docs/research-framework-v2.1.md:774-788 is the required metric diagnosis.

DB (historical_record, 4fae0fb1):
- 2,311 observations, 142 keys, 20 quarters.
- meta:FamilyOfAppsMember and meta:RealityLabsMember revenue and us_gaap_OperatingIncomeLoss: 20 quarters and 5 years each.
- CommonClassBMember: 53 quarterly observations.
- AccountsReceivableNetCurrent: 17 quarters. Capex: 18 quarters.
- ttm_series has 0 rows and statistics is {}.
- The report:section:business-model-and-segments packet contains no 'RealityLabsMember' string (position()=0); historical-performance does.

Report:
- report.md:121: Reality Labs 'revenue levels are not in the reviewed claims, so unit economics cannot be built'.
- report.md:2977: Class B shares not in the reviewed share data.
- report_review notes 'the trailing series is not in the packet'.
- business_process_map: receivables and payables 'not disclosed in the cited claims'.

**Recommendation.** Push before building a tool:
(a) operating-model.ts:105-107: keep historical_median, min, max, current_level and inflection_period for each diagnosis.
(b) Build a deterministic history_summary of about 4 KB, the same for every call so it caches, from historical_record. Cover about 30 core metrics plus each segment member's revenue and operating income: {n, median, min, max, latest, latest percentile, ttm}, reusing the normalizer's TTM logic. Also fill historical_record.ttm_series and statistics instead of leaving them empty.
(c) Put history_summary in the shared run-context keys (RUN_CONTEXT_KEYS, run-context.ts:306), so operating_model, valuation and every report section get it whatever artifact_ids the outline picks.

Only add get_series as a tool if GAP-3-1 stage 2 goes ahead.

Verify:
- A unit test on a 4fae0fb1-shaped fixture: the summary includes RealityLabsMember revenue, n=20.
- In the next run, report prose states Reality Labs revenue history and the Class B count.
- The GAP-3-7 probes 2, 5 and 8 flip to reflected.

**Verifier check.** Confirmed:
- historical_record has 2,311 observations, 142 metric keys and 20 quarterly period_ends. statistics is {} and ttm_series is [].
- meta:RealityLabsMember and meta:FamilyOfAppsMember revenue and OperatingIncomeLoss each have 20 quarterly and 5 annual observations.
- Class B: 22 quarterly observations each for shares outstanding, issued and authorized.
- AccountsReceivableNetCurrent has 17 quarters and capex 18. There are also OperatingLeaseLiability* (22) and ProceedsFromIssuanceOfLongTermDebt (13, through 2025-12-31).
- operating-model.ts:75/:79 (6 and 8 periods) and :105-107 (4 fields) are as cited.
- The valuation packet's history_ratios is 224 bytes. reinvestment_model is {capex_forecast:[137500000000], working_capital_forecast:[]}.
- The business-model-and-segments packets do not contain 'RealityLabsMember'. report.md:121 and :2977 are as quoted.

Corrections:
(1) The statistics the reviewer wants already exist for 17 metrics. historical_diagnosis.diagnoses carries historical_mean, median, min, max and std_dev (diagnosis.ts:74-82). operating-model.ts:105-107 throws them away. Among report sections, only monitoring-and-thesis-breakers receives historical_diagnosis; historical-performance gets historical_record only.
(2) The business section lacks segment series because the outline routes artifacts to sections: section_plan.artifact_ids, filtered in runtime.ts:86-87. That section got only business_process_map, customer_decision_map and segment_model. The fix point is that packet builder.
The pushed summary is therefore S effort, and get_series is optional.

### GAP-3-5: Adopting tools needs request-side, loop, idempotency and telemetry work; tool_use parsing is the only piece that exists

Severity **medium**, effort **L**, verdict **confirmed**

**Problem.** The assumption that 'the Anthropic adapter already parses tool_use blocks' covers only the response side, and only at the end of the stream. The request model is a single prompt with no tools. Missing pieces:
- the adapter never sends 'tools' and always builds one user message;
- assistant content blocks are not kept for replay;
- there is no loop, so a tool call aborts the attempt.

Two subtler issues would also break correctness. Task keys hash the packet; once evidence moves from the packet into tool results, a replay would reuse an output computed before new documents arrived. And per-call telemetry and budget checks run per attempt, not per round.

**Evidence.** Code:
- types.ts:21-35: ModelRequest has system and prompt, no messages or tools.
- anthropic-cache.ts:59: returns messages: [{ role: 'user', content }].
- anthropic-compatible.ts:98-108: serialize() sends model, system, messages, max_tokens and output_config only.
- anthropic-compatible.ts:186-201 accumulates tool_use. :240-243 yields tool.call only after the stream terminates.
- runner.ts:335 throws invalid_request, which is not retryable.
- run-context.ts:361 and :454: researchTaskKey = hash(JSON request incl. packet).
- run-context.ts:7: budget preflight 'before every attempt'.
- openai-compatible.ts:139-181 parses tool_calls the same way and has no request side either.

API facts (claude-api skill reference):
- Render order is tools → system → messages, and changing tool definitions invalidates every cache level.
- Opus 5.5 and Sonnet 5.5 return 400 on forced tool_choice any/tool, so use auto.
- output_config.format is listed as incompatible only with citations and prefill, so the final answer can stay schema-constrained.
- All tool_result blocks for one assistant turn go in a single user message.

**Recommendation.** As written, and only after GAP-3-1 stage 1 shows that probes still miss.

Also required:
- Return the full assistant content blocks (text, tool_use, thinking with signature) so history can be replayed append-only.
- Validate every tool input against its zod schema before running it, and return is_error results for invalid or unknown calls.
- Include the corpus fingerprint (run document IDs, parse versions, historical_record artifact id and version) in the researchTaskKey input.
- Record each round as a telemetry pass.
- Gate it behind RESEARCH_AGENT_TOOLS=1, for anthropic-direct and mock only.
- Shrink the packet first. Report-section packets are 215-890 KB, and every round resends the prefix.

Verify:
- Replace agent-harness.test.ts:440 with a scripted tool_use → tool_result → final JSON test and an unregistered-tool test.
- Run npm run test:unit and npm run test:db.
- Run one user-approved paid smoke on claude-haiku-5-5.

**Verifier check.** Every code citation checks out:
- types.ts ModelRequest has system, prompt and outputSchema, with no tools or messages.
- anthropic-cache.ts:59 returns messages: [{role:'user', content}].
- serialize() in anthropic-compatible.ts:98-108 sends model, prompt fields, max_tokens, output_config and stream only.
- tool_use is accumulated at :186-201, and tool.call is yielded after the stream ends at :240-243.
- runner.ts:335 throws invalid_request. researchTaskKey hashes the whole request (run-context.ts:361, :454). Budget preflight runs per attempt (run-context.ts:6-7).

The claude-api skill reference confirms the API facts:
- render order is tools → system → messages, and a change to the tool set invalidates the cache;
- forced tool_choice any/tool returns 400 on Opus 5.5 and Sonnet 5.5, so use auto;
- citations are incompatible with output_config.format;
- all tool_result blocks for one turn go in one user message.
Haiku 5.5, which this run used, is not on the forced-tool 400 list, but auto is correct anyway.

The corpus-fingerprint point for the task key is valid. Once evidence moves from the packet into tool results, the packet hash no longer changes when new documents arrive.

### GAP-3-6: Keep the trust boundary: read-only executor, retrievePassages' indexing side effect, injection caps, doc updates

Severity **low**, effort **S**, verdict **corrected**

**Problem.** Tools are only safe if the executor really is read-only and bounded. retrievePassages is not side-effect free: it indexes any in-scope document that lacks a current parse, which writes rows. A filing passage returned by a tool is untrusted text. It could tell the model to keep calling tools, so call volume is the new injection surface. Exfiltration is not new: tools read only run-scoped rows, and only the model provider receives them, as it already receives packets. The security doc currently describes untrusted text reaching prompts only through packets.

**Evidence.** Code:
- retrieve.ts:97-103: ensureIndexed calls ensureDocumentIndexed for unparsed IDs.
- retrieve.ts:276: called on every retrievePassages call.

Docs:
- docs/security.md:84: the untrusted model output row lists passages in team-answer prompts and filing_passages, with 'That rule is an instruction to the model, not an enforcement'.
- docs/security.md:33: Z3 output is untrusted.
- AGENTS.md:47: 'Treat fetched pages, filings and model output as untrusted data.'

**Recommendation.** Fold this into the GAP-3-5 implementation as a checklist:
- a readOnly flag that skips ensureIndexed and returns a not_indexed gap;
- an explicit cutoff filter mirroring latestFilings: exclude documents with publishedAt after the cutoff, keep undated ones except in backtest runs;
- tagged-template SQL only, scoped to runDocuments(runId);
- zod-validated arguments;
- results wrapped as untrusted data;
- round and byte caps.

Update AGENTS.md:47, system.md:209, architecture.md:39, the security.md:84 row and the trust-boundary diagram source in the same PR.

Verify with two db tests:
- another run's document ID returns nothing;
- a search on an unindexed document leaves the document_parses count unchanged.

**Verifier check.** The facts hold:
- retrieve.ts:97-103 ensureIndexed calls ensureDocumentIndexed for unparsed IDs, and :276 calls it on every retrievePassages call.
- docs/security.md:84 is the model-output row.
- AGENTS.md:47 states that fetched content is untrusted.

Severity is inflated. Nothing ships today that exposes this. It is a design precondition for a tool that does not exist yet, so it belongs inside GAP-3-1/3-5, not as a standalone medium.

The reviewer missed one point: retrievePassages is not cutoff-aware. runDocuments (retrieve.ts:66-89) selects published_at, but scopedDocuments filters only by ID and role. The 'cutoff-bounded' tool and its test (b) in GAP-3-1 need a new filter. On 4fae0fb1 the only document past the cutoff is the market-data snapshot, published 1 minute after it, so there is no leak today. Backtest runs would need the filter.

### GAP-3-7: No cheap measure of 'reported unavailable but present'; raw input_tokens is the wrong success metric for a tool loop

Severity **medium**, effort **S**, verdict **corrected**, JD trait: Framework completeness gates (JD section 20): 'largest missing evidence named' must be missing for real, not missing only from the packet.

**Problem.** Depth is currently judged by reading reports after paid runs. Present-but-unreported data can be checked for free, deterministically, against the run's own database. The proposed success check 'input tokens per stage fall' would also mislead. The adapter counts cache reads in inputTokens, and every tool round resends the prefix, so logged input tokens rise with rounds even when uncached tokens and cost fall.

**Evidence.** Code: anthropic-compatible.ts promptUsage (lines ~31-41): inputTokens = input + cache_read + cache_write.

Current levels (model_call_logs for 4fae0fb1): asset-analyst logs 1.76M input tokens, of which 0.49M are cache reads; moat 59k and operating model 112k tokens per call.

Eight probes, each present in this run's data but absent or called unavailable in the report:
1. founder voting control: 63 chunks;
2. Class B counts: 53 observations;
3. Snap and peer pricing: 21 claims;
4. US internet ad market $294.6bn: accepted claim;
5. Reality Labs revenue history: 20 quarters;
6. $278.99bn of leases not yet commenced: Q2 2026 10-Q;
7. $30.0bn notes in November 2025: FY2025 10-K Note 10;
8. receivables: 17 quarters.

In report prose (table rows excluded), 0 matches for '278.99', '294.6' and 'November 2025'. report.md:76 and :2977 call items 1 and 2 undocumented.

**Recommendation.** Add scripts/depth-probes.ts <run_id> <probes.json>. It is read-only, makes no provider calls, and runs in seconds.

Each probe is {lookup: passage phrases or metric_key+segment, expect_terms: [distinctive figures/phrases]}. Count a probe as 'reflected' only when an expect_term appears in prose outside table rows, and the matched sentence has no negation such as 'not', 'no ', 'cannot' or 'unavailable'.

Ship a META probe file with the 8 items, using the terms above. The success metric is:
- probes reflected;
- uncached input (input − cache_read) plus cache writes, and cost_usd, per stage.
It is not raw input_tokens.

Optional: emit 'present-but-unreported' as a non-failing finding next to checkReportSubstance (compose.ts:44).

Verify: the script reports 0 of 8 for 4fae0fb1.

**Verifier check.** Confirmed:
- promptUsage (anthropic-compatible.ts:31-41) sets inputTokens = input + cache_read + cache_write, so raw input_tokens rises with tool rounds even when cost falls.
- model_call_logs for 4fae0fb1: asset-analyst 14 calls / 1,761,322 input; export-writer 23 / 3,661,599; research-reviewer 2 / 957,800; 79 calls in total.
- Non-table report prose has 0 matches for '278.99', '294.6' and 'November 2025'.

Correction on probe design: plain term matching gives false positives. 'voting power' appears 3 times in report prose, all in statements that it is unavailable. 'Class B' also appears in prose. Reality Labs revenue appears as derived or forecast figures (2,159 derived, 2,433 forecast, report.md:2495/2770). expect_terms therefore have to be the distinctive sourced facts, for example 'majority of the voting power', '278.99', '294.6', '30.0 billion', and a reported quarterly RL revenue figure. Statements of absence must not count. The baseline of 0 of 8 holds only with such terms.

### GAP-3-8: Code flags surprising numbers and no stage follows them up (unexplained_inflections has no consumer)

Severity **medium**, effort **S**, verdict **corrected**, JD trait: What happened to the economics (section 5): explain each break in the series, for example FCF/NI conversion 106% → 33% or marketing 4.1% → 6.4% of revenue, rather than list it.

**Problem.** historical_diagnosis already does the first half of what the JD analyst did, deterministically: it finds anomalies. Nothing does the second half, finding why. Every diagnosis stays 'unexplained' with control 'unassigned'. Only the producer code references unexplained_inflections. The operating model sees the artifact only inside team_context, with no way to search for causes. This half needs no invariant change: code can run the lookup itself.

**Evidence.** Code:
- src/lib/research/diagnosis/diagnosis.ts:26 and :110 are the only references besides contracts.ts:52 and mock.ts:307 (grep -rn unexplained_inflections src).
- operating-model.ts:105-107 keeps 4 fields of each diagnosis.

DB (historical_diagnosis, 4fae0fb1):
- 17 of 17 diagnoses are structural_cyclical_temporary_or_accounting='unexplained' with management_control='unassigned'.
- 8 inflections. One is financing_cash_flow 2025Q4 (z=2.81). The FY2025 10-K 'Note 10. Long-term Debt' chunk explains it: 'In November 2025, we issued an aggregate of $30.0 billion of fixed-rate senior unsecured notes'. The report prose never mentions this issuance, while the bridge uses 83,664 of long-term debt (report.md:3143).
- The tax-charge inflection (2025Q3 net income) was explained, but only because 'Provision for income taxes' happened to be among the 14 pushed passages.

**Recommendation.** 1. Keep the cheap deterministic lookup: at most 8 inflections × retrievePassages with period-hinted phrases, 2 passages each, about 16 KB.
2. Turn the top passage into an accepted claim through the source-reader path, so it can be cited.
3. Attach inflection_evidence to the operating_model and historical-performance packets.
4. Add an output field inflection_explanations[{metric_key, period, cause: pricing|volume|mix|one_off|financing|accounting|unknown, management_control, claim_ids}] to the operating-model contract.
5. In diagnosis.ts, stop labelling metrics with no change point as 'unexplained'.

Verify:
- A db test on a 4fae0fb1-shaped fixture attaches 'Note 10. Long-term Debt' to financing_cash_flow 2025Q4.
- The next run's inflection_explanations cites a claim for at least 6 of the 8 inflections.
Do not use the historical_diagnosis 'unexplained' count as the metric.

**Verifier check.** Partly confirmed:
- All 17 diagnoses are 'unexplained' / 'unassigned', and there are 8 unexplained_inflections, including financing_cash_flow 2025Q4 z=2.81.
- The FY2025 10-K has exactly 1 chunk 'In November 2025, we issued ...'.
- operating-model.ts:105-107 keeps 4 fields.

Corrections:
(1) The 17 of 17 is by construction, not caused by missing lookups. The historical_diagnosis handler never passes processNodeMapping to buildHistoricalDiagnosis (historical-diagnosis.ts:80-93). causalNode is therefore always undefined, and classifyChange returns 'unexplained' for every metric, including those with no change point (diagnosis.ts:131-132). management_control is hard-coded to 'unassigned' (diagnosis.ts:91). Attaching inflection_evidence to the operating-model packet cannot move the proposed 'below 17 of 17' metric.
(2) unexplained_inflections does have a consumer: presentation.mjs:143 labels it for display ('Changes that still need an explanation'). It has no analysis consumer.
(3) The Note 10 passage has 0 claims. As FILING_PASSAGE_RULE stands, the model could reason from it but not cite it.
