# Report reader implementation review

Completed 26 September 2026 by the root agent. Acceptance and verification tests were written separately before implementation, but have the same author; they are not an independent review.

## Delivered behavior

The actual full-report route now uses the selected neutral business-flow design. Chapters, reading/analysis modes, source dialogs, research questions and supporting exhibits remain accessible. Financial history pivots into periods, humanizes labels, supports measure search and earlier/later/latest controls, and preserves exact values in accessible labels. Wide tables scroll inside their container. Confidence fields, raw IDs and paragraph-count subtitles are absent from the report reader.

Writers and reviewers receive the visual rules in `docs/report-visual-guidelines.md` through `VISUAL_GUIDELINES`. Optional process and history specifications are validated, reviewed and included in approval hashing. Charts resolve saved observations; model-authored values are rejected. Old reports with no visuals keep their existing hash calculation. No dependencies or database migrations were added.

## Trial using saved SoFi research

This is a local author trial, not a paid-model evaluation. The stored report and its approval state remain unchanged. The presentation supplement is restricted to report hash `61ac57651a58c24ba3214a5d4f2a87e0d56444350899a1893ce5885869d71b3e`, run `d2ea550f-7068-4706-9a62-abc89b4ceb9f`.

| Visual | Supporting saved records | Result |
| --- | --- | --- |
| Depositors → SoFi Bank → loans held → interest income | Evidence `39e34214-f46d-40d7-87bd-f402dc526c2f`; process artifact `2d2b12d6-989c-4fb0-b17d-dff52b0b0de1` | Rendered with funding-cost qualification; credit losses and operating costs are distinguished from net interest income. |
| Loan origination → buyers → fees / sale proceeds | Evidence `2dfaa46c-6018-402b-bfd7-2e383ccc8187`; same process artifact | Rendered with the qualification that sale proceeds are not all revenue. |
| Enterprise clients → Galileo / Technisys → technology revenue | Evidence `67bb8c8d-3a82-4598-a0b4-1fffdc12b54a`; segment artifact `da871b3b-2148-49ba-b4db-310c6da53aca` | Rendered with missing pricing and contract terms stated. |
| Deposit funding history | Artifact `775bd945-a2a6-4f98-9c37-80b08f3d8370`, `observations`; deposits, USD, GAAP, quarterly | 19 stored observations; latest Q2 2026 value is exactly 45,543,160,000 USD. Chart displays USD millions, while the data table preserves original precision. |

The trial uses two of sixteen chapters. The remaining chapters keep their full narrative and evidence. A changed/unrelated report hash receives no trial visual. Future authored visuals are stored in the report section, included in reviewer input and Markdown export, and invalidate approval when changed. The legacy presentation supplement is not added to the old report's stored Markdown export.

## Verification

- `npx tsc --noEmit`: passed.
- Eight new acceptance/verification tests: passed, zero failures or skips. They cover saved-data preservation, readable labels, missing versus zero values, invalid references, unsafe paths, authored chart values, duplicate periods, mixed segments, future availability dates, unchanged input and approval hashing.
- Targeted visual/adaptive-report run: 28 reported, 27 passed, one database-dependent skip.
- `npm run test:unit`: 193 reported, 190 passed, zero failed, three database-dependent skips.
- Targeted `git diff --check`: passed; Git emitted only newline-conversion notices.
- Browser: sixteen chapters, fourteen research questions and sixteen sources accessible; source modal closes with Escape; chapter/mode survives reload; analysis jump preserves chapter hash; summary/full-report navigation works; empty chapter search recovers after clearing; financial search, period paging and table expansion work.
- Desktop at 1095 × 1437 and 1440 × 1024, mobile at 390 × 844: inspected with screenshots. No document overflow; financial tables scroll locally. Final browser error/warning log was empty. Temporary viewport overrides reset.

## Limits

Reference validity does not prove semantic entailment. Writers and reviewers are explicitly instructed to check meaning, causal links and accounting. Visual specs currently support process diagrams and stored history bars only. No fresh provider-output trial, paid research, database-backed pipeline, review submission or approval transition was performed. The application remains running locally for review.
