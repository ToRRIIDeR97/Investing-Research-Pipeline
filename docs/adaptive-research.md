# Adaptive research reports

The reference is [Asset Research Agent Framework v2.1](research-framework-v2.1.md).
It is source material for the research standard. Its fixed final-output headings
are implemented as coverage requirements, not a fixed table of contents. The
[implementation plan](../Implementations/adaptive-research/implementation.md)
records the accepted behavior and verification.

New research plans declare `asset-framework-2.1-adaptive-1`. The standard covers
ownership, evidence, historical diagnosis, business mechanics, constraints, moat,
management, forecasts, valuation, downside, monitoring, and conclusion. Analysts
receive its doctrine through the existing model harness. The latest publicly
reported fiscal periods at the source cutoff define history availability; missing
periods and inappropriate metrics must be explained, not synthesized as facts.

The existing `ai_reviewer` stage now plans the report, records material questions,
writes individual sections, and reviews the completed document against the full
analytical artifacts and source passages. The writer selects company-specific
headings and may add sections. The executive judgment is written after the body.
Numerical tables reference stored artifact paths; the writer does not author
their numbers. Evidence citations require an accepted claim, source location,
quoted passage, URL, and a publication date within the cutoff. These checks prove
traceability, not semantic truth. The reviewer checks whether passages support
claims and whether the interpretation follows.

Coverage outcomes are satisfied, qualified, blocked, or not_applicable, each with
a rationale. An evidenced finding of no moat can satisfy a moat investigation.
Blocked material questions withhold the conclusion. Qualified analysis retains
its limitations in the report. Confidence is not inferred from word count.

One writing repair round is allowed per input snapshot. The report specialist can
also send missing-information requests to the data, financials, business or
valuation specialist before writing, while planning sections, or after review.
Requests are persisted and reopen the affected stages and their consumers. A
specialist can escalate missing disclosures to the data collector, which searches
the question and ingests eligible documents before analysis and valuation rerun.
The report then uses the refreshed input snapshot. Two request rounds and one
source escalation per round bound this work across restarts. Existing budget and
model-attempt limits still apply. Unavailable material answers remain blocked
questions and withhold the conclusion.

Report outlines, sections, questions, documents and reviews use the existing
artifact table with immutable content revisions. Run-row locking serializes
version creation. Identical saves reuse the version. Model calls use the existing
input-sensitive task cache, including section feedback and human revision notes.

Final approval submits `reportHash` from the loaded report. The server checks the
report, its input fingerprint, its review, and its integrity before approving.
Position approval is unavailable when the report withholds a conclusion. A
`needs_more_work` decision queues report revision and returns to the same human
gate. Export reproduces the approved Markdown exactly; the human decision stays
in export metadata. Export and refresh scheduling still precede run completion.
Older plans without `report_standard` retain the existing export path.

No schema migration or new dependency is required. Paid model quality has not
been benchmarked by the deterministic tests. Compare reports from the same source
set on citation support, causal depth, numerical consistency, counterarguments,
and company-specific analysis before claiming a live quality improvement.
