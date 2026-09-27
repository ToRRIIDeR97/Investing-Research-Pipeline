# SOFI report presentation review

The user requested working HTML examples using the existing report. The previews
are served from `/report-layouts/index.html`, with `layout=reader` or
`layout=analysis`. They do not replace the application report page or change the
saved research.

## Current-page inspection

1. **Contents and chapter opening: usable but cumbersome.** A full-screen contents
   list uses long section titles. A reader loses navigation after scrolling.
   The current withheld-conclusion notice is clear and should be retained.
2. **Investment thesis and confidence tables: poor.** The captured page shows
   long prose squeezed into narrow columns, JSON list punctuation, internal
   `artifact_type` values and line breaks inside identifiers. These are data
   objects rather than useful reader tables.
3. **Quarterly history: poor.** The captured table leads with unit, currency,
   confidence and internal names. A metadata column becomes almost one character
   wide and makes the whole row extremely tall. Comparing periods is impractical.

These findings come from the actual report page inspected in this task, including
inline browser screenshots. No new financial fact-checking was performed.

## Two examples

**Reading view, recommended:** persistent short chapter names, a comfortable serif
prose column, and full-width supporting exhibits. All exhibits are reachable with
the chapter's View exhibits button. Long records use labeled descriptions and
lists. Financial history is a measure-by-quarter table with a frozen first column.

**Analysis view:** the same content with sans-serif narrative and supporting data
beside it. The data pane remains available while reading. It becomes a single
column on smaller screens. This is useful for checking an argument against the
numbers, but the reading view gives wider tables on a laptop.

Both contain the saved report's 16 chapters, 216 paragraphs, 98 exhibit references,
14 questions, coverage findings and source passages. There are 51 unique exhibit
datasets, reused where the original report references them more than once.
Labels and units are presentation changes. Original values, paragraph text and
conclusion are preserved in the snapshot. Identifiers and storage metadata are
excluded from reader-facing tables. The existing report's evidence limitations
and unverified financial claims are not resolved by these layout changes.

## Verification

- Four formatter/boundary tests were written before implementation and initially
  failed at the explicit missing-module assertion. They then passed. A fifth test
  was added against the generated preview to check content counts, every exhibit,
  raw internal-name removal and the real loan loss reserve value.
- Browser checks at the default desktop viewport and a 390×844 requested viewport.
  The mobile content width was 375 pixels after the browser scrollbar; document
  width matched it. No page-wide horizontal overflow was observed in either view.
- Quarter navigation changed the table to Q1 2024–Q1 2025 and back to the latest
  five quarters. Searching Loan loss reserve returned 47.838, 50.634, 50.934,
  51.934 and 56.459 USD millions for Q2 2025–Q2 2026. The original USD amounts are
  available on the cells. Missing values remain explicit and actual zeros remain 0.
- Expand table works. Scenario price targets fit in the mobile table without
  horizontal scrolling. History tables scroll within their own region, keeping
  the measure visible.
- Source-note dialogs show the original passage and SEC link. Escape closes the
  dialog. Chapter navigation, layout switching and exhibit disclosures work.
- Browser screenshots were inspected for desktop analysis, wide history tables,
  loan loss reserve, desktop/mobile scenario targets and mobile reflow.

This is a scoped usability and visual check, not a complete accessibility audit.
The examples use native headings, table headers, disclosure controls, dialogs,
focus outlines and region labels. The root agent authored and checked the work.
No paid model calls, new dependencies, database mutations or production UI changes.
