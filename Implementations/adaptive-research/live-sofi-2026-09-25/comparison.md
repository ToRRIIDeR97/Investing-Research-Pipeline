# Live SOFI research test — 25 September 2026

The new report explains the business and investment consequences more fully, but
it does **not yet meet the JD initiation example's standard**. The main remaining
problems are incomplete evidence, citation mismatches, excessive repetition, and
raw analytical tables that are difficult to read. More prose did not solve the
upstream research gaps.

The user requested a live paid test on “Sofa,” interpreted as SoFi Technologies
(SOFI), with DeepSeek V4.1 Flash for every required model role. This was a real
provider run, not a mock. It reached final human review with 21 of 24 stages
completed. Human investment approval, canonical export, and refresh scheduling
remain pending. The report itself withholds an investment conclusion.

## Read and verify

- [New report, reading copy](draft-report.md)
- [Old renderer using this run's same analytical inputs](legacy-same-inputs.md)
- [Previous completed SOFI report](baseline-report.md)
- [Run, stage, model and artifact proof](proof.json)
- [Per-attempt model telemetry](model-calls.json)
- [Live provider receipt](provider-receipt.json)
- [Full automated review](report-review.json)
- [Descriptive comparison counts](comparison-metrics.json)

The reading copy preserves the generated narrative, tables and citations. It
omits the separate “Supporting passage” lines from the source appendix. The
database retains the complete report and evidence. Both versions have separate
hashes in proof.json. This reading copy is not an approved pipeline export.

## What improved

| Dimension | Previous format / same-input legacy renderer | New live report |
| --- | --- | --- |
| Structure | 25 fixed headings | 16 company-specific sections, including funding, credit and Galileo/Technisys |
| Explanation | Short summaries and tables | Connects the funding model to margins, credit exposure, capital constraints and per-share value |
| Counterarguments | Mostly risks listed separately | Each section discusses alternatives, uncertainty and investment consequences |
| Moat | Compact classification and mechanism tables | Distinguishes business growth from evidence of durable customer retention or excess returns |
| Research questions | Gaps dispersed across the report | 14 explicit questions: 3 answered, 8 qualified, 3 blocked, with follow-up evidence specified |
| Conclusion | Older report had an approved-for-tracking decision | New report withholds judgment because material questions remain unresolved |

For example, the new funding discussion explains that deposit funding can lower
costs while leaving loan-sale and liquidity risks. The scenario discussion makes
clear that the segment profit split is allocated rather than reported. The
downside discussion identifies zero-valued no-moat inputs as placeholders rather
than treating them as measured forecasts. These are useful analytical improvements.

## What still fails the quality bar

1. **Evidence coverage did not improve.** The new run has 36 linked sources,
   21 accepted claims and 311 metric observations. Only 99 of 200 required
   historical metric-quarter cells are present, versus 100 in the older run.
   The older run had 77 sources and 108 accepted claims, so it is not a controlled
   before/after experiment. The same-input legacy rendering isolates presentation
   differences; it does not prove better source discovery or extraction.
2. **Citations are present but do not always support the figures.** The reviewer
   identified Q2 2026 deposit, margin and other figures whose cited passages do
   not entail the stated numbers. Some exist only in upstream analytical artifacts.
   Of 216 paragraphs, 127 cite source claims and 89 rely on artifacts alone; only
   16 distinct source claims are cited. These counts measure traceability, not
   factual correctness. A citation identifier passing validation is insufficient.
3. **Important banking and segment evidence is missing.** Current segment profit,
   capital ratios, credit vintages, charge-offs, customer retention, ownership and
   future dilution inputs are incomplete or stale. The forecast still uses segment
   proxies. A writing layer cannot repair those inputs by elaborating on them.
4. **The report is bloated.** Its paragraphs contain 19,712 words, and it requests
   98 tables. The body has about 24,724 words outside headings and table rows,
   including gaps and implications, versus 1,747 in the same-input legacy version.
   Repetition and repeated raw data account for much of that expansion. The JD
   example is roughly 4,200 words overall; length is not the target.
5. **Tables are not reader-ready.** There are 2,700 Markdown table rows including
   headers and separators. Nested objects, internal field names and identifiers
   appear in cells. Browser inspection confirmed that some columns become very
   narrow and extremely tall. Narrative typography and the withheld-conclusion
   notice are readable, but the complete report is cumbersome to navigate.
6. **The review gate is too permissive for a quality pass.** The model returned
   `conditional_pass` with 15 findings, including six high-severity findings.
   The composition loop therefore did not revise the draft. This is a qualified
   research draft, not a clean review result. The model's 0.72 score is not an
   independently calibrated measure. Its low-severity claim that an executive
   preview must be moved is also questionable: the code writes conclusions last
   but allows them to appear first. I have not treated every reviewer comment
   as established fact.

## Proof of the paid run

Run: `d2ea550f-7068-4706-9a62-abc89b4ceb9f`.
Provider: `opencode-go-direct`, endpoint `https://opencode.ai/zen/go/v1`.
Every attempted model was `deepseek-v4.1-flash`; the all-agent override also
disabled fallback to a different model. Deterministic data and backtest stages
do not require separate model calls.

| Required role | Harness attempts | Provider requests, including repairs | Estimated USD |
| --- | ---: | ---: | ---: |
| source-reader | 4 | 5 | 0.069849 |
| metric-normalizer | 1 | 2 | 0.057548 |
| asset-analyst | 8 | 10 | 0.317059 |
| valuation-analyst | 1 | 1 | 0.039223 |
| export-writer | 16 | 20 | 0.823909 |
| research-reviewer | 2 | 2 | 0.111568 |
| Total | 32 | 40 | 1.419156 |

There were 2,599,985 logged input tokens and 532,635 output tokens. Two harness
attempts failed before recovery: a decision repair and the initial reviewer
request. The failed HTTP 400 request recorded no tokens or estimated cost.
The run began at 03:47:27 UTC and reached final human review at 04:56:51 UTC,
about 69 minutes including debugging and checkpoints.

These are the application's cost estimates, not an invoice or verified account
debit. Separate small smoke/receipt probes are outside the run ledger. The
receipt records an actual HTTP 200 response whose returned model is
`deepseek-v4.1-flash`. Pipeline telemetry records requested models and returned
usage; provider HTTP request IDs were absent, so it is not an independent
per-request billing attestation. No cost-savings claim is made against the older
run because the work and evidence differ.

## Runtime corrections made during the test

- Supplied the full output schemas to the outline, section and review prompts
  on their first attempt.
- Normalized explicitly named raw-share and million-share denominators. The
  live valuation had returned 1,351,990,000 raw diluted shares; the parser had
  accepted only million-share fields. Existing valuation outputs were reused,
  and all 15 price targets were checked against the dilution adjustment.
- Preserved the original task, output schema and complete bounded response in
  repairs for explicitly typed tasks. The old repair had lost decision fields
  beyond its 12,000-character excerpt. Existing compact repair behavior for
  default tasks remains unchanged.
- Removed repeated corpus and rendered-Markdown copies from the reviewer
  packet. Its prompt fell from 4,199,617 to 1,350,082 characters. The initial
  request received HTTP 400 without a detailed cause; the smaller request
  succeeded. A reconstruction test proves that the representation preserves
  the exact report, source passages, table values and hashes.

TypeScript passed. The full unit suite passed 190 tests with three database tests
skipped. The targeted acceptance, separately designed verification, and SOFI
database suite passed all 23 tests without skips. The root agent authored,
implemented and reviewed the changes; this was not an independent-agent audit.
Browser vision covered the actual live report's notice, narrative and tables.
No credentials, migrations, dependencies, commits or deployments were added.

## Recommended next implementation

Prioritize targeted retrieval and extraction for the blocked banking questions,
then reconcile the operating and valuation artifacts. Require high-severity
citation mismatches to be repaired before a report can receive a clean quality
result. Follow that with an editorial pass that removes repeated arguments and
turns selected model data into concise reader tables, keeping raw artifacts in
an evidence appendix. Those changes address what this test actually exposed.
